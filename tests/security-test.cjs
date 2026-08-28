const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('../../shared/vendor/fflate.umd.js');
const { PDFDocument, PDFName } = require('../../shared/vendor/cantoo-pdf-lib.min.js');
const config = require('./test-config.cjs');
const { generateFixtures } = require('./fixtures/generate-fixtures.cjs');

const outDir = path.join(config.resultsDir, 'security');
const fp = f => path.join(config.fixturesDir, f.fileName);
const waitSettled = page => page.waitForFunction(() => [...document.querySelectorAll('.doc-card')].every(c => !c.textContent.includes('讀取解析中')), null, { timeout: config.timeouts.scan });

function safeDownloadName(name) {
  return !!name && !/[\\/\0-\x1f]/.test(name) && !name.includes('..') && !/^[A-Za-z]:/.test(name);
}

function webpMetadataMismatches(name, bytes) {
  const mismatches = [];
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return [`${name} is not a valid RIFF/WEBP file`];
  }
  const declaredEnd = bytes.readUInt32LE(4) + 8;
  if (declaredEnd !== bytes.length) return [`${name} has a mismatched RIFF size`];
  let offset = 12;
  let hasImage = false;
  while (offset < declaredEnd) {
    if (offset + 8 > declaredEnd) return [`${name} has a truncated WebP chunk header`];
    const fourcc = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + (length % 2);
    if (chunkEnd > declaredEnd) return [`${name} has a truncated ${fourcc} chunk`];
    if (fourcc === 'EXIF' || fourcc === 'XMP ') mismatches.push(`${name} retains WebP ${fourcc.trim()}`);
    if (fourcc === 'VP8X' && length > 0 && (bytes[dataStart] & 0x0c)) mismatches.push(`${name} retains VP8X EXIF/XMP flags`);
    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') hasImage = true;
    offset = chunkEnd;
  }
  if (!hasImage) mismatches.push(`${name} lacks WebP image data`);
  return mismatches;
}

