import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { Timestamp } from 'firebase/firestore';
import {
  computeDayTimeAvailability,
  createEmptyTimetableDraft,
  makeSlotKey,
  resolveTimetableForDate,
} from '../src/lib/timetable';
import { parseTimetableFromExcelBuffer } from '../src/lib/timetableExcelParser';
import { parseTimetableFromOcrData } from '../src/lib/timetableOcrParser';
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

test('Excel parser handles .xlsx and .xls, extracts period times, leaves free periods non-workable, and flags merged cells', () => {
  const aoa = [
    ['교시', '시간', '월요일', '화요일', '수요일', '목요일', '금요일'],
    ['1교시', '08:50~09:35', '국어\n3-1\n301호', '공강', '국어 3-2 302호', '동아리 회의', '영어 2-1'],
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
    assert.equal(preview.periodCount, 2);
    assert.equal(preview.periodTimes['1'].startTime, '08:50');
    assert.equal(preview.periodTimes['1'].endTime, '09:35');

    // Merged Mon 1교시 flagged for confirmation
    const mon1 = preview.slots[makeSlotKey(1, 1)];
    assert.equal(mon1.subject, '국어');
    assert.equal(mon1.className, '3-1');
    assert.equal(mon1.classroom, '301호');
    assert.equal(preview.cellMeta[makeSlotKey(1, 1)].needsConfirmation, true);
    assert.ok(
      preview.cellMeta[makeSlotKey(1, 1)].reasons.some((r) => r.includes('병합')),
    );

    // Free period on Tue 1교시 MUST NOT auto-mark workAvailable
    const tue1 = preview.slots[makeSlotKey(2, 1)];
    assert.equal(tue1.kind, 'free');
    assert.equal(tue1.workAvailable, false);

    // Fixed duty keyword flagged for confirmation
    const thu1 = preview.slots[makeSlotKey(4, 1)];
    assert.equal(thu1.kind, 'fixed_duty');
    assert.equal(preview.cellMeta[makeSlotKey(4, 1)].needsConfirmation, true);
  }
});

test('OCR bounding-box parser aligns rows and Mon-Fri columns geometrically and flags wide/low-confidence cells', () => {
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
    { text: '공강', confidence: 91, bbox: { x0: 215, y0: 85, x1: 245, y1: 105 } },
    // Wide spanning token across 수~목 -> should trigger span confirmation
    { text: '교직원전체행사합반', confidence: 85, bbox: { x0: 300, y0: 85, x1: 455, y1: 105 } },
    // Row 2 (2교시) y=140..170 with low confidence token
    { text: '2교시', confidence: 92, bbox: { x0: 20, y0: 145, x1: 65, y1: 165 } },
    { text: '과학', confidence: 48, bbox: { x0: 515, y0: 145, x1: 545, y1: 165 } },
  ];

  const preview = parseTimetableFromOcrData({
    words,
    text: '월 화 수 목 금\n1교시 수학 2-1 공강\n2교시 과학',
    confidence: 82,
  });

  assert.equal(preview.sourceType, 'ocr');
  assert.equal(preview.periodCount, 2);

  const mon1 = preview.slots[makeSlotKey(1, 1)];
  assert.equal(mon1.subject, '수학');
  assert.equal(mon1.className, '2-1');
  assert.equal(mon1.kind, 'class');
  assert.equal(preview.cellMeta[makeSlotKey(1, 1)].needsConfirmation, false);

  const tue1 = preview.slots[makeSlotKey(2, 1)];
  assert.equal(tue1.kind, 'free');
  assert.equal(tue1.workAvailable, false);

  // Spanning token on Wed 1교시 flagged
  assert.equal(preview.cellMeta[makeSlotKey(3, 1)].needsConfirmation, true);

  // Low-confidence Fri 2교시 flagged
  const fri2 = preview.slots[makeSlotKey(5, 2)];
  assert.equal(fri2.subject, '과학');
  assert.equal(preview.cellMeta[makeSlotKey(5, 2)].needsConfirmation, true);
});

