import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  buildAcademicDedupeKey,
  buildAcademicPlannerSnapshot,
  classifyAcademicCategory,
  getAcademicEventsForDateKey,
  getKoreanSchoolYearForDateKey,
  suggestTimetableImpactForCategory,
  type AcademicEventDraft,
} from '../src/lib/academicCalendar';
import {
  extractAcademicFromExcelBuffer,
  extractAcademicFromHwpxBuffer,
  extractAcademicFromPdfBuffer,
  markDuplicatesOnCandidates,
  parseAcademicDateExpression,
} from '../src/lib/academicFileParser';
import { detectTimetableFileKind } from '../src/lib/timetableGridParser';
import {
  AcademicEventValidationError,
  buildCreateAcademicEventPayload,
} from '../src/repositories/academicOperations';
import type { AcademicEventRecord, TimetableOverrideRecord } from '../src/types/domain';
import type { Timestamp } from 'firebase/firestore';

function makeMockTimestamp(iso = '2026-03-01T00:00:00Z'): Timestamp {
  return {
    toDate: () => new Date(iso),
    toMillis: () => new Date(iso).getTime(),
  } as unknown as Timestamp;
}

function makeFakeAcademicRecord(
  overrides: Partial<AcademicEventRecord> & { id: string; title: string; startDate: string },
): AcademicEventRecord {
  const endDate = overrides.endDate ?? overrides.startDate;
  return {
    id: overrides.id,
    title: overrides.title,
    category: overrides.category ?? classifyAcademicCategory(overrides.title),
    startDate: overrides.startDate,
    endDate,
    startTime: overrides.startTime ?? null,
    endTime: overrides.endTime ?? null,
    location: overrides.location ?? '',
    schoolYear: overrides.schoolYear ?? getKoreanSchoolYearForDateKey(overrides.startDate),
    sourceType: overrides.sourceType ?? 'manual',
    sourceLabel: overrides.sourceLabel ?? '직접 입력',
    sourceText: overrides.sourceText ?? '',
    timetableImpact: overrides.timetableImpact ?? 'none',
    overrideDateKey: overrides.overrideDateKey ?? null,
    dedupeKey:
      overrides.dedupeKey ??
      buildAcademicDedupeKey(overrides.startDate, endDate, overrides.title),
    version: overrides.version ?? 1,
    createdAt: makeMockTimestamp(),
    updatedAt: makeMockTimestamp(),
    schemaVersion: 1,
  };
}

/**
 * Generates a minimal valid single-page PDF with ASCII/numeric text via Tj operators
 * using standard Helvetica font for real pdfjs-dist parser verification.
 */
