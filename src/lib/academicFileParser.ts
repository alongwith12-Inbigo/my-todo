import JSZip from 'jszip';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import * as XLSX from 'xlsx';
import {
  buildAcademicDedupeKey,
  classifyAcademicCategory,
  getKoreanSchoolYearForDateKey,
  suggestTimetableImpactForCategory,
} from './academicCalendar';
import {
  isValidDateInputString,
  isValidTimeInputString,
  sanitizeSingleLine,
} from './dateKst';
import {
  runInBrowserStructuredOcr,
  validateOcrImageFile,
  type BrowserOcrProgress,
} from './ocrProcessor';
import {
  detectTimetableFileKind,
  type TimetableFileKind,
} from './timetableGridParser';
import type { PdfTextToken } from './timetablePdfParser';
import {
  VALIDATION_LIMITS,
  type AcademicEventCategory,
  type AcademicEventRecord,
  type AcademicEventSourceType,
  type AcademicTimetableImpact,
} from '../types/domain';

export const ACADEMIC_MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

export interface AcademicImportCandidate {
  tempId: string;
  selected: boolean;
  title: string;
  category: AcademicEventCategory;
  startDate: string; // YYYY-MM-DD or '' when uncertain
  endDate: string; // YYYY-MM-DD or '' when uncertain
  startTime: string | null;
  endTime: string | null;
  location: string;
  schoolYear: number;
  timetableImpact: AcademicTimetableImpact;
  sourceText: string;
  needsConfirmation: boolean;
  confirmationReasons: string[];
  isDuplicate: boolean;
  duplicateReason: string | null;
  dedupeKey: string;
}

export interface AcademicImportPreview {
  sourceType: Exclude<AcademicEventSourceType, 'manual'>;
  extractionMode: 'excel' | 'hwpx_xml' | 'pdf_text' | 'pdf_ocr' | 'image_ocr';
  sourceLabel: string;
  detectedSchoolYear: number | null;
  candidates: AcademicImportCandidate[];
  warnings: string[];
  sheetNames?: string[];
  selectedSheetName?: string;
  pageCount?: number;
  selectedPage?: number;
  rawTextExcerpt: string;
}

interface YearContext {
  schoolYear: number | null; // e.g. 2026 from "2026학년도"
  explicitYear: number | null; // e.g. 2026 from "2026년"
}

interface ParsedDateSpan {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  remainderText: string;
  uncertainYear: boolean;
  reason?: string;
}

const LOCATION_PATTERNS =
  /(본교\s*강당|대강당|소강당|시청각실|다목적실|체육관|운동장|도서관|회의실|교무실|세미나실|각\s*교실|전\s*교실|\d{2,4}호)/;

function makePad2(num: number): string {
  return String(num).padStart(2, '0');
}

function makeDateKey(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const key = `${String(year).padStart(4, '0')}-${makePad2(month)}-${makePad2(day)}`;
  return isValidDateInputString(key) ? key : null;
}

/**
 * Resolves calendar year for a given month based on Korean schoolYear (`2026학년도`: Mar-Dec = 2026, Jan-Feb = 2027)
 * or an explicit calendar year when no schoolYear header exists.
 */
export function resolveCalendarYearForMonth(
  month: number,
  ctx: YearContext,
): number | null {
  if (ctx.schoolYear !== null) {
    return month >= 3 ? ctx.schoolYear : ctx.schoolYear + 1;
  }
  if (ctx.explicitYear !== null) {
    return ctx.explicitYear;
  }
  return null;
}

export function detectYearContextFromTexts(texts: string[]): YearContext {
  const joined = texts.join('\n');
  // Priority 1: "2026학년도" or "2026 학년도"
  const schoolYearMatch = /(20\d{2})\s*학년도/.exec(joined);
  if (schoolYearMatch) {
    return { schoolYear: Number(schoolYearMatch[1]), explicitYear: null };
  }
  // Priority 2: explicit header year like "2026년" (exclude row-level "2026.07.20." dates)
  const yearMatch = /(20\d{2})\s*년/.exec(joined);
  if (yearMatch) {
    return { schoolYear: null, explicitYear: Number(yearMatch[1]) };
  }
  return { schoolYear: null, explicitYear: null };
}

function extractTimeRange(raw: string): {
  startTime: string | null;
  endTime: string | null;
  cleaned: string;
} {
  let cleaned = raw;
  let startTime: string | null = null;
  let endTime: string | null = null;

  const rangeMatch =
    /([01]?\d|2[0-3]):([0-5]\d)\s*[~\-–—]\s*([01]?\d|2[0-3]):([0-5]\d)/.exec(
      cleaned,
    );
  if (rangeMatch) {
    const s = `${makePad2(Number(rangeMatch[1]))}:${rangeMatch[2]}`;
    const e = `${makePad2(Number(rangeMatch[3]))}:${rangeMatch[4]}`;
    if (isValidTimeInputString(s) && isValidTimeInputString(e) && e > s) {
      startTime = s;
      endTime = e;
      cleaned = cleaned.replace(rangeMatch[0], ' ');
    }
  } else {
    const singleMatch = /(?:^|\s|\()([01]?\d|2[0-3]):([0-5]\d)(?:\)|\s|$)/.exec(
      cleaned,
    );
    if (singleMatch) {
      const s = `${makePad2(Number(singleMatch[1]))}:${singleMatch[2]}`;
      if (isValidTimeInputString(s)) {
        startTime = s;
        cleaned = cleaned.replace(singleMatch[0], ' ');
      }
    }
  }

  return { startTime, endTime, cleaned };
}

function extractLocationFromTitle(raw: string): {
  title: string;
  location: string;
} {
  let text = raw.trim();
  let location = '';

  const parenLoc = /\(([^()]{2,30})\)\s*$/.exec(text);
  if (parenLoc && LOCATION_PATTERNS.test(parenLoc[1])) {
    location = sanitizeSingleLine(parenLoc[1], VALIDATION_LIMITS.LOCATION_MAX_LEN);
    text = text.slice(0, parenLoc.index).trim();
  } else {
    const inlineLoc = LOCATION_PATTERNS.exec(text);
    if (inlineLoc && text.length > inlineLoc[1].length + 3) {
      location = sanitizeSingleLine(
        inlineLoc[1],
        VALIDATION_LIMITS.LOCATION_MAX_LEN,
      );
    }
  }

  return {
    title: sanitizeSingleLine(text, VALIDATION_LIMITS.TITLE_MAX_LEN),
    location,
  };
}

/**
 * Strips leading weekday annotation tokens like "(월)", "월", "월~수" left after date parsing.
 */
