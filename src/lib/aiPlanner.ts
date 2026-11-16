import {
  ACADEMIC_CATEGORY_META,
  getAcademicEventsForDateKey,
} from './academicCalendar.ts';
import {
  AI_LIMITS,
  type AiPlannerRawResult,
  type AiPlannerRequest,
  type AiTokenUsage,
  type MinimalPlannerSlot,
  type MinimalPlannerTask,
} from './aiTypes.ts';
import { classifyTodayBriefing, timestampToDate } from './briefing.ts';
import {
  formatKstEventTimeRange,
  getKstDateInputValue,
  getKstDateParts,
  isValidTimeInputString,
  sanitizeSingleLine,
} from './dateKst.ts';
import { sanitizeMinimalFieldForAi } from './privacyGuard.ts';
import {
  computeDayTimeAvailability,
  formatMinutesKorean,
  hhMmToMinutes,
  minutesToHhMm,
  resolveTimetableForDate,
  type DayTimeAvailability,
  type MinuteInterval,
} from './timetable.ts';
import type {
  AcademicEventRecord,
  CalendarEventRecord,
  TaskPriority,
  TaskRecord,
  TimetableOverrideRecord,
  TimetableRecord,
} from '../types/domain.ts';

export interface PlanAdjustmentFilter {
  maxTaskMinutes?: number | null;
  maxTotalMinutes?: number | null;
  excludedTaskIds?: string[];
  constraintText?: string;
}

export type AvailabilityStatusReason =
  | 'available'
  | 'weekend_or_holiday'
  | 'no_timetable'
  | 'unconfirmed_academic'
  | 'no_workable_free_periods'
  | 'after_work_hours'
  | 'blocked_by_events';

export interface PlannerContextResult {
  todayKey: string;
  currentTimeHhMm: string;
  currentMinOfDay: number;
  timetableConfigured: boolean;
  hasConfirmedOverride: boolean;
  fullDayAvailability: DayTimeAvailability;
  remainingWorkableIntervals: MinuteInterval[];
  remainingWorkableMinutes: number;
  availabilityReason: AvailabilityStatusReason;
  availabilityReasonDetail: string;
  unconfirmedAcademicWarnings: string[];
  todayAcademicEvents: AcademicEventRecord[];
  activeIncompleteTasks: TaskRecord[];
  rankedTasks: TaskRecord[];
  compressedRequest: AiPlannerRequest;
  fingerprint: string;
  dataFingerprint: string;
}

export interface ValidatedPlanItem {
  taskId: string;
  title: string;
  priority: TaskPriority;
  dueDateKey: string | null;
  isOverdue: boolean;
  order: number;
  estimatedMinutes: number;
  durationSource: 'user' | 'ai_estimated';
  slotStart: string | null;
  slotEnd: string | null;
  slotStatus: 'scheduled' | 'repaired' | 'unscheduled_overflow';
  tier: 'must' | 'optional';
  reason: string;
  strategy: string | null;
  validationNote: string | null;
}

export interface ValidatedPlanTaskNote {
  taskId: string;
  title: string;
  priority: TaskPriority;
  dueDateKey: string | null;
  reason: string;
}

export interface ValidatedDayPlan {
  mode: 'ai' | 'deterministic';
  model: string | null;
  generatedAtIso: string;
  todayKey: string;
  coreAdvice: string;
  recommendations: ValidatedPlanItem[];
  attentionTasks: ValidatedPlanTaskNote[];
  deferredTasks: ValidatedPlanTaskNote[];
  totalPlannedMinutes: number;
  remainingWorkableMinutes: number;
  remainingSpareMinutes: number;
  availabilityReason?: AvailabilityStatusReason;
  availabilityReasonDetail?: string;
  overloadWarning: string | null;
  academicWarnings: string[];
  validationRepairs: string[];
  fromCache?: boolean;
  usage?: AiTokenUsage;
}

export function getDefaultUnscheduledNote(reason: AvailabilityStatusReason): string {
  switch (reason) {
    case 'weekend_or_holiday':
      return '주말·휴일에는 근무 시간을 임의로 배정하지 않아 시간대 미배정';
    case 'no_timetable':
      return '주간 시간표가 미등록되어 시간대 미배정 (우선순위 참고용)';
    case 'unconfirmed_academic':
      return '학사일정 시간표 임시 변경이 미확정되어 시간대 미배정';
    case 'no_workable_free_periods':
      return '시간표상 업무 가능 공강·여유 시간이 설정되지 않아 시간대 미배정';
    case 'after_work_hours':
      return '오늘 업무 가능 시각이 지나 시간대 미배정';
    case 'blocked_by_events':
      return '수업·개인 일정·학사일정과 겹쳐 남은 가용 시간 부족';
    default:
      return '오늘 확보된 가용 시간대 부족 (시간 확인 또는 내일로 조정 권장)';
  }
}

export function getAvailabilityReasonShortLabel(
  reason?: AvailabilityStatusReason,
): string {
  switch (reason) {
    case 'weekend_or_holiday':
      return '주말·휴일 (미지정)';
    case 'no_timetable':
      return '시간표 미등록';
    case 'unconfirmed_academic':
      return '학사일정 미확정';
    case 'no_workable_free_periods':
      return '가능 공강 미설정';
    case 'after_work_hours':
      return '근무 시간 경과';
    case 'blocked_by_events':
      return '일정·행사 겹침';
    default:
      return '가용 시간 없음';
  }
}

