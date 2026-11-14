import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { Timestamp } from 'firebase/firestore';
import {
  computeDayTimeAvailability,
  createEmptyTimetableDraft,
  makeSlotKey,
  resolveTimetableForDate,
} from '../src/lib/timetable';
import { parseTimetableFromExcelBuffer } from '../src/lib/timetableExcelParser';
import {
  detectTimetableFileKind,
  parseTimetableCellText,
} from '../src/lib/timetableGridParser';
import {
  buildHwpxPreviewFromTables,
  parseTimetableFromHwpxBuffer,
} from '../src/lib/timetableHwpxParser';
import { parseTimetableFromOcrData } from '../src/lib/timetableOcrParser';
import {
  parseTimetableFromPdfBuffer,
  parseTimetableFromPdfPageTokens,
} from '../src/lib/timetablePdfParser';
import {
  buildCreateTimetableOverridePayload,
  buildCreateTimetablePayload,
  TimetableValidationError,
} from '../src/repositories/timetableOperations';
import type {
  CalendarEventRecord,
  TimetableOverrideRecord,
  TimetableRecord,
} from '../src/types/domain';
import { SCHEMA_VERSION } from '../src/types/domain';

const FAKE_SENTINEL = { _sentinel: 'serverTimestamp' } as unknown as ReturnType<
  typeof import('firebase/firestore').serverTimestamp
>;

function makeTs(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

function buildMinimalTextPdfBytes(lines: { x: number; y: number; text: string }[]): Uint8Array {
  const escapePdf = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const streamOps = lines
    .map(
      (line) =>
        `BT /F1 11 Tf 1 0 0 1 ${line.x} ${line.y} Tm (${escapePdf(line.text)}) Tj ET`,
    )
    .join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamOps, 'utf8')} >>\nstream\n${streamOps}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xrefPos = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'utf8'));
}

test('detectTimetableFileKind routes supported formats and rejects legacy .hwp', () => {
  assert.equal(detectTimetableFileKind('2026시간표.xlsx'), 'excel');
  assert.equal(detectTimetableFileKind('시간표.XLS'), 'excel');
  assert.equal(detectTimetableFileKind('시간표.hwpx'), 'hwpx');
  assert.equal(detectTimetableFileKind('시간표.pdf'), 'pdf');
  assert.equal(detectTimetableFileKind('캡처.png'), 'image');
  assert.equal(detectTimetableFileKind('사진.jpeg'), 'image');
  assert.equal(detectTimetableFileKind('구형문서.hwp'), 'legacy_hwp');
  assert.equal(detectTimetableFileKind('memo.txt'), 'unsupported');
});

test('parseTimetableCellText follows Section 4 rules (3-1 -> className, empty -> blank free without inserting 공강)', () => {
  const classOnly = parseTimetableCellText('3-1');
  assert.equal(classOnly.kind, 'class');
  assert.equal(classOnly.className, '3-1');
  assert.equal(classOnly.subject, '');
  assert.equal(classOnly.status, 'recognized');
  assert.equal(classOnly.workAvailable, false);

  const fullCell = parseTimetableCellText('국어(3-2) 과학실');
  assert.equal(fullCell.kind, 'class');
  assert.equal(fullCell.subject, '국어');
  assert.equal(fullCell.className, '3-2');
  assert.equal(fullCell.classroom, '과학실');

  const blankCell = parseTimetableCellText('   ');
  assert.equal(blankCell.kind, 'free');
  assert.equal(blankCell.subject, '');
  assert.equal(blankCell.status, 'empty');
  assert.equal(blankCell.workAvailable, false);
});

