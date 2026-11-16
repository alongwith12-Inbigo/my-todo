import { addKstDaysToDateKey, getKstDateInputValue, getKstDayBounds } from './dateKst';
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

export interface TodaySituationBriefing {
  summary: TodayBriefingSummary;
  tomorrowKey: string;
  dueTomorrow: TaskRecord[];
  laterImminent: TaskRecord[];
  onHoldTasks: TaskRecord[];
  importantTasks: TaskRecord[];
  officialTasks: TaskRecord[];
  completedCount: number;
  completedTodayCount: number;
  incompleteCount: number;
  todoCount: number;
  doingCount: number;
  onHoldCount: number;
  todayActionableCount: number;
  attentionReasons: string[];
  headlineSummary: string;
}

const OFFICIAL_TASK_KEYWORD_RE = /(공문|결재|기안|품의|보고|제출|회신)/;

/**
 * Rule-based Zero-AI summary of today's tasks and schedules using already-loaded records.
 * Performs 0 Gemini calls and 0 extra Firestore queries.
 */
export function buildTodaySituationBriefing(params: {
  tasks: TaskRecord[];
  completedTasks?: TaskRecord[];
  todayEventsCount: number;
  scheduleConflictCount: number;
  eventOverlapCount: number;
  now?: Date;
  imminentDays?: number;
}): TodaySituationBriefing {
  const now = params.now ?? new Date();
  const imminentDays = params.imminentDays ?? 3;
  const bounds = getKstDayBounds(now, imminentDays);
  const tomorrowKey = addKstDaysToDateKey(bounds.todayKey, 1);

  const summary = classifyTodayBriefing(params.tasks, { now, imminentDays });

  const uniqueActive = new Map<string, TaskRecord>();
  const uniqueDone = new Map<string, TaskRecord>();

  for (const task of [...params.tasks, ...(params.completedTasks ?? [])]) {
    if (task.isDeleted) continue;
    if (task.status === 'done') {
      uniqueDone.set(task.id, task);
    } else {
      uniqueActive.set(task.id, task);
    }
  }

  let todoCount = 0;
  let doingCount = 0;
  let onHoldCount = 0;
  const onHoldTasks: TaskRecord[] = [];
  const importantTasks: TaskRecord[] = [];
  const officialTasks: TaskRecord[] = [];
  const todayActionableIds = new Set<string>();

  for (const t of summary.overdue) todayActionableIds.add(t.id);
  for (const t of summary.dueToday) todayActionableIds.add(t.id);
  for (const t of summary.remindDue) todayActionableIds.add(t.id);
  for (const t of summary.doing) todayActionableIds.add(t.id);

  for (const task of uniqueActive.values()) {
    if (task.status === 'todo') todoCount += 1;
    else if (task.status === 'doing') doingCount += 1;
    else if (task.status === 'on_hold') {
      onHoldCount += 1;
      onHoldTasks.push(task);
    }

    const schedKey = getKstDateInputValue(timestampToDate(task.scheduledAt));
    if (schedKey === bounds.todayKey) {
      todayActionableIds.add(task.id);
    }

    if (task.priority === 'urgent' || task.priority === 'high') {
      importantTasks.push(task);
    }

    const dueMs = timestampToMillis(task.dueAt);
    const isNearDeadline =
      dueMs !== null && dueMs <= bounds.endOfImminentMs;
    if (
      OFFICIAL_TASK_KEYWORD_RE.test(task.title) &&
      (isNearDeadline || task.priority === 'urgent' || task.priority === 'high')
    ) {
      officialTasks.push(task);
    }
  }

  // Split imminent into tomorrow vs later imminent without duplicating dueToday/overdue/remindDue
  const alreadyFeaturedIds = new Set<string>([
    ...summary.overdue.map((t) => t.id),
    ...summary.dueToday.map((t) => t.id),
    ...summary.remindDue.map((t) => t.id),
  ]);

  const dueTomorrow: TaskRecord[] = [];
  const laterImminent: TaskRecord[] = [];
  for (const task of uniqueActive.values()) {
    if (alreadyFeaturedIds.has(task.id)) continue;
    const dueKey = getKstDateInputValue(timestampToDate(task.dueAt));
    if (dueKey === tomorrowKey) {
      dueTomorrow.push(task);
    }
  }
  const dueTomorrowIds = new Set(dueTomorrow.map((t) => t.id));
  for (const task of summary.imminent) {
    if (!dueTomorrowIds.has(task.id)) {
      laterImminent.push(task);
    }
  }

  dueTomorrow.sort(compareTasksByPriority);
  onHoldTasks.sort(compareTasksByPriority);
  importantTasks.sort(compareTasksByPriority);
  officialTasks.sort(compareTasksByDueAt);

  let completedTodayCount = 0;
  for (const task of uniqueDone.values()) {
    const compMs =
      timestampToMillis(task.completedAt) ?? timestampToMillis(task.updatedAt);
    if (
      compMs !== null &&
      compMs >= bounds.startOfTodayMs &&
      compMs <= bounds.endOfTodayMs
    ) {
      completedTodayCount += 1;
    }
  }

  const totalConflicts = params.scheduleConflictCount + params.eventOverlapCount;
  const attentionReasons: string[] = [];
  if (totalConflicts > 0) {
    attentionReasons.push(`일정 시간 중복·충돌 ${totalConflicts}건 확인 필요`);
  }
  if (summary.overdue.length > 0) {
    attentionReasons.push(`마감 기한 초과 업무 ${summary.overdue.length}건`);
  }
  if (importantTasks.length > 0) {
    attentionReasons.push(`중요(긴급·높음) 표시 업무 ${importantTasks.length}건`);
  }
  if (summary.dueToday.length > 0 || dueTomorrow.length > 0) {
    const parts: string[] = [];
    if (summary.dueToday.length > 0) parts.push(`오늘 마감 ${summary.dueToday.length}건`);
    if (dueTomorrow.length > 0) parts.push(`내일 마감 ${dueTomorrow.length}건`);
    attentionReasons.push(parts.join(' · '));
  }
  if (officialTasks.length > 0) {
    attentionReasons.push(`공문·제출 확인 대상 ${officialTasks.length}건`);
  }

  const primaryParts: string[] = [
    `오늘 일정 ${params.todayEventsCount}건`,
    `오늘 마감 업무 ${summary.dueToday.length}건`,
    `미완료 업무 ${uniqueActive.size}건`,
  ];
  const secondaryNotes: string[] = [];
  if (summary.overdue.length > 0) {
    secondaryNotes.push(`기한 초과 ${summary.overdue.length}건`);
  }
  if (dueTomorrow.length > 0) {
    secondaryNotes.push(`내일 마감 예정 ${dueTomorrow.length}건`);
  }
  if (totalConflicts > 0) {
    secondaryNotes.push(`일정 충돌 ${totalConflicts}건`);
  }

  const headlineSummary =
    secondaryNotes.length > 0
      ? `${primaryParts.join(', ')}이 있습니다. ${secondaryNotes.join(', ')}을 먼저 확인해 주세요.`
      : `${primaryParts.join(', ')}이 있습니다.`;

  return {
    summary,
    tomorrowKey,
    dueTomorrow,
    laterImminent,
    onHoldTasks,
    importantTasks,
    officialTasks,
    completedCount: uniqueDone.size,
    completedTodayCount,
    incompleteCount: uniqueActive.size,
    todoCount,
    doingCount,
    onHoldCount,
    todayActionableCount: todayActionableIds.size,
    attentionReasons,
    headlineSummary,
  };
}
