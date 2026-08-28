const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('../../../shared/vendor/fflate.umd.js');
const { PDFDocument } = require('../../../shared/vendor/cantoo-pdf-lib.min.js');
const { readExifTags } = require('../../../shared/img-exif.js');
const config = require('../test-config.cjs');

const FORMATS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'docx', 'xlsx', 'pptx']);
const XSS_PAYLOAD = '<img src=x onerror=globalThis.__fixtureXss=1>';
const WEBP_METADATA_FLAGS = 0x08 | 0x04;
const SENSITIVE = Object.freeze({
  author: 'QA_SECRET_AUTHOR',
  company: 'QA_SECRET_COMPANY',
  localPath: 'file:///Users/qa/QA_SECRET_SOURCE.xlsx',
  comment: 'QA_SECRET_COMMENT',
  pivot: 'QA_SECRET_PIVOT_CUSTOMER',
  notes: 'QA_SECRET_SPEAKER_NOTES'
});

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = Buffer.alloc(size);
  let offset = 0;
  for (const part of parts) {
    Buffer.from(part).copy(out, offset);
    offset += part.length;
  }
  return out;
}

function toArrayBuffer(bytes) {
  const buffer = Buffer.from(bytes);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function buildTiff({ make = 'QA Camera', model = 'Fixture 2026', date = '2026:08:27 12:00:00' } = {}) {
  const makeBytes = Buffer.from(`${make}\0`, 'ascii');
  const modelBytes = Buffer.from(`${model}\0`, 'ascii');
  const dateBytes = Buffer.from(`${date}\0`, 'ascii');
  const ifd0Offset = 8;
  const ifd0Size = 2 + (5 * 12) + 4;
  const makeOffset = ifd0Offset + ifd0Size;
  const modelOffset = makeOffset + makeBytes.length;
  const exifOffset = modelOffset + modelBytes.length;
  const exifSize = 2 + 12 + 4;
  const dateOffset = exifOffset + exifSize;
  const gpsOffset = dateOffset + dateBytes.length;
  const gpsSize = 2 + (4 * 12) + 4;
  const latOffset = gpsOffset + gpsSize;
  const lonOffset = latOffset + 24;
  const out = Buffer.alloc(lonOffset + 24);

  out.write('II', 0, 'ascii');
  out.writeUInt16LE(0x2a, 2);
  out.writeUInt32LE(ifd0Offset, 4);
  out.writeUInt16LE(5, ifd0Offset);

  function entry(base, tag, type, count, value, shortValue) {
    out.writeUInt16LE(tag, base);
    out.writeUInt16LE(type, base + 2);
    out.writeUInt32LE(count, base + 4);
    if (shortValue !== undefined) out.writeUInt16LE(shortValue, base + 8);
    else out.writeUInt32LE(value, base + 8);
  }

  let e = ifd0Offset + 2;
  entry(e, 0x010f, 2, makeBytes.length, makeOffset); e += 12;
  entry(e, 0x0110, 2, modelBytes.length, modelOffset); e += 12;
  entry(e, 0x0112, 3, 1, 0, 1); e += 12;
  entry(e, 0x8769, 4, 1, exifOffset); e += 12;
  entry(e, 0x8825, 4, 1, gpsOffset);
  makeBytes.copy(out, makeOffset);
  modelBytes.copy(out, modelOffset);

  out.writeUInt16LE(1, exifOffset);
  entry(exifOffset + 2, 0x9003, 2, dateBytes.length, dateOffset);
  dateBytes.copy(out, dateOffset);

  out.writeUInt16LE(4, gpsOffset);
  e = gpsOffset + 2;
  entry(e, 0x0001, 2, 2, 0); out.write('N\0', e + 8, 'ascii'); e += 12;
  entry(e, 0x0002, 5, 3, latOffset); e += 12;
  entry(e, 0x0003, 2, 2, 0); out.write('E\0', e + 8, 'ascii'); e += 12;
  entry(e, 0x0004, 5, 3, lonOffset);

  [[25, 1], [2, 1], [0, 1], [121, 1], [34, 1], [0, 1]].forEach(([num, den], index) => {
    const offset = latOffset + (index * 8);
    out.writeUInt32LE(num, offset);
    out.writeUInt32LE(den, offset + 4);
  });
  return out;
}

function jpegApp1(payload) {
  const length = payload.length + 2;
  const header = Buffer.from([0xff, 0xe1, (length >>> 8) & 0xff, length & 0xff]);
  return concat(header, payload);
}

function buildJpeg(metadata) {
  const clean = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9xKKKK6DM/9k=', 'base64');
  if (!metadata) return clean;
  const tiff = buildTiff(metadata);
  const exif = jpegApp1(concat(Buffer.from('Exif\0\0', 'binary'), tiff));
  const xmp = jpegApp1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>QA_XMP</x:xmpmeta>', 'ascii'));
  return concat(clean.subarray(0, 2), exif, xmp, clean.subarray(2));
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBytes.copy(header, 4);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(concat(typeBytes, data)), 0);
  return concat(header, data, footer);
}

