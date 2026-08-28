const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('../../shared/vendor/fflate.umd.js');
const { PDFDocument, PDFName } = require('../../shared/vendor/cantoo-pdf-lib.min.js');
const config = require('./test-config.cjs');
const { SENSITIVE, generateFixtures } = require('./fixtures/generate-fixtures.cjs');

const downloadDir = path.join(config.resultsDir, 'clean-download');
const WEBP_METADATA_FLAGS = 0x08 | 0x04;

function fixturePath(fixture) {
  return path.join(config.fixturesDir, fixture.fileName);
}

function riskyFixtures(manifest) {
  return manifest.fixtures.filter(fixture => fixture.category === 'risky');
}

function outputExtension(format) {
  return format === 'jpeg' ? 'jpg' : format;
}

function expectedOutputName(fixture) {
  const base = fixture.fileName.replace(/\.[^/.]+$/, '');
  return `${base}_cleaned.${outputExtension(fixture.format)}`;
}

function parseWebpStructure(bytes, label) {
  const buffer = Buffer.from(bytes);
  assert.ok(buffer.length >= 20, `${label} is shorter than a valid WebP`);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', `${label} lacks RIFF magic`);
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WEBP', `${label} lacks WEBP magic`);
  const declaredEnd = buffer.readUInt32LE(4) + 8;
  assert.equal(declaredEnd, buffer.length, `${label} has a mismatched RIFF size`);

  const chunks = [];
  let offset = 12;
  while (offset < declaredEnd) {
    assert.ok(offset + 8 <= declaredEnd, `${label} has a truncated chunk header`);
    const fourcc = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length % 2);
    assert.ok(chunkEnd <= declaredEnd, `${label} has a truncated ${fourcc} chunk`);
    if (length % 2) assert.equal(buffer[dataEnd], 0, `${label} has invalid ${fourcc} padding`);
    chunks.push({ fourcc, data: Buffer.from(buffer.subarray(dataStart, dataEnd)) });
    offset = chunkEnd;
  }
  assert.equal(offset, declaredEnd, `${label} chunks do not fill the RIFF body`);

  const vp8xChunk = chunks.find(chunk => chunk.fourcc === 'VP8X');
  const vp8x = vp8xChunk ? {
    flags: vp8xChunk.data[0],
    width: vp8xChunk.data.readUIntLE(4, 3) + 1,
    height: vp8xChunk.data.readUIntLE(7, 3) + 1
  } : null;
  return { chunks, vp8x };
}

function webpPrivacyMismatches(bytes, originalBytes, label) {
  const mismatches = [];
  let cleaned;
  let original;
  try {
    cleaned = parseWebpStructure(bytes, label);
    original = parseWebpStructure(originalBytes, `${label}/source`);
  } catch (error) {
    return [error.message];
  }

  const cleanedNames = cleaned.chunks.map(chunk => chunk.fourcc);
  if (cleanedNames.includes('EXIF')) mismatches.push(`${label} retains WebP EXIF`);
  if (cleanedNames.includes('XMP ')) mismatches.push(`${label} retains WebP XMP`);
  if (!cleaned.vp8x) mismatches.push(`${label} lost VP8X canvas information`);
  if (cleaned.vp8x && (cleaned.vp8x.flags & WEBP_METADATA_FLAGS)) mismatches.push(`${label} retains VP8X EXIF/XMP flags`);
  if (cleaned.vp8x && original.vp8x &&
      (cleaned.vp8x.width !== original.vp8x.width || cleaned.vp8x.height !== original.vp8x.height)) {
    mismatches.push(`${label} changed WebP canvas dimensions`);
  }

  const expectedChunks = original.chunks.filter(chunk => chunk.fourcc !== 'EXIF' && chunk.fourcc !== 'XMP ');
  if (JSON.stringify(cleanedNames) !== JSON.stringify(expectedChunks.map(chunk => chunk.fourcc))) {
    mismatches.push(`${label} changed non-private WebP chunk order`);
    return mismatches;
  }
  expectedChunks.forEach((sourceChunk, index) => {
    const expectedData = Buffer.from(sourceChunk.data);
    if (sourceChunk.fourcc === 'VP8X') expectedData[0] &= ~WEBP_METADATA_FLAGS;
    if (!cleaned.chunks[index].data.equals(expectedData)) {
      mismatches.push(`${label} changed ${sourceChunk.fourcc} image/non-private payload`);
    }
  });
  return mismatches;
}