function stripLeadingPunctAndWeekday(raw: string): string {
  return raw
    .replace(/^\s*(?:\([월화수목금토일]\)|[월화수목금토일]요일)\s*/g, '')
    .replace(/^\s*[.:,\-|/]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a date or date-range expression at the beginning or anywhere in a line/cell.
 * Handles:
 * - `2026.05.11.(월)~2026.05.13.(수)`
 * - `2026-05-11 ~ 05-13`
 * - `3. 2.(월) ~ 3. 3.(화)` (uses YearContext; marks uncertain if missing)
 * - `5월 11일 ~ 13일` / `5월 11일` / `5/11`
 */
export function parseAcademicDateExpression(
  rawText: string,
  yearCtx: YearContext,
  fallbackMonth?: number,
): ParsedDateSpan | null {
  const { startTime, endTime, cleaned: textWithoutTime } =
    extractTimeRange(rawText);

  const normalized = textWithoutTime.replace(/\u00a0/g, ' ').trim();
  if (!normalized) return null;

  // Pattern 1: Full YYYY.M.D ~ (optional YYYY.)M.D or single YYYY.M.D
  const fullRangeRegex =
    /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\s*\.?\s*(?:\([월화수목금토일]\))?\s*\.?\s*(?:[~\-–—]\s*(?:(20\d{2})\s*[.\-/년]\s*)?(?:(\d{1,2})\s*[.\-/월]\s*)?(\d{1,2})\s*일?\s*\.?\s*(?:\([월화수목금토일]\))?\s*\.?)?/;
  const fullMatch = fullRangeRegex.exec(normalized);
  if (fullMatch) {
    const sy = Number(fullMatch[1]);
    const sm = Number(fullMatch[2]);
    const sd = Number(fullMatch[3]);
    const startKey = makeDateKey(sy, sm, sd);
    if (startKey) {
      let endKey = startKey;
      if (fullMatch[6]) {
        const ey = fullMatch[4] ? Number(fullMatch[4]) : sy;
        const em = fullMatch[5] ? Number(fullMatch[5]) : sm;
        const ed = Number(fullMatch[6]);
        const resolvedEnd = makeDateKey(ey, em, ed);
        if (resolvedEnd && resolvedEnd >= startKey) {
          endKey = resolvedEnd;
        }
      }
      const remainderText = stripLeadingPunctAndWeekday(
        (
          normalized.slice(0, fullMatch.index) +
          ' ' +
          normalized.slice(fullMatch.index + fullMatch[0].length)
        ).trim(),
      );
      return {
        startDate: startKey,
        endDate: endKey,
        startTime,
        endTime,
        remainderText,
        uncertainYear: false,
      };
    }
  }

  // Pattern 2: Month + Day without explicit year (e.g. `5. 11.(월) ~ 5. 13.`, `5월 11일 ~ 13일`, `5/11`)
  const mdRangeRegex =
    /(\d{1,2})\s*(?:월|[./])\s*(\d{1,2})\s*일?\s*\.?\s*(?:\([월화수목금토일]\))?\s*\.?\s*(?:[~\-–—]\s*(?:(\d{1,2})\s*(?:월|[./])\s*)?(\d{1,2})\s*일?\s*\.?\s*(?:\([월화수목금토일]\))?\s*\.?)?/;
  const mdMatch = mdRangeRegex.exec(normalized);
  if (mdMatch) {
    const sm = Number(mdMatch[1]);
    const sd = Number(mdMatch[2]);
    if (sm >= 1 && sm <= 12 && sd >= 1 && sd <= 31) {
      const startYear = resolveCalendarYearForMonth(sm, yearCtx);
      const remainderText = stripLeadingPunctAndWeekday(
        (
          normalized.slice(0, mdMatch.index) +
          ' ' +
          normalized.slice(mdMatch.index + mdMatch[0].length)
        ).trim(),
      );

      if (startYear === null) {
        return {
          startDate: '',
          endDate: '',
          startTime,
          endTime,
          remainderText,
          uncertainYear: true,
          reason: `연도 정보가 문서에 없어 '${sm}월 ${sd}일'의 연도를 확정할 수 없습니다. 날짜를 직접 입력해 주세요.`,
        };
      }

      const startKey = makeDateKey(startYear, sm, sd);
      if (startKey) {
        let endKey = startKey;
        if (mdMatch[4]) {
          const em = mdMatch[3] ? Number(mdMatch[3]) : sm;
          const ed = Number(mdMatch[4]);
          const endYear =
            resolveCalendarYearForMonth(em, yearCtx) ?? startYear;
          const candidateEnd = makeDateKey(endYear, em, ed);
          if (candidateEnd && candidateEnd >= startKey) {
            endKey = candidateEnd;
          }
        }
        return {
          startDate: startKey,
          endDate: endKey,
          startTime,
          endTime,
          remainderText,
          uncertainYear: false,
        };
      }
    }
  }

  // Pattern 3: Day-only range within fallbackMonth (e.g. `11~13일` or `14(수)` or `14. 체육대회`, NOT `1학기`)
  if (fallbackMonth && fallbackMonth >= 1 && fallbackMonth <= 12) {
    const dayRangeRegex =
      /^(\d{1,2})(?:\s*일|\s*\([월화수목금토일]\)|\s*\.)\s*(?:[~\-–—]\s*(\d{1,2})\s*(?:일|\([월화수목금토일]\)|\.?))?(?=\s|$|:)/;
    const dayMatch = dayRangeRegex.exec(normalized);
    if (dayMatch) {
      const sd = Number(dayMatch[1]);
      if (sd >= 1 && sd <= 31) {
        const y = resolveCalendarYearForMonth(fallbackMonth, yearCtx);
        const remainderText = stripLeadingPunctAndWeekday(
          normalized.slice(dayMatch[0].length),
        );
        if (y === null) {
          return {
            startDate: '',
            endDate: '',
            startTime,
            endTime,
            remainderText,
            uncertainYear: true,
            reason: `연도 정보가 없어 '${fallbackMonth}월 ${sd}일' 날짜를 직접 확인해 주세요.`,
          };
        }
        const startKey = makeDateKey(y, fallbackMonth, sd);
        if (startKey) {
          let endKey = startKey;
          if (dayMatch[2]) {
            const ed = Number(dayMatch[2]);
            const resolvedEnd = makeDateKey(y, fallbackMonth, ed);
            if (resolvedEnd && resolvedEnd >= startKey) {
              endKey = resolvedEnd;
            }
          }
          return {
            startDate: startKey,
            endDate: endKey,
            startTime,
            endTime,
            remainderText,
            uncertainYear: false,
          };
        }
      }
    }
  }

  return null;
}

function buildCandidate(params: {
  index: number;
  title: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  location?: string;
  fallbackSchoolYear: number;
  sourceText: string;
  extraReasons?: string[];
}): AcademicImportCandidate {
  const locSplit = extractLocationFromTitle(params.title);
  const title =
    locSplit.title ||
    sanitizeSingleLine(params.sourceText, VALIDATION_LIMITS.TITLE_MAX_LEN) ||
    '학사일정(확인 필요)';
  const location = sanitizeSingleLine(
    params.location || locSplit.location || '',
    VALIDATION_LIMITS.LOCATION_MAX_LEN,
  );
  const category = classifyAcademicCategory(title);
  const timetableImpact = suggestTimetableImpactForCategory(category);

  const reasons = [...(params.extraReasons ?? [])];
  if (!params.startDate || !isValidDateInputString(params.startDate)) {
    if (!reasons.some((r) => r.includes('날짜') || r.includes('연도'))) {
      reasons.push('시작일이 명확하지 않아 직접 확인·입력이 필요합니다.');
    }
  }

  const validStart = isValidDateInputString(params.startDate)
    ? params.startDate
    : '';
  const validEnd =
    validStart && isValidDateInputString(params.endDate) && params.endDate >= validStart
      ? params.endDate
      : validStart;

  const schoolYear = validStart
    ? getKoreanSchoolYearForDateKey(validStart)
    : params.fallbackSchoolYear;

  const needsConfirmation = reasons.length > 0 || !validStart;
  const dedupeKey = validStart
    ? buildAcademicDedupeKey(validStart, validEnd, title)
    : `uncertain|${params.index}|${title}`;

  return {
    tempId: `cand_${params.index}_${Math.random().toString(36).slice(2, 7)}`,
    selected: !needsConfirmation,
    title,
    category,
    startDate: validStart,
    endDate: validEnd,
    startTime: params.startTime,
    endTime: params.endTime,
    location,
    schoolYear,
    timetableImpact,
    sourceText: sanitizeSingleLine(
      params.sourceText,
      VALIDATION_LIMITS.ACADEMIC_SOURCE_TEXT_MAX_LEN,
    ),
    needsConfirmation,
    confirmationReasons: reasons,
    isDuplicate: false,
    duplicateReason: null,
    dedupeKey,
  };
}

/**
 * Applies duplicate detection both against already saved Firestore records
 * and within the extracted batch itself. Duplicates default to unselected (`selected: false`).
 */
export function markDuplicatesOnCandidates(
  candidates: AcademicImportCandidate[],
  existingEvents: AcademicEventRecord[],
): AcademicImportCandidate[] {
  const existingKeys = new Set(
    existingEvents.map(
      (ev) => ev.dedupeKey || buildAcademicDedupeKey(ev.startDate, ev.endDate, ev.title),
    ),
  );
  const seenInBatch = new Set<string>();

  return candidates.map((cand) => {
    const recomputedKey =
      cand.startDate && isValidDateInputString(cand.startDate)
        ? buildAcademicDedupeKey(
            cand.startDate,
            cand.endDate || cand.startDate,
            cand.title,
          )
        : cand.dedupeKey;

    if (cand.startDate && existingKeys.has(recomputedKey)) {
      return {
        ...cand,
        dedupeKey: recomputedKey,
        isDuplicate: true,
        duplicateReason: '이미 저장된 학사일정과 날짜·일정명이 동일합니다.',
        selected: false,
      };
    }

    if (cand.startDate && seenInBatch.has(recomputedKey)) {
      return {
        ...cand,
        dedupeKey: recomputedKey,
        isDuplicate: true,
        duplicateReason: '같은 문서에서 중복 추출된 항목입니다.',
        selected: false,
      };
    }

    if (cand.startDate) {
      seenInBatch.add(recomputedKey);
    }

    return {
      ...cand,
      dedupeKey: recomputedKey,
      isDuplicate: false,
      duplicateReason: null,
    };
  });
}

function detectMonthHeader(raw: string): { year?: number; month: number } | null {
  const cleaned = raw.replace(/\s+/g, '');
  const full = /^(20\d{2})[년.\-/](\d{1,2})월?$/.exec(cleaned);
  if (full) {
    const m = Number(full[2]);
    if (m >= 1 && m <= 12) return { year: Number(full[1]), month: m };
  }
  const monthOnly = /^(\d{1,2})월$/.exec(cleaned);
  if (monthOnly) {
    const m = Number(monthOnly[1]);
    if (m >= 1 && m <= 12) return { month: m };
  }
  return null;
}

function detectWeekdayCol(raw: string): number | null {
  const clean = raw.replace(/\s+/g, '').replace(/[()]/g, '');
  const map: Record<string, number> = {
    일: 0,
    일요일: 0,
    월: 1,
    월요일: 1,
    화: 2,
    화요일: 2,
    수: 3,
    수요일: 3,
    목: 4,
    목요일: 4,
    금: 5,
    금요일: 5,
    토: 6,
    토요일: 6,
  };
  return map[clean] ?? null;
}

/**
 * Coalesces consecutive identical day events in grid calendars
 * (e.g. "중간고사" on 5/11, 5/12, 5/13 -> single span 5/11~5/13).
 */
function coalesceAdjacentDayEntries(
  entries: {
    dateKey: string;
    title: string;
    startTime: string | null;
    endTime: string | null;
    sourceText: string;
    reasons: string[];
  }[],
  fallbackSchoolYear: number,
): AcademicImportCandidate[] {
  const sorted = [...entries].sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey),
  );
  const merged: typeof entries = [];

  for (const item of sorted) {
    if (!item.dateKey) {
      merged.push(item);
      continue;
    }
    let prev: (typeof entries)[number] | undefined;
    for (let i = merged.length - 1; i >= 0; i--) {
      const m = merged[i];
      if (
        m.title === item.title &&
        m.startTime === item.startTime &&
        m.endTime === item.endTime &&
        m.dateKey &&
        m.dateKey <= item.dateKey
      ) {
        prev = m;
        break;
      }
    }

    // Check if previous matching entry is same day or exact next calendar day
    if (prev) {
      const prevEnd = prev.sourceText.includes('~end:')
        ? prev.sourceText.split('~end:')[1]
        : prev.dateKey;
      const prevDt = new Date(`${prevEnd}T00:00:00Z`);
      const nextExpected = new Date(prevDt.getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (item.dateKey === prevEnd || item.dateKey === nextExpected) {
        prev.sourceText = `${prev.dateKey}~end:${item.dateKey}`;
        continue;
      }
    }
    merged.push({ ...item });
  }

  return merged.map((m, idx) => {
    const endDate = m.sourceText.includes('~end:')
      ? m.sourceText.split('~end:')[1]
      : m.dateKey;
    const cleanSource = m.sourceText.includes('~end:')
      ? `${m.dateKey} ~ ${endDate} ${m.title}`
      : m.sourceText;
    return buildCandidate({
      index: idx,
      title: m.title,
      startDate: m.dateKey,
      endDate,
      startTime: m.startTime,
      endTime: m.endTime,
      fallbackSchoolYear,
      sourceText: cleanSource,
      extraReasons: m.reasons,
    });
  });
}

/**
 * Strategy 1: Annual Month-Column Matrix (연간 학사일정표)
 * Columns represent months (`3월`, `4월`, ... `2월`), rows represent day numbers `1..31`.
 */
function parseAnnualMonthMatrix(
  grid: string[][],
  yearCtx: YearContext,
  fallbackSchoolYear: number,
): AcademicImportCandidate[] | null {
  let headerRow = -1;
  let monthCols = new Map<number, { month: number; year?: number }>();

  for (let r = 0; r < Math.min(grid.length, 8); r++) {
    const found = new Map<number, { month: number; year?: number }>();
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const parsed = detectMonthHeader(grid[r][c] ?? '');
      if (parsed) found.set(c, parsed);
    }
    if (found.size >= 3) {
      headerRow = r;
      monthCols = found;
      break;
    }
  }

  if (headerRow === -1 || monthCols.size < 3) {
    return null;
  }

  const firstMonthCol = Math.min(...Array.from(monthCols.keys()));
  const rawEntries: {
    dateKey: string;
    title: string;
    startTime: string | null;
    endTime: string | null;
    sourceText: string;
    reasons: string[];
  }[] = [];

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    // Detect day number in leading column(s)
    let rowDay: number | null = null;
    for (let c = 0; c < Math.max(1, firstMonthCol); c++) {
      const cell = (row[c] ?? '').replace(/일$/, '').trim();
      if (/^\d{1,2}$/.test(cell)) {
        const d = Number(cell);
        if (d >= 1 && d <= 31) {
          rowDay = d;
          break;
        }
      }
    }

    for (const [colIdx, monthMeta] of monthCols.entries()) {
      const cellText = (row[colIdx] ?? '').trim();
      if (!cellText || /^[-—–·\s]+$/.test(cellText)) continue;
      // Skip cells that are purely day numbers or weekday letters (e.g. "토", "일", "(월)")
      if (/^(?:\d{1,2}|[월화수목금토일])$/.test(cellText)) continue;

      const resolvedYear =
        monthMeta.year ?? resolveCalendarYearForMonth(monthMeta.month, yearCtx);

      // Split multiple events on separate lines inside one day cell
      const lines = cellText
        .split(/\r?\n+/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (/^(?:[월화수목금토일]|\([월화수목금토일]\))$/.test(line)) continue;
        // Strip leading day/weekday inside cell if repeated like "(금) 입학식" or "2(월) 개학식"
        const parsedInline = parseAcademicDateExpression(
          line,
          resolvedYear !== null
            ? { schoolYear: null, explicitYear: resolvedYear }
            : yearCtx,
          monthMeta.month,
        );

        if (parsedInline && parsedInline.remainderText) {
          rawEntries.push({
            dateKey: parsedInline.startDate,
            title: parsedInline.remainderText,
            startTime: parsedInline.startTime,
            endTime: parsedInline.endTime,
            sourceText: `${monthMeta.month}월: ${line}`,
            reasons: parsedInline.uncertainYear
              ? [parsedInline.reason ?? '연도 확인이 필요합니다.']
              : [],
          });
          continue;
        }

        if (rowDay === null) continue;

        const cleanedLine = stripLeadingPunctAndWeekday(line);
        if (!cleanedLine) continue;

        const { startTime, endTime, cleaned } = extractTimeRange(cleanedLine);
        const title = cleaned.trim();
        if (!title) continue;

        if (resolvedYear === null) {
          rawEntries.push({
            dateKey: '',
            title,
            startTime,
            endTime,
            sourceText: `${monthMeta.month}월 ${rowDay}일 ${cellText}`,
            reasons: [
              `연도(학년도)가 문서에 명시되지 않아 ${monthMeta.month}월 ${rowDay}일의 날짜를 직접 확인해 주세요.`,
            ],
          });
        } else {
          const dateKey = makeDateKey(resolvedYear, monthMeta.month, rowDay);
          if (dateKey) {
            rawEntries.push({
              dateKey,
              title,
              startTime,
              endTime,
              sourceText: `${dateKey} ${title}`,
              reasons: [],
            });
          }
        }
      }
    }
  }

  return coalesceAdjacentDayEntries(rawEntries, fallbackSchoolYear);
}

