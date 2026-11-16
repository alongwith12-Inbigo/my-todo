import { timestampToDate, timestampToMillis } from './briefing';
import {
  addKstDaysToDateKey,
  getKstDateParts,
  getKstDayBounds,
  getKstDayRangeMs,
  getKstMonthGridDays,
  getKstWeekDays,
} from './dateKst';
import type { CalendarEventRecord } from '../types/domain';

export interface TodayEventsSummary {
  startingSoon: CalendarEventRecord[];
  otherToday: CalendarEventRecord[];
  upcoming: CalendarEventRecord[];
  totalTodayCount: number;
}

export function compareEventsChronological(
  a: CalendarEventRecord,
  b: CalendarEventRecord,
): number {
  if (a.allDay !== b.allDay) {
    return a.allDay ? -1 : 1;
  }
  const startA = timestampToMillis(a.startsAt) ?? 0;
  const startB = timestampToMillis(b.startsAt) ?? 0;
  if (startA !== startB) return startA - startB;

  const endA = timestampToMillis(a.endsAt) ?? 0;
  const endB = timestampToMillis(b.endsAt) ?? 0;
  if (endA !== endB) return endA - endB;

  return a.id.localeCompare(b.id);
}

export function doesEventOverlapRange(
  event: CalendarEventRecord,
  rangeStartMs: number,
  rangeEndMs: number,
): boolean {
  const startMs = timestampToMillis(event.startsAt);
  const endMs = timestampToMillis(event.endsAt);
  if (startMs === null || endMs === null) return false;
  return startMs <= rangeEndMs && endMs >= rangeStartMs;
}

export function doesEventOverlapDateKey(
  event: CalendarEventRecord,
  dateKey: string,
): boolean {
  const { startMs, endMs } = getKstDayRangeMs(dateKey);
  return doesEventOverlapRange(event, startMs, endMs);
}

export function getEventsForDateKey(
  events: CalendarEventRecord[],
  dateKey: string,
): CalendarEventRecord[] {
  return events
    .filter((event) => doesEventOverlapDateKey(event, dateKey))
    .sort(compareEventsChronological);
}

export function isEventStartingSoon(
  event: CalendarEventRecord,
  now: Date = new Date(),
  soonMinutes = 120,
): boolean {
  if (event.allDay) return false;
  const startMs = timestampToMillis(event.startsAt);
  const endMs = timestampToMillis(event.endsAt);
  if (startMs === null || endMs === null) return false;

  const nowMs = now.getTime();
  const soonWindowEndMs = nowMs + Math.max(1, soonMinutes) * 60 * 1000;
  const isOngoingNow = startMs <= nowMs && endMs > nowMs;
  const isUpcomingSoon = startMs >= nowMs && startMs <= soonWindowEndMs;
  return isOngoingNow || isUpcomingSoon;
}

export function isEventEnded(
  event: CalendarEventRecord,
  now: Date = new Date(),
): boolean {
  if (event.allDay) return false;
  const endMs = timestampToMillis(event.endsAt);
  if (endMs === null) return false;
  return endMs <= now.getTime();
}

export function getMinutesUntilEventStart(
  event: CalendarEventRecord,
  now: Date = new Date(),
): number | null {
  if (event.allDay) return null;
  const startMs = timestampToMillis(event.startsAt);
  if (startMs === null) return null;
  return Math.round((startMs - now.getTime()) / 60_000);
}

/**
 * Classifies events into mutually exclusive buckets for Today Briefing:
 * - startingSoon: today's timed events currently running or starting within soonMinutes
 * - otherToday: remaining events overlapping today (all-day or later/earlier today)
 * - upcoming: events in the next 7 days that do NOT overlap today (zero duplicates)
 */
