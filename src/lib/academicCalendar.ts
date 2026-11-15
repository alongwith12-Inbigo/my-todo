import {
  addKstDaysToDateKey,
  getKstDateParts,
  getKstWeekDays,
  isValidDateInputString,
  isValidTimeInputString,
  sanitizeSingleLine,
} from './dateKst';
import {
  VALIDATION_LIMITS,
  type AcademicEventCategory,
  type AcademicEventRecord,
  type AcademicEventSourceType,
  type AcademicTimetableImpact,
  type TimetableOverrideRecord,
} from '../types/domain';

export const ACADEMIC_CATEGORY_META: Record<
  AcademicEventCategory,
  {
    label: string;
    shortLabel: string;
    badgeClass: string;
    cellClass: string;
  }
> = {
  exam: {
    label: '시험',
    shortLabel: '시험',
    badgeClass: 'bg-rose-50 text-rose-800 border-rose-200',
    cellClass: 'bg-rose-50 text-rose-900 border-rose-200 hover:bg-rose-100',
  },
  school_event: {
    label: '학교 행사',
    shortLabel: '행사',
    badgeClass: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    cellClass:
      'bg-indigo-50 text-indigo-900 border-indigo-200 hover:bg-indigo-100',
  },
  vacation: {
    label: '방학',
    shortLabel: '방학',
    badgeClass: 'bg-sky-50 text-sky-800 border-sky-200',
    cellClass: 'bg-sky-50 text-sky-900 border-sky-200 hover:bg-sky-100',
  },
  discretionary_holiday: {
    label: '재량휴업일',
    shortLabel: '휴업',
    badgeClass: 'bg-amber-50 text-amber-900 border-amber-200',
    cellClass:
      'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100',
  },
  shortened_schedule: {
    label: '단축수업',
    shortLabel: '단축',
    badgeClass: 'bg-violet-50 text-violet-800 border-violet-200',
    cellClass:
      'bg-violet-50 text-violet-900 border-violet-200 hover:bg-violet-100',
  },
  other: {
    label: '기타',
    shortLabel: '기타',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
    cellClass:
      'bg-slate-100 text-slate-800 border-slate-200 hover:bg-slate-200/70',
  },
};

export const ACADEMIC_CATEGORY_OPTIONS: {
  value: AcademicEventCategory;
  label: string;
}[] = [
  { value: 'exam', label: '시험' },
  { value: 'school_event', label: '학교 행사' },
  { value: 'vacation', label: '방학' },
  { value: 'discretionary_holiday', label: '재량휴업일' },
  { value: 'shortened_schedule', label: '단축수업' },
  { value: 'other', label: '기타' },
];

export const TIMETABLE_IMPACT_LABELS: Record<AcademicTimetableImpact, string> = {
  none: '시간표 영향 없음',
  needs_check: '시간표 변경 확인 필요',
  override_applied: '해당 날짜 시간표 변경 적용됨',
};

export const TIMETABLE_IMPACT_SHORT_LABELS: Record<
  AcademicTimetableImpact,
  string
> = {
  none: '영향 없음',
  needs_check: '확인 필요',
  override_applied: '임시변경 적용',
};

export interface AcademicEventDraft {
  title: string;
  category: AcademicEventCategory;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string;
  schoolYear: number;
  sourceType: AcademicEventSourceType;
  sourceLabel: string;
  sourceText: string;
  timetableImpact: AcademicTimetableImpact;
  overrideDateKey: string | null;
}

/**
 * Computes Korean school year (학년도):
 * March 1 .. Dec 31 belong to same calendar year; Jan 1 .. Feb 29 belong to previous year.
 */
export function getKoreanSchoolYearForDateKey(dateKey: string): number {
  if (!isValidDateInputString(dateKey)) {
    const nowParts = getKstDateParts(new Date());
    return nowParts.month >= 3 ? nowParts.year : nowParts.year - 1;
  }
  const [y, m] = dateKey.split('-').map(Number);
  return m >= 3 ? y : y - 1;
}