/**
 * Strategy 2: Monthly Calendar Grid (월간 달력표)
 * Weekday columns (`일 월 화 수 목 금 토` or `월 화 수 목 금`) with day numbers in cells.
 */
function parseMonthlyCalendarGrid(
  grid: string[][],
  allTexts: string[],
  yearCtx: YearContext,
  fallbackSchoolYear: number,
): AcademicImportCandidate[] | null {
  let headerRow = -1;
  let weekdayCols = new Set<number>();

  for (let r = 0; r < Math.min(grid.length, 8); r++) {
    const matchedCols = new Set<number>();
    const seenDays = new Set<number>();
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const wd = detectWeekdayCol(grid[r][c] ?? '');
      if (wd !== null && !seenDays.has(wd)) {
        seenDays.add(wd);
        matchedCols.add(c);
      }
    }
    if (matchedCols.size >= 5) {
      headerRow = r;
      weekdayCols = matchedCols;
      break;
    }
  }

  if (headerRow === -1) return null;

  // Determine month from rows above headerRow or context texts
  const headerTexts = [
    ...grid.slice(0, headerRow).flat(),
    ...allTexts.slice(0, 15),
  ].join(' ');
  const yearMonthMatch = /(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*월/.exec(headerTexts);
  const monthOnlyMatch = /(\d{1,2})\s*월/.exec(headerTexts);

  const detectedMonth = yearMonthMatch
    ? Number(yearMonthMatch[2])
    : monthOnlyMatch
      ? Number(monthOnlyMatch[1])
      : null;

  if (!detectedMonth || detectedMonth < 1 || detectedMonth > 12) {
    return null;
  }

  const resolvedYear = yearMonthMatch
    ? Number(yearMonthMatch[1])
    : resolveCalendarYearForMonth(detectedMonth, yearCtx);

  const entries: {
    dateKey: string;
    title: string;
    startTime: string | null;
    endTime: string | null;
    sourceText: string;
    reasons: string[];
  }[] = [];

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (const c of weekdayCols) {
      const cell = (row[c] ?? '').trim();
      if (!cell) continue;

      const lines = cell
        .split(/\r?\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;

      const dayMatch = /^(\d{1,2})(?:\s*(?:일|\([월화수목금토일]\)))?(?:\s+(.*))?$/.exec(
        lines[0],
      );
      if (!dayMatch) continue;
      const dayNum = Number(dayMatch[1]);
      if (dayNum < 1 || dayNum > 31) continue;

      const eventLines: string[] = [];
      if (dayMatch[2]?.trim()) eventLines.push(dayMatch[2].trim());
      for (let i = 1; i < lines.length; i++) {
        eventLines.push(lines[i]);
      }

      // Also support paired layout: row r has ONLY day numbers, row r+1 has events below them
      if (eventLines.length === 0 && r + 1 < grid.length) {
        const below = (grid[r + 1]?.[c] ?? '').trim();
        const belowStartsWithDay = /^\d{1,2}(?:\s|$)/.test(below);
        if (below && !belowStartsWithDay) {
          eventLines.push(
            ...below
              .split(/\r?\n+/)
              .map((l) => l.trim())
              .filter(Boolean),
          );
        }
      }

      for (const evLine of eventLines) {
        const { startTime, endTime, cleaned } = extractTimeRange(evLine);
        const title = cleaned.trim();
        if (!title || /^[-—–·\s]+$/.test(title)) continue;

        if (resolvedYear === null) {
          entries.push({
            dateKey: '',
            title,
            startTime,
            endTime,
            sourceText: `${detectedMonth}월 ${dayNum}일 ${evLine}`,
            reasons: [
              `연도가 명시되지 않아 '${detectedMonth}월 ${dayNum}일 ${title}'의 연도를 확인해 주세요.`,
            ],
          });
        } else {
          const dateKey = makeDateKey(resolvedYear, detectedMonth, dayNum);
          if (dateKey) {
            entries.push({
              dateKey,
              title,
              startTime,
              endTime,
              sourceText: `${dateKey} ${title}`,
              reasons: [],
            });
          }
        }
      }
    }
  }

  return coalesceAdjacentDayEntries(entries, fallbackSchoolYear);
}