export function classifyTodayEvents(
  events: CalendarEventRecord[],
  options: { now?: Date; soonMinutes?: number; upcomingDays?: number } = {},
): TodayEventsSummary {
  const now = options.now ?? new Date();
  const soonMinutes = options.soonMinutes ?? 120;
  const upcomingDays = options.upcomingDays ?? 7;

  const bounds = getKstDayBounds(now, upcomingDays);
  const upcomingEndKey = addKstDaysToDateKey(bounds.todayKey, upcomingDays);
  const upcomingEndMs = getKstDayRangeMs(upcomingEndKey).endMs;

  const unique = new Map<string, CalendarEventRecord>();
  for (const event of events) {
    unique.set(event.id, event);
  }

  const startingSoon: CalendarEventRecord[] = [];
  const otherToday: CalendarEventRecord[] = [];
  const upcoming: CalendarEventRecord[] = [];

  for (const event of unique.values()) {
    const overlapsToday = doesEventOverlapRange(
      event,
      bounds.startOfTodayMs,
      bounds.endOfTodayMs,
    );

    if (overlapsToday) {
      if (isEventStartingSoon(event, now, soonMinutes)) {
        startingSoon.push(event);
      } else {
        otherToday.push(event);
      }
      continue;
    }

    const startMs = timestampToMillis(event.startsAt);
    if (
      startMs !== null &&
      startMs > bounds.endOfTodayMs &&
      startMs <= upcomingEndMs
    ) {
      upcoming.push(event);
    }
  }

  startingSoon.sort(compareEventsChronological);
  otherToday.sort(compareEventsChronological);
  upcoming.sort(compareEventsChronological);

  return {
    startingSoon,
    otherToday,
    upcoming,
    totalTodayCount: startingSoon.length + otherToday.length,
  };
}

export function getCalendarRangeForMonth(
  year: number,
  month: number,
): { startMs: number; endMs: number } {
  const cells = getKstMonthGridDays(year, month);
  const firstKey = cells[0].dateKey;
  const lastKey = cells[cells.length - 1].dateKey;
  return {
    startMs: getKstDayRangeMs(firstKey).startMs,
    endMs: getKstDayRangeMs(lastKey).endMs,
  };
}

export function getCalendarRangeForWeek(
  anchorDateKey: string,
): { startMs: number; endMs: number } {
  const days = getKstWeekDays(anchorDateKey);
  return {
    startMs: getKstDayRangeMs(days[0]).startMs,
    endMs: getKstDayRangeMs(days[days.length - 1]).endMs,
  };
}

export function getDefaultEventDraftForDate(
  dateKey: string,
  now: Date = new Date(),
): {
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
} {
  const todayParts = getKstDateParts(now);
  const nextHour = Math.min(22, Math.max(9, todayParts.hour + 1));
  const startTime =
    dateKey === todayParts.dateKey
      ? `${String(nextHour).padStart(2, '0')}:00`
      : '09:00';
  const endHour = Math.min(23, Number(startTime.slice(0, 2)) + 1);
  const endTime = `${String(endHour).padStart(2, '0')}:00`;
  return {
    startDate: dateKey,
    endDate: dateKey,
    startTime,
    endTime,
  };
}

export function formatEventStartDayLabel(
  event: CalendarEventRecord,
  now: Date = new Date(),
): string {
  const startDate = timestampToDate(event.startsAt);
  if (!startDate) return '';
  const todayKey = getKstDateParts(now).dateKey;
  const startKey = getKstDateParts(startDate).dateKey;
  if (startKey === todayKey) return '오늘';
  if (startKey === addKstDaysToDateKey(todayKey, 1)) return '내일';
  return startKey;
}

export interface EventTimeOverlap {
  eventAId: string;
  eventATitle: string;
  eventBId: string;
  eventBTitle: string;
  overlapStartMs: number;
  overlapEndMs: number;
  overlapLabel: string;
}

function formatKstHhMmFromMs(ms: number): string {
  const parts = getKstDateParts(new Date(ms));
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(parts.hour).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Detects time overlaps among timed (non-all-day) calendar events on the same day.
 * Zero AI calls, purely deterministic.
 */
export function detectTodayEventOverlaps(
  todayEvents: CalendarEventRecord[],
): EventTimeOverlap[] {
  const timed = todayEvents
    .filter((ev) => !ev.allDay)
    .map((ev) => ({
      event: ev,
      startMs: timestampToMillis(ev.startsAt),
      endMs: timestampToMillis(ev.endsAt),
    }))
    .filter(
      (item): item is { event: CalendarEventRecord; startMs: number; endMs: number } =>
        item.startMs !== null && item.endMs !== null && item.endMs > item.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const overlaps: EventTimeOverlap[] = [];
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      if (b.startMs >= a.endMs) break;
      const overlapStartMs = Math.max(a.startMs, b.startMs);
      const overlapEndMs = Math.min(a.endMs, b.endMs);
      if (overlapEndMs > overlapStartMs) {
        overlaps.push({
          eventAId: a.event.id,
          eventATitle: a.event.title,
          eventBId: b.event.id,
          eventBTitle: b.event.title,
          overlapStartMs,
          overlapEndMs,
          overlapLabel: `${formatKstHhMmFromMs(overlapStartMs)}~${formatKstHhMmFromMs(overlapEndMs)}`,
        });
      }
    }
  }
  return overlaps;
}
