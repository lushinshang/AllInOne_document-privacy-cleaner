const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const config = require('./test-config.cjs');
const { FORMATS, SENSITIVE, generateFixtures } = require('./fixtures/generate-fixtures.cjs');

function fixturePath(fixture) {
  return path.join(config.fixturesDir, fixture.fileName);
}

function selectFixtures(manifest, category) {
  return manifest.fixtures.filter(fixture => fixture.category === category && !fixture.expected.variant);
}

function selectVariant(manifest, variant, format) {
  const fixture = manifest.fixtures.find(item => item.expected.variant === variant && (!format || item.format === format));
  assert.ok(fixture, `Missing ${variant}/${format || '*'} fixture`);
  return fixture;
}

async function waitForCards(page, expectedCount) {
  await page.waitForFunction(count => {
    const cards = Array.from(document.querySelectorAll('.doc-card'));
    return cards.length === count && cards.every(card => !card.textContent.includes('讀取解析中'));
  }, expectedCount, { timeout: config.timeouts.scan });
}

async function openApp(browser) {
  const context = await browser.newContext(config.contextOptions);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.timeouts.navigation);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(config.htmlPath).href);
  return { context, page, pageErrors };
}

async function runFunctionalTests() {
  const manifest = await generateFixtures();
  const browser = await chromium.launch(config.launchOptions);
  const results = [];

  async function test(name, body) {
    const session = await openApp(browser);
    try {
      await body(session.page, session.pageErrors);
      assert.deepEqual(session.pageErrors, [], `Unexpected page errors: ${session.pageErrors.join('; ')}`);
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
    await test('單一 HTML 啟動與八格式輸入宣告', async page => {
      assert.match(await page.locator('h1').textContent(), /All-in-One/);
      const accepted = (await page.locator('#file-input').getAttribute('accept')).split(',').sort();
      assert.deepEqual(accepted, ['.docx', '.jpeg', '.jpg', '.pdf', '.png', '.pptx', '.webp', '.xlsx']);
      assert.equal(await page.locator('#clean-options-card').isVisible(), false);
      assert.equal(await page.locator('#results-section').isVisible(), false);
    });

    await test('八格式混合批次辨識、Metadata 與風險分級', async page => {
      const risky = selectFixtures(manifest, 'risky');
      assert.deepEqual(risky.map(f => f.format).sort(), [...FORMATS].sort());
      await page.locator('#file-input').setInputFiles(risky.map(fixturePath));
      await waitForCards(page, risky.length);

      const mismatches = [];
      function expectMatch(value, pattern, message) {
        if (!pattern.test(value)) mismatches.push(`${message}; actual=${JSON.stringify(value)}`);
      }

      assert.equal(await page.locator('.doc-card').count(), 8);
      const cardTexts = await page.locator('.doc-card').allTextContents();
      const highCount = await page.locator('.risk-high').count();
      const mediumCount = await page.locator('.risk-med').count();
      if (highCount !== 7) mismatches.push(`expected 7 high-risk cards, got ${highCount}`);
      if (mediumCount !== 1) mismatches.push(`expected 1 medium-risk card, got ${mediumCount}`);
      assert.match(await page.locator('#plan-stats-text').textContent(), /即將清除：8 份，保留原樣：0 份/);

      for (const fixture of risky) {
        const card = page.locator('.doc-card').filter({ hasText: fixture.fileName });
        const count = await card.count();
        if (count !== 1) {
          mismatches.push(`${fixture.format} was not routed to exactly one document card; got ${count}`);
          continue;
        }
        const cardText = await card.textContent();
        if (['jpg', 'jpeg', 'png', 'webp'].includes(fixture.format)) {
          expectMatch(cardText, /高風險.*GPS座標/, `${fixture.format} should be high risk with GPS`);
          expectMatch(cardText, /25\.0333, 121\.5667/, `${fixture.format} should expose synthetic coordinates`);
        } else if (fixture.format === 'pdf') {
          expectMatch(cardText, /中風險.*文件屬性/, 'PDF should be medium risk');
          if (!cardText.includes(SENSITIVE.author)) mismatches.push('PDF author marker is missing');
        } else if (fixture.format === 'docx') {
          expectMatch(cardText, /高風險.*作者/, 'DOCX should be high risk');
          expectMatch(cardText, /註解數量：1/, 'DOCX comment count is missing');
        } else if (fixture.format === 'xlsx') {
          expectMatch(cardText, /高風險.*樞紐分析表快取/, 'XLSX should be high risk');
          expectMatch(cardText, /樞紐分析表快取：1/, 'XLSX pivot cache count is missing');
        } else if (fixture.format === 'pptx') {
          expectMatch(cardText, /高風險.*講者備忘稿/, 'PPTX should be high risk');
          expectMatch(cardText, /講者備忘稿：1/, 'PPTX speaker note count is missing');
        }
      }

      assert.deepEqual(mismatches, [], `Risk mismatches:\n${mismatches.join('\n')}\nCards: ${JSON.stringify(cardTexts)}`);
    });

    await test('混合批次選取、取消選取與清空', async page => {
      const risky = selectFixtures(manifest, 'risky');
      await page.locator('#file-input').setInputFiles(risky.map(fixturePath));
      await waitForCards(page, risky.length);
      const toggles = page.locator('.chk-item-process');
      assert.equal(await toggles.count(), 8);
      await toggles.first().uncheck();
      assert.match(await page.locator('#plan-stats-text').textContent(), /即將清除：7 份，保留原樣：1 份/);
      await toggles.first().check();
      assert.match(await page.locator('#plan-stats-text').textContent(), /即將清除：8 份，保留原樣：0 份/);

      await page.locator('#btn-clear').click();
      assert.equal(await page.locator('.doc-card').count(), 0);
      assert.equal(await page.locator('#doc-count').textContent(), '0');
      assert.equal(await page.locator('#results-section').isVisible(), false);
    });

    await test('八格式乾淨檔均判定無明顯風險', async page => {
      const clean = selectFixtures(manifest, 'clean');
      await page.locator('#file-input').setInputFiles(clean.map(fixturePath));
      await waitForCards(page, clean.length);
      assert.equal(await page.locator('.risk-none').count(), 8);
      assert.equal(await page.locator('.risk-high, .risk-med, .risk-low').count(), 0);
      const text = await page.locator('#docs-container').textContent();
      assert.equal((text.match(/無明顯風險/g) || []).length, 8);
    });

    await test('不支援、損毀與加密輸入提供明確錯誤', async page => {
      await page.locator('#file-input').setInputFiles({
        name: 'unsupported.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('unsupported')
      });
      const toast = page.locator('#__shared_toast');
      await toast.waitFor({ state: 'visible' });
      assert.match(await toast.textContent(), /不支援的檔案格式: unsupported\.txt/);

      const badPdf = selectVariant(manifest, 'malformed', 'pdf');
      const badDocx = selectVariant(manifest, 'malformed', 'docx');
      const badWebp = selectVariant(manifest, 'malformed', 'webp');
      const encryptedDocx = selectVariant(manifest, 'encrypted-office', 'docx');
      await page.locator('#file-input').setInputFiles([badPdf, badDocx, badWebp, encryptedDocx].map(fixturePath));
      await waitForCards(page, 4);

      const text = await page.locator('#docs-container').textContent();
      assert.equal(await page.locator('.doc-card .risk-med').count(), 4);
      assert.ok(text.includes('PDF 檔案解析失敗或有密碼保護'));
      assert.ok(text.includes('此檔案可能已損毀，或不是合法的 DOCX 格式'));
      assert.ok(text.includes('此檔案可能已損毀，或不是合法的 WEBP 格式'));
      assert.ok(text.includes('此檔案有密碼保護，請先在 Office 解除保護後再上傳'));
    });
  } finally {
    await browser.close();
  }

  const failures = results.filter(result => result.status === 'failed');
  console.log(`Functional summary: ${results.length - failures.length}/${results.length} passed`);
  if (failures.length) {
    const details = failures.map(failure => `${failure.name}: ${failure.error}`).join('\n');
    throw new Error(`Functional test failures:\n${details}`);
  }
  return results;
}

if (require.main === module) {
  runFunctionalTests().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { runFunctionalTests };