function buildMinimalAsciiPdfBytes(lines: string[]): Uint8Array {
  const streamLines = ['BT', '/F1 11 Tf'];
  let y = 760;
  for (const line of lines) {
    const escaped = line
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
    streamLines.push(`1 0 0 1 50 ${y} Tm (${escaped}) Tj`);
    y -= 20;
  }
  streamLines.push('ET');
  const streamBody = streamLines.join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

test('detectTimetableFileKind distinguishes pdf/excel/hwpx/image and legacy hwp', () => {
  assert.equal(detectTimetableFileKind('2026_학사일정.pdf'), 'pdf');
  assert.equal(detectTimetableFileKind('2026_학사일정.xlsx'), 'excel');
  assert.equal(detectTimetableFileKind('2026_학사일정.xls'), 'excel');
  assert.equal(detectTimetableFileKind('학사일정.hwpx'), 'hwpx');
  assert.equal(detectTimetableFileKind('scan.png'), 'image');
  assert.equal(detectTimetableFileKind('scan.JPG'), 'image');
  assert.equal(detectTimetableFileKind('old_schedule.hwp'), 'legacy_hwp');
});

test('classifyAcademicCategory and Korean schoolYear behave deterministically', () => {
  assert.equal(classifyAcademicCategory('1학기 중간고사'), 'exam');
  assert.equal(classifyAcademicCategory('체육대회'), 'school_event');
  assert.equal(classifyAcademicCategory('여름방학식'), 'vacation');
  assert.equal(classifyAcademicCategory('학교장 재량휴업일'), 'discretionary_holiday');
  assert.equal(classifyAcademicCategory('단축수업 운영 (4교시)'), 'shortened_schedule');
  assert.equal(classifyAcademicCategory('특별 점검일'), 'other');

  assert.equal(getKoreanSchoolYearForDateKey('2026-03-02'), 2026);
  assert.equal(getKoreanSchoolYearForDateKey('2026-12-28'), 2026);
  assert.equal(getKoreanSchoolYearForDateKey('2027-01-15'), 2026);
  assert.equal(getKoreanSchoolYearForDateKey('2027-02-20'), 2026);

  // Vacation never auto-assumes teacher off-duty or timetable override
  assert.equal(suggestTimetableImpactForCategory('vacation'), 'none');
  assert.equal(suggestTimetableImpactForCategory('exam'), 'needs_check');
});

test('parseAcademicDateExpression resolves school year and flags missing year as uncertain', () => {
  // 2026학년도: May -> 2026, Feb -> 2027
  const resMay = parseAcademicDateExpression(
    '5. 11.(월) ~ 5. 13.(수) 1학기 중간고사',
    { schoolYear: 2026, explicitYear: null },
  );
  assert.ok(resMay);
  assert.equal(resMay.uncertainYear, false);
  assert.equal(resMay.startDate, '2026-05-11');
  assert.equal(resMay.endDate, '2026-05-13');
  assert.equal(resMay.remainderText, '1학기 중간고사');

  const resFeb = parseAcademicDateExpression('2. 10.(수) 종업식 및 졸업식', {
    schoolYear: 2026,
    explicitYear: null,
  });
  assert.ok(resFeb);
  assert.equal(resFeb.startDate, '2027-02-10');

  // Missing year -> must NOT guess
  const resUnknown = parseAcademicDateExpression('5. 15.(금) 스승의 날 행사', {
    schoolYear: null,
    explicitYear: null,
  });
  assert.ok(resUnknown);
  assert.equal(resUnknown.uncertainYear, true);
  assert.equal(resUnknown.startDate, '');
});

test('extractAcademicFromExcelBuffer parses annual month matrix and coalesces multi-day events', () => {
  const wb = XLSX.utils.book_new();
  const rows = [
    ['2026학년도 연간 학사일정표', '', '', ''],
    ['일', '3월', '5월', '2월'],
    ['2', '입학식 및 시업식', '', ''],
    ['11', '', '1학기 중간고사', ''],
    ['12', '', '1학기 중간고사', ''],
    ['13', '', '1학기 중간고사', ''],
    ['10', '', '', '졸업식(대강당)'],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, '연간일정');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const preview = extractAcademicFromExcelBuffer(buf, {
    fileName: '2026학년도_학사일정.xlsx',
  });

  assert.equal(preview.sourceType, 'excel');
  assert.equal(preview.detectedSchoolYear, 2026);
  assert.equal(preview.candidates.length, 3);

  const entrance = preview.candidates.find((c) => c.title.includes('입학식'));
  assert.ok(entrance);
  assert.equal(entrance.startDate, '2026-03-02');
  assert.equal(entrance.category, 'school_event');

  const exam = preview.candidates.find((c) => c.title.includes('중간고사'));
  assert.ok(exam);
  assert.equal(exam.startDate, '2026-05-11');
  assert.equal(exam.endDate, '2026-05-13');
  assert.equal(exam.category, 'exam');

  const grad = preview.candidates.find((c) => c.title.includes('졸업식'));
  assert.ok(grad);
  assert.equal(grad.startDate, '2027-02-10');
  assert.equal(grad.location, '대강당');
});

test('extractAcademicFromExcelBuffer marks missing year items as needsConfirmation without auto-selecting', () => {
  const wb = XLSX.utils.book_new();
  const rows = [
    ['날짜', '행사명', '장소'],
    ['5.15.', '체육대회', '운동장'],
    ['2026.07.20.', '여름방학식', '각 교실'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '목록');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const preview = extractAcademicFromExcelBuffer(buf, {
    fileName: '학사일정_연도미상.xlsx',
  });

  assert.equal(preview.candidates.length, 2);
  const sportsDay = preview.candidates.find((c) => c.title === '체육대회');
  assert.ok(sportsDay);
  assert.equal(sportsDay.needsConfirmation, true);
  assert.equal(sportsDay.selected, false);
  assert.equal(sportsDay.startDate, '');

  const vac = preview.candidates.find((c) => c.title === '여름방학식');
  assert.ok(vac);
  assert.equal(vac.startDate, '2026-07-20');
  assert.equal(vac.needsConfirmation, false);
  assert.equal(vac.selected, true);
});

test('extractAcademicFromHwpxBuffer parses HWPX header year and monthly calendar table', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
    <hp:p><hp:run><hp:t>2026학년도 5월 학사일정</hp:t></hp:run></hp:p>
    <hp:tbl>
      <hp:tr>
        <hp:tc><hp:p><hp:run><hp:t>월</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>화</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>수</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>목</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>금</hp:t></hp:run></hp:p></hp:tc>
      </hp:tr>
      <hp:tr>
        <hp:tc><hp:p><hp:run><hp:t>11</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>중간고사</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>12</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>중간고사</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>13</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>14</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>단축수업 운영 09:00~12:30</hp:t></hp:run></hp:p></hp:tc>
        <hp:tc><hp:p><hp:run><hp:t>15</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>재량휴업일</hp:t></hp:run></hp:p></hp:tc>
      </hp:tr>
    </hp:tbl>
  </hs:sec>`;

  const zip = new JSZip();
  zip.file('Contents/section0.xml', xml);
  const buf = await zip.generateAsync({ type: 'uint8array' });

  const preview = await extractAcademicFromHwpxBuffer(buf, {
    fileName: '5월_학사일정.hwpx',
  });

  assert.equal(preview.sourceType, 'hwpx');
  assert.equal(preview.detectedSchoolYear, 2026);
  assert.equal(preview.candidates.length, 3);

  const exam = preview.candidates.find((c) => c.title === '중간고사');
  assert.ok(exam);
  assert.equal(exam.startDate, '2026-05-11');
  assert.equal(exam.endDate, '2026-05-12');

  const shortened = preview.candidates.find((c) => c.category === 'shortened_schedule');
  assert.ok(shortened);
  assert.equal(shortened.startDate, '2026-05-14');
  assert.equal(shortened.startTime, '09:00');
  assert.equal(shortened.endTime, '12:30');

  const holiday = preview.candidates.find((c) => c.category === 'discretionary_holiday');
  assert.ok(holiday);
  assert.equal(holiday.startDate, '2026-05-15');
});

test('extractAcademicFromPdfBuffer extracts academic dates and titles from real PDF binary', async () => {
  const pdfBytes = buildMinimalAsciiPdfBytes([
    '2026-05-11 ~ 2026-05-13 Midterm Exam Period',
    '2026-10-16 School Festival',
  ]);
  const preview = await extractAcademicFromPdfBuffer(pdfBytes, {
    fileName: '2026_academic.pdf',
  });

  assert.equal(preview.sourceType, 'pdf');
  assert.equal(preview.extractionMode, 'pdf_text');
  assert.equal(preview.candidates.length, 2);
  assert.equal(preview.candidates[0].startDate, '2026-05-11');
  assert.equal(preview.candidates[0].endDate, '2026-05-13');
  assert.equal(preview.candidates[1].startDate, '2026-10-16');
});

test('markDuplicatesOnCandidates detects both existing Firestore duplicates and batch duplicates', () => {
  const existing = [
    makeFakeAcademicRecord({
      id: 'saved-1',
      title: '1학기 중간고사',
      startDate: '2026-05-11',
      endDate: '2026-05-13',
    }),
  ];

  const wb = XLSX.utils.book_new();
  const rows = [
    ['2026학년도', '행사'],
    ['2026.05.11 ~ 2026.05.13', '1학기 중간고사'],
    ['2026.06.05', '체육대회'],
    ['2026.06.05', '체육대회'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '일정');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const preview = extractAcademicFromExcelBuffer(buf, {
    fileName: '중복확인.xlsx',
    existingEvents: existing,
  });

  assert.equal(preview.candidates.length, 3);
  assert.equal(preview.candidates[0].isDuplicate, true);
  assert.equal(preview.candidates[0].selected, false);
  assert.equal(preview.candidates[1].isDuplicate, false);
  assert.equal(preview.candidates[1].selected, true);
  assert.equal(preview.candidates[2].isDuplicate, true);
  assert.equal(preview.candidates[2].selected, false);
});

test('getAcademicEventsForDateKey and buildAcademicPlannerSnapshot summarize cleanly without AI', () => {
  const records: AcademicEventRecord[] = [
    makeFakeAcademicRecord({
      id: 'a1',
      title: '1학기 기말고사',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      category: 'exam',
      timetableImpact: 'needs_check',
    }),
    makeFakeAcademicRecord({
      id: 'a2',
      title: '단축수업',
      startDate: '2026-07-06',
      category: 'shortened_schedule',
      timetableImpact: 'override_applied',
      overrideDateKey: '2026-07-06',
    }),
    makeFakeAcademicRecord({
      id: 'a3',
      title: '여름방학',
      startDate: '2026-07-21',
      endDate: '2026-08-18',
      category: 'vacation',
      timetableImpact: 'none',
    }),
  ];

  // Range overlap matching
  assert.equal(getAcademicEventsForDateKey(records, '2026-07-02').length, 1);
  assert.equal(getAcademicEventsForDateKey(records, '2026-07-02')[0].id, 'a1');
  assert.equal(getAcademicEventsForDateKey(records, '2026-07-04').length, 0);

  const overridesByDate: Record<string, TimetableOverrideRecord> = {
    '2026-07-06': {
      id: '2026-07-06',
      dateKey: '2026-07-06',
      baseTimetableId: 'tt1',
      reason: '단축수업',
      workStart: null,
      workEnd: null,
      lunchStart: null,
      lunchEnd: null,
      periodTimes: {},
      slots: {},
      version: 1,
      createdAt: makeMockTimestamp(),
      updatedAt: makeMockTimestamp(),
      schemaVersion: 1,
    },
  };

  const snap = buildAcademicPlannerSnapshot({
    academicEvents: records,
    overridesByDate,
    todayKey: '2026-07-02', // Thursday
    horizonDays: 30,
  });

  assert.equal(snap.todayAcademicEvents.length, 1);
  assert.equal(snap.todayAcademicEvents[0].title, '1학기 기말고사');
  assert.equal(snap.examPeriods.length, 1);
  assert.deepEqual(snap.overrideAppliedDates, ['2026-07-06']);
  assert.equal(snap.overrideNeededDates.length, 1);
  assert.equal(snap.overrideNeededDates[0].academicEventId, 'a1');
  assert.equal(snap.availabilityImpactingEvents.length, 3);
});

test('buildCreateAcademicEventPayload enforces date/time bounds and dedupeKey integrity', () => {
  const validDraft: AcademicEventDraft = {
    title: '학부모 공개수업',
    category: 'school_event',
    startDate: '2026-09-18',
    endDate: '2026-09-18',
    startTime: '13:30',
    endTime: '15:20',
    location: '각 교실',
    schoolYear: 2026,
    sourceType: 'manual',
    sourceLabel: '직접 입력',
    sourceText: '',
    timetableImpact: 'needs_check',
    overrideDateKey: null,
  };

  const payload = buildCreateAcademicEventPayload(validDraft);
  assert.equal(payload.title, '학부모 공개수업');
  assert.equal(payload.version, 1);
  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.dedupeKey.startsWith('2026-09-18|2026-09-18|'));

  // Reject endDate < startDate
  assert.throws(
    () =>
      buildCreateAcademicEventPayload({
        ...validDraft,
        startDate: '2026-09-20',
        endDate: '2026-09-18',
      }),
    AcademicEventValidationError,
  );

  // Reject endTime <= startTime
  assert.throws(
    () =>
      buildCreateAcademicEventPayload({
        ...validDraft,
        startTime: '15:00',
        endTime: '14:00',
      }),
    AcademicEventValidationError,
  );

  // Verify markDuplicatesOnCandidates also preserves valid helper import
  const rechecked = markDuplicatesOnCandidates([], []);
  assert.equal(rechecked.length, 0);
});