async function outputMismatches(name, bytes) {
  const mismatches = [];
  if (/\.jpe?g$/i.test(name)) {
    if (bytes.includes(Buffer.from('Exif\0\0', 'binary'))) mismatches.push(`${name} retains EXIF`);
    if (bytes.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))) mismatches.push(`${name} retains XMP`);
  } else if (/\.png$/i.test(name)) {
    if (bytes.includes(Buffer.from('eXIf'))) mismatches.push(`${name} retains PNG EXIF`);
    if (bytes.includes(Buffer.from('XML:com.adobe.xmp'))) mismatches.push(`${name} retains PNG XMP`);
  } else if (/\.webp$/i.test(name)) {
    mismatches.push(...webpMetadataMismatches(name, bytes));
  } else if (/\.pdf$/i.test(name)) {
    const doc = await PDFDocument.load(bytes);
    if (doc.getAuthor() || doc.getTitle() || doc.getSubject() || doc.catalog.has(PDFName.of('Metadata'))) mismatches.push(`${name} retains PDF metadata`);
  } else {
    const inner = unzipSync(bytes);
    const core = inner['docProps/core.xml'] ? strFromU8(inner['docProps/core.xml']) : '';
    const app = inner['docProps/app.xml'] ? strFromU8(inner['docProps/app.xml']) : '';
    if (/QA_SECRET_AUTHOR|QA_SECRET_LAST_EDITOR/.test(core)) mismatches.push(`${name} retains sensitive core properties`);
    if (app.includes('QA_SECRET_COMPANY')) mismatches.push(`${name} retains sensitive application properties`);
    if (Object.keys(inner).some(n => /comments\.xml|pivotCache|externalLinks|notesSlides|docProps\/custom\.xml|docProps\/thumbnail/i.test(n))) {
      mismatches.push(`${name} retains a privacy-sensitive Office part`);
    }
    const relText = Object.entries(inner).filter(([n]) => /\.rels$/i.test(n)).map(([, value]) => strFromU8(value)).join('\n');
    if (/Target=["']file:\/\//i.test(relText)) mismatches.push(`${name} retains a local-path relationship`);
  }
  return mismatches;
}

async function session(browser) {
  const context = await browser.newContext(config.contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeouts.scan);
  await page.goto(pathToFileURL(config.htmlPath).href);
  return { context, page };
}

async function runSecurityTests() {
  const manifest = await generateFixtures();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(config.launchOptions);
  const results = [];
  async function check(name, fn) {
    try { const evidence = await fn(); results.push({ name, status: 'passed', evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, status: 'failed', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  try {
    await check('XSS payloads are inert and processing is offline', async () => {
      const { context, page } = await session(browser); const external = []; let dialog = false;
      page.on('request', r => { if (/^(https?|wss?):/i.test(r.url())) external.push(r.url()); });
      page.on('dialog', async d => { dialog = true; await d.dismiss(); });
      await page.evaluate(() => { window.__fixtureXss = false; });
      const files = manifest.fixtures.filter(f => f.category === 'malicious');
      assert.equal(files.length, 8, 'XSS fixtures must cover eight extensions');
      assert.equal(files.filter(file => file.format === 'webp').length, 1, 'WebP XSS fixture is missing');
      await page.locator('#file-input').setInputFiles(files.map(fp)); await waitSettled(page);
      await page.locator('#btn-start-clean').click();
      await page.waitForFunction(count => document.querySelectorAll('.btn-download-one').length === count,
        files.length, { timeout: config.timeouts.clean });
      const state = await page.evaluate(() => ({ xss: window.__fixtureXss, raw: document.body.innerHTML.includes('<img src=x onerror'), escaped: document.body.innerHTML.includes('&lt;img') }));
      const downloadNames = [];
      const one = page.locator('.btn-download-one');
      for (let i = 0; i < await one.count(); i++) {
        const [download] = await Promise.all([page.waitForEvent('download'), one.nth(i).click()]);
        downloadNames.push(download.suggestedFilename());
      }
      assert.equal(downloadNames.length, files.length, 'single-download coverage is incomplete');
      assert.ok(downloadNames.every(safeDownloadName), `unsafe single-download name: ${downloadNames.join(', ')}`);
      assert.equal(downloadNames.filter(name => /_cleaned\.webp$/i.test(name)).length, 1, 'safe WebP download name is missing');
      assert.equal(state.xss, false); assert.equal(state.raw, false); assert.equal(dialog, false); assert.equal(external.length, 0); assert.ok(state.escaped);
      await context.close(); return { files: files.length, external, downloadNames };
    });
    await check('malformed, encrypted and archive attacks do not crash the page', async () => {
      const { context, page } = await session(browser); const errors = []; page.on('pageerror', e => errors.push(e.message));
      const files = manifest.fixtures.filter(f => f.category === 'malicious-extra');
      await page.locator('#file-input').setInputFiles(files.map(fp)); await waitSettled(page);
      const texts = await page.locator('.doc-card').allTextContents();
      assert.equal(errors.length, 0, errors.join('; '));
      const unsafe = texts.filter(t => /格式偽裝|path|bomb|壓縮/.test(t) && /無明顯風險/.test(t));
      assert.equal(unsafe.length, 0, `unsafe inputs accepted as clean: ${unsafe.join(' | ')}`);
      await context.close(); return { files: files.length, cards: texts.length };
    });
    await check('cleaned archive has no traversal names or sensitive markers', async () => {
      const { context, page } = await session(browser); const files = manifest.fixtures.filter(f => f.category === 'risky');
      await page.locator('#file-input').setInputFiles(files.map(fp)); await waitSettled(page); await page.locator('#btn-start-clean').click();
      await page.locator('#download-actions').waitFor({ state: 'visible', timeout: config.timeouts.scan });
      await page.locator('.btn-download-one').first().waitFor({ state: 'visible', timeout: config.timeouts.clean });
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download-zip').click()]);
      const zipPath = path.join(outDir, 'batch.zip'); await download.saveAs(zipPath);
      assert.ok(safeDownloadName(download.suggestedFilename()), `unsafe ZIP download name: ${download.suggestedFilename()}`);
      const archive = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      const entries = Object.keys(archive);
      assert.equal(entries.length, 8, 'cleaned ZIP must cover eight extensions');
      assert.equal(entries.filter(name => /\.webp$/i.test(name)).length, 1, 'cleaned ZIP lacks WebP output');
      assert.ok(entries.every(safeDownloadName), `unsafe ZIP entry: ${entries.join(', ')}`);
      const mismatches = [];
      for (const name of entries) mismatches.push(...await outputMismatches(name, Buffer.from(archive[name])));
      assert.deepEqual(mismatches, [], `cleaned output failures:\n${mismatches.join('\n')}`);
      await context.close(); return { entries: entries.length, names: entries };
    });
  } finally { await browser.close(); }
  const report = { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform }, results };
  fs.writeFileSync(path.join(outDir, 'security-results.json'), JSON.stringify(report, null, 2));
  const failures = results.filter(r => r.status === 'failed'); console.log(`Security summary: ${results.length - failures.length}/${results.length} passed`);
  if (failures.length) throw new Error(`Security test failures:\n${failures.map(f => `${f.name}: ${f.error}`).join('\n')}`);
  return report;
}
if (require.main === module) runSecurityTests().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { runSecurityTests };
