(function () {
  'use strict';

  var state = {
    items: [], // Array<{ id, file, format, bytes, entries, before, cleanedBytes, cleanedEntries, cleanedBefore, status: 'loading'|'scanned'|'cleaned'|'skipped'|'error'|'encrypted', process: boolean, errorMessage?: string, skipReason?: string, pptxSkippedMedia?: any[] }>
    cleaned: false
  };

  var dropZone = document.getElementById('drop-zone');
  var fileInput = document.getElementById('file-input');
  var btnSelectFiles = document.getElementById('btn-select-files');
  var cleanOptionsCard = document.getElementById('clean-options-card');
  var planStatsText = document.getElementById('plan-stats-text');
  var btnStartClean = document.getElementById('btn-start-clean');
  var btnClear = document.getElementById('btn-clear');
  var resultsSection = document.getElementById('results-section');
  var docCount = document.getElementById('doc-count');
  var docsContainer = document.getElementById('docs-container');
  var downloadActions = document.getElementById('download-actions');
  var btnDownloadZip = document.getElementById('btn-download-zip');
  var btnCopySummary = document.getElementById('btn-copy-summary');
  var btnDownloadOffline = document.getElementById('btn-download-offline');

  var nextId = 1;

  var MIME_BY_FORMAT = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };

  var FILE_LIMIT_BYTES = 20 * 1024 * 1024;
  var PDF_LIMIT_BYTES = 50 * 1024 * 1024;
  var BATCH_LIMIT_BYTES = 100 * 1024 * 1024;

  function detectFormat(filename) {
    if (/\.(jpe?g)$/i.test(filename)) return 'jpg';
    if (/\.png$/i.test(filename)) return 'png';
    if (/\.webp$/i.test(filename)) return 'webp';
    if (/\.pdf$/i.test(filename)) return 'pdf';
    if (/\.docx$/i.test(filename)) return 'docx';
    if (/\.xlsx$/i.test(filename)) return 'xlsx';
    if (/\.pptx$/i.test(filename)) return 'pptx';
    return null;
  }

  function isImageFormat(format) {
    return format === 'jpg' || format === 'png' || format === 'webp';
  }

  // 圖片共用模組刻意只接受 ArrayBuffer；FileReader 後的整合層則以
  // Uint8Array 保存檔案。轉換時依 view 的實際範圍複製，避免把同一個
  // backing buffer 中不屬於檔案的前後位元組一起交給解析器。
  function imageArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    if (bytes && bytes.buffer instanceof ArrayBuffer) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    throw new TypeError('圖片資料必須是 ArrayBuffer 或 Uint8Array');
  }

  function isValidWebpBytes(bytes) {
    var arrayBuffer = imageArrayBuffer(bytes);
    if (arrayBuffer.byteLength < 20) return false;
    var view = new DataView(arrayBuffer);
    if (view.getUint32(0, false) !== 0x52494646 || // RIFF
        view.getUint32(8, false) !== 0x57454250) { // WEBP
      return false;
    }

    var declaredEnd = view.getUint32(4, true) + 8;
    if (declaredEnd < 20 || declaredEnd > arrayBuffer.byteLength) return false;
    var offset = 12;
    var hasImageData = false;
    while (offset < declaredEnd) {
      if (offset + 8 > declaredEnd) return false;
      var fourcc = view.getUint32(offset, false);
      var dataLength = view.getUint32(offset + 4, true);
      var chunkEnd = offset + 8 + dataLength + (dataLength % 2);
      if (chunkEnd > declaredEnd) return false;
      if (fourcc === 0x56503820 || // VP8 
          fourcc === 0x5650384c || // VP8L
          fourcc === 0x414e4d46) { // ANMF
        hasImageData = true;
      }
      offset = chunkEnd;
    }
    return offset === declaredEnd && hasImageData;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function fieldLine(label, value) {
    var valStr = (value == null || value === '' || (Array.isArray(value) && value.length === 0)) ? '無' : value;
    return '<div><strong>' + escapeHtml(label) + '：</strong>' + escapeHtml(String(valStr)) + '</div>';
  }

  function _riskResult(level, reasons) {
    if (level === 'none' || !reasons.length) return { level: 'none', label: '🟢 無明顯風險', cls: 'risk-none' };
    var icon = level === 'high' ? '🔴' : (level === 'med' ? '🟡' : '🔵');
    var text = level === 'high' ? '高風險' : (level === 'med' ? '中風險' : '低風險');
    return { level: level, label: icon + ' ' + text + '（含' + reasons.join('/') + '）', cls: 'risk-' + level };
  }

  // --- PDF 解析輔助 ---
  function scanPdfDoc(doc) {
    var res = {
      metadata: { count: 0, items: [], details: {} },
      links: { count: 0, items: [] },
      comments: { count: 0, items: [] },
      forms: { count: 0, items: [] },
      attachments: { count: 0, items: [] },
      actions: { count: 0, items: [] }
    };

    var title = doc.getTitle() || '';
    var author = doc.getAuthor() || '';
    var subject = doc.getSubject() || '';
    var creator = doc.getCreator() || '';
    var producer = doc.getProducer() || '';
    var hasXmp = doc.catalog.has(PDFLib.PDFName.of('Metadata'));

    res.metadata.details = {
      title: title,
      author: author,
      subject: subject,
      creator: creator,
      producer: producer,
      hasXmp: hasXmp
    };

    if (title.trim()) res.metadata.items.push('標題: ' + title);
    if (author.trim()) res.metadata.items.push('作者: ' + author);
    if (subject.trim()) res.metadata.items.push('主旨: ' + subject);
    if (creator.trim() && creator !== 'pdf-lib (https://github.com/Hopding/pdf-lib)') res.metadata.items.push('建立軟體: ' + creator);
    if (producer.trim() && producer !== 'pdf-lib (https://github.com/Hopding/pdf-lib)') res.metadata.items.push('生產者: ' + producer);
    if (hasXmp) res.metadata.items.push('XMP 串流');
    res.metadata.count = res.metadata.items.length;

    var pageCount = doc.getPageCount();
    for (var pIdx = 0; pIdx < pageCount; pIdx++) {
      var page = doc.getPage(pIdx);
      var annotsRef = page.node.get(PDFLib.PDFName.of('Annots'));
      if (annotsRef) {
        var annotsArr = doc.context.lookup(annotsRef);
        if (annotsArr && typeof annotsArr.size === 'function') {
          for (var aIdx = 0; aIdx < annotsArr.size(); aIdx++) {
            var annotObj = doc.context.lookup(annotsArr.get(aIdx));
            if (!annotObj || typeof annotObj.get !== 'function') continue;

            var subTypeObj = annotObj.get(PDFLib.PDFName.of('Subtype'));
            var subType = subTypeObj ? (subTypeObj.asString ? subTypeObj.asString().replace(/^\//, '') : String(subTypeObj).replace(/^\//, '')) : '';

            if (subType === 'Link') {
              res.links.count++;
            } else if (subType && subType !== 'Widget') {
              res.comments.count++;
            }
          }
        }
      }
    }

    if (doc.catalog.has(PDFLib.PDFName.of('AcroForm'))) {
      try {
        var form = doc.getForm();
        res.forms.count = form.getFields().length || 1;
      } catch (e) {
        res.forms.count = 1;
      }
    }

    if (doc.catalog.has(PDFLib.PDFName.of('Names'))) {
      var names = doc.context.lookup(doc.catalog.get(PDFLib.PDFName.of('Names')));
      if (names && names.has && names.has(PDFLib.PDFName.of('EmbeddedFiles'))) {
        res.attachments.count = 1;
      }
    }

    if (doc.catalog.has(PDFLib.PDFName.of('OpenAction')) || doc.catalog.has(PDFLib.PDFName.of('AA'))) {
      res.actions.count = 1;
    }

    return res;
  }

  function cleanPdfBytes(bytes) {
    return PDFLib.PDFDocument.load(bytes).then(function (doc) {
      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setProducer('');
      doc.setCreator('');
      doc.setCreationDate(new Date(0));
      doc.setModificationDate(new Date(0));
      if (doc.catalog.has(PDFLib.PDFName.of('Metadata'))) {
        doc.catalog.delete(PDFLib.PDFName.of('Metadata'));
      }

      var pCount = doc.getPageCount();
      for (var p = 0; p < pCount; p++) {
        var page = doc.getPage(p);
        var annotsRef = page.node.get(PDFLib.PDFName.of('Annots'));
        if (annotsRef) {
          var annotsArr = doc.context.lookup(annotsRef);
          if (annotsArr && typeof annotsArr.size === 'function') {
            var keptRefs = [];
            for (var a = 0; a < annotsArr.size(); a++) {
              var rawRef = annotsArr.get(a);
              var annotObj = doc.context.lookup(rawRef);
              if (!annotObj || typeof annotObj.get !== 'function') continue;

              var subTypeObj = annotObj.get(PDFLib.PDFName.of('Subtype'));
              var subType = subTypeObj ? (subTypeObj.asString ? subTypeObj.asString().replace(/^\//, '') : String(subTypeObj).replace(/^\//, '')) : '';

              if (subType === 'Widget') {
                keptRefs.push(rawRef);
              }
            }
            if (keptRefs.length > 0) {
              page.node.set(PDFLib.PDFName.of('Annots'), doc.context.obj(keptRefs));
            } else {
              page.node.delete(PDFLib.PDFName.of('Annots'));
            }
          }
        }
      }

      if (doc.catalog.has(PDFLib.PDFName.of('AcroForm'))) {
        doc.catalog.delete(PDFLib.PDFName.of('AcroForm'));
      }
      if (doc.catalog.has(PDFLib.PDFName.of('Names'))) {
        var namesObj = doc.context.lookup(doc.catalog.get(PDFLib.PDFName.of('Names')));
        if (namesObj && namesObj.delete) {
          namesObj.delete(PDFLib.PDFName.of('EmbeddedFiles'));
        }
      }
      if (doc.catalog.has(PDFLib.PDFName.of('AF'))) {
        doc.catalog.delete(PDFLib.PDFName.of('AF'));
      }
      if (doc.catalog.has(PDFLib.PDFName.of('OpenAction'))) {
        doc.catalog.delete(PDFLib.PDFName.of('OpenAction'));
      }
      if (doc.catalog.has(PDFLib.PDFName.of('AA'))) {
        doc.catalog.delete(PDFLib.PDFName.of('AA'));
      }

      return doc.save();
    });
  }

  // --- Office 摘要與清理 ---
  function summarizeOfficeBefore(entries, format) {
    var base = {
      core: readDocxCoreProps(entries),
      app: readDocxAppProps(entries),
      hasCustom: hasCustomProps(entries),
      hasThumbnail: hasThumbnail(entries)
    };
    if (format === 'xlsx') {
      base.pivotCaches = scanXlsxPivotCaches(entries);
      base.hiddenSheets = scanXlsxHiddenSheets(entries);
      base.externalLinks = scanXlsxExternalLinks(entries);
    } else if (format === 'pptx') {
      base.croppedImages = scanPptxCroppedImages(entries);
      base.speakerNotes = scanPptxSpeakerNotes(entries);
      base.hiddenSlides = scanPptxHiddenSlides(entries);
    } else {
      base.comments = scanDocxComments(entries);
      base.trackedChanges = scanDocxTrackedChanges(entries);
      base.localPaths = scanDocxLocalPathLinks(entries);
    }
    return base;
  }

  function cleanOfficeEntries(entries, format) {
    var next = cleanDocxCoreProps(entries);
    next = cleanDocxAppProps(next);
    if (hasCustomProps(next)) next = removeZipEntryAndRelationship(next, 'docProps/custom.xml');
    var thumbPath = _findThumbnailPath(next);
    if (thumbPath) next = removeZipEntryAndRelationship(next, thumbPath);

    if (format === 'xlsx') {
      next = cleanXlsxPivotCaches(next);
      next = cleanXlsxExternalLinks(next);
      return Promise.resolve({ entries: next, pptxSkippedMedia: [] });
    }
    if (format === 'pptx') {
      next = cleanPptxSpeakerNotes(next);
      return cleanPptxCroppedImages(next).then(function (result) {
        return { entries: result.entries, pptxSkippedMedia: result.skippedMedia };
      });
    }
    next = cleanDocxComments(next);
    next = cleanDocxLocalPathLinks(next);
    return Promise.resolve({ entries: next, pptxSkippedMedia: [] });
  }

  // --- 統合風險計算 ---
  function computeRisk(before, format) {
    if (!before) return { level: 'none', label: '', cls: 'risk-none' };

    if (isImageFormat(format)) {
      var imgHigh = [];
      if (before.hasGPS) imgHigh.push('GPS座標');
      if (imgHigh.length) return _riskResult('high', imgHigh);

      var imgMed = [];
      if (before.make || before.model) imgMed.push('裝置資訊');
      if (before.dateTimeOriginal) imgMed.push('拍攝時間');
      if (imgMed.length) return _riskResult('med', imgMed);

      var imgLow = [];
      if (before.hasXMP) imgLow.push('XMP');
      if (imgLow.length) return _riskResult('low', imgLow);

      return _riskResult('none', []);
    }

    if (format === 'pdf') {
      var pdfHigh = [];
      if (before.links.count > 0) pdfHigh.push('超連結');
      if (before.comments.count > 0) pdfHigh.push('註解');
      if (before.forms.count > 0) pdfHigh.push('表單欄位');
      if (before.attachments.count > 0) pdfHigh.push('內嵌附件');
      if (before.actions.count > 0) pdfHigh.push('自動腳本');
      if (pdfHigh.length) return _riskResult('high', pdfHigh);

      var pdfMed = [];
      if (before.metadata.count > 0) pdfMed.push('文件屬性');
      if (pdfMed.length) return _riskResult('med', pdfMed);

      return _riskResult('none', []);
    }

    if (format === 'xlsx') {
      var xlsxHigh = [];
      if (before.core.creator) xlsxHigh.push('作者');
      if (before.core.lastModifiedBy) xlsxHigh.push('最後修改者');
      if (before.core.description) xlsxHigh.push('描述');
      if (before.app.company) xlsxHigh.push('公司');
      if (before.pivotCaches.count > 0) xlsxHigh.push('樞紐分析表快取');
      if (before.externalLinks.relationshipHits.length > 0) xlsxHigh.push('外部連結');
      if (xlsxHigh.length) return _riskResult('high', xlsxHigh);

      var xlsxMed = [];
      if (before.hasThumbnail) xlsxMed.push('縮圖');
      if (before.hasCustom) xlsxMed.push('自訂屬性');
      if (before.hiddenSheets.length > 0) xlsxMed.push('隱藏工作表');
      if (xlsxMed.length) return _riskResult('med', xlsxMed);

      return _riskResult('none', []);
    }

    if (format === 'pptx') {
      var pptxHigh = [];
      if (before.core.creator) pptxHigh.push('作者');
      if (before.core.lastModifiedBy) pptxHigh.push('最後修改者');
      if (before.core.description) pptxHigh.push('描述');
      if (before.app.company) pptxHigh.push('公司');
      if (before.speakerNotes.count > 0) pptxHigh.push('講者備忘稿');
      if (before.croppedImages.count > 0) pptxHigh.push('裁切原圖殘留');
      if (pptxHigh.length) return _riskResult('high', pptxHigh);

      var pptxMed = [];
      if (before.hasThumbnail) pptxMed.push('縮圖');
      if (before.hasCustom) pptxMed.push('自訂屬性');
      if (before.hiddenSlides.length > 0) pptxMed.push('隱藏投影片');
      if (pptxMed.length) return _riskResult('med', pptxMed);

      return _riskResult('none', []);
    }

    if (format === 'docx') {
      var docxHigh = [];
      if (before.core.creator) docxHigh.push('作者');
      if (before.core.lastModifiedBy) docxHigh.push('最後修改者');
      if (before.core.description) docxHigh.push('描述');
      if (before.app.company) docxHigh.push('公司');
      if (before.comments.count > 0) docxHigh.push('註解');
      if (before.localPaths.relationshipHits.length > 0 || before.localPaths.displayTextHits.length > 0) docxHigh.push('本機路徑');
      if (docxHigh.length) return _riskResult('high', docxHigh);

      var docxMed = [];
      if (before.hasThumbnail) docxMed.push('縮圖');
      if (before.hasCustom) docxMed.push('自訂屬性');
      if (before.trackedChanges.insertions.length > 0 || before.trackedChanges.deletions.length > 0) docxMed.push('追蹤修訂');
      if (docxMed.length) return _riskResult('med', docxMed);

      return _riskResult('none', []);
    }

    return _riskResult('none', []);
  }

  // --- 檔案載入與掃描 ---
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    var supportedFiles = files.filter(function (file) { return !!detectFormat(file.name); });
    var batchBytes = supportedFiles.reduce(function (sum, file) { return sum + file.size; }, 0);

    // 批次限制必須先於逐檔處理，避免前幾份已開始讀取後才發現總量超限。
    if (batchBytes > BATCH_LIMIT_BYTES) {
      showToast('批次檔案總量超過 100MB 上限，已於讀取前拒絕加入');
      return;
    }

    files.forEach(function (file) {
      var format = detectFormat(file.name);
      if (!format) {
        showToast('不支援的檔案格式: ' + file.name);
        return;
      }

      var limitBytes = format === 'pdf' ? PDF_LIMIT_BYTES : FILE_LIMIT_BYTES;
      if (file.size > limitBytes) {
        var limitMb = limitBytes / (1024 * 1024);
        state.items.push({
          id: nextId++,
          file: file,
          format: format,
          bytes: null,
          entries: null,
          before: null,
          status: 'skipped',
          process: false,
          skipReason: '檔案超過 ' + limitMb + 'MB 上限，已於讀取前拒絕'
        });
        renderList();
        showToast(file.name + ' 超過 ' + limitMb + 'MB 上限，已拒絕加入');
        return;
      }

      var item = {
        id: nextId++,
        file: file,
        format: format,
        bytes: null,
        entries: null,
        before: null,
        status: 'loading',
        process: false
      };
      state.items.push(item);
      renderList();

      var reader = new FileReader();
      reader.onload = function () {
        var rawBuf = reader.result;
        var bytes = new Uint8Array(rawBuf);
        item.bytes = bytes;

        try {
          if (isImageFormat(format)) {
            if (format === 'webp' && !isValidWebpBytes(bytes)) {
              item.status = 'error';
              item.errorMessage = '此檔案可能已損毀，或不是合法的 WEBP 格式';
              renderList();
              return;
            }
            item.before = readExifTags(imageArrayBuffer(bytes));
            item.status = 'scanned';
            item.process = true;
            renderList();
          } else if (format === 'pdf') {
            PDFLib.PDFDocument.load(bytes).then(function (doc) {
              item.before = scanPdfDoc(doc);
              item.status = 'scanned';
              item.process = true;
              renderList();
            }).catch(function (err) {
              item.status = 'error';
              item.errorMessage = 'PDF 檔案解析失敗或有密碼保護';
              renderList();
            });
          } else {
            // Office 格式
            var entries;
            try {
              assertSafeZipArchive(bytes);
              entries = unzipToEntries(bytes);
              assertOfficeStructure(entries, format);
            } catch (err) {
              item.status = isLikelyEncryptedOfficeFile(rawBuf) ? 'encrypted' : 'error';
              item.errorMessage = item.status === 'encrypted'
                ? '此檔案有密碼保護，請先在 Office 解除保護後再上傳'
                : '此檔案可能已損毀，或不是合法的 ' + format.toUpperCase() + ' 格式';
              renderList();
              return;
            }
            item.entries = entries;
            item.before = summarizeOfficeBefore(entries, format);
            item.status = 'scanned';
            item.process = true;
            renderList();
          }
        } catch (e) {
          item.status = 'error';
          item.errorMessage = '讀取檔案時發生未預期的錯誤: ' + (e.message || e);
          renderList();
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function updateStats() {
    var toProcess = state.items.filter(function (i) { return i.process && i.status === 'scanned'; }).length;
    var toKeep = state.items.filter(function (i) { return i.status === 'scanned' && !i.process; }).length;
    planStatsText.textContent = '即將清除：' + toProcess + ' 份，保留原樣：' + toKeep + ' 份';
    cleanOptionsCard.style.display = state.items.some(function (i) { return i.status === 'scanned'; }) ? 'block' : 'none';
    btnStartClean.disabled = toProcess === 0;
  }

  function renderList() {
    resultsSection.style.display = state.items.length ? 'block' : 'none';
    docCount.textContent = String(state.items.length);
    updateStats();

    docsContainer.innerHTML = state.items.map(function (item, idx) {
      if (item.status === 'loading') {
        return '<div class="doc-card"><div class="doc-header"><div class="doc-icon">⏳</div>' +
          '<strong>' + escapeHtml(item.file.name) + '</strong><span>讀取解析中…</span></div></div>';
      }
      if (item.status === 'skipped') {
        return '<div class="doc-card"><div class="doc-header"><div class="doc-icon">⚠️</div>' +
          '<strong>' + escapeHtml(item.file.name) + '</strong>' +
          '<span class="risk-badge risk-med">已略過</span></div>' +
          '<div class="warn-box">' + escapeHtml(item.skipReason || '大小超出限制') + '</div></div>';
      }
      if (item.status === 'encrypted' || item.status === 'error') {
        return '<div class="doc-card"><div class="doc-header"><div class="doc-icon">❌</div>' +
          '<strong>' + escapeHtml(item.file.name) + '</strong>' +
          '<span class="risk-badge risk-med">無法處理</span></div>' +
          '<div class="warn-box">' + escapeHtml(item.errorMessage || '檔案讀取錯誤') + '</div></div>';
      }

      var b = item.before;
      var format = item.format;
      var risk = computeRisk(b, format);

      var icon = isImageFormat(format) ? '🖼️'
        : format === 'pdf' ? '📄'
        : format === 'xlsx' ? '📊'
        : format === 'pptx' ? '📽️' : '📝';

      var metaGridContent = '';
      var warnParts = [];

      if (isImageFormat(format)) {
        var gpsText = b.hasGPS ? (b.gpsLatitude.toFixed(4) + ', ' + b.gpsLongitude.toFixed(4)) : '無';
        metaGridContent =
          fieldLine('拍攝時間', b.dateTimeOriginal) +
          fieldLine('相機品牌', b.make) +
          fieldLine('相機型號', b.model) +
          fieldLine('GPS 座標', gpsText) +
          fieldLine('XMP 資料', b.hasXMP ? '有' : '無');
      } else if (format === 'pdf') {
        metaGridContent =
          fieldLine('作者 (Author)', b.metadata.details.author) +
          fieldLine('建立軟體 (Creator)', b.metadata.details.creator) +
          fieldLine('生產者 (Producer)', b.metadata.details.producer) +
          fieldLine('超連結 (Links)', b.links.count > 0 ? (b.links.count + ' 處') : '無') +
          fieldLine('註解/標記 (Comments)', b.comments.count > 0 ? (b.comments.count + ' 處') : '無') +
          fieldLine('表單欄位 (Forms)', b.forms.count > 0 ? (b.forms.count + ' 處') : '無');
      } else if (format === 'xlsx') {
        metaGridContent =
          fieldLine('作者', b.core.creator) +
          fieldLine('最後修改者', b.core.lastModifiedBy) +
          fieldLine('公司', b.app.company) +
          fieldLine('樞紐分析表快取', String(b.pivotCaches.count)) +
          fieldLine('隱藏工作表', String(b.hiddenSheets.length)) +
          fieldLine('外部連結', String(b.externalLinks.relationshipHits.length));
        if (b.pivotCaches.count > 0) warnParts.push('清除樞紐分析表快取會使原樞紐分析表失效。');
      } else if (format === 'pptx') {
        metaGridContent =
          fieldLine('作者', b.core.creator) +
          fieldLine('最後修改者', b.core.lastModifiedBy) +
          fieldLine('公司', b.app.company) +
          fieldLine('講者備忘稿', String(b.speakerNotes.count)) +
          fieldLine('裁切原圖殘留', String(b.croppedImages.count)) +
          fieldLine('隱藏投影片', String(b.hiddenSlides.length));
      } else {
        // docx
        var trackedCount = b.trackedChanges.insertions.length + b.trackedChanges.deletions.length;
        metaGridContent =
          fieldLine('作者', b.core.creator) +
          fieldLine('最後修改者', b.core.lastModifiedBy) +
          fieldLine('公司', b.app.company) +
          fieldLine('註解數量', String(b.comments.count)) +
          fieldLine('本機路徑連結', String(b.localPaths.relationshipHits.length)) +
          fieldLine('追蹤修訂', trackedCount > 0 ? (trackedCount + ' 處') : '無');
      }

      var metaGrid = '<div class="doc-meta-grid">' + metaGridContent + '</div>';
      var warnBox = warnParts.length ? '<div class="warn-box">⚠️ ' + escapeHtml(warnParts.join(' ')) + '</div>' : '';

      var processToggle = (item.status === 'scanned')
        ? '<label style="font-size: 0.85rem;"><input type="checkbox" class="chk-item-process" data-idx="' + idx + '" ' + (item.process ? 'checked' : '') + '> 此份要清除</label>'
        : '';

      var diffSection = '';
      if (state.cleaned && item.status === 'cleaned') {
        var diffRows = '';
        if (isImageFormat(format)) {
          diffRows =
            '<tr><td>拍攝時間</td><td>' + escapeHtml(b.dateTimeOriginal || '無') + '</td><td>' + (item.cleanedBefore.dateTimeOriginal ? escapeHtml(item.cleanedBefore.dateTimeOriginal) : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>裝置型號</td><td>' + escapeHtml((b.make || '') + ' ' + (b.model || '')).trim() + '</td><td>' + (item.cleanedBefore.model ? escapeHtml(item.cleanedBefore.model) : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>GPS 座標</td><td>' + (b.hasGPS ? '有座標' : '無') + '</td><td>' + (item.cleanedBefore.hasGPS ? '仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>XMP 資料</td><td>' + (b.hasXMP ? '有' : '無') + '</td><td>' + (item.cleanedBefore.hasXMP ? '仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>';
        } else if (format === 'pdf') {
          diffRows =
            '<tr><td>文件屬性 (Metadata)</td><td>' + b.metadata.count + ' 項</td><td>' + (item.cleanedBefore.metadata.count > 0 ? item.cleanedBefore.metadata.count + ' 項仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>超連結 (Links)</td><td>' + b.links.count + ' 處</td><td>' + (item.cleanedBefore.links.count > 0 ? item.cleanedBefore.links.count + ' 處仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>註解 (Comments)</td><td>' + b.comments.count + ' 處</td><td>' + (item.cleanedBefore.comments.count > 0 ? item.cleanedBefore.comments.count + ' 處仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>表單 (Forms)</td><td>' + b.forms.count + ' 處</td><td>' + (item.cleanedBefore.forms.count > 0 ? item.cleanedBefore.forms.count + ' 處仍在' : '<strong>✓ 已清除</strong>') + '</td></tr>';
        } else {
          var a = item.cleanedBefore;
          diffRows =
            '<tr><td>作者 (Creator)</td><td>' + escapeHtml(b.core.creator || '無') + '</td><td>' + (a.core.creator ? escapeHtml(a.core.creator) : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>公司 (Company)</td><td>' + escapeHtml(b.app.company || '無') + '</td><td>' + (a.app.company ? escapeHtml(a.app.company) : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>自訂屬性 (Custom)</td><td>' + (b.hasCustom ? '有' : '無') + '</td><td>' + (a.hasCustom ? '仍有' : '<strong>✓ 已清除</strong>') + '</td></tr>' +
            '<tr><td>內嵌縮圖 (Thumbnail)</td><td>' + (b.hasThumbnail ? '有' : '無') + '</td><td>' + (a.hasThumbnail ? '仍有' : '<strong>✓ 已清除</strong>') + '</td></tr>';
        }

        diffSection = '<table class="diff-table">' +
          '<thead><tr><th>檢測項目</th><th>清除前</th><th>清除後（驗證結果）</th></tr></thead><tbody>' +
          diffRows + '</tbody></table>';
      }

      var downloadBtn = (state.cleaned && item.status === 'cleaned')
        ? '<button type="button" class="btn secondary btn-sm btn-download-one" data-idx="' + idx + '">下載清除版</button>' : '';

      return '<div class="doc-card">' +
        '<div class="doc-header"><div class="doc-icon">' + icon + '</div>' +
        '<div style="flex:1; min-width: 180px;"><strong>#' + (idx + 1) + ' ' + escapeHtml(item.file.name) + '</strong> (' + formatBytes(item.file.size) + ')<br>' +
        '<span class="risk-badge ' + risk.cls + '">' + risk.label + '</span></div>' +
        '<div style="display:flex; gap:0.5rem; align-items:center;">' + processToggle + downloadBtn + '</div></div>' +
        metaGrid + warnBox + diffSection + '</div>';
    }).join('');

    docsContainer.querySelectorAll('.chk-item-process').forEach(function (chk) {
      chk.addEventListener('change', function () {
        var idx = Number(chk.getAttribute('data-idx'));
        state.items[idx].process = chk.checked;
        updateStats();
      });
    });

    docsContainer.querySelectorAll('.btn-download-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-idx'));
        downloadOne(state.items[idx]);
      });
    });
  }

  // --- 下載單檔 ---
  function downloadOne(item) {
    var ext = item.format;
    var baseName = item.file.name.replace(/\.[^/.]+$/, '');
    var outFilename = baseName + '_cleaned.' + ext;

    if (isImageFormat(item.format) || item.format === 'pdf') {
      var blob = new Blob([item.cleanedBytes], { type: MIME_BY_FORMAT[ext] });
      downloadFile(outFilename, blob, MIME_BY_FORMAT[ext]);
    } else {
      var zipFiles = Object.keys(item.cleanedEntries).map(function (name) {
        return { name: name, bytes: item.cleanedEntries[name] };
      });
      var blob = createZipBlob(zipFiles);
      downloadFile(outFilename, blob, MIME_BY_FORMAT[ext]);
    }
  }

  // --- 開始清除按鈕事件 ---
  btnStartClean.addEventListener('click', function () {
    var targets = state.items.filter(function (item) { return item.status === 'scanned' && item.process; });
    if (!targets.length) return;

    btnStartClean.disabled = true;
    showToast('正在清除 Metadata...');

    Promise.all(targets.map(function (item) {
      var format = item.format;
      if (isImageFormat(format)) {
        try {
          var cleaned = stripMetadataSegments(imageArrayBuffer(item.bytes));
          item.cleanedBytes = cleaned;
          item.cleanedBefore = readExifTags(cleaned);
          item.status = 'cleaned';
          return Promise.resolve();
        } catch (e) {
          item.status = 'error';
          item.errorMessage = '圖片清除失敗: ' + (e.message || e);
          return Promise.resolve();
        }
      } else if (format === 'pdf') {
        return cleanPdfBytes(item.bytes).then(function (cleanedBytes) {
          item.cleanedBytes = cleanedBytes;
          return PDFLib.PDFDocument.load(cleanedBytes).then(function (cleanedDoc) {
            item.cleanedBefore = scanPdfDoc(cleanedDoc);
            item.status = 'cleaned';
          });
        }).catch(function (err) {
          item.status = 'error';
          item.errorMessage = 'PDF 清除失敗: ' + (err.message || err);
        });
      } else {
        return cleanOfficeEntries(item.entries, format).then(function (result) {
          item.cleanedEntries = result.entries;
          item.pptxSkippedMedia = result.pptxSkippedMedia;
          item.cleanedBefore = summarizeOfficeBefore(result.entries, format);
          item.status = 'cleaned';
        }).catch(function (err) {
          item.status = 'error';
          item.errorMessage = 'Office 檔案清除失敗: ' + (err.message || err);
        });
      }
    })).then(function () {
      state.cleaned = true;
      var count = state.items.filter(function (i) { return i.status === 'cleaned'; }).length;
      downloadActions.style.display = count > 0 ? 'flex' : 'none';
      showToast('已完成 ' + count + ' 份檔案的 Metadata 清除！');
      renderList();
    });
  });

  // --- 清空佇列 ---
  btnClear.addEventListener('click', function () {
    state.items = [];
    state.cleaned = false;
    downloadActions.style.display = 'none';
    renderList();
    showToast('已清空清單');
  });

  // --- 批次打包 ZIP ---
  btnDownloadZip.addEventListener('click', function () {
    var cleanedItems = state.items.filter(function (i) { return i.status === 'cleaned'; });
    if (!cleanedItems.length) return;

    var zipFiles = [];
    cleanedItems.forEach(function (item) {
      var baseName = item.file.name.replace(/\.[^/.]+$/, '');
      var outFilename = baseName + '_cleaned.' + item.format;

      if (isImageFormat(item.format) || item.format === 'pdf') {
        zipFiles.push({ name: outFilename, bytes: item.cleanedBytes });
      } else {
        var innerZipFiles = Object.keys(item.cleanedEntries).map(function (name) {
          return { name: name, bytes: item.cleanedEntries[name] };
        });
        var innerBlobBytes = fflate.zipSync(innerZipFiles.reduce(function (acc, f) {
          acc[f.name] = (f.bytes instanceof Uint8Array) ? f.bytes : new Uint8Array(f.bytes);
          return acc;
        }, {}));
        zipFiles.push({ name: outFilename, bytes: innerBlobBytes });
      }
    });

    var outerBlob = createZipBlob(zipFiles);
    downloadFile('cleaned_privacy_documents.zip', outerBlob, 'application/zip');
  });

  // --- 複製風險摘要 ---
  btnCopySummary.addEventListener('click', function () {
    var lines = state.items.map(function (item, idx) {
      if (!item.before) return '#' + (idx + 1) + ' ' + item.file.name + '：無法解析';
      var risk = computeRisk(item.before, item.format);
      return '#' + (idx + 1) + ' ' + item.file.name + '：' + risk.label;
    });
    copyToClipboard(lines.join('\n'));
    showToast('已複製風險摘要');
  });

  // --- 拖放事件 ---
  dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('click', function (e) {
    if (e.target === btnSelectFiles) return;
    fileInput.click();
  });
  btnSelectFiles.addEventListener('click', function (e) {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  // --- 下載離線版 ---
  btnDownloadOffline.addEventListener('click', function () {
    // outerHTML 會包含目前由 renderList() 寫入的檔名與 Metadata。先在不影響
    // 畫面的 clone 上還原初始 UI，確保匯出的工具只有程式本身、沒有本次資料。
    var cleanRoot = document.documentElement.cloneNode(true);
    cleanRoot.querySelector('#docs-container').textContent = '';
    cleanRoot.querySelector('#doc-count').textContent = '0';
    cleanRoot.querySelector('#plan-stats-text').textContent = '即將清除：0 份，保留原樣：0 份';
    cleanRoot.querySelector('#clean-options-card').style.display = 'none';
    cleanRoot.querySelector('#results-section').style.display = 'none';
    cleanRoot.querySelector('#download-actions').style.display = 'none';
    cleanRoot.querySelector('#btn-start-clean').removeAttribute('disabled');
    cleanRoot.querySelector('#file-input').removeAttribute('value');
    var transientToast = cleanRoot.querySelector('#__shared_toast');
    if (transientToast) transientToast.remove();
    var html = cleanRoot.outerHTML;
    var blob = new Blob(['<!DOCTYPE html>\n' + html], { type: 'text/html' });
    downloadFile('all-in-one-cleaner-offline.html', blob, 'text/html');
  });

})();
