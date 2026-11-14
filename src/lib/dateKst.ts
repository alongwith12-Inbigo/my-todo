export const KST_TIMEZONE = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const kstDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

const kstShortDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
});

const kstYearShortDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
});

const kstDateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface KstDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  dateKey: string;
}

export interface KstDayBounds {
  todayKey: string;
  startOfTodayMs: number;
  endOfTodayMs: number;
  endOfImminentMs: number;
}

export function getKstDateParts(date: Date = new Date()): KstDateParts {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth() + 1;
  const day = kstDate.getUTCDate();
  const hour = kstDate.getUTCHours();
  const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, dateKey };
}

export function getKstDateInputValue(date: Date | null | undefined): string {
  if (!date) return '';
  return getKstDateParts(date).dateKey;
}

export function isValidDateInputString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

export function parseKstDateInput(
  value: string,
  role: 'due' | 'schedule' | 'remind',
): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isValidDateInputString(trimmed)) {
    throw new Error('올바른 날짜 형식(YYYY-MM-DD)을 입력해 주세요.');
  }
  const [year, month, day] = trimmed.split('-').map(Number);
  if (role === 'due') {
    const utcMs =
      Date.UTC(year, month - 1, day, 23, 59, 59, 999) - KST_OFFSET_MS;
    return new Date(utcMs);
  }
  const utcMs = Date.UTC(year, month - 1, day, 9, 0, 0, 0) - KST_OFFSET_MS;
  return new Date(utcMs);
}