/**
 * Returns broad YYYY-MM-DD query bounds covering a given Korean schoolYear
 * while allowing single-field Firestore range query on `startDate` without new composite indexes.
 */
export function getSchoolYearQueryBounds(schoolYear: number): {
  rangeStart: string;
  rangeEnd: string;
} {
  return {
    rangeStart: `${schoolYear}-01-01`,
    rangeEnd: `${schoolYear + 1}-03-31`,
  };
}

/**
 * Returns the exact KST calendar bounds of a Korean schoolYear (March 1 ~ Feb 28/29 next year).
 */
export function getSchoolYearAcademicBounds(schoolYear: number): {
  fromKey: string;
  toKey: string;
} {
  const nextYear = schoolYear + 1;
  const isLeap =
    (nextYear % 4 === 0 && nextYear % 100 !== 0) || nextYear % 400 === 0;
  return {
    fromKey: `${schoolYear}-03-01`,
    toKey: `${nextYear}-02-${isLeap ? '29' : '28'}`,
  };
}

export function classifyAcademicCategory(title: string): AcademicEventCategory {
  const norm = title.replace(/\s+/g, '').toLowerCase();

  if (
    /(?:재량휴업|학교장재량|휴업일|임시휴업)/.test(norm) ||
    /개교기념.*휴업/.test(norm)
  ) {
    return 'discretionary_holiday';
  }

  if (/(?:단축수업|단축운영|단축일과|오전수업|4교시운영|5교시운영)/.test(norm)) {
    return 'shortened_schedule';
  }

  if (/(?:여름방학|겨울방학|봄방학|학년말방학|동계방학|하계방학|방학식|방학중)/.test(norm) || /^방학/.test(norm)) {
    return 'vacation';
  }

  if (
    /(?:중간고사|기말고사|정기고사|지필평가|수행평가|모의고사|전국연합|학력평가|성취도평가|모의평가|수능|시험|평가일|고사실|예비소집)/.test(
      norm,
    )
  ) {
    return 'exam';
  }

  if (
    /(?:입학식|졸업식|시업식|종업식|개학식|개학|체육대회|운동회|축제|학예회|발표회|수학여행|수련회|현장체험|체험학습|소풍|봉사활동|상담주간|학부모총회|공개수업|교육과정설명회|진로의날|합창제|안전교육|대피훈련|봉사|학생회|선거|졸업사진|신체검사|건강검진)/.test(
      norm,
    )
  ) {
    return 'school_event';
  }

  return 'other';
}

export function suggestTimetableImpactForCategory(
  category: AcademicEventCategory,
): AcademicTimetableImpact {
  if (
    category === 'exam' ||
    category === 'shortened_schedule' ||
    category === 'school_event' ||
    category === 'discretionary_holiday'
  ) {
    return 'needs_check';
  }
  return 'none';
}

