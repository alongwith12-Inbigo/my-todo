import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTodaySituationBriefing,
  classifyTodayBriefing,
  compareTasksByPriority,
  sortTasks,
} from '../src/lib/briefing';
import { detectTodayEventOverlaps } from '../src/lib/calendar';
import {
  addKstDaysToDateKey,
  getKstDateInputValue,
  getKstDayBounds,
  parseKstDateInput,
} from '../src/lib/dateKst';
import type { CalendarEventRecord, TaskRecord } from '../src/types/domain';

function ts(iso: string) {
  const date = new Date(iso);
  return {
    toMillis: () => date.getTime(),
    toDate: () => date,
  } as unknown as TaskRecord['dueAt'];
}

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `업무 ${id}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: null,
    scheduledAt: null,
    remindAt: null,
    completedAt: null,
    sourceType: 'manual',
    relatedEventId: null,
    isDeleted: false,
    deletedAt: null,
    version: 1,
    createdAt: ts('2026-05-01T00:00:00Z')!,
    updatedAt: ts('2026-05-01T00:00:00Z')!,
    schemaVersion: 1,
    ...overrides,
  };
}

// Fixed "now": 2026-05-15 10:00:00 KST (01:00:00 UTC)
const NOW = new Date('2026-05-15T01:00:00Z');

test('KST date parsing and day bounds align with Asia/Seoul midnight', () => {
  const bounds = getKstDayBounds(NOW, 3);
  assert.equal(bounds.todayKey, '2026-05-15');
  assert.equal(addKstDaysToDateKey('2026-05-15', 3), '2026-05-18');

  const due = parseKstDateInput('2026-05-15', 'due');
  assert.ok(due);
  assert.equal(getKstDateInputValue(due), '2026-05-15');
  assert.ok(due.getTime() >= bounds.startOfTodayMs && due.getTime() <= bounds.endOfTodayMs);

  const remind = parseKstDateInput('2026-05-15', 'remind');
  assert.ok(remind);
  assert.equal(getKstDateInputValue(remind), '2026-05-15');
  assert.ok(remind.getTime() <= bounds.endOfTodayMs);

  assert.throws(() => parseKstDateInput('2026-02-30', 'due'));
  assert.equal(parseKstDateInput('', 'due'), null);
});

test('classifyTodayBriefing deduplicates tasks across buckets and excludes done/deleted tasks', () => {
  // Task overlapping overdue + remindDue + doing -> MUST appear ONLY in overdue
  const overlapTask = makeTask('t-overlap', {
    status: 'doing',
    priority: 'high',
    dueAt: ts('2026-05-14T14:59:59Z'), // 2026-05-14 23:59:59 KST (yesterday)
    remindAt: ts('2026-05-15T00:00:00Z'), // today
  });

  // Duplicate reference of same ID should be deduplicated
  const overlapDup = makeTask('t-overlap', {
    status: 'doing',
    priority: 'high',
    dueAt: ts('2026-05-14T14:59:59Z'),
    remindAt: ts('2026-05-15T00:00:00Z'),
  });

  const dueTodayTask = makeTask('t-today', {
    dueAt: ts('2026-05-15T14:59:59Z'), // 2026-05-15 23:59:59 KST
    remindAt: ts('2026-05-15T00:00:00Z'), // should NOT duplicate into remindDue
  });

  const remindPastTask = makeTask('t-remind-past', {
    dueAt: ts('2026-05-25T14:59:59Z'),
    remindAt: ts('2026-05-13T00:00:00Z'), // past remindAt
  });

  const imminentTask = makeTask('t-imminent', {
    dueAt: ts('2026-05-17T14:59:59Z'), // +2 days KST
  });

  const doingTask = makeTask('t-doing', {
    status: 'doing',
    dueAt: ts('2026-05-28T14:59:59Z'),
  });

  const undatedTask = makeTask('t-undated', {
    status: 'todo',
  });

  const doneTask = makeTask('t-done', {
    status: 'done',
    dueAt: ts('2026-05-15T14:59:59Z'),
    completedAt: ts('2026-05-15T00:30:00Z'),
  });

  const deletedTask = makeTask('t-deleted', {
    isDeleted: true,
    deletedAt: ts('2026-05-15T00:30:00Z'),
    dueAt: ts('2026-05-14T14:59:59Z'),
  });

  const summary = classifyTodayBriefing(
    [
      overlapTask,
      overlapDup,
      dueTodayTask,
      remindPastTask,
      imminentTask,
      doingTask,
      undatedTask,
      doneTask,
      deletedTask,
    ],
    { now: NOW, imminentDays: 3 },
  );

  assert.deepEqual(
    summary.overdue.map((t) => t.id),
    ['t-overlap'],
  );
  assert.deepEqual(
    summary.dueToday.map((t) => t.id),
    ['t-today'],
  );
  assert.deepEqual(
    summary.remindDue.map((t) => t.id),
    ['t-remind-past'],
  );
  assert.deepEqual(
    summary.imminent.map((t) => t.id),
    ['t-imminent'],
  );
  assert.deepEqual(
    summary.doing.map((t) => t.id),
    ['t-doing'],
  );
  assert.deepEqual(
    summary.undated.map((t) => t.id),
    ['t-undated'],
  );
  assert.deepEqual(
    summary.unreminded.map((t) => t.id).sort(),
    ['t-doing', 't-imminent', 't-undated'],
  );
  assert.equal(summary.uniqueFocusCount, 5);
  assert.equal(summary.totalActiveCount, 6);
});

test('priority and dueAt sorting places urgent tasks and earliest deadlines first', () => {
  const lowEarly = makeTask('a', {
    priority: 'low',
    dueAt: ts('2026-05-16T00:00:00Z'),
  });
  const urgentLater = makeTask('b', {
    priority: 'urgent',
    dueAt: ts('2026-05-19T00:00:00Z'),
  });
  const highNoDate = makeTask('c', {
    priority: 'high',
    dueAt: null,
  });

  const byPriority = sortTasks([lowEarly, urgentLater, highNoDate], 'priority');
  assert.deepEqual(
    byPriority.map((t) => t.id),
    ['b', 'c', 'a'],
  );

  const byDue = sortTasks([highNoDate, urgentLater, lowEarly], 'dueAt');
  assert.deepEqual(
    byDue.map((t) => t.id),
    ['a', 'b', 'c'],
  );

  assert.ok(compareTasksByPriority(urgentLater, lowEarly) < 0);
});

test('buildTodaySituationBriefing summarizes deadlines, status breakdown, attention items, and completed tasks with 0 AI', () => {
  const overdueTask = makeTask('s-over', {
    title: '교육청 공문 회신',
    priority: 'urgent',
    dueAt: ts('2026-05-14T14:59:59Z'),
  });
  const dueTodayTask = makeTask('s-today', {
    title: '가정통신문 결재',
    priority: 'high',
    dueAt: ts('2026-05-15T14:59:59Z'),
  });
  const dueTomorrowTask = makeTask('s-tomorrow', {
    title: '성적 처리 계획안 제출',
    priority: 'normal',
    dueAt: ts('2026-05-16T14:59:59Z'),
  });
  const laterImminentTask = makeTask('s-later', {
    title: '교과 협의회 자료',
    priority: 'normal',
    dueAt: ts('2026-05-18T14:59:59Z'),
  });
  const onHoldTask = makeTask('s-hold', {
    title: '예산 품의 보류건',
    status: 'on_hold',
  });
  const doneTodayTask = makeTask('s-done-today', {
    title: '아침 조례 공지',
    status: 'done',
    completedAt: ts('2026-05-15T00:30:00Z'),
  });
  const doneEarlierTask = makeTask('s-done-old', {
    title: '지난주 보고',
    status: 'done',
    completedAt: ts('2026-05-10T01:00:00Z'),
  });

  const situation = buildTodaySituationBriefing({
    tasks: [overdueTask, dueTodayTask, dueTomorrowTask, laterImminentTask, onHoldTask],
    completedTasks: [doneTodayTask, doneEarlierTask],
    todayEventsCount: 3,
    scheduleConflictCount: 1,
    eventOverlapCount: 1,
    now: NOW,
    imminentDays: 3,
  });

  assert.equal(situation.tomorrowKey, '2026-05-16');
  assert.deepEqual(
    situation.dueTomorrow.map((t) => t.id),
    ['s-tomorrow'],
  );
  assert.deepEqual(
    situation.laterImminent.map((t) => t.id),
    ['s-later'],
  );
  assert.deepEqual(
    situation.onHoldTasks.map((t) => t.id),
    ['s-hold'],
  );
  assert.deepEqual(
    situation.importantTasks.map((t) => t.id),
    ['s-over', 's-today'],
  );
  assert.equal(situation.incompleteCount, 5);
  assert.equal(situation.onHoldCount, 1);
  assert.equal(situation.completedCount, 2);
  assert.equal(situation.completedTodayCount, 1);
  assert.ok(situation.headlineSummary.includes('오늘 일정 3건'));
  assert.ok(situation.headlineSummary.includes('오늘 마감 업무 1건'));
  assert.ok(situation.headlineSummary.includes('미완료 업무 5건'));
  assert.ok(situation.headlineSummary.includes('내일 마감 예정 1건'));
  assert.ok(situation.attentionReasons.some((r) => r.includes('일정 시간 중복·충돌 2건')));
  assert.ok(situation.officialTasks.some((t) => t.id === 's-over'));
});

test('detectTodayEventOverlaps detects overlapping timed events and ignores non-overlapping or all-day events', () => {
  const mkEvent = (
    id: string,
    title: string,
    startIso: string,
    endIso: string,
    allDay = false,
  ): CalendarEventRecord => ({
    id,
    title,
    startsAt: ts(startIso)!,
    endsAt: ts(endIso)!,
    allDay,
    location: '',
    description: '',
    relatedTaskId: null,
    version: 1,
    createdAt: ts('2026-05-01T00:00:00Z')!,
    updatedAt: ts('2026-05-01T00:00:00Z')!,
    schemaVersion: 1,
  });

  const overlaps = detectTodayEventOverlaps([
    mkEvent('all-day', '학교 축제', '2026-05-15T00:00:00+09:00', '2026-05-15T23:59:59+09:00', true),
    mkEvent('ev-1', '교직원 회의', '2026-05-15T14:00:00+09:00', '2026-05-15T15:00:00+09:00'),
    mkEvent('ev-2', '학부모 상담', '2026-05-15T14:30:00+09:00', '2026-05-15T15:30:00+09:00'),
    mkEvent('ev-3', '연수', '2026-05-15T15:30:00+09:00', '2026-05-15T16:30:00+09:00'),
  ]);

  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].eventAId, 'ev-1');
  assert.equal(overlaps[0].eventBId, 'ev-2');
  assert.equal(overlaps[0].overlapLabel, '14:30~15:00');
});
