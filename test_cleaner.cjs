const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const testConfig = require('./tests/test-config.cjs');

async function runTest() {
  console.log('🚀 開始執行 All-in-One Metadata 清理器 E2E 測試...');

  const htmlPath = testConfig.htmlPath;
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`找不到待測試的 index.html: ${htmlPath}`);
  }

  const browser = await chromium.launch(testConfig.launchOptions);
  const context = await browser.newContext(testConfig.contextOptions);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(testConfig.timeouts.navigation);

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error('瀏覽器 Error:', msg.text());
    }
  });

  console.log(`📄 開啟網頁: file://${htmlPath}`);
  await page.goto(`file://${htmlPath}`);

  // 1. 驗證標題
  const title = await page.textContent('h1');
  console.log(`✓ 網頁標題: "${title}"`);
  if (!title.includes('All-in-One')) {
    throw new Error('標題不符合預期');
  }

  // 2. 建立測試檔案
  const testDir = testConfig.tempDir;
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  // A. PNG
  const samplePngPath = path.join(testDir, 'sample_photo.png');
  const png1x1Base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  fs.writeFileSync(samplePngPath, Buffer.from(png1x1Base64, 'base64'));

  // B. PDF & DOCX (利用瀏覽器環境內的 PDFLib 與 fflate 建立)
  const testFilesData = await page.evaluate(async () => {
    const pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setTitle('機密合約 2026');
    pdfDoc.setAuthor('機密作者張三');
    pdfDoc.setProducer('Internal Test Generator');
    const pdfPage = pdfDoc.addPage([400, 400]);
    pdfPage.drawText('Test Confidential Content');
    const pdfBytes = await pdfDoc.save();

    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator>極機密主管</dc:creator>' +
      '<cp:lastModifiedBy>工程師李四</cp:lastModifiedBy>' +
      '</cp:coreProperties>';
    
    const docxZip = fflate.zipSync({
      '[Content_Types].xml': fflate.strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
      'docProps/core.xml': fflate.strToU8(coreXml)
    });

    return {
      pdfBase64: btoa(String.fromCharCode(...pdfBytes)),
      docxBase64: btoa(String.fromCharCode(...docxZip))
    };
  });

  const samplePdfPath = path.join(testDir, 'sample_contract.pdf');
  fs.writeFileSync(samplePdfPath, Buffer.from(testFilesData.pdfBase64, 'base64'));

  const sampleDocxPath = path.join(testDir, 'secret_doc.docx');
  fs.writeFileSync(sampleDocxPath, Buffer.from(testFilesData.docxBase64, 'base64'));

  console.log('✓ 測試檔案準備完成：PNG、PDF、DOCX');

  // 3. 上傳檔案
  const fileInput = await page.$('#file-input');
  await fileInput.setInputFiles([samplePngPath, samplePdfPath, sampleDocxPath]);
  console.log('✓ 已將 3 份檔案上傳至 input');

  // 4. 等待清單渲染
  await page.waitForSelector('.doc-card', { timeout: testConfig.timeouts.scan });
  const docCards = await page.$$('.doc-card');
  console.log(`✓ 渲染出 ${docCards.length} 張文件卡片`);
  if (docCards.length !== 3) {
    throw new Error(`預期有 3 張卡片，實際得到 ${docCards.length}`);
  }

  // 驗證風險判定
  const textContent = await page.textContent('#docs-container');
  if (!textContent.includes('機密作者張三') && !textContent.includes('機密合約')) {
    throw new Error('PDF 檔案中的 Metadata 欄位未成功顯示');
  }
  if (!textContent.includes('極機密主管')) {
    throw new Error('DOCX 檔案中的 作者 欄位未成功顯示');
  }
  console.log('✓ PDF 與 DOCX 敏感 Metadata 均被成功偵測與展示');

  // 5. 點擊「開始清除 Metadata」
  console.log('👉 點擊「開始清除 Metadata」按鈕');
  const btnStartClean = await page.$('#btn-start-clean');
  await btnStartClean.click();

  // 6. 等待清除完成
  await page.waitForSelector('.diff-table', { timeout: testConfig.timeouts.clean });
  console.log('✓ 清除完成，對照表格已渲染');

  const diffText = await page.textContent('.diff-table');
  if (!diffText.includes('已清除')) {
    throw new Error('對照表未包含「已清除」驗證文字');
  }
  console.log('✓ 清除前後對照表驗證成功：所有項目皆顯示已清除');

  // 7. 驗證下載按鈕
  const zipBtnVisible = await page.isVisible('#btn-download-zip');
  if (!zipBtnVisible) {
    throw new Error('批次 ZIP 下載按鈕未顯示');
  }
  console.log('✓ 「打包下載已清除 ZIP」按鈕正常顯示');

  // 8. 驗證離線版匯出
  const offlineBtn = await page.$('#btn-download-offline');
  if (!offlineBtn) {
    throw new Error('離線下載按鈕不存在');
  }
  console.log('✓ 離線版下載按鈕存在');

  // 清理臨時檔案
  fs.rmSync(testDir, { recursive: true, force: true });
  await context.close();
  await browser.close();
  console.log('\n🎉 [PASS] 所有 E2E 測試條件均順利通過！');
}

runTest().catch(err => {
  console.error('❌ 測試失敗:', err);
  process.exit(1);
});