async function waitForCards(page, expectedCount) {
  await page.waitForFunction(count => {
    const cards = Array.from(document.querySelectorAll('.doc-card'));
    return cards.length === count && cards.every(card => !card.textContent.includes('讀取解析中'));
  }, expectedCount, { timeout: config.timeouts.scan });
}

async function cleanAll(page, fixtures) {
  await page.locator('#file-input').setInputFiles(fixtures.map(fixturePath));
  await waitForCards(page, fixtures.length);
  await page.locator('#btn-start-clean').click();
  await page.waitForFunction(count => document.querySelectorAll('.btn-download-one').length === count,
    fixtures.length, { timeout: config.timeouts.clean });
}

async function saveDownload(page, trigger, targetPath) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    trigger.click()
  ]);
  const failure = await download.failure();
  assert.equal(failure, null, `Download failed: ${failure}`);
  await download.saveAs(targetPath);
  return download.suggestedFilename();
}

function officeMainPart(format) {
  if (format === 'docx') return 'word/document.xml';
  if (format === 'xlsx') return 'xl/workbook.xml';
  return 'ppt/slides/slide1.xml';
}

async function assertStructurallyOpen(page, format, bytes, label) {
  if (format === 'jpg' || format === 'jpeg' || format === 'png' || format === 'webp') {
    const decoded = await page.evaluate(async ({ data, mime }) => {
      const blob = new Blob([new Uint8Array(data)], { type: mime });
      try {
        const bitmap = await createImageBitmap(blob);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      } catch (error) {
        return { error: error.message };
      }
    }, { data: [...bytes], mime: format === 'png' ? 'image/png' : (format === 'webp' ? 'image/webp' : 'image/jpeg') });
    assert.ok(!decoded.error && decoded.width > 0 && decoded.height > 0, `${label} cannot be decoded: ${decoded.error || 'zero dimensions'}`);
  } else if (format === 'pdf') {
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1, `${label} lost its PDF page`);
  } else {
    const entries = unzipSync(bytes);
    const mainPart = officeMainPart(format);
    assert.ok(entries['[Content_Types].xml'], `${label} lacks [Content_Types].xml`);
    assert.ok(entries[mainPart], `${label} lacks ${mainPart}`);
    assert.match(strFromU8(entries[mainPart]), /^<\?xml[^>]*>/, `${label} main XML is not readable`);
  }
}