function buildPng(metadata) {
  const clean = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  if (!metadata) return clean;
  const iendAt = clean.indexOf(Buffer.from('IEND')) - 4;
  const itxt = Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>QA_XMP</x:xmpmeta>', 'ascii');
  return concat(clean.subarray(0, iendAt), pngChunk('eXIf', buildTiff(metadata)), pngChunk('iTXt', itxt), clean.subarray(iendAt));
}

function riffChunk(fourcc, data) {
  assert.equal(fourcc.length, 4, 'RIFF FourCC must be four characters');
  const payload = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return concat(header, payload, payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0));
}

function wrapWebpChunks(...chunks) {
  const body = concat(Buffer.from('WEBP', 'ascii'), ...chunks);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return concat(header, body);
}

function buildWebp(metadata) {
  // Deterministic 1x1 lossless WebP generated from the clean PNG with cwebp.
  const clean = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAEAfQ/4j+BSKi/wEA', 'base64');
  if (!metadata) return clean;

  const cleanStructure = inspectWebp(clean);
  const imageChunk = cleanStructure.chunks.find(chunk => chunk.fourcc === 'VP8L');
  const vp8x = Buffer.alloc(10);
  vp8x[0] = WEBP_METADATA_FLAGS | 0x10; // The embedded VP8L payload contains alpha.
  // Bytes 4..6 and 7..9 store canvas width-1 and height-1; zero means 1x1.
  const xmp = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/">QA_XMP ${metadata.make || ''}</x:xmpmeta>`, 'utf8');
  return wrapWebpChunks(
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', clean.subarray(imageChunk.dataStart, imageChunk.dataEnd)),
    riffChunk('EXIF', buildTiff(metadata)),
    riffChunk('XMP ', xmp)
  );
}

function inspectWebp(bytes, { allowedTrailingBytes = 0 } = {}) {
  const buffer = Buffer.from(bytes);
  assert.ok(buffer.length >= 12, 'WebP is shorter than its RIFF header');
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', 'WebP lacks RIFF magic');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WEBP', 'WebP lacks WEBP magic');
  const declaredEnd = buffer.readUInt32LE(4) + 8;
  assert.equal(buffer.length - declaredEnd, allowedTrailingBytes, 'WebP RIFF size does not match its file size');

  const chunks = [];
  let offset = 12;
  while (offset < declaredEnd) {
    assert.ok(offset + 8 <= declaredEnd, 'WebP has a truncated chunk header');
    const fourcc = buffer.subarray(offset, offset + 4).toString('ascii');
    const dataLength = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + (dataLength % 2);
    assert.ok(chunkEnd <= declaredEnd, `WebP ${fourcc} chunk is truncated`);
    if (dataLength % 2) assert.equal(buffer[dataEnd], 0, `WebP ${fourcc} padding must be zero`);
    chunks.push({ fourcc, dataStart, dataEnd, dataLength, chunkEnd });
    offset = chunkEnd;
  }
  assert.equal(offset, declaredEnd, 'WebP chunks do not fill the declared RIFF body');

  const vp8xChunk = chunks.find(chunk => chunk.fourcc === 'VP8X');
  const vp8x = vp8xChunk ? {
    flags: buffer[vp8xChunk.dataStart],
    width: buffer.readUIntLE(vp8xChunk.dataStart + 4, 3) + 1,
    height: buffer.readUIntLE(vp8xChunk.dataStart + 7, 3) + 1
  } : null;
  return { declaredEnd, chunks, vp8x };
}