const PRIORITY_CODE_MAP: Record<TaskPriority, MinimalPlannerTask['p']> = {
  urgent: 'u',
  high: 'h',
  normal: 'n',
  low: 'l',
};

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 400,
  high: 250,
  normal: 100,
  low: 40,
};

function dateKeyToEpochDays(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function diffDaysFromToday(targetDateKey: string, todayKey: string): number {
  return dateKeyToEpochDays(targetDateKey) - dateKeyToEpochDays(todayKey);
}

function scoreTaskForPlanning(
  task: TaskRecord,
  todayKey: string,
  imminentDays: number,
  todayEventIds: ReadonlySet<string>,
): number {
  let score = PRIORITY_WEIGHT[task.priority] ?? 100;

  if (task.status === 'doing') score += 120;
  if (task.status === 'on_hold') score -= 180;

  const dueKey = getKstDateInputValue(timestampToDate(task.dueAt));
  const schedKey = getKstDateInputValue(timestampToDate(task.scheduledAt));
  const remindKey = getKstDateInputValue(timestampToDate(task.remindAt));

  if (dueKey) {
    const dDay = diffDaysFromToday(dueKey, todayKey);
    if (dDay < 0) {
      // Overdue gets highest urgency plus modest extra per overdue day (capped)
      score += 700 + Math.min(200, Math.abs(dDay) * 20);
    } else if (dDay === 0) {
      score += 550;
    } else if (dDay <= imminentDays) {
      score += 360 - dDay * 40;
    } else if (dDay <= 7) {
      score += 120;
    }
  }

  if (schedKey === todayKey) score += 200;
  if (remindKey && remindKey <= todayKey) score += 160;
  if (task.relatedEventId && todayEventIds.has(task.relatedEventId)) {
    score += 140;
  }
  if (task.estimatedMinutes && task.estimatedMinutes <= 30) {
    score += 20;
  }

  return score;
}

/**
 * Trims day workable intervals from current KST minute onward when planning for today.
 * Respects classes, fixed_duty, lunch, unworkable free periods, personal events, and minimum 10m window.
 */
export function clipIntervalsToCurrentTime(
  intervals: MinuteInterval[],
  currentMinOfDay: number,
  minWindowMinutes = 10,
): MinuteInterval[] {
  const result: MinuteInterval[] = [];
  for (const seg of intervals) {
    if (seg.endMin <= currentMinOfDay) continue;
    const startMin = Math.max(seg.startMin, currentMinOfDay);
    const minutes = seg.endMin - startMin;
    if (minutes < minWindowMinutes) continue;
    result.push({
      startMin,
      endMin: seg.endMin,
      startTime: minutesToHhMm(startMin),
      endTime: seg.endTime,
      minutes,
      ...(seg.label ? { label: seg.label } : {}),
    });
  }
  return result;
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computePlannerFingerprint(params: {
  uid: string;
  todayKey: string;
  workableSlots: MinimalPlannerSlot[];
  tasks: MinimalPlannerTask[];
  blockedEventsSummary: string[];
  academicAlertsSummary: string[];
  constraint?: string;
}): string {
  const canonical = JSON.stringify({
    u: params.uid,
    d: params.todayKey,
    w: params.workableSlots.map((s) => `${s.st}-${s.et}`),
    t: params.tasks.map((t) => `${t.id}:${t.p}:${t.s}:${t.d ?? ''}:${t.m ?? ''}:${t.t}`),
    e: params.blockedEventsSummary,
    a: params.academicAlertsSummary,
    c: (params.constraint ?? '').trim(),
  });
  return `plan_${fnv1aHash(canonical)}`;
}

/**
 * Pure deterministic context builder: computes timetable/event/academic availability
 * and compresses up to 15 highest-priority tasks WITHOUT any task description or memo content.
 */
export function buildAiPlannerContext(params: {
  uid: string;
  todayKey: string;
  now?: Date;
  imminentDays?: number;
  tasks: TaskRecord[];
  events: CalendarEventRecord[];
  timetables: TimetableRecord[];
  overridesByDate: Record<string, TimetableOverrideRecord>;
  academicEvents: AcademicEventRecord[];
  filter?: PlanAdjustmentFilter;
}): PlannerContextResult {
  const now = params.now ?? new Date();
  const imminentDays = params.imminentDays ?? 3;
  const kstParts = getKstDateParts(now);
  const kstNowDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMinOfDay =
    kstParts.dateKey === params.todayKey
      ? kstParts.hour * 60 + kstNowDate.getUTCMinutes()
      : 0;
  const currentTimeHhMm = minutesToHhMm(currentMinOfDay);

  const override = params.overridesByDate[params.todayKey] ?? null;
  const resolvedDay = resolveTimetableForDate(
    params.todayKey,
    params.timetables,
    override,
  );
  const fullDayAvailability = computeDayTimeAvailability({
    resolvedDay,
    events: params.events,
  });

  const todayAcademicEvents = getAcademicEventsForDateKey(
    params.academicEvents,
    params.todayKey,
  );

  const unconfirmedAcademicWarnings: string[] = [];
  let hasUnconfirmedDisruption = false;

  for (const aev of todayAcademicEvents) {
    const catLabel = ACADEMIC_CATEGORY_META[aev.category].label;
    if (aev.timetableImpact === 'needs_check' && !override) {
      hasUnconfirmedDisruption = true;
      unconfirmedAcademicWarnings.push(
        `오늘 학사일정 "${aev.title}"(${catLabel})의 시간표 임시 변경이 아직 확정되지 않아 가용 시간을 보수적으로 확인해 주세요.`,
      );
    } else if (aev.category === 'discretionary_holiday' && !override) {
      hasUnconfirmedDisruption = true;
      unconfirmedAcademicWarnings.push(
        `오늘은 "${aev.title}"(${catLabel})입니다. 실제 근무·수업 여부를 시간표 임시 변경으로 확인해 주세요.`,
      );
    }
  }

  if (!fullDayAvailability.hasTimetable && resolvedDay.isWeekday) {
    unconfirmedAcademicWarnings.push(
      '오늘 적용되는 주간 시간표가 아직 등록되지 않아 수업 외 빈 시간대를 확정할 수 없습니다. 우선순위 중심으로 안내합니다.',
    );
  }

  let remainingWorkableIntervals = clipIntervalsToCurrentTime(
    fullDayAvailability.netAvailableIntervals,
    currentMinOfDay,
  );

  // Respect explicit academic events with startTime/endTime if not already in personal events
  const academicTimeBlocks: MinuteInterval[] = [];
  for (const aev of todayAcademicEvents) {
    if (aev.startTime && aev.endTime && isValidTimeInputString(aev.startTime) && isValidTimeInputString(aev.endTime)) {
      const sMin = hhMmToMinutes(aev.startTime);
      const eMin = hhMmToMinutes(aev.endTime);
      if (eMin > sMin) {
        academicTimeBlocks.push({
          startMin: sMin,
          endMin: eMin,
          startTime: aev.startTime,
          endTime: aev.endTime,
          minutes: eMin - sMin,
          label: aev.title,
        });
      }
    }
  }

  if (academicTimeBlocks.length > 0 && remainingWorkableIntervals.length > 0) {
    remainingWorkableIntervals = subtractIntervals(
      remainingWorkableIntervals,
      academicTimeBlocks,
    );
  }

  // Also cap total workable minutes if user set maxTotalMinutes filter
  if (
    params.filter?.maxTotalMinutes &&
    params.filter.maxTotalMinutes > 0
  ) {
    remainingWorkableIntervals = trimIntervalsToTotalCap(
      remainingWorkableIntervals,
      params.filter.maxTotalMinutes,
    );
  }

  const remainingWorkableMinutes = remainingWorkableIntervals.reduce(
    (sum, s) => sum + s.minutes,
    0,
  );

  // Identify today's personal events
  const todayEventIds = new Set<string>();
  const blockedEventsSummary: string[] = [];
  for (const ev of params.events) {
    const start = timestampToDate(ev.startsAt);
    const end = timestampToDate(ev.endsAt);
    if (!start || !end) continue;
    const sKey = getKstDateInputValue(start);
    const eKey = getKstDateInputValue(end);
    if (sKey <= params.todayKey && eKey >= params.todayKey) {
      todayEventIds.add(ev.id);
      if (blockedEventsSummary.length < 6) {
        blockedEventsSummary.push(
          `${formatKstEventTimeRange(start, end, ev.allDay)} ${sanitizeSingleLine(
            sanitizeMinimalFieldForAi(ev.title),
            40,
          )}`,
        );
      }
    }
  }

  const academicAlertsSummary = todayAcademicEvents.slice(0, 4).map((aev) => {
    const status =
      aev.timetableImpact === 'override_applied'
        ? '임시변경적용'
        : aev.timetableImpact === 'needs_check' && !override
          ? '확인필요'
          : '영향없음';
    return `${sanitizeSingleLine(aev.title, 35)}(${ACADEMIC_CATEGORY_META[aev.category].shortLabel},${status})`;
  });

  // Incomplete active tasks only
  const excludedSet = new Set(params.filter?.excludedTaskIds ?? []);
  const activeIncompleteTasks = params.tasks.filter(
    (t) => !t.isDeleted && t.status !== 'done',
  );

  const filterableTasks = activeIncompleteTasks.filter((t) => {
    if (excludedSet.has(t.id)) return false;
    if (
      params.filter?.maxTaskMinutes &&
      t.estimatedMinutes &&
      t.estimatedMinutes > params.filter.maxTaskMinutes
    ) {
      return false;
    }
    return true;
  });

  const rankedTasks = [...filterableTasks].sort((a, b) => {
    const sa = scoreTaskForPlanning(a, params.todayKey, imminentDays, todayEventIds);
    const sb = scoreTaskForPlanning(b, params.todayKey, imminentDays, todayEventIds);
    if (sb !== sa) return sb - sa;
    return a.title.localeCompare(b.title, 'ko');
  });

  const briefingCounts = classifyTodayBriefing(activeIncompleteTasks, {
    now,
    imminentDays,
  });

  const compressedTasks: MinimalPlannerTask[] = rankedTasks
    .slice(0, AI_LIMITS.MAX_PLANNER_TASKS)
    .map((task) => {
      const dueKey = getKstDateInputValue(timestampToDate(task.dueAt)) || null;
      const schedKey = getKstDateInputValue(timestampToDate(task.scheduledAt)) || null;
      const remindKey = getKstDateInputValue(timestampToDate(task.remindAt)) || null;
      const dDay = dueKey ? diffDaysFromToday(dueKey, params.todayKey) : null;
      return {
        id: task.id,
        t: sanitizeSingleLine(sanitizeMinimalFieldForAi(task.title), 70),
        d: dueKey,
        ov: dDay !== null && dDay < 0,
        dd: dDay,
        p: PRIORITY_CODE_MAP[task.priority] ?? 'n',
        s: task.status === 'doing' ? 'dg' : task.status === 'on_hold' ? 'oh' : 'td',
        m: typeof task.estimatedMinutes === 'number' ? task.estimatedMinutes : null,
        tdy:
          dDay === 0 ||
          schedKey === params.todayKey ||
          (remindKey !== null && remindKey <= params.todayKey),
        ...(task.relatedEventId && todayEventIds.has(task.relatedEventId)
          ? { ev: true }
          : {}),
      };
    });

  const effectiveRemainingIntervals =
    hasUnconfirmedDisruption && !override ? [] : remainingWorkableIntervals;
  const effectiveRemainingMinutes =
    hasUnconfirmedDisruption && !override ? 0 : remainingWorkableMinutes;

  let availabilityReason: AvailabilityStatusReason = 'available';
  let availabilityReasonDetail = '';

  if (hasUnconfirmedDisruption && !override) {
    availabilityReason = 'unconfirmed_academic';
    availabilityReasonDetail =
      '오늘 학사일정의 시간표 임시 변경 여부가 확정되지 않아 수업 외 가용 시간을 비워 두었습니다. 시간표 임시 변경으로 확정하면 가용 시간이 반영됩니다.';
  } else if (effectiveRemainingMinutes > 0) {
    availabilityReason = 'available';
  } else if (!resolvedDay.isWeekday && !override) {
    availabilityReason = 'weekend_or_holiday';
    availabilityReasonDetail =
      '주말·휴일에는 임의의 근무시간을 만들지 않습니다. 실제 근무·출근 일정이 있다면 해당 날짜에 시간표 임시 변경을 등록해 주세요.';
  } else if (!fullDayAvailability.hasTimetable) {
    availabilityReason = 'no_timetable';
    availabilityReasonDetail =
      '오늘 적용되는 주간 시간표가 아직 등록되지 않았습니다. 시간표를 등록하면 수업 외 가용 시간대에 업무를 배치할 수 있습니다.';
  } else if (fullDayAvailability.workableConfiguredMinutes === 0) {
    availabilityReason = 'no_workable_free_periods';
    availabilityReasonDetail =
      '오늘 시간표에 수업 외 "업무 가능"으로 지정된 공강·여유 시간이 없습니다. 시간표에서 공강 교시에 업무 가능 표시를 켜거나 비수업 근무 구간을 확인해 주세요.';
  } else if (
    fullDayAvailability.netAvailableMinutes === 0 &&
    fullDayAvailability.overlappingEventMinutes > 0
  ) {
    availabilityReason = 'blocked_by_events';
    availabilityReasonDetail =
      '오늘 업무 가능 시간이 개인 일정과 모두 겹쳐 남은 가용 시간이 없습니다.';
  } else {
    const clippedBeforeAcademic = clipIntervalsToCurrentTime(
      fullDayAvailability.netAvailableIntervals,
      currentMinOfDay,
    );
    if (clippedBeforeAcademic.length === 0 && fullDayAvailability.netAvailableMinutes > 0) {
      availabilityReason = 'after_work_hours';
      availabilityReasonDetail = `현재 시각(${currentTimeHhMm}) 기준으로 오늘 설정된 업무 가능 시간(${resolvedDay.workStart}~${resolvedDay.workEnd})이 모두 지났습니다.`;
    } else if (academicTimeBlocks.length > 0) {
      availabilityReason = 'blocked_by_events';
      availabilityReasonDetail =
        '오늘 업무 가능 시간이 개인 일정 또는 학사일정 시간대와 모두 겹쳐 남은 가용 시간이 없습니다.';
    } else {
      availabilityReason = 'no_workable_free_periods';
      availabilityReasonDetail =
        '오늘 남은 가용 시간이 확보되지 않아 우선순위만 정리했습니다.';
    }
  }

  const workableSlots: MinimalPlannerSlot[] = effectiveRemainingIntervals
    .slice(0, AI_LIMITS.MAX_PLANNER_SLOTS)
    .map((seg) => ({
      st: seg.startTime,
      et: seg.endTime,
      min: seg.minutes,
      lb: sanitizeSingleLine(seg.label || '업무 가능 시간', 24),
    }));

  const fullDaySlotsForSignature: MinimalPlannerSlot[] = (
    hasUnconfirmedDisruption && !override
      ? []
      : fullDayAvailability.netAvailableIntervals
  )
    .slice(0, AI_LIMITS.MAX_PLANNER_SLOTS)
    .map((seg) => ({
      st: seg.startTime,
      et: seg.endTime,
      min: seg.minutes,
      lb: sanitizeSingleLine(seg.label || '업무 가능 시간', 24),
    }));

  const constraint = params.filter?.constraintText
    ? sanitizeSingleLine(
        sanitizeMinimalFieldForAi(params.filter.constraintText),
        AI_LIMITS.MAX_ADJUST_CONSTRAINT_CHARS,
      )
    : undefined;

  const compressedRequest: AiPlannerRequest = {
    todayKey: params.todayKey,
    currentTimeHhMm,
    totalIncompleteCount: activeIncompleteTasks.length,
    overdueCount: briefingCounts.overdue.length,
    dueTodayCount: briefingCounts.dueToday.length,
    timetableConfigured: fullDayAvailability.hasTimetable,
    remainingWorkableMinutes: effectiveRemainingMinutes,
    workableSlots,
    blockedEventsSummary,
    academicAlertsSummary,
    tasks: compressedTasks,
    ...(constraint ? { constraint } : {}),
  };

  const fingerprint = computePlannerFingerprint({
    uid: params.uid,
    todayKey: params.todayKey,
    workableSlots,
    tasks: compressedTasks,
    blockedEventsSummary,
    academicAlertsSummary,
    constraint,
  });

  const dataFingerprint = computePlannerFingerprint({
    uid: params.uid,
    todayKey: params.todayKey,
    workableSlots: fullDaySlotsForSignature,
    tasks: compressedTasks,
    blockedEventsSummary,
    academicAlertsSummary,
    constraint,
  });

  return {
    todayKey: params.todayKey,
    currentTimeHhMm,
    currentMinOfDay,
    timetableConfigured: fullDayAvailability.hasTimetable,
    hasConfirmedOverride: Boolean(override),
    fullDayAvailability,
    remainingWorkableIntervals: effectiveRemainingIntervals,
    remainingWorkableMinutes: effectiveRemainingMinutes,
    availabilityReason,
    availabilityReasonDetail,
    unconfirmedAcademicWarnings,
    todayAcademicEvents,
    activeIncompleteTasks,
    rankedTasks,
    compressedRequest,
    fingerprint,
    dataFingerprint,
  };
}

function subtractIntervals(
  base: MinuteInterval[],
  blockers: MinuteInterval[],
): MinuteInterval[] {
  let current = base.map((b) => ({ ...b }));
  for (const blk of blockers) {
    const next: MinuteInterval[] = [];
    for (const seg of current) {
      if (blk.endMin <= seg.startMin || blk.startMin >= seg.endMin) {
        next.push(seg);
        continue;
      }
      if (blk.startMin > seg.startMin) {
        const mins = blk.startMin - seg.startMin;
        if (mins >= 10) {
          next.push({
            startMin: seg.startMin,
            endMin: blk.startMin,
            startTime: minutesToHhMm(seg.startMin),
            endTime: minutesToHhMm(blk.startMin),
            minutes: mins,
            label: seg.label,
          });
        }
      }
      if (blk.endMin < seg.endMin) {
        const mins = seg.endMin - blk.endMin;
        if (mins >= 10) {
          next.push({
            startMin: blk.endMin,
            endMin: seg.endMin,
            startTime: minutesToHhMm(blk.endMin),
            endTime: seg.endTime,
            minutes: mins,
            label: seg.label,
          });
        }
      }
    }
    current = next;
  }
  return current;
}

function trimIntervalsToTotalCap(
  intervals: MinuteInterval[],
  capMinutes: number,
): MinuteInterval[] {
  let remaining = capMinutes;
  const trimmed: MinuteInterval[] = [];
  for (const seg of intervals) {
    if (remaining <= 0) break;
    if (seg.minutes <= remaining) {
      trimmed.push(seg);
      remaining -= seg.minutes;
    } else {
      const endMin = seg.startMin + remaining;
      trimmed.push({
        startMin: seg.startMin,
        endMin,
        startTime: seg.startTime,
        endTime: minutesToHhMm(endMin),
        minutes: remaining,
        label: seg.label,
      });
      remaining = 0;
    }
  }
  return trimmed;
}

function isRangeInsideIntervals(
  startMin: number,
  endMin: number,
  intervals: MinuteInterval[],
): boolean {
  if (endMin <= startMin) return false;
  return intervals.some((seg) => startMin >= seg.startMin && endMin <= seg.endMin);
}

function allocateSlotDeterministically(
  durationMinutes: number,
  freeCursorIntervals: MinuteInterval[],
  minSplitMinutes = 10,
): { startMin: number; endMin: number; updatedFree: MinuteInterval[] } | null {
  // 1. Prefer first free interval that fits the entire task cleanly
  for (let i = 0; i < freeCursorIntervals.length; i++) {
    const seg = freeCursorIntervals[i];
    if (seg.minutes >= durationMinutes) {
      const startMin = seg.startMin;
      const endMin = startMin + durationMinutes;
      const updatedFree = subtractIntervals(freeCursorIntervals, [
        {
          startMin,
          endMin,
          startTime: minutesToHhMm(startMin),
          endTime: minutesToHhMm(endMin),
          minutes: durationMinutes,
        },
      ]);
      return { startMin, endMin, updatedFree };
    }
  }

  // 2. Otherwise fit into the largest remaining free window (>= minSplitMinutes)
  const largest = [...freeCursorIntervals].sort((a, b) => b.minutes - a.minutes)[0];
  if (largest && largest.minutes >= minSplitMinutes) {
    const startMin = largest.startMin;
    const endMin = largest.endMin;
    const updatedFree = subtractIntervals(freeCursorIntervals, [largest]);
    return { startMin, endMin, updatedFree };
  }

  return null;
}

function clampEstimatedMinutes(val: unknown, fallback = 30): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(10, Math.min(180, Math.round(val / 5) * 5));
}

export function recomputePlanTotals(
  plan: ValidatedDayPlan,
): ValidatedDayPlan {
  const totalPlannedMinutes = plan.recommendations.reduce(
    (sum, item) => sum + item.estimatedMinutes,
    0,
  );
  const remainingSpareMinutes = Math.max(
    0,
    plan.remainingWorkableMinutes - totalPlannedMinutes,
  );
  const overloadWarning =
    plan.remainingWorkableMinutes > 0 &&
    totalPlannedMinutes > plan.remainingWorkableMinutes
      ? `선택된 업무 예상 소요(${formatMinutesKorean(
          totalPlannedMinutes,
        )})가 오늘 남은 가용 시간(${formatMinutesKorean(
          plan.remainingWorkableMinutes,
        )})보다 ${formatMinutesKorean(
          totalPlannedMinutes - plan.remainingWorkableMinutes,
        )} 많습니다. 일부 업무를 미루거나 소요 시간을 조정해 주세요.`
      : null;

  return {
    ...plan,
    totalPlannedMinutes,
    remainingSpareMinutes,
    overloadWarning,
  };
}

/**
 * Strictly validates Gemini's structured JSON against active tasks and deterministic
 * workable intervals. Removes invalid/completed IDs and deterministically repairs any
 * colliding or invalid time slots without re-calling AI.
 */
export function validateAndRepairAiPlan(
  rawPlan: AiPlannerRawResult,
  context: PlannerContextResult,
  meta: { model: string; generatedAtIso: string; usage?: AiTokenUsage },
): ValidatedDayPlan {
  const activeTaskById = new Map<string, TaskRecord>();
  for (const t of context.activeIncompleteTasks) {
    activeTaskById.set(t.id, t);
  }
  const taskById = new Map<string, TaskRecord>();
  for (const t of context.rankedTasks) {
    taskById.set(t.id, t);
  }

  const seenIds = new Set<string>();
  const validationRepairs: string[] = [];
  let freeWindows = context.remainingWorkableIntervals.map((seg) => ({ ...seg }));

  const rawRecs = Array.isArray(rawPlan.recommendations)
    ? [...rawPlan.recommendations].sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    : [];

  const recommendations: ValidatedPlanItem[] = [];

  for (const raw of rawRecs) {
    if (recommendations.length >= AI_LIMITS.MAX_PLANNER_RECOMMENDATIONS) break;
    if (!raw || typeof raw.taskId !== 'string') continue;
    const taskId = raw.taskId.trim();
    const task = taskById.get(taskId);
    if (!task) {
      if (!activeTaskById.has(taskId)) {
        validationRepairs.push('목록에 없거나 이미 완료된 업무 ID가 제외되었습니다.');
      }
      continue;
    }
    if (seenIds.has(taskId)) continue;
    seenIds.add(taskId);

    const hasUserDuration = typeof task.estimatedMinutes === 'number';
    const durationMinutes = hasUserDuration
      ? (task.estimatedMinutes as number)
      : clampEstimatedMinutes(raw.estimatedMinutes, 30);

    const dueKey = getKstDateInputValue(timestampToDate(task.dueAt)) || null;
    const isOverdue = Boolean(dueKey && dueKey < context.todayKey);

    let slotStart: string | null = null;
    let slotEnd: string | null = null;
    let slotStatus: ValidatedPlanItem['slotStatus'] = 'unscheduled_overflow';
    let validationNote: string | null = null;

    const validAiTimes =
      isValidTimeInputString(raw.recommendedStart ?? '') &&
      isValidTimeInputString(raw.recommendedEnd ?? '');

    if (validAiTimes) {
      const sMin = hhMmToMinutes(raw.recommendedStart!);
      const eMin = hhMmToMinutes(raw.recommendedEnd!);
      if (isRangeInsideIntervals(sMin, eMin, freeWindows)) {
        slotStart = raw.recommendedStart!;
        slotEnd = raw.recommendedEnd!;
        slotStatus = 'scheduled';
        freeWindows = subtractIntervals(freeWindows, [
          {
            startMin: sMin,
            endMin: eMin,
            startTime: slotStart,
            endTime: slotEnd,
            minutes: eMin - sMin,
          },
        ]);
      } else {
        const allocated = allocateSlotDeterministically(durationMinutes, freeWindows);
        if (allocated) {
          slotStart = minutesToHhMm(allocated.startMin);
          slotEnd = minutesToHhMm(allocated.endMin);
          slotStatus = 'repaired';
          freeWindows = allocated.updatedFree;
          validationNote = '수업·일정 또는 지난 시간과 겹치지 않는 실제 가용 시간대로 자동 조정됨';
          validationRepairs.push(
            `"${task.title}" 시간대가 가용 시간 기준(${slotStart}~${slotEnd})으로 보정되었습니다.`,
          );
        } else {
          validationNote = getDefaultUnscheduledNote(context.availabilityReason);
        }
      }
    } else if (freeWindows.length > 0) {
      const allocated = allocateSlotDeterministically(durationMinutes, freeWindows);
      if (allocated) {
        slotStart = minutesToHhMm(allocated.startMin);
        slotEnd = minutesToHhMm(allocated.endMin);
        slotStatus = 'repaired';
        freeWindows = allocated.updatedFree;
      } else {
        validationNote = getDefaultUnscheduledNote(context.availabilityReason);
      }
    } else {
      validationNote = getDefaultUnscheduledNote(context.availabilityReason);
    }

    const tier: ValidatedPlanItem['tier'] =
      raw.tier === 'optional'
        ? 'optional'
        : raw.tier === 'must'
          ? 'must'
          : isOverdue ||
              dueKey === context.todayKey ||
              task.priority === 'urgent' ||
              task.priority === 'high' ||
              task.status === 'doing' ||
              recommendations.length < 2
            ? 'must'
            : 'optional';

    const strategy =
      typeof raw.strategy === 'string' && raw.strategy.trim()
        ? sanitizeSingleLine(raw.strategy, 140)
        : null;

    recommendations.push({
      taskId,
      title: task.title,
      priority: task.priority,
      dueDateKey: dueKey,
      isOverdue,
      order: recommendations.length + 1,
      estimatedMinutes: durationMinutes,
      durationSource: hasUserDuration ? 'user' : 'ai_estimated',
      slotStart,
      slotEnd,
      slotStatus,
      tier,
      reason: sanitizeSingleLine(raw.reason || '마감과 중요도를 반영해 우선 추천합니다.', 180),
      strategy,
      validationNote,
    });
  }

  const normalizeTaskNotes = (
    list: Array<{ taskId?: string; reason?: string }> | undefined,
    maxCount = 6,
  ): ValidatedPlanTaskNote[] => {
    if (!Array.isArray(list)) return [];
    const out: ValidatedPlanTaskNote[] = [];
    const localSeen = new Set<string>();
    for (const entry of list) {
      if (out.length >= maxCount) break;
      if (!entry || typeof entry.taskId !== 'string') continue;
      const id = entry.taskId.trim();
      const task = taskById.get(id);
      if (!task || localSeen.has(id)) continue;
      localSeen.add(id);
      out.push({
        taskId: id,
        title: task.title,
        priority: task.priority,
        dueDateKey: getKstDateInputValue(timestampToDate(task.dueAt)) || null,
        reason: sanitizeSingleLine(entry.reason || '', 160) || '세부 일정을 확인해 주세요.',
      });
    }
    return out;
  };

  const attentionTasks = normalizeTaskNotes(rawPlan.attentionTasks);
  const deferredTasks = normalizeTaskNotes(rawPlan.deferredTasks).filter(
    (d) => !seenIds.has(d.taskId),
  );

  const coreAdvice =
    sanitizeSingleLine(rawPlan.coreAdvice || '', 260) ||
    '오늘 마감 업무와 실제 가용 시간을 기준으로 핵심 실행 순서를 정리했습니다.';

  return recomputePlanTotals({
    mode: 'ai',
    model: meta.model,
    generatedAtIso: meta.generatedAtIso,
    todayKey: context.todayKey,
    coreAdvice,
    recommendations,
    attentionTasks,
    deferredTasks,
    totalPlannedMinutes: 0,
    remainingWorkableMinutes: context.remainingWorkableMinutes,
    remainingSpareMinutes: 0,
    availabilityReason: context.availabilityReason,
    availabilityReasonDetail: context.availabilityReasonDetail,
    overloadWarning: null,
    academicWarnings: context.unconfirmedAcademicWarnings,
    validationRepairs: Array.from(new Set(validationRepairs)),
    usage: meta.usage,
  });
}

/**
 * Pure algorithmic deterministic day plan (0 AI calls).
 * Used when no API key is registered or as a rule-based fallback.
 */
export function buildDeterministicDayPlan(
  context: PlannerContextResult,
): ValidatedDayPlan {
  let freeWindows = context.remainingWorkableIntervals.map((seg) => ({ ...seg }));
  const recommendations: ValidatedPlanItem[] = [];
  const attentionTasks: ValidatedPlanTaskNote[] = [];
  const deferredTasks: ValidatedPlanTaskNote[] = [];

  for (const task of context.rankedTasks) {
    const dueKey = getKstDateInputValue(timestampToDate(task.dueAt)) || null;
    const isOverdue = Boolean(dueKey && dueKey < context.todayKey);
    const hasUserDuration = typeof task.estimatedMinutes === 'number';
    const estimatedMinutes = hasUserDuration
      ? (task.estimatedMinutes as number)
      : task.priority === 'urgent' || task.priority === 'high'
        ? 40
        : 30;

    if (recommendations.length < AI_LIMITS.MAX_PLANNER_RECOMMENDATIONS) {
      const allocated = allocateSlotDeterministically(estimatedMinutes, freeWindows);
      const slotStart = allocated ? minutesToHhMm(allocated.startMin) : null;
      const slotEnd = allocated ? minutesToHhMm(allocated.endMin) : null;
      if (allocated) {
        freeWindows = allocated.updatedFree;
      }

      const reasonParts: string[] = [];
      if (isOverdue) reasonParts.push('기한이 지나 즉시 처리 필요');
      else if (dueKey === context.todayKey) reasonParts.push('오늘 마감 예정');
      else if (task.priority === 'urgent' || task.priority === 'high') reasonParts.push('중요도 높음');
      if (task.status === 'doing') reasonParts.push('현재 진행 중');

      const compressedMatch = context.compressedRequest.tasks.find(
        (c) => c.id === task.id,
      );
      const maxRemainingWindow =
        context.remainingWorkableIntervals.length > 0
          ? Math.max(...context.remainingWorkableIntervals.map((s) => s.minutes))
          : 0;
      const tier: ValidatedPlanItem['tier'] =
        isOverdue ||
        dueKey === context.todayKey ||
        task.priority === 'urgent' ||
        task.priority === 'high' ||
        task.status === 'doing'
          ? 'must'
          : 'optional';

      let strategy: string | null = null;
      if (compressedMatch?.ev) {
        strategy = '오늘 연결된 일정 시작 전 관련 자료·안건을 먼저 점검하세요.';
      } else if (
        maxRemainingWindow > 0 &&
        estimatedMinutes > maxRemainingWindow
      ) {
        strategy = '연속 공강이 짧아 자료 확인·초안 작성·최종 점검으로 분할 진행을 권장합니다.';
      }

      recommendations.push({
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        dueDateKey: dueKey,
        isOverdue,
        order: recommendations.length + 1,
        estimatedMinutes,
        durationSource: hasUserDuration ? 'user' : 'ai_estimated',
        slotStart,
        slotEnd,
        slotStatus: allocated ? 'scheduled' : 'unscheduled_overflow',
        tier,
        reason: reasonParts.length > 0 ? `${reasonParts.join(' · ')} 항목입니다.` : '우선순위에 따라 배치했습니다.',
        strategy,
        validationNote: allocated
          ? null
          : getDefaultUnscheduledNote(context.availabilityReason),
      });

      if (isOverdue || dueKey === context.todayKey) {
        attentionTasks.push({
          taskId: task.id,
          title: task.title,
          priority: task.priority,
          dueDateKey: dueKey,
          reason: isOverdue ? '마감 기한 초과' : '오늘 마감 도래',
        });
      }
    } else if (deferredTasks.length < 5) {
      deferredTasks.push({
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        dueDateKey: dueKey,
        reason: '상위 우선순위 5건 처리 후 다음 일정으로 미루어 진행 권장',
      });
    }
  }

  const coreAdvice =
    recommendations.length === 0
      ? '현재 조건에 맞는 미완료 업무가 없습니다.'
      : context.remainingWorkableMinutes > 0
        ? `남은 업무 가능 시간 ${formatMinutesKorean(
            context.remainingWorkableMinutes,
          )} 안에 마감·중요도 순으로 ${recommendations.length}건을 배치했습니다.`
        : `${context.availabilityReasonDetail || '오늘 가용 시간이 확보되지 않아'} 우선순위 ${recommendations.length}건만 정리했습니다.`;

  return recomputePlanTotals({
    mode: 'deterministic',
    model: null,
    generatedAtIso: new Date().toISOString(),
    todayKey: context.todayKey,
    coreAdvice,
    recommendations,
    attentionTasks: attentionTasks.slice(0, 5),
    deferredTasks,
    totalPlannedMinutes: 0,
    remainingWorkableMinutes: context.remainingWorkableMinutes,
    remainingSpareMinutes: 0,
    availabilityReason: context.availabilityReason,
    availabilityReasonDetail: context.availabilityReasonDetail,
    overloadWarning: null,
    academicWarnings: context.unconfirmedAcademicWarnings,
    validationRepairs: [],
  });
}

/**
 * Reflows slots deterministically across remainingWorkableIntervals after local
 * user ordering / exclusion adjustments (0 AI calls).
 */
export function reflowPlanSlots(
  items: ValidatedPlanItem[],
  availableIntervals: MinuteInterval[],
): ValidatedPlanItem[] {
  let freeWindows = availableIntervals.map((seg) => ({ ...seg }));
  return items.map((item, idx) => {
    const allocated = allocateSlotDeterministically(item.estimatedMinutes, freeWindows);
    if (allocated) {
      freeWindows = allocated.updatedFree;
      return {
        ...item,
        order: idx + 1,
        slotStart: minutesToHhMm(allocated.startMin),
        slotEnd: minutesToHhMm(allocated.endMin),
        slotStatus: 'scheduled',
        validationNote: null,
      };
    }
    return {
      ...item,
      order: idx + 1,
      slotStart: null,
      slotEnd: null,
      slotStatus: 'unscheduled_overflow',
      validationNote: '남은 가용 시간대 부족',
    };
  });
}

export function movePlanItemOrder(
  plan: ValidatedDayPlan,
  taskId: string,
  direction: 'up' | 'down',
  availableIntervals: MinuteInterval[],
): ValidatedDayPlan {
  const list = [...plan.recommendations];
  const idx = list.findIndex((r) => r.taskId === taskId);
  if (idx === -1) return plan;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return plan;

  const temp = list[idx];
  list[idx] = list[swapIdx];
  list[swapIdx] = temp;

  return recomputePlanTotals({
    ...plan,
    recommendations: reflowPlanSlots(list, availableIntervals),
  });
}

export function excludePlanItemFromToday(
  plan: ValidatedDayPlan,
  taskId: string,
  availableIntervals: MinuteInterval[],
): ValidatedDayPlan {
  const target = plan.recommendations.find((r) => r.taskId === taskId);
  if (!target) return plan;

  const remaining = plan.recommendations.filter((r) => r.taskId !== taskId);
  const deferredTasks = [
    ...plan.deferredTasks,
    {
      taskId: target.taskId,
      title: target.title,
      priority: target.priority,
      dueDateKey: target.dueDateKey,
      reason: '사용자 조정으로 오늘 계획에서 제외됨',
    },
  ];

  return recomputePlanTotals({
    ...plan,
    recommendations: reflowPlanSlots(remaining, availableIntervals),
    deferredTasks,
  });
}

export function reassignPlanItemSlot(
  plan: ValidatedDayPlan,
  taskId: string,
  intervalIndex: number,
  availableIntervals: MinuteInterval[],
): ValidatedDayPlan {
  const chosen = availableIntervals[intervalIndex];
  if (!chosen) return plan;
  const target = plan.recommendations.find((r) => r.taskId === taskId);
  if (!target) return plan;

  const startMin = chosen.startMin;
  const endMin = Math.min(chosen.endMin, startMin + target.estimatedMinutes);

  const updated = plan.recommendations.map((item) =>
    item.taskId === taskId
      ? {
          ...item,
          slotStart: minutesToHhMm(startMin),
          slotEnd: minutesToHhMm(endMin),
          slotStatus: 'scheduled' as const,
          validationNote: null,
        }
      : item,
  );

  return recomputePlanTotals({
    ...plan,
    recommendations: updated,
  });
}