test('resolveTimetableForDate isolates temporary single-date overrides and computeDayTimeAvailability honors explicit workAvailable and event overlaps', () => {
  // Base semester timetable: 2026-08-15 ~ 2027-02-28
  // Work hours 08:30~16:30, Lunch 12:20~13:20
  const draft = createEmptyTimetableDraft('2026-11-16');
  draft.periodCount = 5;
  // Monday (day=1):
  // 1교시 (08:50~09:35): 국어 수업 (45m)
  // 2교시 (09:45~10:30): 공강 with workAvailable = false (default -> NOT workable)
  // 3교시 (10:40~11:25): 공강 with workAvailable = true (45m workable)
  // 4교시 (11:35~12:20): 고정 업무 (학년 협의 45m -> NOT workable)
  // 5교시 (13:20~14:05): 국어 수업 (45m)
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

  // Monday 2026-11-16 (no override)
  const monResolved = resolveTimetableForDate('2026-11-16', [timetable], null);
  assert.equal(monResolved.hasOverride, false);
  assert.equal(monResolved.periods[0].subject, '국어');
  assert.equal(monResolved.periods[1].workAvailable, false);
  assert.equal(monResolved.periods[2].workAvailable, true);

  // Add a meeting on 2026-11-16 from 10:55 ~ 11:25 KST (01:55Z ~ 02:25Z), overlapping 30m of 3교시 workable free period!
  const events: CalendarEventRecord[] = [
    {
      id: 'ev_meeting',
      title: '학부모 전화 상담',
      startsAt: makeTs('2026-11-16T01:55:00Z'), // 10:55 KST
      endsAt: makeTs('2026-11-16T02:25:00Z'), // 11:25 KST
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

  // Class minutes: 1교시(45) + 5교시(45) = 90m
  assert.equal(avail.classMinutes, 90);
  // Free minutes: 2교시(45) + 3교시(45) = 90m
  assert.equal(avail.freeMinutes, 90);
  // Explicit free workable: ONLY 3교시 (45m), since 2교시 has workAvailable=false!
  assert.equal(avail.freeWorkableMinutes, 45);
  // Unscheduled work blocks inside 08:30~16:30 excluding periods & lunch:
  // 08:30~08:50 (20m) + 14:05~16:30 (145m) = 165m
  assert.equal(avail.unscheduledWorkMinutes, 165);
  // Total configured workable = 45 + 165 = 210m
  assert.equal(avail.workableConfiguredMinutes, 210);
  // Overlapping event = 30m (10:55~11:25)
  assert.equal(avail.overlappingEventMinutes, 30);
  assert.equal(avail.conflicts.length, 1);
  assert.equal(avail.conflicts[0].overlapsWith, 'workable');
  // Net available = 210 - 30 = 180m
  assert.equal(avail.netAvailableMinutes, 180);

  // Temporary override ONLY for 2026-11-16: swap 5교시 class to workable free period
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

  // Next Monday 2026-11-23 must remain unaffected!
  const nextWeekDay = resolveTimetableForDate('2026-11-23', [timetable], override);
  assert.equal(nextWeekDay.hasOverride, false);
  assert.equal(nextWeekDay.periods[4].kind, 'class');
  assert.equal(nextWeekDay.periods[4].subject, '국어');
});

test('Repository payload builders enforce valid dates, times, and force workAvailable=false on class/fixed_duty', () => {
  const draft = createEmptyTimetableDraft('2026-11-16');
  draft.slots[makeSlotKey(1, 1)] = {
    day: 1,
    period: 1,
    kind: 'class',
    subject: '수학',
    className: '2-3',
    classroom: '203호',
    note: '',
    workAvailable: true, // should be forced false!
  };

  const payload = buildCreateTimetablePayload(draft, FAKE_SENTINEL);
  assert.equal(payload.slots[makeSlotKey(1, 1)].workAvailable, false);
  assert.equal(payload.version, 1);
  assert.equal(payload.schemaVersion, SCHEMA_VERSION);

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