export function addKstDaysToDateKey(dateKey: string, deltaDays: number): string {
  if (!isValidDateInputString(dateKey)) {
    throw new Error('올바른 기준 날짜가 아닙니다.');
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function getKstDayBounds(
  now: Date = new Date(),
  imminentDays = 3,
): KstDayBounds {
  const { year, month, day, dateKey } = getKstDateParts(now);
  const safeDays = Math.min(14, Math.max(1, Math.round(imminentDays)));
  const startOfTodayMs =
    Date.UTC(year, month - 1, day, 0, 0, 0, 0) - KST_OFFSET_MS;
  const endOfTodayMs =
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - KST_OFFSET_MS;
  const endOfImminentMs =
    Date.UTC(year, month - 1, day + safeDays, 23, 59, 59, 999) - KST_OFFSET_MS;

  return {
    todayKey: dateKey,
    startOfTodayMs,
    endOfTodayMs,
    endOfImminentMs,
  };
}

export function getKstGreeting(displayName: string, now: Date = new Date()): string {
  const { hour } = getKstDateParts(now);
  const name = displayName.trim() || '선생님';
  const honorific = name.endsWith('선생님') ? name : `${name} 선생님`;
  if (hour < 6) {
    return `${honorific}, 이른 새벽 하루를 차분히 준비해 보세요.`;
  }
  if (hour < 12) {
    return `${honorific}, 좋은 아침입니다. 오늘 꼭 챙길 일을 정리했습니다.`;
  }
  if (hour < 17) {
    return `${honorific}, 오후 일과 중 놓치기 쉬운 마감을 먼저 확인하세요.`;
  }
  if (hour < 21) {
    return `${honorific}, 오늘 업무를 마무리하고 내일 일정을 점검해 보세요.`;
  }
  return `${honorific}, 늦은 시간까지 수고하셨습니다. 남은 일정만 가볍게 확인하세요.`;
}

export function formatKstTodayHeader(date: Date = new Date()): string {
  return kstDateFormatter.format(date);
}

export function formatKstShortDate(
  date: Date | null | undefined,
  referenceNow: Date = new Date(),
): string {
  if (!date) return '미지정';
  const targetYear = getKstDateParts(date).year;
  const currentYear = getKstDateParts(referenceNow).year;
  if (targetYear !== currentYear) {
    return kstYearShortDateFormatter.format(date);
  }
  return kstShortDateFormatter.format(date);
}

export function formatRelativeKstDueLabel(
  dueDate: Date | null | undefined,
  now: Date = new Date(),
): { label: string; isOverdue: boolean; isToday: boolean } {
  if (!dueDate) {
    return { label: '마감일 없음', isOverdue: false, isToday: false };
  }
  const todayParts = getKstDateParts(now);
  const dueParts = getKstDateParts(dueDate);
  const todayUtcDay = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  const dueUtcDay = Date.UTC(dueParts.year, dueParts.month - 1, dueParts.day);
  const diffDays = Math.round((dueUtcDay - todayUtcDay) / 86_400_000);

  if (diffDays < 0) {
    return {
      label: `${Math.abs(diffDays)}일 지남`,
      isOverdue: true,
      isToday: false,
    };
  }
  if (diffDays === 0) {
    return { label: '오늘 마감', isOverdue: false, isToday: true };
  }
  if (diffDays === 1) {
    return { label: '내일 마감', isOverdue: false, isToday: false };
  }
  return { label: `D-${diffDays}`, isOverdue: false, isToday: false };
}

export function formatKstDateTime(date: Date | null | undefined): string {
  if (!date) return '-';
  return kstDateTimeFormatter.format(date);
}

export function sanitizeSingleLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function sanitizeMultiline(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function isValidFirestoreId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

const kstTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function isValidTimeInputString(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function getKstTimeInputValue(date: Date | null | undefined): string {
  if (!date) return '09:00';
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  const hh = String(kstDate.getUTCHours()).padStart(2, '0');
  const mm = String(kstDate.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function parseKstDateTimeInput(dateStr: string, timeStr: string): Date {
  const trimmedDate = dateStr.trim();
  const trimmedTime = timeStr.trim();
  if (!isValidDateInputString(trimmedDate)) {
    throw new Error('올바른 날짜 형식(YYYY-MM-DD)을 입력해 주세요.');
  }
  if (!isValidTimeInputString(trimmedTime)) {
    throw new Error('올바른 시간 형식(HH:MM)을 입력해 주세요.');
  }
  const [year, month, day] = trimmedDate.split('-').map(Number);
  const [hour, minute] = trimmedTime.split(':').map(Number);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - KST_OFFSET_MS;
  return new Date(utcMs);
}

export function parseKstAllDayRange(
  startDateStr: string,
  endDateStr: string,
): { startsAt: Date; endsAt: Date } {
  const trimmedStart = startDateStr.trim();
  const trimmedEnd = (endDateStr || startDateStr).trim();
  if (!isValidDateInputString(trimmedStart) || !isValidDateInputString(trimmedEnd)) {
    throw new Error('올바른 날짜 형식(YYYY-MM-DD)을 입력해 주세요.');
  }
  if (trimmedEnd < trimmedStart) {
    throw new Error('종료 날짜는 시작 날짜보다 빠를 수 없습니다.');
  }
  const [sy, sm, sd] = trimmedStart.split('-').map(Number);
  const [ey, em, ed] = trimmedEnd.split('-').map(Number);
  const startsAt = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - KST_OFFSET_MS);
  const endsAt = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - KST_OFFSET_MS);
  return { startsAt, endsAt };
}

export function getKstDayRangeMs(dateKey: string): { startMs: number; endMs: number } {
  if (!isValidDateInputString(dateKey)) {
    throw new Error('올바른 기준 날짜가 아닙니다.');
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  return {
    startMs: Date.UTC(year, month - 1, day, 0, 0, 0, 0) - KST_OFFSET_MS,
    endMs: Date.UTC(year, month - 1, day, 23, 59, 59, 999) - KST_OFFSET_MS,
  };
}

export function getKstWeekdayIndex(dateKey: string): number {
  if (!isValidDateInputString(dateKey)) {
    throw new Error('올바른 기준 날짜가 아닙니다.');
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function getKstMonthGridDays(
  year: number,
  month: number,
): { dateKey: string; day: number; inMonth: boolean }[] {
  const firstDayKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const startOffset = getKstWeekdayIndex(firstDayKey);
  const gridStartKey = addKstDaysToDateKey(firstDayKey, -startOffset);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const totalCells = startOffset + daysInMonth > 35 ? 42 : 35;

  const cells: { dateKey: string; day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < totalCells; i++) {
    const key = addKstDaysToDateKey(gridStartKey, i);
    const [cy, cm, cd] = key.split('-').map(Number);
    cells.push({
      dateKey: key,
      day: cd,
      inMonth: cy === year && cm === month,
    });
  }
  return cells;
}

export function getKstWeekDays(anchorDateKey: string): string[] {
  const weekday = getKstWeekdayIndex(anchorDateKey);
  const sundayKey = addKstDaysToDateKey(anchorDateKey, -weekday);
  const result: string[] = [];
  for (let i = 0; i < 7; i++) {
    result.push(addKstDaysToDateKey(sundayKey, i));
  }
  return result;
}

export function formatKstTime(date: Date | null | undefined): string {
  if (!date) return '';
  return kstTimeFormatter.format(date);
}

export function formatKstMonthLabel(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

export function formatKstDateKeyLabel(dateKey: string): string {
  if (!isValidDateInputString(dateKey)) return dateKey;
  const { startMs } = getKstDayRangeMs(dateKey);
  return kstDateFormatter.format(new Date(startMs));
}

export function formatKstEventTimeRange(
  startsAt: Date | null,
  endsAt: Date | null,
  allDay: boolean,
): string {
  if (!startsAt || !endsAt) return '';
  const startKey = getKstDateParts(startsAt).dateKey;
  const endKey = getKstDateParts(endsAt).dateKey;

  if (allDay) {
    if (startKey === endKey) {
      return '종일';
    }
    return `종일 (${formatKstShortDate(startsAt)} ~ ${formatKstShortDate(endsAt)})`;
  }

  const startTime = formatKstTime(startsAt);
  const endTime = formatKstTime(endsAt);
  if (startKey === endKey) {
    return `${startTime} ~ ${endTime}`;
  }
  return `${formatKstShortDate(startsAt)} ${startTime} ~ ${formatKstShortDate(endsAt)} ${endTime}`;
}