test('Excel parser handles .xlsx and .xls, leaves blank cells empty without inserting 공강, and flags merged cells', () => {
  const aoa = [
    ['교시', '시간', '월요일', '화요일', '수요일', '목요일', '금요일'],
    ['1교시', '08:50~09:35', '국어\n3-1\n301호', '', '국어 3-2 302호', '동아리 회의', '3-4'],
    ['2교시', '09:45~10:30', '국어\n3-1\n301호', '국어 3-3', '공강', '수학 1-2', ''],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // Merge 월 1교시~2교시 (row 1..2, col 2)
  sheet['!merges'] = [{ s: { r: 1, c: 2 }, e: { r: 2, c: 2 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '1학기시간표');

  for (const bookType of ['xlsx', 'biff8'] as const) {
    const rawOut = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer;
    const preview = parseTimetableFromExcelBuffer(rawOut);

    assert.equal(preview.sourceType, 'excel');
    assert.equal(preview.extractionMode, 'excel');
    assert.equal(preview.periodCount, 2);
    assert.equal(preview.periodTimes['1'].startTime, '08:50');
    assert.equal(preview.periodTimes['1'].endTime, '09:35');

    // Merged Mon 1교시 flagged for confirmation
    const mon1 = preview.slots[makeSlotKey(1, 1)];
    assert.equal(mon1.subject, '국어');
    assert.equal(mon1.className, '3-1');
    assert.equal(mon1.classroom, '301호');
    assert.equal(preview.cellMeta[makeSlotKey(1, 1)].status, 'needs_confirmation');
    assert.ok(
      preview.cellMeta[makeSlotKey(1, 1)].reasons.some((r) => r.includes('병합')),
    );

    // Blank Tue 1교시 MUST stay empty without auto-inserting '공강' and workAvailable=false
    const tue1 = preview.slots[makeSlotKey(2, 1)];
    assert.equal(tue1.kind, 'free');
    assert.equal(tue1.subject, '');
    assert.equal(tue1.workAvailable, false);
    assert.equal(preview.cellMeta[makeSlotKey(2, 1)].status, 'empty');

    // Class-only cell '3-4' on Fri 1교시 -> className='3-4', subject=''
    const fri1 = preview.slots[makeSlotKey(5, 1)];
    assert.equal(fri1.kind, 'class');
    assert.equal(fri1.className, '3-4');
    assert.equal(fri1.subject, '');

    // Explicit '공강' text on Wed 2교시 -> preserved as subject='공강', workAvailable=false
    const wed2 = preview.slots[makeSlotKey(3, 2)];
    assert.equal(wed2.kind, 'free');
    assert.equal(wed2.subject, '공강');
    assert.equal(wed2.workAvailable, false);

    // Fixed duty keyword flagged for confirmation
    const thu1 = preview.slots[makeSlotKey(4, 1)];
    assert.equal(thu1.kind, 'fixed_duty');
    assert.equal(preview.cellMeta[makeSlotKey(4, 1)].needsConfirmation, true);
  }
});

test('HWPX parser reads Contents/section0.xml tables, ranks timetable table first, parses 3-1/empty/merged cells, and supports table switching', async () => {
  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
  <hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
    <hp:p>
      <hp:run>
        <hp:tbl rowCnt="2" colCnt="2">
          <hp:tr>
            <hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>문서번호</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>2026-11</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          </hp:tr>
          <hp:tr>
            <hp:tc><hp:cellAddr colAddr="0" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>담당</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="1" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>교무부</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          </hp:tr>
        </hp:tbl>
      </hp:run>
    </hp:p>
    <hp:p>
      <hp:run>
        <hp:tbl rowCnt="3" colCnt="7">
          <hp:tr>
            <hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>교시</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>시각</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="2" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>월</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="3" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>화</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="4" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>수</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="5" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>목</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="6" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>금</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          </hp:tr>
          <hp:tr>
            <hp:tc><hp:cellAddr colAddr="0" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>1교시</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="1" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>08:50~09:35</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="2" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>3-1</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="3" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t></hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="4" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>3-4</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="5" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>3-1</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="6" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="2"/><hp:subList><hp:p><hp:run><hp:t>국어</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>3-2</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>과학실</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          </hp:tr>
          <hp:tr>
            <hp:tc><hp:cellAddr colAddr="0" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>2교시</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="1" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>09:45~10:30</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="2" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>3-2</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="3" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>국어(3-3)</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="4" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t></hp:t></hp:run></hp:p></hp:subList></hp:tc>
            <hp:tc><hp:cellAddr colAddr="5" rowAddr="2"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>3-4</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          </hp:tr>
        </hp:tbl>
      </hp:run>
    </hp:p>
  </hs:sec>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip');
  zip.file('Contents/section0.xml', sectionXml);
  const hwpxBuffer = await zip.generateAsync({ type: 'uint8array' });

  const { tables, preview } = await parseTimetableFromHwpxBuffer(hwpxBuffer);
  assert.equal(tables.length, 2);
  assert.equal(preview.sourceType, 'hwpx');
  assert.equal(preview.extractionMode, 'hwpx_xml');
  assert.equal(preview.selectedTableId, 'hwpx_table_1');
  assert.equal(preview.tableOptions?.length, 2);
  assert.equal(preview.periodCount, 2);
  assert.equal(preview.periodTimes['1'].startTime, '08:50');
  assert.equal(preview.periodTimes['1'].endTime, '09:35');

  // Row 1 example: 월 3-1, 화 blank, 수 3-4, 목 3-1
  const mon1 = preview.slots[makeSlotKey(1, 1)];
  assert.equal(mon1.kind, 'class');
  assert.equal(mon1.className, '3-1');
  assert.equal(mon1.subject, '');
  assert.equal(preview.cellMeta[makeSlotKey(1, 1)].status, 'recognized');

  const tue1 = preview.slots[makeSlotKey(2, 1)];
  assert.equal(tue1.kind, 'free');
  assert.equal(tue1.subject, '');
  assert.equal(tue1.workAvailable, false);
  assert.equal(preview.cellMeta[makeSlotKey(2, 1)].status, 'empty');

  const wed1 = preview.slots[makeSlotKey(3, 1)];
  assert.equal(wed1.className, '3-4');

  // Merged Fri 1~2교시 cell: subject/className/classroom parsed AND flagged as needs_confirmation
  const fri1 = preview.slots[makeSlotKey(5, 1)];
  assert.equal(fri1.subject, '국어');
  assert.equal(fri1.className, '3-2');
  assert.equal(fri1.classroom, '과학실');
  assert.equal(preview.cellMeta[makeSlotKey(5, 1)].status, 'needs_confirmation');

  // Switching to table 0 works and flags missing weekday structure as recognition_failed
  const switched = buildHwpxPreviewFromTables(tables, 'hwpx_table_0');
  assert.equal(switched.selectedTableId, 'hwpx_table_0');
  assert.ok(switched.recognitionFailedCount > 0);
});

test('Text PDF coordinate parser aligns Mon-Fri x period, extracts times and 3-1 classes, and distinguishes empty vs recognition_failed', () => {
  const preview = parseTimetableFromPdfPageTokens({
    pageNumber: 1,
    width: 600,
    height: 800,
    tokens: [
      { text: '월', x: 140, topY: 40, width: 20, height: 14 },
      { text: '화', x: 220, topY: 40, width: 20, height: 14 },
      { text: '수', x: 300, topY: 40, width: 20, height: 14 },
      { text: '목', x: 380, topY: 40, width: 20, height: 14 },
      { text: '금', x: 460, topY: 40, width: 20, height: 14 },
      // 1교시
      { text: '1교시', x: 40, topY: 100, width: 35, height: 14 },
      { text: '08:50~09:35', x: 80, topY: 100, width: 50, height: 12 },
      { text: '3-1', x: 138, topY: 100, width: 24, height: 14 },
      // 화 1교시 intentionally blank -> status 'empty'
      { text: '국어', x: 298, topY: 96, width: 26, height: 12 },
      { text: '3-2', x: 298, topY: 110, width: 24, height: 12 },
      { text: '302호', x: 294, topY: 124, width: 32, height: 12 },
      { text: '3-4', x: 378, topY: 100, width: 24, height: 14 },
      // 2교시
      { text: '2교시', x: 40, topY: 170, width: 35, height: 14 },
      { text: '3-2', x: 218, topY: 170, width: 24, height: 14 },
    ],
  });

  assert.equal(preview.sourceType, 'pdf');
  assert.equal(preview.extractionMode, 'pdf_text');
  assert.equal(preview.periodCount, 2);
  assert.equal(preview.periodTimes['1'].startTime, '08:50');
  assert.equal(preview.periodTimes['1'].endTime, '09:35');
  assert.equal(preview.recognitionFailedCount, 0);

  const mon1 = preview.slots[makeSlotKey(1, 1)];
  assert.equal(mon1.kind, 'class');
  assert.equal(mon1.className, '3-1');
  assert.equal(mon1.subject, '');

  const tue1 = preview.slots[makeSlotKey(2, 1)];
  assert.equal(tue1.kind, 'free');
  assert.equal(tue1.subject, '');
  assert.equal(preview.cellMeta[makeSlotKey(2, 1)].status, 'empty');

  const wed1 = preview.slots[makeSlotKey(3, 1)];
  assert.equal(wed1.subject, '국어');
  assert.equal(wed1.className, '3-2');
  assert.equal(wed1.classroom, '302호');

  // Missing Friday header should mark Friday cells as recognition_failed while keeping Mon empty cells clean
  const partialPreview = parseTimetableFromPdfPageTokens({
    pageNumber: 1,
    width: 600,
    height: 800,
    tokens: [
      { text: '월', x: 140, topY: 40, width: 20, height: 14 },
      { text: '화', x: 220, topY: 40, width: 20, height: 14 },
      { text: '1교시', x: 40, topY: 100, width: 35, height: 14 },
      { text: '3-1', x: 138, topY: 100, width: 24, height: 14 },
    ],
  });
  assert.equal(partialPreview.cellMeta[makeSlotKey(2, 1)].status, 'empty');
  assert.equal(partialPreview.cellMeta[makeSlotKey(5, 1)].status, 'recognition_failed');
  assert.ok(partialPreview.recognitionFailedCount > 0);
});

test('parseTimetableFromPdfBuffer extracts text tokens end-to-end from a real PDF byte stream via pdfjs-dist', async () => {
  const pdfBytes = buildMinimalTextPdfBytes([
    { x: 120, y: 720, text: 'Mon' },
    { x: 200, y: 720, text: 'Tue' },
    { x: 280, y: 720, text: 'Wed' },
    { x: 360, y: 720, text: 'Thu' },
    { x: 440, y: 720, text: 'Fri' },
    { x: 40, y: 660, text: '1' },
    { x: 120, y: 660, text: '3-1' },
    { x: 280, y: 660, text: '3-4' },
    { x: 360, y: 660, text: '3-1' },
  ]);

  const preview = await parseTimetableFromPdfBuffer(pdfBytes);
  assert.equal(preview.sourceType, 'pdf');
  assert.equal(preview.extractionMode, 'pdf_text');
  assert.equal(preview.pageCount, 1);
  assert.equal(preview.slots[makeSlotKey(1, 1)].className, '3-1');
  assert.equal(preview.slots[makeSlotKey(2, 1)].kind, 'free');
  assert.equal(preview.slots[makeSlotKey(2, 1)].subject, '');
  assert.equal(preview.cellMeta[makeSlotKey(2, 1)].status, 'empty');
  assert.equal(preview.slots[makeSlotKey(3, 1)].className, '3-4');
  assert.equal(preview.slots[makeSlotKey(4, 1)].className, '3-1');
});

test('OCR bounding-box parser aligns rows and Mon-Fri columns geometrically and never fabricates missing headers', () => {
  const words = [
    // Header row y=20..40
    { text: '월', confidence: 95, bbox: { x0: 120, y0: 20, x1: 140, y1: 40 } },
    { text: '화', confidence: 95, bbox: { x0: 220, y0: 20, x1: 240, y1: 40 } },
    { text: '수', confidence: 95, bbox: { x0: 320, y0: 20, x1: 340, y1: 40 } },
    { text: '목', confidence: 95, bbox: { x0: 420, y0: 20, x1: 440, y1: 40 } },
    { text: '금', confidence: 95, bbox: { x0: 520, y0: 20, x1: 540, y1: 40 } },
    // Row 1 (1교시) y=80..110
    { text: '1교시', confidence: 92, bbox: { x0: 20, y0: 85, x1: 65, y1: 105 } },
    { text: '수학', confidence: 90, bbox: { x0: 115, y0: 82, x1: 145, y1: 98 } },
    { text: '2-1', confidence: 88, bbox: { x0: 118, y0: 100, x1: 142, y1: 114 } },
    // Wide spanning token across 수~목 -> should trigger span confirmation
    { text: '교직원전체행사합반', confidence: 85, bbox: { x0: 300, y0: 85, x1: 455, y1: 105 } },
    // Row 2 (2교시) y=140..170 with low confidence token
    { text: '2교시', confidence: 92, bbox: { x0: 20, y0: 145, x1: 65, y1: 165 } },
    { text: '과학', confidence: 48, bbox: { x0: 515, y0: 145, x1: 545, y1: 165 } },
  ];

  const preview = parseTimetableFromOcrData({
    words,
    text: '월 화 수 목 금\n1교시 수학 2-1\n2교시 과학',
    confidence: 82,
  });

  assert.equal(preview.sourceType, 'ocr');
  assert.equal(preview.periodCount, 2);

  const mon1 = preview.slots[makeSlotKey(1, 1)];
  assert.equal(mon1.subject, '수학');
  assert.equal(mon1.className, '2-1');
  assert.equal(mon1.kind, 'class');
  assert.equal(preview.cellMeta[makeSlotKey(1, 1)].status, 'recognized');

  // Empty Tue 1교시 stays blank free with status 'empty'
  const tue1 = preview.slots[makeSlotKey(2, 1)];
  assert.equal(tue1.kind, 'free');
  assert.equal(tue1.subject, '');
  assert.equal(tue1.workAvailable, false);
  assert.equal(preview.cellMeta[makeSlotKey(2, 1)].status, 'empty');

  // Spanning token on Wed 1교시 flagged
  assert.equal(preview.cellMeta[makeSlotKey(3, 1)].needsConfirmation, true);

  // Low-confidence Fri 2교시 flagged
  const fri2 = preview.slots[makeSlotKey(5, 2)];
  assert.equal(fri2.subject, '과학');
  assert.equal(preview.cellMeta[makeSlotKey(5, 2)].needsConfirmation, true);

  // Unreadable image with no headers -> recognition_failed rather than guessing
  const brokenOcr = parseTimetableFromOcrData({
    words: [{ text: '흐릿한글자', confidence: 40, bbox: { x0: 10, y0: 10, x1: 50, y1: 30 } }],
    text: '흐릿한글자',
    confidence: 40,
  });
  assert.ok(brokenOcr.recognitionFailedCount > 0);
  assert.equal(brokenOcr.cellMeta[makeSlotKey(1, 1)].status, 'recognition_failed');
});

test('resolveTimetableForDate isolates temporary single-date overrides and computeDayTimeAvailability honors explicit workAvailable and event overlaps', () => {
  const draft = createEmptyTimetableDraft('2026-11-16');
  draft.periodCount = 5;
  draft.slots[makeSlotKey(1, 1)] = {
    day: 1,
    period: 1,
    kind: 'class',
    subject: '국어',
    className: '3-1',
    classroom: '301호',
    note: '',
    workAvailable: false,
  };
  draft.slots[makeSlotKey(1, 2)] = {
    day: 1,
    period: 2,
    kind: 'free',
    subject: '',
    className: '',
    classroom: '',
    note: '',
    workAvailable: false,
  };
  draft.slots[makeSlotKey(1, 3)] = {
    day: 1,
    period: 3,
    kind: 'free',
    subject: '',
    className: '',
    classroom: '',
    note: '',
    workAvailable: true,
  };
  draft.slots[makeSlotKey(1, 4)] = {
    day: 1,
    period: 4,
    kind: 'fixed_duty',
    subject: '학년 협의',
    className: '',
    classroom: '교무실',
    note: '',
    workAvailable: false,
  };
  draft.slots[makeSlotKey(1, 5)] = {
    day: 1,
    period: 5,
    kind: 'class',
    subject: '국어',
    className: '3-2',
    classroom: '302호',
    note: '',
    workAvailable: false,
  };

  const timetable: TimetableRecord = {
    id: 'tt_2026_2',
    ...draft,
    version: 1,
    createdAt: makeTs('2026-08-15T00:00:00Z'),
    updatedAt: makeTs('2026-08-15T00:00:00Z'),
    schemaVersion: SCHEMA_VERSION,
  };

  const monResolved = resolveTimetableForDate('2026-11-16', [timetable], null);
  assert.equal(monResolved.hasOverride, false);
  assert.equal(monResolved.periods[0].subject, '국어');
  assert.equal(monResolved.periods[1].workAvailable, false);
  assert.equal(monResolved.periods[2].workAvailable, true);

  const events: CalendarEventRecord[] = [
    {
      id: 'ev_meeting',
      title: '학부모 전화 상담',
      startsAt: makeTs('2026-11-16T01:55:00Z'),
      endsAt: makeTs('2026-11-16T02:25:00Z'),
      allDay: false,
      location: '상담실',
      description: '',
      relatedTaskId: null,
      version: 1,
      createdAt: makeTs('2026-11-15T00:00:00Z'),
      updatedAt: makeTs('2026-11-15T00:00:00Z'),
      schemaVersion: SCHEMA_VERSION,
    },
  ];

  const avail = computeDayTimeAvailability({
    resolvedDay: monResolved,
    events,
  });

  assert.equal(avail.classMinutes, 90);
  assert.equal(avail.freeMinutes, 90);
  assert.equal(avail.freeWorkableMinutes, 45);
  assert.equal(avail.unscheduledWorkMinutes, 165);
  assert.equal(avail.workableConfiguredMinutes, 210);
  assert.equal(avail.overlappingEventMinutes, 30);
  assert.equal(avail.conflicts.length, 1);
  assert.equal(avail.conflicts[0].overlapsWith, 'workable');
  assert.equal(avail.netAvailableMinutes, 180);

  const override: TimetableOverrideRecord = {
    id: '2026-11-16',
    dateKey: '2026-11-16',
    baseTimetableId: 'tt_2026_2',
    reason: '보강 변경',
    workStart: null,
    workEnd: null,
    lunchStart: null,
    lunchEnd: null,
    periodTimes: {},
    slots: {
      '5': {
        period: 5,
        kind: 'free',
        subject: '보강 공강',
        className: '',
        classroom: '',
        note: '',
        workAvailable: true,
      },
    },
    version: 1,
    createdAt: makeTs('2026-11-15T00:00:00Z'),
    updatedAt: makeTs('2026-11-15T00:00:00Z'),
    schemaVersion: SCHEMA_VERSION,
  };

  const overriddenDay = resolveTimetableForDate('2026-11-16', [timetable], override);
  assert.equal(overriddenDay.hasOverride, true);
  assert.equal(overriddenDay.periods[4].kind, 'free');
  assert.equal(overriddenDay.periods[4].isOverridden, true);

  const nextWeekDay = resolveTimetableForDate('2026-11-23', [timetable], override);
  assert.equal(nextWeekDay.hasOverride, false);
  assert.equal(nextWeekDay.periods[4].kind, 'class');
  assert.equal(nextWeekDay.periods[4].subject, '국어');
});

test('Repository payload builders accept hwpx/pdf sources and enforce valid dates, times, and workAvailable=false on class/fixed_duty', () => {
  const draft = createEmptyTimetableDraft('2026-11-16');
  draft.sourceType = 'hwpx';
  draft.slots[makeSlotKey(1, 1)] = {
    day: 1,
    period: 1,
    kind: 'class',
    subject: '수학',
    className: '2-3',
    classroom: '203호',
    note: '',
    workAvailable: true,
  };

  const hwpxPayload = buildCreateTimetablePayload(draft, FAKE_SENTINEL);
  assert.equal(hwpxPayload.sourceType, 'hwpx');
  assert.equal(hwpxPayload.slots[makeSlotKey(1, 1)].workAvailable, false);
  assert.equal(hwpxPayload.version, 1);
  assert.equal(hwpxPayload.schemaVersion, SCHEMA_VERSION);

  const pdfPayload = buildCreateTimetablePayload(
    { ...draft, sourceType: 'pdf' },
    FAKE_SENTINEL,
  );
  assert.equal(pdfPayload.sourceType, 'pdf');

  assert.throws(
    () =>
      buildCreateTimetablePayload(
        { ...draft, effectiveFrom: '2026-12-01', effectiveTo: '2026-11-01' },
        FAKE_SENTINEL,
      ),
    TimetableValidationError,
  );

  assert.throws(
    () =>
      buildCreateTimetableOverridePayload(
        {
          dateKey: 'invalid-date',
          baseTimetableId: null,
          slots: {},
        },
        FAKE_SENTINEL,
      ),
    TimetableValidationError,
  );
});
