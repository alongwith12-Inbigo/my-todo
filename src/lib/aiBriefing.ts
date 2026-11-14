import { classifyTodayBriefing, timestampToDate } from './briefing.ts';
import {
  formatKstEventTimeRange,
  getKstDateInputValue,
  sanitizeSingleLine,
} from './dateKst.ts';
import { sanitizeMinimalFieldForAi } from './privacyGuard.ts';
import {
  AI_LIMITS,
  type AiBriefingRequest,
  type MinimalBriefingEvent,
  type MinimalBriefingTask,
  type MinimalExistingContextItem,
} from './aiTypes.ts';
import type { CalendarEventRecord, TaskRecord } from '../types/domain.ts';

export function buildMinimalExistingContext(
  tasks: TaskRecord[],
  events: CalendarEventRecord[],
): MinimalExistingContextItem[] {
  const items: MinimalExistingContextItem[] = [];

  for (const task of tasks) {
    if (task.isDeleted || task.status === 'done') continue;
    items.push({
      id: task.id,
      kind: 'task',
      title: sanitizeSingleLine(sanitizeMinimalFieldForAi(task.title), 80),
      dateKey: getKstDateInputValue(timestampToDate(task.dueAt)) || null,
    });
    if (items.length >= AI_LIMITS.MAX_EXISTING_CONTEXT_ITEMS) {
      return items;
    }
  }

  for (const ev of events) {
    items.push({
      id: ev.id,
      kind: 'event',
      title: sanitizeSingleLine(sanitizeMinimalFieldForAi(ev.title), 80),
      dateKey: getKstDateInputValue(timestampToDate(ev.startsAt)) || null,
    });
    if (items.length >= AI_LIMITS.MAX_EXISTING_CONTEXT_ITEMS) {
      return items;
    }
  }

  return items;
}

/**
 * Builds the minimum necessary, privacy-sanitized payload for AI Today Briefing
 * belonging strictly to the currently signed-in teacher.
 */
export function buildMinimalBriefingPayload(
  tasks: TaskRecord[],
  events: CalendarEventRecord[],
  options: { now?: Date; imminentDays?: number } = {},
): AiBriefingRequest {
  const now = options.now ?? new Date();
  const imminentDays = options.imminentDays ?? 3;
  const todayKey = getKstDateInputValue(now);

  const summary = classifyTodayBriefing(tasks, { now, imminentDays });

  const bucketEntries: Array<{
    bucket: MinimalBriefingTask['bucket'];
    list: TaskRecord[];
  }> = [
    { bucket: 'overdue', list: summary.overdue },
    { bucket: 'dueToday', list: summary.dueToday },
    { bucket: 'remindDue', list: summary.remindDue },
    { bucket: 'imminent', list: summary.imminent },
    { bucket: 'doing', list: summary.doing },
    { bucket: 'undated', list: summary.undated },
  ];

  const minimalTasks: MinimalBriefingTask[] = [];
  for (const group of bucketEntries) {
    for (const task of group.list) {
      if (minimalTasks.length >= AI_LIMITS.MAX_BRIEFING_TASKS) break;
      minimalTasks.push({
        id: task.id,
        title: sanitizeSingleLine(sanitizeMinimalFieldForAi(task.title), 80),
        status: task.status,
        priority: task.priority,
        dueDateKey: getKstDateInputValue(timestampToDate(task.dueAt)) || null,
        remindDateKey:
          getKstDateInputValue(timestampToDate(task.remindAt)) || null,
        bucket: group.bucket,
      });
    }
    if (minimalTasks.length >= AI_LIMITS.MAX_BRIEFING_TASKS) break;
  }

  const minimalEvents: MinimalBriefingEvent[] = [];
  const sortedEvents = [...events].sort((a, b) => {
    const aMs = timestampToDate(a.startsAt)?.getTime() ?? 0;
    const bMs = timestampToDate(b.startsAt)?.getTime() ?? 0;
    return aMs - bMs;
  });

  for (const ev of sortedEvents) {
    const start = timestampToDate(ev.startsAt);
    const end = timestampToDate(ev.endsAt);
    const dateKey = getKstDateInputValue(start);
    if (!dateKey || dateKey < todayKey) continue;
    minimalEvents.push({
      id: ev.id,
      title: sanitizeSingleLine(sanitizeMinimalFieldForAi(ev.title), 80),
      dateKey,
      timeRange: formatKstEventTimeRange(start, end, ev.allDay),
      allDay: ev.allDay,
      location: sanitizeSingleLine(sanitizeMinimalFieldForAi(ev.location), 40),
    });
    if (minimalEvents.length >= AI_LIMITS.MAX_BRIEFING_EVENTS) break;
  }

  return {
    todayKey,
    imminentDays,
    tasks: minimalTasks,
    events: minimalEvents,
  };
}