/**
 * Strategy 3: Row-based List Table (날짜 | 일정명 | 장소 | 비고)
 */
function parseRowListTable(
  grid: string[][],
  yearCtx: YearContext,
  fallbackSchoolYear: number,
): AcademicImportCandidate[] {
  const candidates: AcademicImportCandidate[] = [];
  let dateColIdx = -1;
  let titleColIdx = -1;
  let locationColIdx = -1;
  let timeColIdx = -1;
  let headerRowIdx = -1;

  for (let r = 0; r < Math.min(grid.length, 6); r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = (row[c] ?? '').replace(/\s+/g, '');
      if (!cell) continue;
      if (dateColIdx === -1 && /^(?:날짜|일자|일시|기간|월일)$/.test(cell)) {
        dateColIdx = c;
        headerRowIdx = r;
      } else if (
        titleColIdx === -1 &&
        /^(?:행사명|일정명|학사일정|내용|주요행사|행사내용|일정|제목)$/.test(cell)
      ) {
        titleColIdx = c;
        headerRowIdx = r;
      } else if (locationColIdx === -1 && /^(?:장소|위치|비고장소)$/.test(cell)) {
        locationColIdx = c;
        headerRowIdx = r;
      } else if (timeColIdx === -1 && /^(?:시간|시각)$/.test(cell)) {
        timeColIdx = c;
        headerRowIdx = r;
      }
    }
    if (dateColIdx !== -1 || titleColIdx !== -1) break;
  }

  const startRow = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;

  for (let r = startRow; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const nonEmptyCells = row.map((c) => c.trim()).filter(Boolean);
    if (nonEmptyCells.length === 0) continue;

    // Skip repeated header rows
    if (
      nonEmptyCells.some((c) => /^(?:날짜|일자)$/.test(c)) &&
      nonEmptyCells.some((c) => /^(?:행사명|일정명|내용)$/.test(c))
    ) {
      continue;
    }

    const rowJoined = nonEmptyCells.join(' ');
    const targetDateCell =
      dateColIdx >= 0 && row[dateColIdx]?.trim() ? row[dateColIdx].trim() : rowJoined;

    const parsedDate = parseAcademicDateExpression(targetDateCell, yearCtx);
    if (!parsedDate) continue;

    let rawTitle = '';
    if (titleColIdx >= 0 && row[titleColIdx]?.trim()) {
      rawTitle = row[titleColIdx].trim();
    } else if (dateColIdx >= 0) {
      rawTitle = row
        .filter((_, idx) => idx !== dateColIdx && idx !== locationColIdx && idx !== timeColIdx)
        .map((c) => c.trim())
        .filter(Boolean)
        .join(' ');
    } else {
      rawTitle = parsedDate.remainderText;
    }

    if (!rawTitle) rawTitle = parsedDate.remainderText;
    if (!rawTitle || /^[-—–·\s]+$/.test(rawTitle)) continue;

    const timeExtract =
      timeColIdx >= 0 && row[timeColIdx]?.trim()
        ? extractTimeRange(row[timeColIdx])
        : extractTimeRange(rawTitle);

    const cleanTitle = timeExtract.cleaned.trim() || rawTitle;
    const rawLocation =
      locationColIdx >= 0 ? (row[locationColIdx] ?? '').trim() : '';

    candidates.push(
      buildCandidate({
        index: candidates.length,
        title: cleanTitle,
        startDate: parsedDate.startDate,
        endDate: parsedDate.endDate,
        startTime: parsedDate.startTime ?? timeExtract.startTime,
        endTime: parsedDate.endTime ?? timeExtract.endTime,
        location: rawLocation,
        fallbackSchoolYear,
        sourceText: rowJoined,
        extraReasons: parsedDate.uncertainYear
          ? [parsedDate.reason ?? '연도 확인이 필요합니다.']
          : [],
      }),
    );
  }

  return candidates;
}

