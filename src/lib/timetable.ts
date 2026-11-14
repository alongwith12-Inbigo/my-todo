import { timestampToDate } from './briefing';
import {
  getKstDateParts,
  getKstDayRangeMs,
  getKstWeekdayIndex,
  isValidDateInputString,
  isValidTimeInputString,
  sanitizeSingleLine,
} from './dateKst';
import {
  VALIDATION_LIMITS,
  type CalendarEventRecord,
  type TimetableOverrideRecord,
  type TimetablePeriodTime,
  type TimetableRecord,
  type TimetableSlot,
  type TimetableSlotKind,
  type TimetableSourceType,
  type TimetableWeekday,
} from '../types/domain';

export const TIMETABLE_WEEKDAYS: { day: TimetableWeekday; label: string; short: string }[] = [
  { day: 1, label: '월요일', short: '월' },
  { day: 2, label: '화요일', short: '화' },
  { day: 3, label: '수요일', short: '수' },
  { day: 4, label: '목요일', short: '목' },
  { day: 5, label: '금요일', short: '금' },
];

export const SLOT_KIND_LABELS: Record<TimetableSlotKind, string> = {
  class: '수업',
  free: '공강',
  fixed_duty: '고정 업무',
  other: '기타 일정',
};

export interface TimetableDraft {
  name: string;
  semesterLabel: string;
  effectiveFrom: string;
  effectiveTo: string;
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  periodCount: number;
  periodTimes: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableSlot>;
  isActive: boolean;
  sourceType: TimetableSourceType;
}

export interface ResolvedPeriodSlot {
  period: number;
  label: string;
  startTime: string;
  endTime: string;
  kind: TimetableSlotKind;
  subject: string;
  className: string;
  classroom: string;
  note: string;
  workAvailable: boolean;
  isOverridden: boolean;
}

export interface ResolvedDaySchedule {
  dateKey: string;
  weekdayIndex: number; // 0=Sun..6=Sat
  isWeekday: boolean;
  timetableId: string | null;
  timetableName: string | null;
  hasOverride: boolean;
  overrideReason: string;
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  periods: ResolvedPeriodSlot[];
}

export interface MinuteInterval {
  startMin: number;
  endMin: number;
  startTime: string;
  endTime: string;
  minutes: number;
  label?: string;
}

export interface EventOverlapConflict {
  eventId: string;
  eventTitle: string;
  startTime: string;
  endTime: string;
  minutes: number;
  overlapsWith: 'workable' | 'class' | 'fixed_duty' | 'lunch' | 'outside';
  detail: string;
}

export interface DayTimeAvailability {
  dateKey: string;
  hasTimetable: boolean;
  isWeekday: boolean;
  hasOverride: boolean;
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  classMinutes: number;
  classIntervals: MinuteInterval[];
  freeMinutes: number;
  freeIntervals: MinuteInterval[];
  fixedDutyMinutes: number;
  fixedDutyIntervals: MinuteInterval[];
  /**
   * Free periods explicitly configured as workable (`workAvailable === true`).
   */
  freeWorkableMinutes: number;
  /**
   * Non-class, non-lunch blocks inside working hours outside period slots (>= 15m).
   */
  unscheduledWorkMinutes: number;
  /**
   * Total workable minutes before subtracting personal events.
   */
  workableConfiguredMinutes: number;
  workableConfiguredIntervals: MinuteInterval[];
  /**
   * Overlap between personal events on `dateKey` and workable time.
   */
  overlappingEventMinutes: number;
  conflicts: EventOverlapConflict[];
  /**
   * Final net usable time windows for task planning after subtracting events.
   */
  netAvailableMinutes: number;
  netAvailableIntervals: MinuteInterval[];
}

const DEFAULT_PERIOD_SCHEDULE: [string, string][] = [
  ['08:50', '09:35'], // 1교시
  ['09:45', '10:30'], // 2교시
  ['10:40', '11:25'], // 3교시
  ['11:35', '12:20'], // 4교시
  ['13:20', '14:05'], // 5교시
  ['14:15', '15:00'], // 6교시
  ['15:10', '15:55'], // 7교시
  ['16:05', '16:50'], // 8교시
  ['17:00', '17:45'], // 9교시
  ['17:55', '18:40'], // 10교시
  ['18:50', '19:35'], // 11교시
  ['19:45', '20:30'], // 12교시
];