async function privacyMismatches(format, bytes, label, originalBytes) {
  const mismatches = [];
  if (format === 'jpg' || format === 'jpeg') {
    if (bytes.includes(Buffer.from('Exif\0\0', 'binary'))) mismatches.push(`${label} retains EXIF APP1`);
    if (bytes.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))) mismatches.push(`${label} retains XMP APP1`);
  } else if (format === 'png') {
    if (bytes.includes(Buffer.from('eXIf'))) mismatches.push(`${label} retains PNG eXIf`);
    if (bytes.includes(Buffer.from('XML:com.adobe.xmp'))) mismatches.push(`${label} retains PNG XMP`);
  } else if (format === 'webp') {
    mismatches.push(...webpPrivacyMismatches(bytes, originalBytes, label));
  } else if (format === 'pdf') {
    const doc = await PDFDocument.load(bytes);
    if (doc.getAuthor()) mismatches.push(`${label} retains PDF author ${JSON.stringify(doc.getAuthor())}`);
    if (doc.getTitle()) mismatches.push(`${label} retains PDF title ${JSON.stringify(doc.getTitle())}`);
    if (doc.getSubject()) mismatches.push(`${label} retains PDF subject ${JSON.stringify(doc.getSubject())}`);
    if (doc.catalog.has(PDFName.of('Metadata'))) mismatches.push(`${label} retains PDF XMP Metadata stream`);
  } else {
    const entries = unzipSync(bytes);
    const core = entries['docProps/core.xml'] ? strFromU8(entries['docProps/core.xml']) : '';
    const app = entries['docProps/app.xml'] ? strFromU8(entries['docProps/app.xml']) : '';
    if (core.includes(SENSITIVE.author)) mismatches.push(`${label} retains core author`);
    if (app.includes(SENSITIVE.company)) mismatches.push(`${label} retains company`);
    if (entries['docProps/custom.xml']) mismatches.push(`${label} retains custom properties`);
    if (entries['docProps/thumbnail.jpeg']) mismatches.push(`${label} retains embedded thumbnail`);

    if (format === 'docx') {
      if (entries['word/comments.xml']) mismatches.push(`${label} retains comments.xml`);
      const rels = entries['word/_rels/document.xml.rels'] ? strFromU8(entries['word/_rels/document.xml.rels']) : '';
      if (/Target="file:\/\//i.test(rels)) mismatches.push(`${label} retains local-path relationship`);
    } else if (format === 'xlsx') {
      const names = Object.keys(entries);
      if (names.some(name => name.startsWith('xl/pivotCache/'))) mismatches.push(`${label} retains pivot cache`);
      if (names.some(name => name.startsWith('xl/externalLinks/'))) mismatches.push(`${label} retains external links`);
    } else if (format === 'pptx') {
      const names = Object.keys(entries);
      if (names.some(name => name.startsWith('ppt/notesSlides/'))) mismatches.push(`${label} retains speaker notes`);
      const slide = entries['ppt/slides/slide1.xml'] ? strFromU8(entries['ppt/slides/slide1.xml']) : '';
      if (slide.includes('srcRect')) mismatches.push(`${label} retains crop-only display metadata`);
    }
  }
  return mismatches;
}

async function installBlobTypeProbe(page) {
  await page.evaluate(() => {
    const NativeBlob = globalThis.Blob;
    globalThis.__qaBlobTypes = [];
    globalThis.Blob = class QaBlob extends NativeBlob {
      constructor(parts, options) {
        super(parts, options);
        globalThis.__qaBlobTypes.push(this.type);
      }
    };
  });
}

async function openApp(browser, htmlPath = config.htmlPath) {
  const context = await browser.newContext(config.contextOptions);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.timeouts.navigation);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href);
  return { context, page, pageErrors };
}

