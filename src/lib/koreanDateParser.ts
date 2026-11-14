import {
  addKstDaysToDateKey,
  getKstDateParts,
  getKstWeekdayIndex,
  isValidDateInputString,
} from './dateKst';

export interface ParsedKoreanDateTime {
  dateKey: string | null;
  yearExplicit: boolean;
  relativeLabel: string | null;
  startTime: string | null;
  endTime: string | null;
  periodLabel: string | null;
  hasDeadlineCue: boolean;
  matchedText: string | null;
  needsConfirmation: boolean;
  confirmationReasons: string[];
}

const WEEKDAY_CHAR_TO_ISO: Record<string, number> = {
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
  일: 7,
};

const PERIOD_SUGGESTED_TIMES: Record<number, { start: string; end: string }> = {
  1: { start: '08:50', end: '09:40' },
  2: { start: '09:50', end: '10:40' },
  3: { start: '10:50', end: '11:40' },
  4: { start: '11:50', end: '12:40' },
  5: { start: '13:30', end: '14:20' },
  6: { start: '14:30', end: '15:20' },
  7: { start: '15:30', end: '16:20' },
  8: { start: '16:30', end: '17:20' },
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildDateKeyIfValid(year: number, month: number, day: number): string | null {
  const key = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  return isValidDateInputString(key) ? key : null;
}

function toIsoWeekday(jsSundayZeroDay: number): number {
  return jsSundayZeroDay === 0 ? 7 : jsSundayZeroDay;
}

function to24Hour(rawHour: number, meridiem?: string): number | null {
  if (!Number.isInteger(rawHour) || rawHour < 0 || rawHour > 23) return null;
  if (!meridiem) return rawHour;

  if (meridiem === '오전' || meridiem === '아침') {
    if (rawHour === 12) return 0;
    return rawHour <= 12 ? rawHour : null;
  }
  if (meridiem === '오후' || meridiem === '저녁' || meridiem === '밤') {
    if (rawHour === 12) return 12;
    if (rawHour >= 1 && rawHour <= 11) return rawHour + 12;
    return rawHour >= 13 && rawHour <= 23 ? rawHour : null;
  }
  return rawHour;
}

function addMinutesToTime(timeStr: string, deltaMinutes: number): string {
  const [hStr, mStr] = timeStr.split(':');
  const total = Number(hStr) * 60 + Number(mStr) + deltaMinutes;
  const clamped = Math.min(23 * 60 + 59, Math.max(0, total));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function parseSingleTimeToken(token: string, fallbackMeridiem?: string): {
  time: string | null;
  meridiem?: string;
} {
  const colonMatch = /^\s*(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(
    token,
  );
  if (colonMatch) {
    const meridiem = colonMatch[1] || fallbackMeridiem;
    const hour = to24Hour(Number(colonMatch[2]), meridiem);
    const minute = Number(colonMatch[3]);
    if (hour !== null && minute >= 0 && minute <= 59) {
      return { time: `${pad2(hour)}:${pad2(minute)}`, meridiem };
    }
    return { time: null };
  }

  const korMatch =
    /^\s*(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?\s*$/.exec(
      token,
    );
  if (korMatch) {
    const meridiem = korMatch[1] || fallbackMeridiem;
    const hour = to24Hour(Number(korMatch[2]), meridiem);
    const minute = korMatch[3] ? Number(korMatch[3]) : 0;
    if (hour !== null && minute >= 0 && minute <= 59) {
      return { time: `${pad2(hour)}:${pad2(minute)}`, meridiem };
    }
  }

  return { time: null };
}

export function parseKoreanDateTimeExpression(
  text: string,
  now: Date = new Date(),
): ParsedKoreanDateTime {
  const kstNow = getKstDateParts(now);
  const todayKey = kstNow.dateKey;
  const todayIsoWeekday = toIsoWeekday(getKstWeekdayIndex(todayKey));

  const reasons: string[] = [];
  let dateKey: string | null = null;
  let yearExplicit = false;
  let relativeLabel: string | null = null;
  let matchedDateText: string | null = null;
  let invalidDateFound = false;

  // 1) Explicit year formats: 2026.11.30., 2026-11-30, 2026/11/30, 2026년 11월 30일
  const fullNumericMatch =
    /(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?(?:\s*\([월화수목금토일]\))?/.exec(
      text,
    );
  const fullKorMatch =
    /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\([월화수목금토일]\))?/.exec(
      text,
    );

  const fullMatch = fullKorMatch || fullNumericMatch;
  if (fullMatch) {
    const y = Number(fullMatch[1]);
    const m = Number(fullMatch[2]);
    const d = Number(fullMatch[3]);
    const valid = buildDateKeyIfValid(y, m, d);
    matchedDateText = fullMatch[0].trim();
    if (valid) {
      dateKey = valid;
      yearExplicit = true;
    } else {
      invalidDateFound = true;
      reasons.push(`날짜 표현("${matchedDateText}")이 올바른 달력 날짜가 아닙니다.`);
    }
  }

  // 2) Month/Day without explicit year: 11월 20일, 11/23(월), 11.23.(월)
  if (!dateKey && !invalidDateFound) {
    const korMonthDayMatch =
      /(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\([월화수목금토일]\))?/.exec(text);
    const slashMonthDayMatch =
      /(?:^|[^\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\(([월화수목금토일])\))?(?!\s*[\/\d])/.exec(
        text,
      );
    const dotMonthDayMatch =
      /(?:^|[^\d.])(\d{1,2})\.(\d{1,2})\.?(?:\s*\(([월화수목금토일])\))?(?!\s*[.\d월])/.exec(
        text,
      );

    const mdMatch = korMonthDayMatch || slashMonthDayMatch || dotMonthDayMatch;
    if (mdMatch) {
      const m = Number(mdMatch[1]);
      const d = Number(mdMatch[2]);
      const valid = buildDateKeyIfValid(kstNow.year, m, d);
      matchedDateText = mdMatch[0].trim();
      if (valid) {
        dateKey = valid;
        yearExplicit = false;
        reasons.push(
          `연도가 명시되지 않은 날짜("${matchedDateText}")로 올해(${kstNow.year}년) 기준 추정값입니다. 연도를 확인해 주세요.`,
        );
      } else {
        invalidDateFound = true;
        reasons.push(`날짜 표현("${matchedDateText}")이 유효하지 않습니다.`);
      }
    }
  }

  // 3) Relative date expressions: 오늘/금일, 내일/명일/익일, 모레, 글피, 이번 주 X요일, 다음 주 X요일
  if (!dateKey && !invalidDateFound) {
    const nextWeekMatch =
      /(다음\s*주|차주)\s*([월화수목금토일])(?:요일)?/.exec(text);
    const thisWeekMatch =
      /(이번\s*주|금주)\s*([월화수목금토일])(?:요일)?/.exec(text);
    const relWordMatch = /(오늘|금일|내일|명일|익일|모레|글피)/.exec(text);

    if (nextWeekMatch) {
      const targetIso = WEEKDAY_CHAR_TO_ISO[nextWeekMatch[2]];
      const deltaDays = 7 - todayIsoWeekday + targetIso;
      dateKey = addKstDaysToDateKey(todayKey, deltaDays);
      yearExplicit = true;
      relativeLabel = nextWeekMatch[0].trim();
      matchedDateText = relativeLabel;
    } else if (thisWeekMatch) {
      const targetIso = WEEKDAY_CHAR_TO_ISO[thisWeekMatch[2]];
      const deltaDays = targetIso - todayIsoWeekday;
      dateKey = addKstDaysToDateKey(todayKey, deltaDays);
      yearExplicit = true;
      relativeLabel = thisWeekMatch[0].trim();
      matchedDateText = relativeLabel;
    } else if (relWordMatch) {
      const word = relWordMatch[1];
      let delta = 0;
      if (word === '내일' || word === '명일' || word === '익일') delta = 1;
      else if (word === '모레') delta = 2;
      else if (word === '글피') delta = 3;
      dateKey = addKstDaysToDateKey(todayKey, delta);
      yearExplicit = true;
      relativeLabel = word;
      matchedDateText = word;
    }
  }

  // 4) Time range or single time
  let startTime: string | null = null;
  let endTime: string | null = null;
  let matchedTimeText: string | null = null;

  const timeRangeRegex =
    /((?:오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분?)?))\s*[~\-–—]\s*((?:오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분?)?))/;
  const rangeMatch = timeRangeRegex.exec(text);

  if (rangeMatch) {
    const startParsed = parseSingleTimeToken(rangeMatch[1]);
    const endParsed = parseSingleTimeToken(rangeMatch[2], startParsed.meridiem);
    if (startParsed.time && endParsed.time) {
      startTime = startParsed.time;
      endTime = endParsed.time > startParsed.time ? endParsed.time : addMinutesToTime(startParsed.time, 60);
      matchedTimeText = rangeMatch[0].trim();
    }
  }

  if (!startTime) {
    const singleColonMatch =
      /(?:(오전|오후|아침|저녁|밤)\s*)?(\d{1,2})\s*:\s*(\d{2})/.exec(text);
    const singleKorTimeMatch =
      /(?:(오전|오후|아침|저녁|밤)\s*)(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?|(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/.exec(
        text,
      );

    if (singleColonMatch) {
      const parsed = parseSingleTimeToken(singleColonMatch[0]);
      if (parsed.time) {
        startTime = parsed.time;
        matchedTimeText = singleColonMatch[0].trim();
      }
    } else if (singleKorTimeMatch) {
      const rawToken = singleKorTimeMatch[0];
      const parsed = parseSingleTimeToken(rawToken);
      if (parsed.time) {
        startTime = parsed.time;
        matchedTimeText = rawToken.trim();
        // Ambiguous hour like "2시" without 오전/오후
        if (!/(오전|오후|아침|저녁|밤)/.test(rawToken)) {
          const hourNum = Number(startTime.slice(0, 2));
          if (hourNum >= 1 && hourNum <= 7) {
            // In school context 1~7시 without 오전/오후 is very likely afternoon (13:00~19:00), flag for confirmation
            reasons.push(
              `오전/오후가 없는 시각("${matchedTimeText}")입니다. 실제 시각을 확인해 주세요.`,
            );
          }
        }
      }
    }
  }

  // 5) Class period (교시)
  let periodLabel: string | null = null;
  const periodMatch = /(\d{1,2})\s*교시/.exec(text);
  if (periodMatch) {
    const periodNum = Number(periodMatch[1]);
    if (periodNum >= 1 && periodNum <= 10) {
      periodLabel = `${periodNum}교시`;
      if (!startTime && PERIOD_SUGGESTED_TIMES[periodNum]) {
        startTime = PERIOD_SUGGESTED_TIMES[periodNum].start;
        endTime = PERIOD_SUGGESTED_TIMES[periodNum].end;
      }
      reasons.push(
        `교시 표현(${periodLabel})은 학교 학사일정에 따라 달라지므로 시작·종료 시각을 직접 확인해 주세요.`,
      );
    }
  }

  // 6) Deadline cue
  const hasDeadlineCue = /(까지|마감|기한|제출일|회신일)/.test(text);

  const combinedMatched = [matchedDateText, matchedTimeText, periodLabel]
    .filter(Boolean)
    .join(' ');

  return {
    dateKey,
    yearExplicit,
    relativeLabel,
    startTime,
    endTime,
    periodLabel,
    hasDeadlineCue,
    matchedText: combinedMatched || null,
    needsConfirmation: reasons.length > 0,
    confirmationReasons: reasons,
  };
}