export function normalizeAcademicTitleForDedupe(title: string): string {
  return title
    .toLowerCase()
    .replace(/[[\]()<>「」『』·•※*]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

export function buildAcademicDedupeKey(
  startDate: string,
  endDate: string,
  title: string,
): string {
  const safeStart = startDate.trim();
  const safeEnd = (endDate || startDate).trim();
  const normTitle = normalizeAcademicTitleForDedupe(title) || 'event';
  const raw = `${safeStart}|${safeEnd}|${normTitle}`;
  return raw.slice(0, VALIDATION_LIMITS.ACADEMIC_DEDUPE_KEY_MAX_LEN);
}

export function validateAcademicEventDraft(
  draft: AcademicEventDraft,
): string | null {
  const title = sanitizeSingleLine(draft.title, VALIDATION_LIMITS.TITLE_MAX_LEN);
  if (!title) {
    return '학사일정명을 입력해 주세요.';
  }
  if (!isValidDateInputString(draft.startDate)) {
    return '시작일(YYYY-MM-DD)을 정확히 입력해 주세요.';
  }
  if (!isValidDateInputString(draft.endDate)) {
    return '종료일(YYYY-MM-DD)을 정확히 입력해 주세요.';
  }
  if (draft.endDate < draft.startDate) {
    return '종료일은 시작일과 같거나 그 이후여야 합니다.';
  }
  if (draft.startTime !== null && !isValidTimeInputString(draft.startTime)) {
    return '시작 시각(HH:MM) 형식이 올바르지 않습니다.';
  }
  if (draft.endTime !== null && !isValidTimeInputString(draft.endTime)) {
    return '종료 시각(HH:MM) 형식이 올바르지 않습니다.';
  }
  if (draft.endTime && !draft.startTime) {
    return '종료 시각을 지정하려면 시작 시각도 함께 입력해 주세요.';
  }
  if (draft.startTime && draft.endTime && draft.endTime <= draft.startTime) {
    return '종료 시각은 시작 시각보다 늦어야 합니다.';
  }
  if (
    !Number.isInteger(draft.schoolYear) ||
    draft.schoolYear < 2000 ||
    draft.schoolYear > 2100
  ) {
    return '학년도(YYYY)가 올바르지 않습니다.';
  }
  if (
    draft.overrideDateKey !== null &&
    !isValidDateInputString(draft.overrideDateKey)
  ) {
    return '연결된 임시 시간표 날짜(YYYY-MM-DD)가 올바르지 않습니다.';
  }
  return null;
}

export function doesAcademicEventOverlapDateKey(
  event: Pick<AcademicEventRecord, 'startDate' | 'endDate'>,
  dateKey: string,
): boolean {
  if (!event.startDate || !event.endDate || !dateKey) return false;
  return event.startDate <= dateKey && event.endDate >= dateKey;
}

export function getAcademicEventsForDateKey(
  academicEvents: AcademicEventRecord[],
  dateKey: string,
): AcademicEventRecord[] {
  return academicEvents
    .filter((ev) => doesAcademicEventOverlapDateKey(ev, dateKey))
    .sort((a, b) => {
      if (a.startDate !== b.startDate) {
        return a.startDate.localeCompare(b.startDate);
      }
      if ((a.startTime ?? '') !== (b.startTime ?? '')) {
        return (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
      }
      return a.title.localeCompare(b.title, 'ko');
    });
}

export function formatAcademicDateSpan(
  startDate: string,
  endDate: string,
): string {
  if (!startDate) return '날짜 미정';
  if (!endDate || startDate === endDate) return startDate;
  const [sy, sm, sd] = startDate.split('-');
  const [ey, em, ed] = endDate.split('-');
  if (sy === ey) {
    return `${startDate} ~ ${em}-${ed}`;
  }
  return `${sy}.${sm}.${sd} ~ ${ey}.${em}.${ed}`;
}

export function formatAcademicTimeRange(
  startTime: string | null,
  endTime: string | null,
): string {
  if (!startTime) return '종일';
  if (!endTime) return `${startTime}~`;
  return `${startTime}~${endTime}`;
}

export interface AcademicPlannerAvailabilityItem {
  id: string;
  title: string;
  category: AcademicEventCategory;
  categoryLabel: string;
  startDate: string;
  endDate: string;
  timetableImpact: AcademicTimetableImpact;
  overrideDateKey: string | null;
  hasTimetableOverride: boolean;
}

export interface AcademicPlannerSnapshot {
  todayKey: string;
  weekStartKey: string;
  weekEndKey: string;
  todayAcademicEvents: AcademicEventRecord[];
  thisWeekAcademicEvents: AcademicEventRecord[];
  examPeriods: AcademicEventRecord[];
  majorSchoolEvents: AcademicEventRecord[];
  overrideAppliedDates: string[];
  overrideNeededDates: {
    academicEventId: string;
    title: string;
    category: AcademicEventCategory;
    dateKey: string;
  }[];
  availabilityImpactingEvents: AcademicPlannerAvailabilityItem[];
}

/**
 * Pure client-side data preparation helper for future AI 업무 플래너 (Section 7).
 * Makes ZERO AI calls and never guesses/auto-decides teacher duty or off-days on vacations/holidays.
 */
export function buildAcademicPlannerSnapshot(params: {
  academicEvents: AcademicEventRecord[];
  overridesByDate: Record<string, TimetableOverrideRecord>;
  todayKey: string;
  horizonDays?: number;
}): AcademicPlannerSnapshot {
  const {
    academicEvents,
    overridesByDate,
    todayKey,
    horizonDays = 30,
  } = params;

  const weekDays = isValidDateInputString(todayKey)
    ? getKstWeekDays(todayKey)
    : [];
  const weekStartKey = weekDays[0] ?? todayKey;
  const weekEndKey = weekDays[weekDays.length - 1] ?? todayKey;
  const horizonEndKey = isValidDateInputString(todayKey)
    ? addKstDaysToDateKey(todayKey, horizonDays)
    : todayKey;

  const sorted = [...academicEvents].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );

  const todayAcademicEvents = getAcademicEventsForDateKey(sorted, todayKey);

  const thisWeekAcademicEvents = sorted.filter(
    (ev) => ev.endDate >= weekStartKey && ev.startDate <= weekEndKey,
  );

  const examPeriods = sorted.filter(
    (ev) => ev.category === 'exam' && ev.endDate >= todayKey,
  );

  const majorSchoolEvents = sorted.filter(
    (ev) =>
      ev.category !== 'other' &&
      ev.endDate >= todayKey &&
      ev.startDate <= horizonEndKey,
  );

  const appliedDatesSet = new Set<string>(Object.keys(overridesByDate));
  for (const ev of sorted) {
    if (ev.timetableImpact === 'override_applied' && ev.overrideDateKey) {
      appliedDatesSet.add(ev.overrideDateKey);
    }
  }
  const overrideAppliedDates = Array.from(appliedDatesSet).sort();

  const overrideNeededDates: AcademicPlannerSnapshot['overrideNeededDates'] = [];
  for (const ev of sorted) {
    if (ev.endDate < todayKey) continue;
    const targetDateKey = ev.overrideDateKey ?? ev.startDate;
    const hasOverride = Boolean(overridesByDate[targetDateKey]);
    if (ev.timetableImpact === 'needs_check' && !hasOverride) {
      overrideNeededDates.push({
        academicEventId: ev.id,
        title: ev.title,
        category: ev.category,
        dateKey: targetDateKey,
      });
    }
  }

  const availabilityImpactingEvents: AcademicPlannerAvailabilityItem[] = sorted
    .filter(
      (ev) =>
        ev.endDate >= todayKey &&
        ev.startDate <= horizonEndKey &&
        (ev.category !== 'other' || ev.timetableImpact !== 'none'),
    )
    .map((ev) => {
      const checkDateKey = ev.overrideDateKey ?? ev.startDate;
      return {
        id: ev.id,
        title: ev.title,
        category: ev.category,
        categoryLabel: ACADEMIC_CATEGORY_META[ev.category].label,
        startDate: ev.startDate,
        endDate: ev.endDate,
        timetableImpact: ev.timetableImpact,
        overrideDateKey: ev.overrideDateKey,
        hasTimetableOverride: Boolean(overridesByDate[checkDateKey]),
      };
    });

  return {
    todayKey,
    weekStartKey,
    weekEndKey,
    todayAcademicEvents,
    thisWeekAcademicEvents,
    examPeriods,
    majorSchoolEvents,
    overrideAppliedDates,
    overrideNeededDates,
    availabilityImpactingEvents,
  };
}