async function runCleanDownloadTests() {
  const manifest = await generateFixtures();
  const fixtures = riskyFixtures(manifest);
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const browser = await chromium.launch(config.launchOptions);
  const results = [];
  const singleOutputs = new Map();

  async function withTimeout(promise, name, timeoutMs = 45000) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs} ms`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function test(name, body) {
    const session = await openApp(browser);
    try {
      await withTimeout(body(session.page), name);
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
    await test('八格式清除狀態、單檔下載與產物可解析性', async page => {
      await cleanAll(page, fixtures);
      assert.equal(await page.locator('.diff-table').count(), 8);
      assert.equal(await page.locator('.btn-download-one').count(), 8);
      assert.equal(await page.locator('.doc-card .risk-med').filter({ hasText: '無法處理' }).count(), 0);
      await installBlobTypeProbe(page);

      for (const fixture of fixtures) {
        const card = page.locator('.doc-card').filter({ hasText: fixture.fileName });
        const outputName = expectedOutputName(fixture);
        const outputPath = path.join(downloadDir, outputName);
        const suggested = await saveDownload(page, card.locator('.btn-download-one'), outputPath);
        assert.equal(suggested, outputName);
        if (fixture.format === 'webp') {
          const blobTypes = await page.evaluate(() => globalThis.__qaBlobTypes);
          assert.equal(blobTypes.at(-1), 'image/webp', 'WebP download Blob has the wrong MIME type');
        }
        const bytes = fs.readFileSync(outputPath);
        await assertStructurallyOpen(page, fixture.format, bytes, outputName);
        singleOutputs.set(fixture.fileName, { fixture, outputName, bytes });
      }
    });

    await test('八格式清除後由獨立解析器複驗隱私資料', async () => {
      assert.equal(singleOutputs.size, 8, 'Single-download outputs are incomplete');
      const mismatches = [];
      for (const { fixture, outputName, bytes } of singleOutputs.values()) {
        mismatches.push(...await privacyMismatches(fixture.format, bytes, outputName, fs.readFileSync(fixturePath(fixture))));
      }
      assert.deepEqual(mismatches, [], `Privacy verification failures:\n${mismatches.join('\n')}`);
    });

    await test('批次 ZIP 含八份可解析且無隱私 Metadata 的清除產物', async page => {
      await cleanAll(page, fixtures);
      const zipPath = path.join(downloadDir, 'cleaned_privacy_documents.zip');
      const suggested = await saveDownload(page, page.locator('#btn-download-zip'), zipPath);
      assert.equal(suggested, 'cleaned_privacy_documents.zip');
      const outer = unzipSync(fs.readFileSync(zipPath));
      const expectedNames = fixtures.map(expectedOutputName).sort();
      assert.deepEqual(Object.keys(outer).sort(), expectedNames);
      const mismatches = [];
      for (const fixture of fixtures) {
        const outputName = expectedOutputName(fixture);
        const bytes = Buffer.from(outer[outputName]);
        await assertStructurallyOpen(page, fixture.format, bytes, `ZIP/${outputName}`);
        mismatches.push(...await privacyMismatches(fixture.format, bytes, `ZIP/${outputName}`, fs.readFileSync(fixturePath(fixture))));
      }
      assert.deepEqual(mismatches, [], `ZIP privacy verification failures:\n${mismatches.join('\n')}`);
    });

    await test('離線 HTML 不帶處理快取且可重新處理已下載 WebP', async page => {
      const webpFixture = fixtures.find(fixture => fixture.format === 'webp');
      const webpOutput = singleOutputs.get(webpFixture.fileName);
      assert.ok(webpOutput, 'Downloaded WebP output is unavailable');
      console.log('STEP offline: clean source WebP');
      await cleanAll(page, [webpFixture]);
      const offlinePath = path.join(downloadDir, 'all-in-one-cleaner-offline.html');
      console.log('STEP offline: download HTML');
      const suggested = await saveDownload(page, page.locator('#btn-download-offline'), offlinePath);
      assert.equal(suggested, 'all-in-one-cleaner-offline.html');

      console.log('STEP offline: inspect exported source');
      const exportedHtml = fs.readFileSync(offlinePath, 'utf8');
      const mismatches = [];
      if (exportedHtml.includes(webpFixture.fileName)) mismatches.push('offline HTML retains processed filename');
      if (exportedHtml.includes('QA Camera')) mismatches.push('offline HTML retains WebP device metadata in rendered DOM');

      console.log('STEP offline: reopen exported HTML');
      await page.goto(pathToFileURL(offlinePath).href);
      const staleCards = await page.locator('.doc-card').count();
      if (staleCards !== 0) mismatches.push(`offline HTML reopens with ${staleCards} stale document card(s)`);

      console.log('STEP offline: rerun downloaded WebP cleaning');
      await page.locator('#file-input').setInputFiles(path.join(downloadDir, webpOutput.outputName));
      await waitForCards(page, 1);
      assert.equal(await page.locator('.risk-none').count(), 1, 'downloaded cleaned WebP is not metadata-free when reopened');
      await page.locator('#btn-start-clean').click();
      await page.waitForFunction(() => document.querySelectorAll('.btn-download-one').length === 1,
        null, { timeout: config.timeouts.clean });
      assert.equal(await page.locator('.diff-table').count(), 1, 'exported offline HTML cannot rerun cleaning');
      console.log('STEP offline: rerun complete');
      assert.deepEqual(mismatches, [], `Offline export failures:\n${mismatches.join('\n')}`);
    });
  } finally {
    await browser.close();
  }

  const failures = results.filter(result => result.status === 'failed');
  console.log(`Clean/download summary: ${results.length - failures.length}/${results.length} passed`);
  if (failures.length) {
    throw new Error(`Clean/download test failures:\n${failures.map(f => `${f.name}: ${f.error}`).join('\n')}`);
  }
  return results;
}

if (require.main === module) {
  runCleanDownloadTests().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { runCleanDownloadTests };