/**
 * Strategy 4: Line-by-line plain text extraction fallback (PDF paragraphs, OCR lines, etc.)
 */
export function parseAcademicTextLines(
  lines: string[],
  yearCtx: YearContext,
  fallbackSchoolYear: number,
): AcademicImportCandidate[] {
  const candidates: AcademicImportCandidate[] = [];
  let currentMonthContext: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || line.length < 3) continue;

    // Track section headers like "5월 주요 학사일정" or "[5월]"
    const monthSection =
      /(?:^|\s|\[)(?:(20\d{2})\s*[년.\-/]\s*)?(\d{1,2})\s*월(?:\s|\]|주요|학사|$)/.exec(
        line,
      );
    if (monthSection && line.length <= 24) {
      currentMonthContext = Number(monthSection[2]);
    }

    const parsed = parseAcademicDateExpression(
      line,
      yearCtx,
      currentMonthContext,
    );
    if (!parsed || !parsed.remainderText || parsed.remainderText.length < 2) {
      continue;
    }

    candidates.push(
      buildCandidate({
        index: candidates.length,
        title: parsed.remainderText,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        fallbackSchoolYear,
        sourceText: line,
        extraReasons: parsed.uncertainYear
          ? [parsed.reason ?? '연도 확인이 필요합니다.']
          : [],
      }),
    );
  }

  return candidates;
}

function finalizeCandidates(
  rawCandidates: AcademicImportCandidate[],
  existingEvents: AcademicEventRecord[],
  warnings: string[],
): AcademicImportCandidate[] {
  let result = rawCandidates;
  if (result.length > VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH) {
    warnings.push(
      `추출된 학사일정이 ${result.length}건으로 최대 일괄 제한(${VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH}건)을 초과하여 상위 ${VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH}건만 표시했습니다.`,
    );
    result = result.slice(0, VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH);
  }
  return markDuplicatesOnCandidates(result, existingEvents);
}

// ---------------------------------------------------------------------------
// Excel Parser
// ---------------------------------------------------------------------------
function normalizeExcelCellValue(
  cell: XLSX.CellObject | undefined,
  formattedText: string,
): string {
  const text = formattedText.trim();
  if (text && !/^\d{5}$/.test(text)) {
    return text;
  }
  // Handle unformatted Excel serial date numbers (e.g., 46083 -> 2026-03-02)
  if (cell && cell.t === 'n' && typeof cell.v === 'number') {
    if (cell.v >= 35000 && cell.v <= 65000) {
      const utcMs = Math.round((cell.v - 25569) * 86400 * 1000);
      const dt = new Date(utcMs);
      if (!Number.isNaN(dt.getTime())) {
        return dt.toISOString().slice(0, 10);
      }
    }
  }
  return text;
}

export function extractAcademicFromExcelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: {
    fileName: string;
    sheetName?: string;
    existingEvents?: AcademicEventRecord[];
    fallbackSchoolYear?: number;
  },
): AcademicImportPreview {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const workbook = XLSX.read(data, { type: 'array', cellText: true, cellDates: false });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    throw new Error('엑셀 파일에서 시트를 찾을 수 없습니다.');
  }

  const selectedSheetName =
    options.sheetName && sheetNames.includes(options.sheetName)
      ? options.sheetName
      : sheetNames[0];
  const sheet = workbook.Sheets[selectedSheetName];
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  const rowsCount = Math.min(250, range.e.r - range.s.r + 1);
  const colsCount = Math.min(25, range.e.c - range.s.c + 1);

  const grid: string[][] = Array.from({ length: rowsCount }, () =>
    Array.from({ length: colsCount }, () => ''),
  );

  for (let r = 0; r < rowsCount; r++) {
    for (let c = 0; c < colsCount; c++) {
      const addr = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      const formatted = cell ? XLSX.utils.format_cell(cell) : '';
      grid[r][c] = normalizeExcelCellValue(cell, formatted);
    }
  }

  // Fill merged cells horizontally/vertically for span completeness when short
  for (const merge of sheet['!merges'] ?? []) {
    const val = grid[merge.s.r - range.s.r]?.[merge.s.c - range.s.c] ?? '';
    if (!val) continue;
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        const rr = r - range.s.r;
        const cc = c - range.s.c;
        if (rr >= 0 && rr < rowsCount && cc >= 0 && cc < colsCount && !grid[rr][cc]) {
          grid[rr][cc] = val;
        }
      }
    }
  }

  const flatTexts = [options.fileName, selectedSheetName, ...grid.slice(0, 10).flat()];
  const yearCtx = detectYearContextFromTexts(flatTexts);
  const fallbackSchoolYear = options.fallbackSchoolYear ?? getKoreanSchoolYearForDateKey('');
  const warnings: string[] = [];

  if (sheetNames.length > 1) {
    warnings.push(
      `총 ${sheetNames.length}개 시트 중 '${selectedSheetName}' 시트를 분석했습니다. 다른 시트를 보려면 시트를 변경해 주세요.`,
    );
  }
  if (yearCtx.schoolYear === null && yearCtx.explicitYear === null) {
    warnings.push(
      '엑셀 시트에서 학년도(예: 2026학년도)를 찾지 못해 연도가 없는 날짜는 확인 필요로 표시했습니다.',
    );
  }

  const annual = parseAnnualMonthMatrix(grid, yearCtx, fallbackSchoolYear);
  const monthly = !annual
    ? parseMonthlyCalendarGrid(grid, flatTexts, yearCtx, fallbackSchoolYear)
    : null;
  const listTable =
    !annual && !monthly ? parseRowListTable(grid, yearCtx, fallbackSchoolYear) : null;

  const rawCandidates = annual ?? monthly ?? listTable ?? [];
  const textFallback =
    rawCandidates.length === 0
      ? parseAcademicTextLines(
          grid.map((r) => r.filter(Boolean).join(' ')),
          yearCtx,
          fallbackSchoolYear,
        )
      : [];

  const finalList = finalizeCandidates(
    rawCandidates.length > 0 ? rawCandidates : textFallback,
    options.existingEvents ?? [],
    warnings,
  );

  return {
    sourceType: 'excel',
    extractionMode: 'excel',
    sourceLabel: options.fileName,
    detectedSchoolYear: yearCtx.schoolYear ?? yearCtx.explicitYear,
    candidates: finalList,
    warnings,
    sheetNames,
    selectedSheetName,
    rawTextExcerpt: grid
      .slice(0, 20)
      .map((r) => r.filter(Boolean).join(' | '))
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200),
  };
}

