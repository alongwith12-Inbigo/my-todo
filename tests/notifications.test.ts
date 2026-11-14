import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInAppNotifications } from '../src/lib/notifications';
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

function makeEvent(
  id: string,
  overrides: Partial<CalendarEventRecord> = {},
): CalendarEventRecord {
  return {
    id,
    title: `일정 ${id}`,
    startsAt: ts('2026-05-15T01:30:00Z')!,
    endsAt: ts('2026-05-15T02:30:00Z')!,
    allDay: false,
    location: '',
    description: '',
    relatedTaskId: null,
    version: 1,
    createdAt: ts('2026-05-01T00:00:00Z')!,
    updatedAt: ts('2026-05-01T00:00:00Z')!,
    schemaVersion: 1,
    ...overrides,
  };
}

test('buildInAppNotifications prioritizes soon events, overdue tasks, remind tasks, and remaining today events without duplicates', () => {
  // 2026-05-15 10:00 KST
  const now = new Date('2026-05-15T01:00:00Z');

  const soonEvent = makeEvent('ev-soon', {
    title: '학년 부장회의',
    startsAt: ts('2026-05-15T01:30:00Z')!, // 10:30 KST (30m later)
    endsAt: ts('2026-05-15T02:30:00Z')!,
    location: '본관 2층 회의실',
  });

  const endedEvent = makeEvent('ev-ended', {
    title: '아침 조회',
    startsAt: ts('2026-05-14T23:30:00Z')!, // 08:30 KST
    endsAt: ts('2026-05-15T00:00:00Z')!, // 09:00 KST (already ended)
  });

  const allDayEvent = makeEvent('ev-allday', {
    title: '학부모 공개수업의 날',
    allDay: true,
    startsAt: ts('2026-05-14T15:00:00Z')!,
    endsAt: ts('2026-05-15T14:59:59Z')!,
  });

  // Overdue + remindDue same task -> must appear ONLY once as task_overdue
  const overdueTask = makeTask('t-overdue', {
    title: '성적 처리 마감',
    dueAt: ts('2026-05-14T14:59:59Z'),
    remindAt: ts('2026-05-15T00:00:00Z'),
  });

  const remindTask = makeTask('t-remind', {
    title: '현장체험학습 안내 재확인',
    remindAt: ts('2026-05-15T00:00:00Z'),
  });

  const doneTask = makeTask('t-done', {
    status: 'done',
    dueAt: ts('2026-05-14T14:59:59Z'),
  });

  const summary = buildInAppNotifications({
    tasks: [overdueTask, remindTask, doneTask],
    events: [soonEvent, endedEvent, allDayEvent],
    now,
    soonMinutes: 120,
  });

  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['event:ev-soon', 'task:t-overdue', 'task:t-remind', 'event:ev-allday'],
  );
  assert.equal(summary.urgentCount, 3);
  assert.equal(summary.totalCount, 4);

  // When clock advances past midnight to 2026-05-16 09:00 KST, ended/past items reflect new day
  const nextDay = new Date('2026-05-16T00:00:00Z');
  const nextSummary = buildInAppNotifications({
    tasks: [overdueTask, remindTask],
    events: [soonEvent, allDayEvent],
    now: nextDay,
    soonMinutes: 120,
  });
  assert.deepEqual(
    nextSummary.items.map((item) => item.id),
    ['task:t-overdue', 'task:t-remind'],
  );
});
