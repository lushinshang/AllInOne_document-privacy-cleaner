const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const config = require('./test-config.cjs');
const { generateFixtures } = require('./fixtures/generate-fixtures.cjs');

function fixturePath(fixture) {
  return path.join(config.fixturesDir, fixture.fileName);
}

async function openInstrumentedApp(browser) {
  const context = await browser.newContext(config.contextOptions);
  await context.addInitScript(() => {
    const originalRead = FileReader.prototype.readAsArrayBuffer;
    window.__qaFileReads = [];
    window.__qaBlockAllReads = false;
    FileReader.prototype.readAsArrayBuffer = function (file) {
      const match = file.name.toLowerCase().match(/\.([^.]+)$/);
      const extension = match ? match[1] : '';
      const limit = extension === 'pdf' ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
      const blocked = window.__qaBlockAllReads || file.size > limit;
      window.__qaFileReads.push({ name: file.name, size: file.size, blocked });
      if (blocked) return undefined;
      return originalRead.call(this, file);
    };
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.timeouts.navigation);
  await page.goto(pathToFileURL(config.htmlPath).href);
  return { context, page };
}

async function resetQueue(page) {
  await page.evaluate(() => {
    const clear = document.getElementById('btn-clear');
    if (clear) clear.click();
    window.__qaFileReads = [];
    window.__qaBlockAllReads = false;
  });
  assert.equal(await page.locator('.doc-card').count(), 0);
}

async function assertStillOperable(page, cleanFixture) {
  await resetQueue(page);
  await page.locator('#file-input').setInputFiles(fixturePath(cleanFixture));
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.doc-card'));
    return cards.length === 1 && !cards[0].textContent.includes('讀取解析中');
  }, null, { timeout: config.timeouts.scan });
  assert.equal(await page.locator('.risk-none').count(), 1, 'UI did not process a small file after rejection');
  await page.locator('#btn-clear').click();
  assert.equal(await page.locator('.doc-card').count(), 0, 'visible clear action stopped working');
}

function rejectionTextMatches(text, expectedLimitMb, batch) {
  if (!/(超過|上限|拒絕|過大)/.test(text)) return false;
  if (!text.includes(`${expectedLimitMb}MB`) && !text.includes(`${expectedLimitMb} MB`)) return false;
  return !batch || /(批次|總量|合計)/.test(text);
}

async function runCapacityTests() {
  const manifest = await generateFixtures();
  const browser = await chromium.launch(config.launchOptions);
  const results = [];

  async function test(name, body) {
    const session = await openInstrumentedApp(browser);
    try {
      await body(session.page);
      results.push({ name, status: 'passed' });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message });
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      await session.context.close();
    }
  }

  try {
    await test('八格式單檔超限於讀取前拒絕且介面可恢復', async page => {
      const boundary = manifest.fixtures.filter(fixture => fixture.category === 'boundary');
      const cleanPdf = manifest.fixtures.find(fixture => fixture.category === 'clean' && fixture.format === 'pdf');
      assert.equal(boundary.length, 8);
      assert.equal(boundary.filter(fixture => fixture.format === 'webp').length, 1, 'WebP boundary fixture is missing');
      const mismatches = [];

      for (const fixture of boundary) {
        await resetQueue(page);
        await page.locator('#file-input').setInputFiles(fixturePath(fixture));
        await page.waitForTimeout(50);
        const reads = await page.evaluate(() => window.__qaFileReads.slice());
        const bodyText = await page.locator('body').innerText();
        const cardText = await page.locator('.doc-card').allTextContents();
        const observed = `${bodyText}\n${cardText.join('\n')}`;

        if (reads.some(read => read.name === fixture.fileName)) {
          mismatches.push(`${fixture.format}: FileReader was invoked for ${fixture.expected.exactBytes} bytes`);
        }
        const limitMb = fixture.expected.limitBytes / (1024 * 1024);
        if (!rejectionTextMatches(observed, limitMb, false)) {
          mismatches.push(`${fixture.format}: no understandable ${limitMb}MB rejection message`);
        }
        if (cardText.some(text => text.includes('讀取解析中'))) {
          mismatches.push(`${fixture.format}: oversized file remained in loading state`);
        }
      }

      await assertStillOperable(page, cleanPdf);
      assert.deepEqual(mismatches, [], `Single-file limit failures:\n${mismatches.join('\n')}`);
    });

    await test('批次超過 100MB 於任何檔案讀取前拒絕且介面可恢復', async page => {
      const batch = manifest.fixtures.filter(fixture => fixture.category === 'batch-boundary');
      const cleanPdf = manifest.fixtures.find(fixture => fixture.category === 'clean' && fixture.format === 'pdf');
      const totalBytes = batch.reduce((sum, fixture) => sum + fs.statSync(fixturePath(fixture)).size, 0);
      assert.equal(batch.length, 6);
      assert.ok(totalBytes > 100 * 1024 * 1024);
      assert.ok(batch.every(fixture => fs.statSync(fixturePath(fixture)).size <= 20 * 1024 * 1024));

      await page.evaluate(() => {
        window.__qaFileReads = [];
        window.__qaBlockAllReads = true;
      });
      await page.locator('#file-input').setInputFiles(batch.map(fixturePath));
      await page.waitForTimeout(50);
      const reads = await page.evaluate(() => window.__qaFileReads.slice());
      const bodyText = await page.locator('body').innerText();
      const cardText = await page.locator('.doc-card').allTextContents();
      const mismatches = [];
      if (reads.length) mismatches.push(`FileReader was invoked ${reads.length} time(s) before batch rejection`);
      if (!rejectionTextMatches(`${bodyText}\n${cardText.join('\n')}`, 100, true)) {
        mismatches.push('no understandable batch-total 100MB rejection message');
      }
      if (cardText.some(text => text.includes('讀取解析中'))) mismatches.push('batch files remained in loading state');

      await assertStillOperable(page, cleanPdf);
      assert.deepEqual(mismatches, [], `Batch limit failures (${(totalBytes / 1024 / 1024).toFixed(1)}MB):\n${mismatches.join('\n')}`);
    });
  } finally {
    await browser.close();
  }

  const failures = results.filter(result => result.status === 'failed');
  console.log(`Capacity summary: ${results.length - failures.length}/${results.length} passed`);
  if (failures.length) {
    throw new Error(`Capacity test failures:\n${failures.map(f => `${f.name}: ${f.error}`).join('\n')}`);
  }
  return results;
}

if (require.main === module) {
  runCapacityTests().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { runCapacityTests };
