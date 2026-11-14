import { timestampToDate, timestampToMillis } from './briefing';
import { classifyTodayEvents, getMinutesUntilEventStart, isEventEnded } from './calendar';
import {
  formatKstEventTimeRange,
  formatKstShortDate,
  formatRelativeKstDueLabel,
  getKstDayBounds,
} from './dateKst';
import type { CalendarEventRecord, TaskRecord } from '../types/domain';

export type NotificationKind =
  | 'event_starting_soon'
  | 'event_today'
  | 'task_overdue'
  | 'task_remind_due';

export type NotificationSeverity = 'urgent' | 'warn' | 'info';

export interface AppNotificationItem {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  targetType: 'task' | 'event';
  targetId: string;
  title: string;
  categoryLabel: string;
  detail: string;
}

export interface InAppNotificationSummary {
  items: AppNotificationItem[];
  urgentCount: number;
  totalCount: number;
}

/**
 * Computes live in-app notifications purely in memory from cached tasks & events.
 * Runs whenever the open-app clock ticks without firing extra Firestore reads.
 * Guarantees each task or event appears at most once (highest urgency wins).
 */
export function buildInAppNotifications(params: {
  tasks: TaskRecord[];
  events: CalendarEventRecord[];
  now?: Date;
  soonMinutes?: number;
}): InAppNotificationSummary {
  const now = params.now ?? new Date();
  const soonMinutes = params.soonMinutes ?? 120;
  const bounds = getKstDayBounds(now, 3);

  const items: AppNotificationItem[] = [];

  // 1. Events starting soon (or ongoing right now)
  const eventSummary = classifyTodayEvents(params.events, { now, soonMinutes });

  for (const event of eventSummary.startingSoon) {
    const startDate = timestampToDate(event.startsAt);
    const endDate = timestampToDate(event.endsAt);
    const mins = getMinutesUntilEventStart(event, now);
    const timingHint =
      mins !== null && mins <= 0
        ? '진행 중'
        : mins !== null && mins <= 60
          ? `${mins}분 후 시작`
          : '곧 시작';
    const rangeText = formatKstEventTimeRange(startDate, endDate, event.allDay);

    items.push({
      id: `event:${event.id}`,
      kind: 'event_starting_soon',
      severity: 'urgent',
      targetType: 'event',
      targetId: event.id,
      title: event.title,
      categoryLabel: `곧 시작할 일정 · ${timingHint}`,
      detail: event.location ? `${rangeText} · ${event.location}` : rangeText,
    });
  }

  // 2. Overdue tasks & Remind-due tasks (deduplicated per task; overdue takes precedence)
  const overdueTasks: TaskRecord[] = [];
  const remindTasks: TaskRecord[] = [];

  const seenTasks = new Set<string>();
  for (const task of params.tasks) {
    if (task.isDeleted || task.status === 'done' || seenTasks.has(task.id)) continue;
    seenTasks.add(task.id);

    const dueMs = timestampToMillis(task.dueAt);
    const remindMs = timestampToMillis(task.remindAt);

    if (dueMs !== null && dueMs < bounds.startOfTodayMs) {
      overdueTasks.push(task);
      continue;
    }

    if (remindMs !== null && remindMs <= bounds.endOfTodayMs) {
      remindTasks.push(task);
    }
  }

  for (const task of overdueTasks) {
    const dueDate = timestampToDate(task.dueAt);
    const rel = formatRelativeKstDueLabel(dueDate, now);
    items.push({
      id: `task:${task.id}`,
      kind: 'task_overdue',
      severity: 'urgent',
      targetType: 'task',
      targetId: task.id,
      title: task.title,
      categoryLabel: `기한 초과 업무 · ${rel.label}`,
      detail: dueDate ? `마감 ${formatKstShortDate(dueDate, now)}` : '기한 지남',
    });
  }

  for (const task of remindTasks) {
    const remindDate = timestampToDate(task.remindAt);
    const dueDate = timestampToDate(task.dueAt);
    items.push({
      id: `task:${task.id}`,
      kind: 'task_remind_due',
      severity: 'warn',
      targetType: 'task',
      targetId: task.id,
      title: task.title,
      categoryLabel: '재확인 업무',
      detail: dueDate
        ? `재확인 ${formatKstShortDate(remindDate, now)} · 마감 ${formatKstShortDate(dueDate, now)}`
        : `재확인 ${formatKstShortDate(remindDate, now)}`,
    });
  }

  // 3. Remaining today events (not already ended and not in startingSoon)
  for (const event of eventSummary.otherToday) {
    if (isEventEnded(event, now)) continue;
    const startDate = timestampToDate(event.startsAt);
    const endDate = timestampToDate(event.endsAt);
    const rangeText = formatKstEventTimeRange(startDate, endDate, event.allDay);

    items.push({
      id: `event:${event.id}`,
      kind: 'event_today',
      severity: 'info',
      targetType: 'event',
      targetId: event.id,
      title: event.title,
      categoryLabel: event.allDay ? '오늘 종일 일정' : '오늘 예정된 일정',
      detail: event.location ? `${rangeText} · ${event.location}` : rangeText,
    });
  }

  const urgentCount = items.filter(
    (item) => item.severity === 'urgent' || item.severity === 'warn',
  ).length;

  return {
    items,
    urgentCount,
    totalCount: items.length,
  };
}
