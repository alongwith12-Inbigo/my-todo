import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTodayEvents,
  doesEventOverlapDateKey,
  getCalendarRangeForMonth,
  getCalendarRangeForWeek,
  getEventsForDateKey,
} from '../src/lib/calendar';
import {
  formatKstEventTimeRange,
  getKstDateParts,
  getKstMonthGridDays,
  getKstWeekDays,
  parseKstAllDayRange,
  parseKstDateTimeInput,
} from '../src/lib/dateKst';
import type { CalendarEventRecord } from '../src/types/domain';

function ts(iso: string) {
  const date = new Date(iso);
  return {
    toMillis: () => date.getTime(),
    toDate: () => date,
  } as unknown as CalendarEventRecord['startsAt'];
}

function makeEvent(
  id: string,
  overrides: Partial<CalendarEventRecord> = {},
): CalendarEventRecord {
  return {
    id,
    title: `일정 ${id}`,
    startsAt: ts('2026-05-15T01:00:00Z'),
    endsAt: ts('2026-05-15T02:00:00Z'),
    allDay: false,
    location: '',
    description: '',
    relatedTaskId: null,
    version: 1,
    createdAt: ts('2026-05-01T00:00:00Z'),
    updatedAt: ts('2026-05-01T00:00:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

// 2026-05-15 10:00:00 KST (01:00:00 UTC)
const NOW = new Date('2026-05-15T01:00:00Z');

test('KST timed & all-day event parsing aligns cleanly with Asia/Seoul', () => {
  const start = parseKstDateTimeInput('2026-05-15', '09:30');
  const end = parseKstDateTimeInput('2026-05-15', '11:00');
  assert.equal(start.toISOString(), '2026-05-15T00:30:00.000Z');
  assert.equal(end.toISOString(), '2026-05-15T02:00:00.000Z');
  assert.equal(formatKstEventTimeRange(start, end, false), '09:30 ~ 11:00');

  const allDay = parseKstAllDayRange('2026-05-15', '2026-05-15');
  assert.equal(getKstDateParts(allDay.startsAt).dateKey, '2026-05-15');
  assert.equal(getKstDateParts(allDay.endsAt).dateKey, '2026-05-15');
  assert.equal(formatKstEventTimeRange(allDay.startsAt, allDay.endsAt, true), '종일');

  assert.throws(() => parseKstAllDayRange('2026-05-16', '2026-05-15'));
  assert.throws(() => parseKstDateTimeInput('2026-05-15', '25:00'));
});

test('month grid and week day generation produce valid KST date keys', () => {
  const cells = getKstMonthGridDays(2026, 5);
  assert.ok(cells.length === 35 || cells.length === 42);
  assert.equal(cells.filter((c) => c.inMonth).length, 31);
  assert.equal(cells[0].dateKey, '2026-04-26');

  const week = getKstWeekDays('2026-05-15');
  assert.deepEqual(week, [
    '2026-05-10',
    '2026-05-11',
    '2026-05-12',
    '2026-05-13',
    '2026-05-14',
    '2026-05-15',
    '2026-05-16',
  ]);

  const monthRange = getCalendarRangeForMonth(2026, 5);
  const weekRange = getCalendarRangeForWeek('2026-05-15');
  assert.ok(monthRange.startMs < weekRange.startMs);
  assert.ok(monthRange.endMs > weekRange.endMs);
});

test('multi-day events overlap every spanned KST date and classifyTodayEvents guarantees zero duplicates', () => {
  // Multi-day event from 2026-05-14 all day through 2026-05-16
  const multiDay = makeEvent('ev-multi', {
    allDay: true,
    startsAt: ts('2026-05-13T15:00:00Z'), // May 14 00:00 KST
    endsAt: ts('2026-05-16T14:59:59Z'), // May 16 23:59 KST
  });

  // Timed event starting in 45 min (10:45 ~ 11:30 KST)
  const soonEvent = makeEvent('ev-soon', {
    startsAt: ts('2026-05-15T01:45:00Z'),
    endsAt: ts('2026-05-15T02:30:00Z'),
  });

  // Timed event later today (15:00 ~ 16:00 KST)
  const laterToday = makeEvent('ev-later', {
    startsAt: ts('2026-05-15T06:00:00Z'),
    endsAt: ts('2026-05-15T07:00:00Z'),
  });

  // Future event in 2 days
  const upcoming = makeEvent('ev-upcoming', {
    startsAt: ts('2026-05-17T01:00:00Z'),
    endsAt: ts('2026-05-17T02:00:00Z'),
  });

  assert.equal(doesEventOverlapDateKey(multiDay, '2026-05-14'), true);
  assert.equal(doesEventOverlapDateKey(multiDay, '2026-05-15'), true);
  assert.equal(doesEventOverlapDateKey(multiDay, '2026-05-16'), true);
  assert.equal(doesEventOverlapDateKey(multiDay, '2026-05-17'), false);

  const may15Events = getEventsForDateKey(
    [laterToday, soonEvent, multiDay, upcoming],
    '2026-05-15',
  );
  assert.deepEqual(
    may15Events.map((e) => e.id),
    ['ev-multi', 'ev-soon', 'ev-later'],
  );

  const summary = classifyTodayEvents(
    [multiDay, soonEvent, soonEvent, laterToday, upcoming],
    { now: NOW, soonMinutes: 120, upcomingDays: 7 },
  );
  assert.deepEqual(
    summary.startingSoon.map((e) => e.id),
    ['ev-soon'],
  );
  assert.deepEqual(
    summary.otherToday.map((e) => e.id),
    ['ev-multi', 'ev-later'],
  );
  // Multi-day overlapping today must NOT duplicate into upcoming
  assert.deepEqual(
    summary.upcoming.map((e) => e.id),
    ['ev-upcoming'],
  );
  assert.equal(summary.totalTodayCount, 3);
});