export function makeSlotKey(day: TimetableWeekday, period: number): string {
  return `${day}_${period}`;
}

export function hhMmToMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`올바른 시간 형식(HH:MM)이 아닙니다: ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToHhMm(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  if (clamped === 24 * 60) return '24:00';
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function formatMinutesKorean(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours > 0 && mins > 0) return `${hours}시간 ${mins}분`;
  if (hours > 0) return `${hours}시간`;
  return `${mins}분`;
}

export function createDefaultPeriodTimes(
  periodCount = 7,
): Record<string, TimetablePeriodTime> {
  const safeCount = Math.max(1, Math.min(VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX, periodCount));
  const result: Record<string, TimetablePeriodTime> = {};
  for (let p = 1; p <= safeCount; p++) {
    const [startTime, endTime] = DEFAULT_PERIOD_SCHEDULE[p - 1] ?? ['09:00', '09:45'];
    result[String(p)] = {
      period: p,
      label: `${p}교시`,
      startTime,
      endTime,
    };
  }
  return result;
}

export function createDefaultSlot(day: TimetableWeekday, period: number): TimetableSlot {
  return {
    day,
    period,
    kind: 'free',
    subject: '',
    className: '',
    classroom: '',
    note: '',
    workAvailable: false,
  };
}

export function createEmptyTimetableDraft(anchorDateKey: string): TimetableDraft {
  const year = isValidDateInputString(anchorDateKey)
    ? Number(anchorDateKey.slice(0, 4))
    : new Date().getUTCFullYear();
  const month = isValidDateInputString(anchorDateKey)
    ? Number(anchorDateKey.slice(5, 7))
    : 3;

  const isSecondSemester = month >= 8 || month <= 1;
  const semesterLabel = isSecondSemester ? `${year}-2학기` : `${year}-1학기`;
  const effectiveFrom = isSecondSemester ? `${year}-08-15` : `${year}-03-01`;
  const effectiveTo = isSecondSemester ? `${year + 1}-02-28` : `${year}-08-14`;
  const periodCount = 7;
  const slots: Record<string, TimetableSlot> = {};

  for (const w of TIMETABLE_WEEKDAYS) {
    for (let p = 1; p <= periodCount; p++) {
      slots[makeSlotKey(w.day, p)] = createDefaultSlot(w.day, p);
    }
  }

  return {
    name: `${year}학년도 ${isSecondSemester ? '2학기' : '1학기'} 시간표`,
    semesterLabel,
    effectiveFrom,
    effectiveTo,
    workStart: '08:30',
    workEnd: '16:30',
    lunchStart: '12:20',
    lunchEnd: '13:20',
    periodCount,
    periodTimes: createDefaultPeriodTimes(periodCount),
    slots,
    isActive: true,
    sourceType: 'manual',
  };
}

export function validateTimetableDraft(draft: TimetableDraft): string | null {
  const name = sanitizeSingleLine(draft.name, VALIDATION_LIMITS.TIMETABLE_NAME_MAX_LEN);
  if (name.length < VALIDATION_LIMITS.TIMETABLE_NAME_MIN_LEN) {
    return '시간표 이름을 입력해 주세요.';
  }
  if (!isValidDateInputString(draft.effectiveFrom) || !isValidDateInputString(draft.effectiveTo)) {
    return '적용 시작일과 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.';
  }
  if (draft.effectiveTo < draft.effectiveFrom) {
    return '적용 종료일은 적용 시작일보다 빠를 수 없습니다.';
  }
  if (
    !isValidTimeInputString(draft.workStart) ||
    !isValidTimeInputString(draft.workEnd) ||
    draft.workEnd <= draft.workStart
  ) {
    return '근무 시작 시각은 종료 시각보다 빨라야 합니다.';
  }
  if (
    !isValidTimeInputString(draft.lunchStart) ||
    !isValidTimeInputString(draft.lunchEnd) ||
    draft.lunchEnd <= draft.lunchStart
  ) {
    return '점심 시작 시각은 종료 시각보다 빨라야 합니다.';
  }
  if (
    !Number.isInteger(draft.periodCount) ||
    draft.periodCount < 1 ||
    draft.periodCount > VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX
  ) {
    return `교시 수는 1교시부터 ${VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX}교시까지만 설정할 수 있습니다.`;
  }

  for (let p = 1; p <= draft.periodCount; p++) {
    const pt = draft.periodTimes[String(p)];
    if (!pt) {
      return `${p}교시 시간 설정이 누락되었습니다.`;
    }
    if (
      !isValidTimeInputString(pt.startTime) ||
      !isValidTimeInputString(pt.endTime) ||
      pt.endTime <= pt.startTime
    ) {
      return `${p}교시 시작 시각이 종료 시각보다 빠르도록 설정해 주세요.`;
    }
  }
  return null;
}

export function selectActiveTimetableForDate(
  timetables: TimetableRecord[],
  dateKey: string,
): TimetableRecord | null {
  if (!isValidDateInputString(dateKey) || timetables.length === 0) {
    return null;
  }

  const inRange = timetables.filter(
    (tt) => tt.effectiveFrom <= dateKey && dateKey <= tt.effectiveTo,
  );
  if (inRange.length === 0) return null;

  const sorted = [...inRange].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.effectiveFrom !== b.effectiveFrom) {
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    }
    const aMs = a.updatedAt?.toMillis?.() ?? 0;
    const bMs = b.updatedAt?.toMillis?.() ?? 0;
    return bMs - aMs;
  });

  return sorted[0] ?? null;
}

export function resolveTimetableForDate(
  dateKey: string,
  timetables: TimetableRecord[],
  override: TimetableOverrideRecord | null = null,
): ResolvedDaySchedule {
  const weekdayIndex = getKstWeekdayIndex(dateKey);
  const isWeekday = weekdayIndex >= 1 && weekdayIndex <= 5;
  const activeTimetable = selectActiveTimetableForDate(timetables, dateKey);

  const effectiveOverride =
    override && override.dateKey === dateKey ? override : null;

  const workStart =
    effectiveOverride?.workStart || activeTimetable?.workStart || '08:30';
  const workEnd =
    effectiveOverride?.workEnd || activeTimetable?.workEnd || '16:30';
  const lunchStart =
    effectiveOverride?.lunchStart || activeTimetable?.lunchStart || '12:20';
  const lunchEnd =
    effectiveOverride?.lunchEnd || activeTimetable?.lunchEnd || '13:20';

  const basePeriodCount = activeTimetable?.periodCount ?? 0;
  const overridePeriodNums = Object.keys(effectiveOverride?.slots ?? {}).map(Number);
  const maxPeriod = Math.max(
    basePeriodCount,
    overridePeriodNums.length > 0 ? Math.max(...overridePeriodNums) : 0,
  );

  const fallbackTimes = createDefaultPeriodTimes(Math.max(1, maxPeriod));
  const periods: ResolvedPeriodSlot[] = [];

  for (let p = 1; p <= maxPeriod; p++) {
    const pKey = String(p);
    const pt =
      effectiveOverride?.periodTimes?.[pKey] ??
      activeTimetable?.periodTimes?.[pKey] ??
      fallbackTimes[pKey];
    if (!pt) continue;

    const overrideSlot = effectiveOverride?.slots?.[pKey];
    const baseSlot =
      isWeekday && activeTimetable
        ? activeTimetable.slots[makeSlotKey(weekdayIndex as TimetableWeekday, p)]
        : undefined;

    if (overrideSlot) {
      periods.push({
        period: p,
        label: pt.label || `${p}교시`,
        startTime: pt.startTime,
        endTime: pt.endTime,
        kind: overrideSlot.kind,
        subject: overrideSlot.subject,
        className: overrideSlot.className,
        classroom: overrideSlot.classroom,
        note: overrideSlot.note,
        workAvailable:
          overrideSlot.kind === 'class' || overrideSlot.kind === 'fixed_duty'
            ? false
            : Boolean(overrideSlot.workAvailable),
        isOverridden: true,
      });
    } else if (baseSlot) {
      periods.push({
        period: p,
        label: pt.label || `${p}교시`,
        startTime: pt.startTime,
        endTime: pt.endTime,
        kind: baseSlot.kind,
        subject: baseSlot.subject,
        className: baseSlot.className,
        classroom: baseSlot.classroom,
        note: baseSlot.note,
        workAvailable:
          baseSlot.kind === 'class' || baseSlot.kind === 'fixed_duty'
            ? false
            : Boolean(baseSlot.workAvailable),
        isOverridden: false,
      });
    } else if (isWeekday && activeTimetable) {
      periods.push({
        period: p,
        label: pt.label || `${p}교시`,
        startTime: pt.startTime,
        endTime: pt.endTime,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: false,
        isOverridden: false,
      });
    }
  }

  return {
    dateKey,
    weekdayIndex,
    isWeekday,
    timetableId: activeTimetable?.id ?? null,
    timetableName: activeTimetable?.name ?? null,
    hasOverride: Boolean(effectiveOverride),
    overrideReason: effectiveOverride?.reason ?? '',
    workStart,
    workEnd,
    lunchStart,
    lunchEnd,
    periods,
  };
}

interface RawRange {
  startMin: number;
  endMin: number;
  label?: string;
}

function normalizeAndMergeRanges(ranges: RawRange[]): RawRange[] {
  const valid = ranges
    .filter((r) => r.endMin > r.startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const merged: RawRange[] = [];
  for (const r of valid) {
    const prev = merged[merged.length - 1];
    if (prev && r.startMin <= prev.endMin) {
      prev.endMin = Math.max(prev.endMin, r.endMin);
      if (prev.label && r.label && prev.label !== r.label) {
        prev.label = `${prev.label}, ${r.label}`;
      }
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

function subtractRanges(base: RawRange[], blockers: RawRange[]): RawRange[] {
  const cleanBase = normalizeAndMergeRanges(base);
  const cleanBlockers = normalizeAndMergeRanges(blockers);
  let current = cleanBase;

  for (const block of cleanBlockers) {
    const next: RawRange[] = [];
    for (const seg of current) {
      if (block.endMin <= seg.startMin || block.startMin >= seg.endMin) {
        next.push(seg);
        continue;
      }
      if (block.startMin > seg.startMin) {
        next.push({ startMin: seg.startMin, endMin: block.startMin, label: seg.label });
      }
      if (block.endMin < seg.endMin) {
        next.push({ startMin: block.endMin, endMin: seg.endMin, label: seg.label });
      }
    }
    current = next;
  }

  return current;
}

function intersectRangeLists(aList: RawRange[], bList: RawRange[]): RawRange[] {
  const res: RawRange[] = [];
  for (const a of normalizeAndMergeRanges(aList)) {
    for (const b of normalizeAndMergeRanges(bList)) {
      const start = Math.max(a.startMin, b.startMin);
      const end = Math.min(a.endMin, b.endMin);
      if (end > start) {
        res.push({ startMin: start, endMin: end });
      }
    }
  }
  return normalizeAndMergeRanges(res);
}

function toMinuteIntervals(ranges: RawRange[]): MinuteInterval[] {
  return ranges.map((r) => ({
    startMin: r.startMin,
    endMin: r.endMin,
    startTime: minutesToHhMm(r.startMin),
    endTime: minutesToHhMm(r.endMin),
    minutes: r.endMin - r.startMin,
    ...(r.label ? { label: r.label } : {}),
  }));
}

function sumRangeMinutes(ranges: RawRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.endMin - r.startMin), 0);
}

/**
 * Computes deterministic daily schedule availability & personal-event overlaps
 * without invoking any AI service (prepares structured data for future AI planner).
 */
export function computeDayTimeAvailability(params: {
  resolvedDay: ResolvedDaySchedule;
  events: CalendarEventRecord[];
  minUnscheduledBlockMinutes?: number;
}): DayTimeAvailability {
  const { resolvedDay, events, minUnscheduledBlockMinutes = 15 } = params;
  const hasTimetable = resolvedDay.timetableId !== null || resolvedDay.hasOverride;
  const workStartMin = hhMmToMinutes(resolvedDay.workStart);
  const workEndMin = hhMmToMinutes(resolvedDay.workEnd);
  const lunchStartMin = hhMmToMinutes(resolvedDay.lunchStart);
  const lunchEndMin = hhMmToMinutes(resolvedDay.lunchEnd);

  const classRaw: RawRange[] = [];
  const freeRaw: RawRange[] = [];
  const fixedDutyRaw: RawRange[] = [];
  const explicitWorkablePeriodRaw: RawRange[] = [];
  const allDefinedPeriodRaw: RawRange[] = [];

  for (const slot of resolvedDay.periods) {
    if (!isValidTimeInputString(slot.startTime) || !isValidTimeInputString(slot.endTime)) {
      continue;
    }
    const sMin = hhMmToMinutes(slot.startTime);
    const eMin = hhMmToMinutes(slot.endTime);
    if (eMin <= sMin) continue;

    allDefinedPeriodRaw.push({ startMin: sMin, endMin: eMin });

    const displayLabel = slot.subject
      ? `${slot.label} ${slot.subject}`
      : slot.label;

    if (slot.kind === 'class') {
      classRaw.push({ startMin: sMin, endMin: eMin, label: displayLabel });
    } else if (slot.kind === 'free') {
      freeRaw.push({ startMin: sMin, endMin: eMin, label: slot.label });
      if (slot.workAvailable) {
        explicitWorkablePeriodRaw.push({
          startMin: sMin,
          endMin: eMin,
          label: `${slot.label} 공강(업무 가능)`,
        });
      }
    } else if (slot.kind === 'fixed_duty') {
      fixedDutyRaw.push({ startMin: sMin, endMin: eMin, label: displayLabel });
    } else {
      // kind === 'other'
      if (slot.workAvailable) {
        explicitWorkablePeriodRaw.push({ startMin: sMin, endMin: eMin, label: displayLabel });
      } else {
        fixedDutyRaw.push({ startMin: sMin, endMin: eMin, label: displayLabel });
      }
    }
  }

  // Unscheduled working blocks (e.g. before 1st period, after last period, >= 15 mins)
  const unscheduledWorkRaw: RawRange[] = [];
  if (hasTimetable && resolvedDay.isWeekday && workEndMin > workStartMin) {
    const lunchRange: RawRange[] =
      lunchEndMin > lunchStartMin
        ? [{ startMin: lunchStartMin, endMin: lunchEndMin }]
        : [];
    const remainingWorking = subtractRanges(
      [{ startMin: workStartMin, endMin: workEndMin }],
      [...allDefinedPeriodRaw, ...lunchRange],
    );
    for (const seg of remainingWorking) {
      if (seg.endMin - seg.startMin >= minUnscheduledBlockMinutes) {
        unscheduledWorkRaw.push({
          startMin: seg.startMin,
          endMin: seg.endMin,
          label: '수업 외 근무 시간',
        });
      }
    }
  }

  // Workable intervals inside [workStart, workEnd] minus lunch
  const lunchBlock: RawRange[] =
    lunchEndMin > lunchStartMin
      ? [{ startMin: lunchStartMin, endMin: lunchEndMin }]
      : [];

  const workableBeforeLunchRemoval = [
    ...intersectRangeLists(explicitWorkablePeriodRaw, [
      { startMin: workStartMin, endMin: workEndMin },
    ]),
    ...unscheduledWorkRaw,
  ];
  const workableConfiguredRaw = normalizeAndMergeRanges(
    subtractRanges(workableBeforeLunchRemoval, lunchBlock),
  );

  // Convert personal events overlapping dateKey into minute ranges
  const { startMs: dayStartMs, endMs: dayEndMs } = getKstDayRangeMs(resolvedDay.dateKey);
  const eventRangesWithMeta: {
    event: CalendarEventRecord;
    range: RawRange;
  }[] = [];

  for (const ev of events) {
    const startDate = timestampToDate(ev.startsAt);
    const endDate = timestampToDate(ev.endsAt);
    if (!startDate || !endDate) continue;
    const evStartMs = startDate.getTime();
    const evEndMs = endDate.getTime();
    if (evEndMs < dayStartMs || evStartMs > dayEndMs) continue;

    if (ev.allDay) {
      eventRangesWithMeta.push({
        event: ev,
        range: { startMin: workStartMin, endMin: workEndMin },
      });
      continue;
    }

    const clippedStartMs = Math.max(evStartMs, dayStartMs);
    const clippedEndMs = Math.min(evEndMs, dayEndMs);
    const startParts = getKstDateParts(new Date(clippedStartMs));
    const endParts = getKstDateParts(new Date(clippedEndMs));

    const startMin =
      startParts.dateKey === resolvedDay.dateKey
        ? startParts.hour * 60 +
          new Date(clippedStartMs + 9 * 60 * 60 * 1000).getUTCMinutes()
        : 0;

    const endKst = new Date(clippedEndMs + 9 * 60 * 60 * 1000);
    const endMin =
      clippedEndMs === dayEndMs
        ? 24 * 60
        : endParts.hour * 60 + endKst.getUTCMinutes();

    if (endMin > startMin) {
      eventRangesWithMeta.push({
        event: ev,
        range: { startMin, endMin },
      });
    }
  }

  const conflicts: EventOverlapConflict[] = [];
  const allEventRanges: RawRange[] = [];

  for (const { event, range } of eventRangesWithMeta) {
    allEventRanges.push(range);

    const overlapWorkable = intersectRangeLists([range], workableConfiguredRaw);
    const overlapClass = intersectRangeLists([range], classRaw);
    const overlapDuty = intersectRangeLists([range], fixedDutyRaw);

    if (overlapClass.length > 0) {
      const mins = sumRangeMinutes(overlapClass);
      const first = overlapClass[0];
      conflicts.push({
        eventId: event.id,
        eventTitle: event.title,
        startTime: minutesToHhMm(first.startMin),
        endTime: minutesToHhMm(overlapClass[overlapClass.length - 1].endMin),
        minutes: mins,
        overlapsWith: 'class',
        detail: `수업 시간과 ${formatMinutesKorean(mins)} 겹칩니다.`,
      });
    } else if (overlapDuty.length > 0) {
      const mins = sumRangeMinutes(overlapDuty);
      const first = overlapDuty[0];
      conflicts.push({
        eventId: event.id,
        eventTitle: event.title,
        startTime: minutesToHhMm(first.startMin),
        endTime: minutesToHhMm(overlapDuty[overlapDuty.length - 1].endMin),
        minutes: mins,
        overlapsWith: 'fixed_duty',
        detail: `고정 업무 시간과 ${formatMinutesKorean(mins)} 겹칩니다.`,
      });
    } else if (overlapWorkable.length > 0) {
      const mins = sumRangeMinutes(overlapWorkable);
      const first = overlapWorkable[0];
      conflicts.push({
        eventId: event.id,
        eventTitle: event.title,
        startTime: minutesToHhMm(first.startMin),
        endTime: minutesToHhMm(overlapWorkable[overlapWorkable.length - 1].endMin),
        minutes: mins,
        overlapsWith: 'workable',
        detail: `업무 가능 시간대 중 ${formatMinutesKorean(mins)}을 사용합니다.`,
      });
    }
  }

  const mergedClass = normalizeAndMergeRanges(classRaw);
  const mergedFree = normalizeAndMergeRanges(freeRaw);
  const mergedFixed = normalizeAndMergeRanges(fixedDutyRaw);
  const mergedExplicitFreeWorkable = normalizeAndMergeRanges(
    subtractRanges(explicitWorkablePeriodRaw, lunchBlock),
  );
  const mergedUnscheduled = normalizeAndMergeRanges(unscheduledWorkRaw);

  const workableOverlapRanges = intersectRangeLists(
    workableConfiguredRaw,
    allEventRanges,
  );
  const netAvailableRaw = subtractRanges(workableConfiguredRaw, allEventRanges);

  return {
    dateKey: resolvedDay.dateKey,
    hasTimetable,
    isWeekday: resolvedDay.isWeekday,
    hasOverride: resolvedDay.hasOverride,
    workStart: resolvedDay.workStart,
    workEnd: resolvedDay.workEnd,
    lunchStart: resolvedDay.lunchStart,
    lunchEnd: resolvedDay.lunchEnd,
    classMinutes: sumRangeMinutes(mergedClass),
    classIntervals: toMinuteIntervals(mergedClass),
    freeMinutes: sumRangeMinutes(mergedFree),
    freeIntervals: toMinuteIntervals(mergedFree),
    fixedDutyMinutes: sumRangeMinutes(mergedFixed),
    fixedDutyIntervals: toMinuteIntervals(mergedFixed),
    freeWorkableMinutes: sumRangeMinutes(mergedExplicitFreeWorkable),
    unscheduledWorkMinutes: sumRangeMinutes(mergedUnscheduled),
    workableConfiguredMinutes: sumRangeMinutes(workableConfiguredRaw),
    workableConfiguredIntervals: toMinuteIntervals(workableConfiguredRaw),
    overlappingEventMinutes: sumRangeMinutes(workableOverlapRanges),
    conflicts,
    netAvailableMinutes: sumRangeMinutes(netAvailableRaw),
    netAvailableIntervals: toMinuteIntervals(netAvailableRaw),
  };
}