// ---------------------------------------------------------------------------
// HWPX Parser
// ---------------------------------------------------------------------------
function parseXmlDocument(xmlText: string): Document {
  if (typeof globalThis.DOMParser !== 'undefined') {
    return new globalThis.DOMParser().parseFromString(xmlText, 'text/xml');
  }
  return new XmlDomParser().parseFromString(xmlText, 'text/xml') as unknown as Document;
}

function getDescendantsByLocalName(root: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const name = el.localName || el.nodeName.replace(/^[^:]+:/, '');
    if (name === localName) result.push(el);
  }
  return result;
}

function getDirectChildrenByLocalName(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType === 1) {
      const el = node as Element;
      const name = el.localName || el.nodeName.replace(/^[^:]+:/, '');
      if (name === localName) result.push(el);
    }
  }
  return result;
}

function getAttr(el: Element, attrName: string): string | null {
  return el.getAttribute(attrName) ?? el.getAttribute(`hp:${attrName}`) ?? null;
}

function extractHwpxCellText(tc: Element): string {
  const paragraphs = getDescendantsByLocalName(tc, 'p');
  if (paragraphs.length === 0) {
    return getDescendantsByLocalName(tc, 't')
      .map((t) => (t.textContent ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return paragraphs
    .map((p) =>
      getDescendantsByLocalName(p, 't')
        .map((t) => t.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function extractAcademicTablesAndLinesFromHwpxXmls(
  xmlStrings: string[],
): {
  paragraphs: string[];
  tables: string[][][];
} {
  const paragraphs: string[] = [];
  const tables: string[][][] = [];

  for (const xml of xmlStrings) {
    const doc = parseXmlDocument(xml);

    // Top-level paragraphs for document headers (e.g., "2026학년도 학사일정")
    for (const p of getDescendantsByLocalName(doc, 'p')) {
      let insideTbl = false;
      let parent = p.parentNode as Element | null;
      while (parent && parent.nodeType === 1) {
        const pName = parent.localName || parent.nodeName.replace(/^[^:]+:/, '');
        if (pName === 'tbl') {
          insideTbl = true;
          break;
        }
        parent = parent.parentNode as Element | null;
      }
      if (!insideTbl) {
        const line = getDescendantsByLocalName(p, 't')
          .map((t) => t.textContent ?? '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (line) paragraphs.push(line);
      }
    }

    // Extract tables including merged cells
    for (const tbl of getDescendantsByLocalName(doc, 'tbl')) {
      let parent = tbl.parentNode as Element | null;
      let nested = false;
      while (parent && parent.nodeType === 1) {
        const pName = parent.localName || parent.nodeName.replace(/^[^:]+:/, '');
        if (pName === 'tbl') {
          nested = true;
          break;
        }
        parent = parent.parentNode as Element | null;
      }
      if (nested) continue;

      const trList = getDirectChildrenByLocalName(tbl, 'tr');
      if (trList.length === 0) continue;

      const occupied = new Set<string>();
      const placements: { row: number; col: number; rowSpan: number; colSpan: number; text: string }[] = [];
      let maxRow = 0;
      let maxCol = 0;

      trList.forEach((tr, rowFallback) => {
        const tcList = getDirectChildrenByLocalName(tr, 'tc');
        let nextFallbackCol = 0;
        for (const tc of tcList) {
          const cellAddrEls = getDirectChildrenByLocalName(tc, 'cellAddr');
          const cellSpanEls = getDirectChildrenByLocalName(tc, 'cellSpan');
          const addrCol = cellAddrEls[0] ? getAttr(cellAddrEls[0], 'colAddr') : null;
          const addrRow = cellAddrEls[0] ? getAttr(cellAddrEls[0], 'rowAddr') : null;
          const colSpan = Math.max(1, Number((cellSpanEls[0] && getAttr(cellSpanEls[0], 'colSpan')) ?? 1) || 1);
          const rowSpan = Math.max(1, Number((cellSpanEls[0] && getAttr(cellSpanEls[0], 'rowSpan')) ?? 1) || 1);

          let row = addrRow !== null ? Number(addrRow) : rowFallback;
          let col = addrCol !== null ? Number(addrCol) : -1;
          if (!Number.isInteger(row) || row < 0) row = rowFallback;
          if (!Number.isInteger(col) || col < 0) {
            while (occupied.has(`${row}_${nextFallbackCol}`)) nextFallbackCol += 1;
            col = nextFallbackCol;
          }

          for (let rr = row; rr < row + rowSpan; rr++) {
            for (let cc = col; cc < col + colSpan; cc++) {
              occupied.add(`${rr}_${cc}`);
            }
          }
          nextFallbackCol = col + colSpan;
          maxRow = Math.max(maxRow, row + rowSpan);
          maxCol = Math.max(maxCol, col + colSpan);

          placements.push({
            row,
            col,
            rowSpan,
            colSpan,
            text: extractHwpxCellText(tc),
          });
        }
      });

      if (maxRow > 0 && maxCol > 0) {
        const grid: string[][] = Array.from({ length: maxRow }, () =>
          Array.from({ length: maxCol }, () => ''),
        );
        for (const item of placements) {
          for (let r = item.row; r < item.row + item.rowSpan; r++) {
            for (let c = item.col; c < item.col + item.colSpan; c++) {
              grid[r][c] = item.text;
            }
          }
        }
        tables.push(grid);
      }
    }
  }

  return { paragraphs, tables };
}

export async function extractAcademicFromHwpxBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: {
    fileName: string;
    existingEvents?: AcademicEventRecord[];
    fallbackSchoolYear?: number;
  },
): Promise<AcademicImportPreview> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error(
      'HWPX 압축 구조를 열 수 없습니다. (구형 .hwp 파일은 한글에서 .hwpx 또는 .pdf로 저장한 뒤 업로드해 주세요.)',
    );
  }

  const sectionEntries = Object.keys(zip.files)
    .filter((name) => /^contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = Number(/section(\d+)\.xml/i.exec(a)?.[1] ?? 0);
      const numB = Number(/section(\d+)\.xml/i.exec(b)?.[1] ?? 0);
      return numA - numB;
    });

  if (sectionEntries.length === 0) {
    throw new Error('HWPX 본문(Contents/section*.xml)을 찾지 못했습니다.');
  }

  const xmlStrings = await Promise.all(
    sectionEntries.map((name) => zip.files[name].async('string')),
  );

  const { paragraphs, tables } = extractAcademicTablesAndLinesFromHwpxXmls(xmlStrings);
  const allHeaderTexts = [
    options.fileName,
    ...paragraphs,
    ...tables.flatMap((t) => t.slice(0, 3).flat()),
  ];
  const yearCtx = detectYearContextFromTexts(allHeaderTexts);
  const fallbackSchoolYear = options.fallbackSchoolYear ?? getKoreanSchoolYearForDateKey('');
  const warnings: string[] = [];

  if (yearCtx.schoolYear === null && yearCtx.explicitYear === null) {
    warnings.push(
      'HWPX 문서에서 학년도(예: 2026학년도)를 찾지 못해 연도가 생략된 날짜는 확인 필요로 표시했습니다.',
    );
  }

  const combinedCandidates: AcademicImportCandidate[] = [];
  for (const grid of tables) {
    const annual = parseAnnualMonthMatrix(grid, yearCtx, fallbackSchoolYear);
    if (annual && annual.length > 0) {
      combinedCandidates.push(...annual);
      continue;
    }
    const monthly = parseMonthlyCalendarGrid(
      grid,
      [...paragraphs, ...grid.slice(0, 3).flat()],
      yearCtx,
      fallbackSchoolYear,
    );
    if (monthly && monthly.length > 0) {
      combinedCandidates.push(...monthly);
      continue;
    }
    const rows = parseRowListTable(grid, yearCtx, fallbackSchoolYear);
    combinedCandidates.push(...rows);
  }

  // Also check paragraphs outside tables
  const paragraphCandidates = parseAcademicTextLines(
    paragraphs,
    yearCtx,
    fallbackSchoolYear,
  );
  combinedCandidates.push(...paragraphCandidates);

  const finalList = finalizeCandidates(
    combinedCandidates,
    options.existingEvents ?? [],
    warnings,
  );

  return {
    sourceType: 'hwpx',
    extractionMode: 'hwpx_xml',
    sourceLabel: options.fileName,
    detectedSchoolYear: yearCtx.schoolYear ?? yearCtx.explicitYear,
    candidates: finalList,
    warnings,
    rawTextExcerpt: [...paragraphs, ...tables.flat().map((r) => r.filter(Boolean).join(' | '))]
      .filter(Boolean)
      .slice(0, 25)
      .join('\n')
      .slice(0, 1200),
  };
}

// ---------------------------------------------------------------------------
// PDF Parser (Text + Table Reconstruction + Scanned OCR Fallback)
// ---------------------------------------------------------------------------
let academicPdfWorkerInitialized = false;

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && !academicPdfWorkerInitialized) {
    const workerModule = await import(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
    );
    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    academicPdfWorkerInitialized = true;
  }
  return pdfjs;
}

function reconstructLinesFromPdfTokens(tokens: PdfTextToken[]): {
  lines: string[];
  grid: string[][];
} {
  const sorted = [...tokens]
    .filter((t) => t.text.trim().length > 0)
    .sort((a, b) => a.topY - b.topY || a.x - b.x);

  const yGroups: PdfTextToken[][] = [];
  for (const tok of sorted) {
    const last = yGroups[yGroups.length - 1];
    if (last && Math.abs(last[0].topY - tok.topY) <= 6) {
      last.push(tok);
    } else {
      yGroups.push([tok]);
    }
  }

  const lines = yGroups.map((grp) =>
    grp
      .sort((a, b) => a.x - b.x)
      .map((t) => t.text.trim())
      .join(' '),
  );

  // Build coarse column grid by splitting tokens separated by >= 18pt X gaps
  const grid: string[][] = yGroups.map((grp) => {
    const ordered = [...grp].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let currentCell = '';
    let prevRight = ordered[0]?.x ?? 0;

    for (const tok of ordered) {
      if (currentCell && tok.x - prevRight >= 18) {
        cells.push(currentCell.trim());
        currentCell = tok.text.trim();
      } else {
        currentCell = currentCell ? `${currentCell} ${tok.text.trim()}` : tok.text.trim();
      }
      prevRight = tok.x + tok.width;
    }
    if (currentCell.trim()) {
      cells.push(currentCell.trim());
    }
    return cells;
  });

  return { lines, grid };
}

export async function extractAcademicFromPdfBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: {
    fileName: string;
    pageNumber?: number;
    existingEvents?: AcademicEventRecord[];
    fallbackSchoolYear?: number;
    onProgress?: (p: BrowserOcrProgress) => void;
    signal?: AbortSignal;
  },
): Promise<AcademicImportPreview> {
  const pdfjs = await getPdfJs();
  const dataCopy =
    buffer instanceof Uint8Array
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.slice(0));

  const loadingTask = pdfjs.getDocument({
    data: dataCopy,
    isEvalSupported: false,
    useSystemFonts: true,
    ...(typeof window === 'undefined' ? { disableWorker: true } : {}),
  } as Parameters<typeof pdfjs.getDocument>[0]);

  const pdfDoc = await loadingTask.promise;
  try {
    const pageCount = pdfDoc.numPages;
    if (pageCount <= 0) {
      throw new Error('PDF 파일에 페이지가 없습니다.');
    }

    const pagesTokens: PdfTextToken[][] = [];
    const targetPages = options.pageNumber
      ? [Math.max(1, Math.min(pageCount, options.pageNumber))]
      : Array.from({ length: Math.min(pageCount, 8) }, (_, idx) => idx + 1);

    for (const pNum of targetPages) {
      const page = await pdfDoc.getPage(pNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const toks: PdfTextToken[] = [];
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const text = (item.str ?? '').trim();
        if (!text) continue;
        const tx = item.transform;
        const x = Number(tx?.[4] ?? 0);
        const yBottom = Number(tx?.[5] ?? 0);
        const height = Math.max(8, Number(item.height || Math.abs(tx?.[3] ?? 10)));
        const width = Math.max(4, Number(item.width ?? text.length * 6));
        toks.push({
          text,
          x,
          topY: viewport.height - yBottom - height,
          width,
          height,
        });
      }
      pagesTokens.push(toks);
    }

    const totalTextChars = pagesTokens
      .flat()
      .reduce((acc, tok) => acc + tok.text.length, 0);
    const fallbackSchoolYear =
      options.fallbackSchoolYear ?? getKoreanSchoolYearForDateKey('');
    const warnings: string[] = [];

    if (pageCount > 8 && !options.pageNumber) {
      warnings.push(
        `총 ${pageCount}페이지 중 앞 8페이지를 분석했습니다. 필요 시 페이지를 지정해 주세요.`,
      );
    }

    // Text-based PDF path
    if (totalTextChars >= 15) {
      const pageExtracts = pagesTokens.map(reconstructLinesFromPdfTokens);
      const allLines = pageExtracts.flatMap((p) => p.lines);
      const yearCtx = detectYearContextFromTexts([options.fileName, ...allLines]);

      if (yearCtx.schoolYear === null && yearCtx.explicitYear === null) {
        warnings.push(
          'PDF 본문에서 학년도(예: 2026학년도)를 찾지 못해 연도가 생략된 날짜는 확인 필요로 표시했습니다.',
        );
      }

      const candidates: AcademicImportCandidate[] = [];
      for (const { lines, grid } of pageExtracts) {
        const annual = parseAnnualMonthMatrix(grid, yearCtx, fallbackSchoolYear);
        if (annual && annual.length > 0) {
          candidates.push(...annual);
          continue;
        }
        const monthly = parseMonthlyCalendarGrid(
          grid,
          lines,
          yearCtx,
          fallbackSchoolYear,
        );
        if (monthly && monthly.length > 0) {
          candidates.push(...monthly);
          continue;
        }
        const lineCandidates = parseAcademicTextLines(
          lines,
          yearCtx,
          fallbackSchoolYear,
        );
        candidates.push(...lineCandidates);
      }

      const finalList = finalizeCandidates(
        candidates,
        options.existingEvents ?? [],
        warnings,
      );

      return {
        sourceType: 'pdf',
        extractionMode: 'pdf_text',
        sourceLabel: options.fileName,
        detectedSchoolYear: yearCtx.schoolYear ?? yearCtx.explicitYear,
        candidates: finalList,
        warnings,
        pageCount,
        selectedPage: options.pageNumber,
        rawTextExcerpt: allLines.slice(0, 30).join('\n').slice(0, 1200),
      };
    }

    // Scanned PDF fallback -> render page 1 (or selected page) to canvas and run OCR
    if (typeof document === 'undefined') {
      return {
        sourceType: 'pdf',
        extractionMode: 'pdf_ocr',
        sourceLabel: options.fileName,
        detectedSchoolYear: null,
        candidates: [],
        warnings: [
          '스캔 이미지 형태의 PDF입니다. 브라우저 환경에서 OCR 인식이 필요합니다.',
        ],
        pageCount,
        selectedPage: options.pageNumber ?? 1,
        rawTextExcerpt: '',
      };
    }

    const ocrPageNum = options.pageNumber ?? 1;
    const page = await pdfDoc.getPage(ocrPageNum);
    const renderViewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(renderViewport.width);
    canvas.height = Math.round(renderViewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('스캔 PDF 이미지를 렌더링할 캔버스를 초기화하지 못했습니다.');
    }

    await page.render({
      canvasContext: ctx,
      viewport: renderViewport,
      canvas,
    }).promise;

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('PDF 페이지를 이미지로 변환하지 못했습니다.'));
      }, 'image/png');
    });

    const ocrRes = await runInBrowserStructuredOcr(blob, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
    const ocrLines = ocrRes.text
      .split(/\r?\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const yearCtx = detectYearContextFromTexts([options.fileName, ...ocrLines]);
    const ocrCandidates = parseAcademicTextLines(
      ocrLines,
      yearCtx,
      fallbackSchoolYear,
    );

    warnings.push(
      '스캔 이미지 형태의 PDF로 감지되어 OCR 인식을 수행했습니다. 날짜와 일정명을 검토해 주세요.',
    );
    if (yearCtx.schoolYear === null && yearCtx.explicitYear === null) {
      warnings.push(
        '문서에서 연도를 찾지 못한 항목은 확인 필요로 표시했습니다.',
      );
    }

    return {
      sourceType: 'pdf',
      extractionMode: 'pdf_ocr',
      sourceLabel: options.fileName,
      detectedSchoolYear: yearCtx.schoolYear ?? yearCtx.explicitYear,
      candidates: finalizeCandidates(
        ocrCandidates,
        options.existingEvents ?? [],
        warnings,
      ),
      warnings,
      pageCount,
      selectedPage: ocrPageNum,
      rawTextExcerpt: ocrLines.slice(0, 25).join('\n').slice(0, 1200),
    };
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------
// Image OCR Parser & Unified Entry Point
// ---------------------------------------------------------------------------
export async function parseAcademicScheduleFile(
  file: File,
  options: {
    sheetName?: string;
    pageNumber?: number;
    existingEvents?: AcademicEventRecord[];
    fallbackSchoolYear?: number;
    onProgress?: (p: BrowserOcrProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<AcademicImportPreview> {
  if (file.size > ACADEMIC_MAX_FILE_BYTES) {
    throw new Error('파일 크기는 최대 15MB까지 업로드할 수 있습니다.');
  }

  const kind: TimetableFileKind = detectTimetableFileKind(file.name, file.type);

  if (kind === 'legacy_hwp') {
    throw new Error(
      '구형 한글 파일(.hwp)은 브라우저에서 직접 표를 읽을 수 없습니다. 한글 프로그램에서 HWPX(.hwpx) 또는 PDF(.pdf)로 다시 저장해 업로드해 주세요.',
    );
  }
  if (kind === 'unsupported') {
    throw new Error(
      '지원하지 않는 파일 형식입니다. PDF(.pdf), 엑셀(.xlsx/.xls), 한글(.hwpx), 이미지(.png/.jpg/.jpeg) 파일을 선택해 주세요.',
    );
  }

  if (kind === 'excel') {
    const buf = await file.arrayBuffer();
    return extractAcademicFromExcelBuffer(buf, {
      fileName: file.name,
      sheetName: options.sheetName,
      existingEvents: options.existingEvents,
      fallbackSchoolYear: options.fallbackSchoolYear,
    });
  }

  if (kind === 'hwpx') {
    const buf = await file.arrayBuffer();
    return extractAcademicFromHwpxBuffer(buf, {
      fileName: file.name,
      existingEvents: options.existingEvents,
      fallbackSchoolYear: options.fallbackSchoolYear,
    });
  }

  if (kind === 'pdf') {
    const buf = await file.arrayBuffer();
    return extractAcademicFromPdfBuffer(buf, {
      fileName: file.name,
      pageNumber: options.pageNumber,
      existingEvents: options.existingEvents,
      fallbackSchoolYear: options.fallbackSchoolYear,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }

  // Image OCR path
  const validationErr = validateOcrImageFile(file);
  if (validationErr) {
    throw new Error(validationErr);
  }
  const ocrRes = await runInBrowserStructuredOcr(file, {
    onProgress: options.onProgress,
    signal: options.signal,
  });
  const ocrLines = ocrRes.text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const yearCtx = detectYearContextFromTexts([file.name, ...ocrLines]);
  const fallbackSchoolYear =
    options.fallbackSchoolYear ?? getKoreanSchoolYearForDateKey('');
  const warnings: string[] = [];

  if (ocrRes.confidence > 0 && ocrRes.confidence < 65) {
    warnings.push(
      '이미지 화질 또는 기울기로 인해 OCR 인식 정확도가 낮을 수 있습니다. 추출된 날짜와 일정을 꼭 확인해 주세요.',
    );
  }
  if (yearCtx.schoolYear === null && yearCtx.explicitYear === null) {
    warnings.push(
      '이미지에서 학년도 정보를 찾지 못해 연도가 생략된 날짜는 확인 필요로 표시했습니다.',
    );
  }

  const rawCandidates = parseAcademicTextLines(
    ocrLines,
    yearCtx,
    fallbackSchoolYear,
  );

  return {
    sourceType: 'ocr',
    extractionMode: 'image_ocr',
    sourceLabel: file.name,
    detectedSchoolYear: yearCtx.schoolYear ?? yearCtx.explicitYear,
    candidates: finalizeCandidates(
      rawCandidates,
      options.existingEvents ?? [],
      warnings,
    ),
    warnings,
    rawTextExcerpt: ocrLines.slice(0, 25).join('\n').slice(0, 1200),
  };
}
