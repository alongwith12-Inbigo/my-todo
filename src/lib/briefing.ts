import { getKstDayBounds } from './dateKst';
import type { TaskPriority, TaskRecord, TaskStatus } from '../types/domain';

export type TaskSortMode = 'briefing' | 'priority' | 'dueAt' | 'updatedAt';

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export const STATUS_WEIGHT: Record<TaskStatus, number> = {
  doing: 3,
  todo: 2,
  on_hold: 1,
  done: 0,
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: '긴급',
  high: '높음',
  normal: '보통',
  low: '낮음',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '미착수',
  doing: '진행 중',
  done: '완료',
  on_hold: '보류',
};

export interface TimestampLike {
  toMillis: () => number;
  toDate?: () => Date;
}

export function timestampToMillis(
  value: TimestampLike | Date | null | undefined,
): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  return null;
}

export function timestampToDate(
  value: TimestampLike | Date | null | undefined,
): Date | null {
  const ms = timestampToMillis(value);
  return ms === null ? null : new Date(ms);
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function compareTasksByPriority(a: TaskRecord, b: TaskRecord): number {
  const priorityDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
  if (priorityDiff !== 0) return priorityDiff;

  const dueDiff = compareNullableAsc(
    timestampToMillis(a.dueAt),
    timestampToMillis(b.dueAt),
  );
  if (dueDiff !== 0) return dueDiff;

  const remindDiff = compareNullableAsc(
    timestampToMillis(a.remindAt),
    timestampToMillis(b.remindAt),
  );
  if (remindDiff !== 0) return remindDiff;

  const statusDiff = STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status];
  if (statusDiff !== 0) return statusDiff;

  const updatedA = timestampToMillis(a.updatedAt) ?? 0;
  const updatedB = timestampToMillis(b.updatedAt) ?? 0;
  if (updatedB !== updatedA) return updatedB - updatedA;

  return a.id.localeCompare(b.id);
}

export function compareTasksByDueAt(a: TaskRecord, b: TaskRecord): number {
  const dueDiff = compareNullableAsc(
    timestampToMillis(a.dueAt),
    timestampToMillis(b.dueAt),
  );
  if (dueDiff !== 0) return dueDiff;
  return compareTasksByPriority(a, b);
}

export function compareTasksByUpdatedAt(a: TaskRecord, b: TaskRecord): number {
  const updatedA = timestampToMillis(a.updatedAt) ?? 0;
  const updatedB = timestampToMillis(b.updatedAt) ?? 0;
  if (updatedB !== updatedA) return updatedB - updatedA;
  return compareTasksByPriority(a, b);
}

export function sortTasks(tasks: TaskRecord[], mode: TaskSortMode): TaskRecord[] {
  const copy = [...tasks];
  if (mode === 'dueAt') return copy.sort(compareTasksByDueAt);
  if (mode === 'updatedAt') return copy.sort(compareTasksByUpdatedAt);
  return copy.sort(compareTasksByPriority);
}

export interface TodayBriefingSummary {
  overdue: TaskRecord[];
  dueToday: TaskRecord[];
  remindDue: TaskRecord[];
  imminent: TaskRecord[];
  doing: TaskRecord[];
  undated: TaskRecord[];
  unreminded: TaskRecord[];
  uniqueFocusCount: number;
  totalActiveCount: number;
}

/**
 * Classifies incomplete active tasks into Today's Briefing buckets in KST.
 * Each unique task enters at most ONE primary bucket (overdue > dueToday > remindDue > imminent > doing > undated)
 * to guarantee zero duplicate aggregation.
 * `unreminded` is a secondary reference view of incomplete tasks without a remindAt date.
 */
export function classifyTodayBriefing(
  tasks: TaskRecord[],
  options: { now?: Date; imminentDays?: number } = {},
): TodayBriefingSummary {
  const now = options.now ?? new Date();
  const imminentDays = options.imminentDays ?? 3;
  const bounds = getKstDayBounds(now, imminentDays);

  // Deduplicate by ID and exclude soft-deleted or completed tasks
  const uniqueActive = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (!task.isDeleted && task.status !== 'done') {
      uniqueActive.set(task.id, task);
    }
  }

  const overdue: TaskRecord[] = [];
  const dueToday: TaskRecord[] = [];
  const remindDue: TaskRecord[] = [];
  const imminent: TaskRecord[] = [];
  const doing: TaskRecord[] = [];
  const undated: TaskRecord[] = [];
  const unreminded: TaskRecord[] = [];

  for (const task of uniqueActive.values()) {
    const dueMs = timestampToMillis(task.dueAt);
    const scheduledMs = timestampToMillis(task.scheduledAt);
    const remindMs = timestampToMillis(task.remindAt);

    if (remindMs === null) {
      unreminded.push(task);
    }

    if (dueMs !== null && dueMs < bounds.startOfTodayMs) {
      overdue.push(task);
      continue;
    }

    if (dueMs !== null && dueMs >= bounds.startOfTodayMs && dueMs <= bounds.endOfTodayMs) {
      dueToday.push(task);
      continue;
    }

    if (remindMs !== null && remindMs <= bounds.endOfTodayMs) {
      remindDue.push(task);
      continue;
    }

    if (dueMs !== null && dueMs > bounds.endOfTodayMs && dueMs <= bounds.endOfImminentMs) {
      imminent.push(task);
      continue;
    }

    if (task.status === 'doing') {
      doing.push(task);
      continue;
    }

    if (dueMs === null && scheduledMs === null && remindMs === null) {
      undated.push(task);
    }
  }

  overdue.sort(compareTasksByPriority);
  dueToday.sort(compareTasksByPriority);
  remindDue.sort(compareTasksByPriority);
  imminent.sort(compareTasksByDueAt);
  doing.sort(compareTasksByPriority);
  undated.sort(compareTasksByPriority);
  unreminded.sort(compareTasksByPriority);

  const uniqueFocusCount =
    overdue.length +
    dueToday.length +
    remindDue.length +
    imminent.length +
    doing.length;

  return {
    overdue,
    dueToday,
    remindDue,
    imminent,
    doing,
    undated,
    unreminded,
    uniqueFocusCount,
    totalActiveCount: uniqueActive.size,
  };
}