function padWebpToSize(bytes, targetBytes) {
  const source = Buffer.from(bytes);
  assert.equal(targetBytes % 2, 0, 'A padded RIFF fixture must have an even byte size');
  assert.ok(targetBytes >= source.length + 8, 'WebP target size is too small for a JUNK chunk');
  return wrapWebpChunks(source.subarray(12), riffChunk('JUNK', Buffer.alloc(targetBytes - source.length - 8)));
}

async function buildPdf(author) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText('Synthetic QA fixture');
  if (author) {
    doc.setTitle('QA_SECRET_PDF_TITLE');
    doc.setAuthor(author);
    doc.setSubject('QA synthetic metadata');
  }
  return Buffer.from(await doc.save());
}

function commonOfficeEntries({ clean = false, author = SENSITIVE.author } = {}) {
  const creator = clean ? '' : author;
  const company = clean ? '' : SENSITIVE.company;
  const metadataRelationships = clean ? '' : [
    '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>',
    '<Relationship Id="rIdThumbnail" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>'
  ].join('');
  return {
    '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${clean ? '' : '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${metadataRelationships}</Relationships>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${xml(creator)}</dc:creator><cp:lastModifiedBy>${xml(creator)}</cp:lastModifiedBy></cp:coreProperties>`),
    'docProps/app.xml': strToU8(`<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>${xml(company)}</Company><TotalTime>7</TotalTime></Properties>`)
  };
}

function buildOffice(format, options = {}) {
  const { clean = false } = options;
  const entries = commonOfficeEntries(options);
  if (!clean) {
    entries['docProps/custom.xml'] = strToU8(`<Properties>${SENSITIVE.comment}</Properties>`);
    entries['docProps/thumbnail.jpeg'] = buildJpeg(false);
  }
  if (format === 'docx') {
    const docText = clean ? 'Clean document' : 'C:\\QA_SECRET\\report.docx';
    entries['word/document.xml'] = strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rIdLocal"><w:r><w:t>${docText}</w:t></w:r></w:hyperlink>${clean ? '' : `<w:ins w:author="${SENSITIVE.author}"><w:r><w:t>tracked</w:t></w:r></w:ins>`}</w:p></w:body></w:document>`);
    entries['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${clean ? '' : `<Relationship Id="rIdLocal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///Users/qa/QA_SECRET/report.docx" TargetMode="External"/>`}</Relationships>`);
    if (!clean) entries['word/comments.xml'] = strToU8(`<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="${SENSITIVE.author}"><w:p><w:r><w:t>${SENSITIVE.comment}</w:t></w:r></w:p></w:comment></w:comments>`);
  } else if (format === 'xlsx') {
    entries['xl/workbook.xml'] = strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Visible" sheetId="1"/><sheet name="${clean ? 'Archive' : 'QA_SECRET_HIDDEN'}" sheetId="2"${clean ? '' : ' state="veryHidden"'}/></sheets></workbook>`);
    if (!clean) {
      entries['xl/pivotCache/pivotCacheDefinition1.xml'] = strToU8(`<?xml version="1.0"?><pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cacheFields><cacheField><sharedItems><s v="${SENSITIVE.pivot}"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>`);
      entries['xl/pivotCache/pivotCacheRecords1.xml'] = strToU8('<?xml version="1.0"?><pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1"><r><x v="0"/></r></pivotCacheRecords>');
      entries['xl/externalLinks/externalLink1.xml'] = strToU8('<?xml version="1.0"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
      entries['xl/externalLinks/_rels/externalLink1.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="${SENSITIVE.localPath}" TargetMode="External"/></Relationships>`);
    }
  } else if (format === 'pptx') {
    entries['ppt/slides/slide1.xml'] = strToU8(`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"${clean ? '' : ' show="0"'}><p:cSld><a:t>QA slide</a:t>${clean ? '' : '<a:blipFill><a:blip r:embed="rIdImage"/><a:srcRect l="10000"/></a:blipFill>'}</p:cSld></p:sld>`);
    entries['ppt/slides/_rels/slide1.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${clean ? '' : '<Relationship Id="rIdImage" Target="../media/image1.png"/><Relationship Id="rIdNotes" Target="../notesSlides/notesSlide1.xml"/>'}</Relationships>`);
    if (!clean) {
      entries['ppt/media/image1.png'] = buildPng(false);
      entries['ppt/notesSlides/notesSlide1.xml'] = strToU8(`<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>${SENSITIVE.notes}</a:t></p:notes>`);
    }
  }
  return Buffer.from(zipSync(entries));
}

function writeFixture(manifest, id, category, format, bytes, expected = {}) {
  const fileName = `${id}.${format}`;
  const filePath = path.join(config.fixturesDir, fileName);
  fs.writeFileSync(filePath, bytes);
  manifest.fixtures.push({ id, category, format, fileName, expected });
  return filePath;
}

function writeBoundaryFixture(manifest, format, baseBytes, limitMb) {
  const id = `boundary-over-${limitMb}mb-${format}`;
  const filePath = writeFixture(manifest, id, 'boundary', format, baseBytes, {
    limitBytes: limitMb * 1024 * 1024,
    exactBytes: (limitMb * 1024 * 1024) + 1,
    rejectBeforeParse: true
  });
  fs.truncateSync(filePath, (limitMb * 1024 * 1024) + 1);
}

function writeBatchBoundaryFixture(manifest, index, baseBytes) {
  const sizeBytes = 18 * 1024 * 1024;
  const filePath = writeFixture(manifest, `batch-part-${index}`, 'batch-boundary', 'jpg', baseBytes, {
    exactBytes: sizeBytes,
    batchPart: true
  });
  fs.truncateSync(filePath, sizeBytes);
}

function writePerformanceBoundaryFixture(manifest, index, format, baseBytes, sizeMb) {
  const sizeBytes = sizeMb * 1024 * 1024;
  const filePath = writeFixture(manifest, `performance-part-${index}`, 'performance-boundary', format, baseBytes, {
    exactBytes: sizeBytes,
    performancePart: true
  });
  fs.truncateSync(filePath, sizeBytes);
}

function flattenedZipText(bytes) {
  const entries = unzipSync(bytes);
  return Object.keys(entries).sort().map(name => `${name}\n${strFromU8(entries[name])}`).join('\n');
}

async function validateFixtures(manifest) {
  const categories = ['risky', 'clean', 'malicious', 'boundary'];
  for (const category of categories) {
    const found = new Set(manifest.fixtures.filter(f => f.category === category && !f.expected.variant).map(f => f.format));
    assert.deepEqual([...found].sort(), [...FORMATS].sort(), `${category} fixtures must cover all eight extensions`);
  }

  for (const fixture of manifest.fixtures) {
    const filePath = path.join(config.fixturesDir, fixture.fileName);
    const bytes = fs.readFileSync(filePath);
    assert.ok(bytes.length > 0, `${fixture.id} must not be empty`);
    if (fixture.category === 'boundary') {
      assert.equal(bytes.length, fixture.expected.exactBytes, `${fixture.id} has wrong boundary size`);
      if (fixture.format === 'webp') {
        const structure = inspectWebp(bytes, { allowedTrailingBytes: 1 });
        assert.equal(structure.declaredEnd, fixture.expected.limitBytes, `${fixture.id} lacks a valid 20MB WebP prefix`);
        assert.ok(structure.chunks.some(chunk => chunk.fourcc === 'VP8L'), `${fixture.id} lacks image data`);
        assert.ok(structure.chunks.some(chunk => chunk.fourcc === 'JUNK'), `${fixture.id} lacks deterministic padding`);
      }
      continue;
    }
    if (fixture.expected.variant) continue;

    if (fixture.category === 'risky') {
      if (fixture.format === 'jpg' || fixture.format === 'jpeg') {
        assert.ok(bytes.includes(Buffer.from('Exif\0\0', 'binary')) && bytes.includes(Buffer.from('QA Camera')), `${fixture.id} lacks EXIF`);
      } else if (fixture.format === 'png') {
        assert.ok(bytes.includes(Buffer.from('eXIf')) && bytes.includes(Buffer.from('XML:com.adobe.xmp')), `${fixture.id} lacks PNG metadata`);
      } else if (fixture.format === 'webp') {
        const structure = inspectWebp(bytes);
        const tags = readExifTags(toArrayBuffer(bytes));
        assert.deepEqual(structure.chunks.map(chunk => chunk.fourcc), ['VP8X', 'VP8L', 'EXIF', 'XMP '], `${fixture.id} has unexpected chunks`);
        assert.equal(structure.vp8x.flags & WEBP_METADATA_FLAGS, WEBP_METADATA_FLAGS, `${fixture.id} lacks EXIF/XMP flags`);
        assert.deepEqual([structure.vp8x.width, structure.vp8x.height], [1, 1], `${fixture.id} has wrong canvas dimensions`);
        assert.ok(bytes.includes(Buffer.from('QA Camera')) && bytes.includes(Buffer.from('QA_XMP')), `${fixture.id} lacks WebP metadata`);
        assert.equal(tags.make, 'QA Camera', `${fixture.id} has unreadable EXIF`);
        assert.equal(tags.hasGPS, true, `${fixture.id} lacks readable GPS`);
        assert.equal(tags.hasXMP, true, `${fixture.id} lacks readable XMP`);
      } else if (fixture.format === 'pdf') {
        const doc = await PDFDocument.load(bytes);
        assert.equal(doc.getAuthor(), SENSITIVE.author, `${fixture.id} lacks PDF author`);
      } else {
        const text = flattenedZipText(bytes);
        assert.ok(text.includes(SENSITIVE.author) && text.includes('docProps/custom.xml'), `${fixture.id} lacks Office metadata`);
        assert.ok(text.includes(fixture.expected.specificMarker), `${fixture.id} lacks format-specific marker`);
      }
    } else if (fixture.category === 'clean') {
      const decoded = ['docx', 'xlsx', 'pptx'].includes(fixture.format) ? flattenedZipText(bytes) : bytes.toString('latin1');
      assert.ok(!decoded.includes('QA_SECRET_'), `${fixture.id} contains a sensitive marker`);
      if (fixture.format === 'webp') {
        const structure = inspectWebp(bytes);
        const tags = readExifTags(toArrayBuffer(bytes));
        assert.deepEqual(structure.chunks.map(chunk => chunk.fourcc), ['VP8L'], `${fixture.id} is not a metadata-free WebP`);
        assert.equal(tags.hasGPS, false, `${fixture.id} unexpectedly exposes GPS`);
        assert.equal(tags.hasXMP, false, `${fixture.id} unexpectedly exposes XMP`);
      }
    } else if (fixture.category === 'malicious') {
      const decoded = fixture.format === 'pdf'
        ? (await PDFDocument.load(bytes)).getAuthor()
        : (['docx', 'xlsx', 'pptx'].includes(fixture.format) ? flattenedZipText(bytes) : bytes.toString('latin1'));
      assert.ok(decoded.includes('__fixtureXss=1'), `${fixture.id} lacks its XSS marker`);
      assert.ok(fixture.fileName.includes('<img src=x onerror='), `${fixture.id} lacks its hostile filename`);
      if (fixture.format === 'webp') {
        const structure = inspectWebp(bytes);
        assert.equal(structure.vp8x.flags & WEBP_METADATA_FLAGS, WEBP_METADATA_FLAGS, `${fixture.id} lacks metadata flags`);
      }
    }
  }

  const traversal = manifest.fixtures.find(f => f.expected.variant === 'zip-path-traversal');
  const traversalBytes = fs.readFileSync(path.join(config.fixturesDir, traversal.fileName));
  assert.ok(traversalBytes.includes(Buffer.from('../escape.txt')) && Object.keys(unzipSync(traversalBytes)).some(name => name.includes('escape.txt')),
    'ZIP traversal fixture lacks its traversal entry');
  const encrypted = fs.readFileSync(path.join(config.fixturesDir, manifest.fixtures.find(f => f.expected.variant === 'encrypted-office').fileName));
  assert.equal(encrypted.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1', 'encrypted fixture lacks CFB magic');
  const batchBoundary = manifest.fixtures.filter(f => f.category === 'batch-boundary');
  assert.equal(batchBoundary.length, 6, 'batch boundary needs six individually valid-size parts');
  const batchTotal = batchBoundary.reduce((sum, fixture) => sum + fs.statSync(path.join(config.fixturesDir, fixture.fileName)).size, 0);
  assert.ok(batchBoundary.every(f => f.expected.exactBytes <= 20 * 1024 * 1024), 'batch part exceeds the image limit');
  assert.ok(batchTotal > 100 * 1024 * 1024, 'batch boundary does not exceed 100MB');
  const performanceBoundary = manifest.fixtures.filter(f => f.category === 'performance-boundary');
  assert.equal(performanceBoundary.length, 6, 'performance boundary needs six parts');
  const performanceTotal = performanceBoundary.reduce((sum, fixture) => sum + fs.statSync(path.join(config.fixturesDir, fixture.fileName)).size, 0);
  assert.ok(performanceBoundary.every(f => f.expected.exactBytes <= 20 * 1024 * 1024), 'performance part exceeds its image limit');
  assert.equal(performanceTotal, 98 * 1024 * 1024, 'performance boundary must be exactly 98MB');
  const performanceWebp = performanceBoundary.filter(f => f.format === 'webp');
  assert.equal(performanceWebp.length, 1, 'performance boundary needs one WebP part');
  const performanceWebpBytes = fs.readFileSync(path.join(config.fixturesDir, performanceWebp[0].fileName));
  const performanceWebpStructure = inspectWebp(performanceWebpBytes);
  assert.ok(performanceWebpStructure.chunks.some(chunk => chunk.fourcc === 'VP8L'), 'performance WebP lacks image data');
  assert.ok(performanceWebpStructure.chunks.some(chunk => chunk.fourcc === 'JUNK'), 'performance WebP lacks deterministic padding');
}

async function generateFixtures() {
  const root = path.resolve(config.fixturesDir);
  assert.equal(path.dirname(root), path.resolve(config.resultsDir), 'fixture output must stay inside qa/results');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), formats: FORMATS, fixtures: [] };

  const riskyImage = { make: 'QA Camera', model: 'Fixture 2026' };
  writeFixture(manifest, 'risky-photo-jpg', 'risky', 'jpg', buildJpeg(riskyImage), { specificMarker: 'QA Camera' });
  writeFixture(manifest, 'risky-photo-jpeg', 'risky', 'jpeg', buildJpeg(riskyImage), { specificMarker: 'QA Camera' });
  writeFixture(manifest, 'risky-photo-png', 'risky', 'png', buildPng(riskyImage), { specificMarker: 'QA Camera' });
  writeFixture(manifest, 'risky-photo-webp', 'risky', 'webp', buildWebp(riskyImage), { specificMarker: 'QA Camera' });
  writeFixture(manifest, 'risky-contract', 'risky', 'pdf', await buildPdf(SENSITIVE.author), { specificMarker: SENSITIVE.author });
  writeFixture(manifest, 'risky-report', 'risky', 'docx', buildOffice('docx'), { specificMarker: SENSITIVE.comment });
  writeFixture(manifest, 'risky-workbook', 'risky', 'xlsx', buildOffice('xlsx'), { specificMarker: SENSITIVE.pivot });
  writeFixture(manifest, 'risky-slides', 'risky', 'pptx', buildOffice('pptx'), { specificMarker: SENSITIVE.notes });

  writeFixture(manifest, 'clean-photo-jpg', 'clean', 'jpg', buildJpeg(false));
  writeFixture(manifest, 'clean-photo-jpeg', 'clean', 'jpeg', buildJpeg(false));
  writeFixture(manifest, 'clean-photo-png', 'clean', 'png', buildPng(false));
  writeFixture(manifest, 'clean-photo-webp', 'clean', 'webp', buildWebp(false));
  writeFixture(manifest, 'clean-document', 'clean', 'pdf', await buildPdf(null));
  for (const format of ['docx', 'xlsx', 'pptx']) writeFixture(manifest, `clean-${format}`, 'clean', format, buildOffice(format, { clean: true }));

  for (const format of FORMATS) {
    let bytes;
    if (format === 'jpg' || format === 'jpeg') bytes = buildJpeg({ make: XSS_PAYLOAD, model: 'XSS' });
    else if (format === 'png') bytes = buildPng({ make: XSS_PAYLOAD, model: 'XSS' });
    else if (format === 'webp') bytes = buildWebp({ make: XSS_PAYLOAD, model: 'XSS' });
    else if (format === 'pdf') bytes = await buildPdf(XSS_PAYLOAD);
    else bytes = buildOffice(format, { author: XSS_PAYLOAD });
    writeFixture(manifest, `<img src=x onerror=globalThis.__fixtureXss=1>-${format}`, 'malicious', format, bytes, { payload: XSS_PAYLOAD });
  }

  for (const format of FORMATS) writeFixture(manifest, `malformed-${format}`, 'malicious-extra', format, Buffer.from('NOT_A_VALID_FILE'), { variant: 'malformed' });
  for (const format of ['docx', 'xlsx', 'pptx']) {
    writeFixture(manifest, `encrypted-${format}`, 'malicious-extra', format, Buffer.from('d0cf11e0a1b11ae10000000000000000', 'hex'), { variant: 'encrypted-office' });
  }
  writeFixture(manifest, 'spoofed-pdf-as-docx', 'malicious-extra', 'docx', await buildPdf(SENSITIVE.author), { variant: 'format-spoof' });
  writeFixture(manifest, 'zip-path-traversal', 'malicious-extra', 'docx', Buffer.from(zipSync({ '../escape.txt': strToU8('QA_TRAVERSAL_MARKER'), '[Content_Types].xml': strToU8('<Types/>') })), { variant: 'zip-path-traversal' });
  writeFixture(manifest, 'zip-bomb', 'malicious-extra', 'xlsx', Buffer.from(zipSync({ 'xl/bomb.bin': new Uint8Array(8 * 1024 * 1024) }, { level: 9 })), { variant: 'zip-bomb', expandedBytes: 8 * 1024 * 1024 });

  writeBoundaryFixture(manifest, 'jpg', buildJpeg(false), 20);
  writeBoundaryFixture(manifest, 'jpeg', buildJpeg(false), 20);
  writeBoundaryFixture(manifest, 'png', buildPng(false), 20);
  writeBoundaryFixture(manifest, 'webp', padWebpToSize(buildWebp(false), 20 * 1024 * 1024), 20);
  writeBoundaryFixture(manifest, 'pdf', await buildPdf(null), 50);
  for (const format of ['docx', 'xlsx', 'pptx']) writeBoundaryFixture(manifest, format, buildOffice(format, { clean: true }), 20);
  for (let index = 1; index <= 6; index++) writeBatchBoundaryFixture(manifest, index, buildJpeg(false));
  for (let index = 1; index <= 5; index++) writePerformanceBoundaryFixture(manifest, index, 'jpg', buildJpeg(false), 18);
  writePerformanceBoundaryFixture(manifest, 6, 'webp', padWebpToSize(buildWebp(false), 8 * 1024 * 1024), 8);

  await validateFixtures(manifest);
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  generateFixtures().then(manifest => {
    const counts = manifest.fixtures.reduce((acc, fixture) => {
      acc[fixture.category] = (acc[fixture.category] || 0) + 1;
      return acc;
    }, {});
    console.log(`Fixture validation PASS: ${manifest.fixtures.length} files`);
    console.log(JSON.stringify(counts));
    console.log(path.join(config.fixturesDir, 'manifest.json'));
  }).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { FORMATS, SENSITIVE, XSS_PAYLOAD, buildJpeg, buildPng, buildWebp, inspectWebp, buildPdf, buildOffice, generateFixtures, validateFixtures };
