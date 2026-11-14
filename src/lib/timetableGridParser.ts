import { createDefaultPeriodTimes, makeSlotKey, TIMETABLE_WEEKDAYS } from './timetable';
import { sanitizeSingleLine } from './dateKst';
import {
  VALIDATION_LIMITS,
  type TimetablePeriodTime,
  type TimetableSlot,
  type TimetableSlotKind,
  type TimetableSourceType,
  type TimetableWeekday,
} from '../types/domain';

export type TimetableCellStatus =
  | 'recognized'
  | 'empty'
  | 'needs_confirmation'
  | 'recognition_failed';

export interface TimetableImportCellMeta {
  status: TimetableCellStatus;
  needsConfirmation: boolean;
  reasons: string[];
  rawText: string;
}

export interface TimetableTableOption {
  id: string;
  label: string;
  rowCount: number;
  colCount: number;
  weekdayMatchCount: number;
}

export interface TimetableImportPreview {
  sourceType: Exclude<TimetableSourceType, 'manual'>;
  extractionMode?: 'excel' | 'hwpx_xml' | 'pdf_text' | 'pdf_ocr' | 'image_ocr';
  sheetNames?: string[];
  selectedSheetName?: string;
  tableOptions?: TimetableTableOption[];
  selectedTableId?: string;
  pageCount?: number;
  selectedPage?: number;
  rawSourceRows?: string[][];
  rawSourceText?: string;
  originalPreviewImageUrl?: string;
  periodCount: number;
  periodTimes: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableSlot>;
  cellMeta: Record<string, TimetableImportCellMeta>;
  warnings: string[];
  needsConfirmationCount: number;
  recognitionFailedCount: number;
}

export interface MergedCellSpan {
  masterRow: number;
  masterCol: number;
  spanRows: number;
  spanCols: number;
}

export type TimetableFileKind =
  | 'excel'
  | 'hwpx'
  | 'pdf'
  | 'image'
  | 'legacy_hwp'
  | 'unsupported';

export function detectTimetableFileKind(
  fileName: string,
  mimeType = '',
): TimetableFileKind {
  const lower = fileName.trim().toLowerCase();
  const mime = mimeType.trim().toLowerCase();

  if (lower.endsWith('.hwpx') || mime.includes('hwpx')) {
    return 'hwpx';
  }
  if (lower.endsWith('.hwp') || mime === 'application/x-hwp' || mime === 'application/haansofthwp') {
    return 'legacy_hwp';
  }
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    mime.includes('spreadsheet') ||
    mime.includes('ms-excel')
  ) {
    return 'excel';
  }
  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    return 'pdf';
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.bmp') ||
    mime.startsWith('image/')
  ) {
    return 'image';
  }
  return 'unsupported';
}

const WEEKDAY_HEADER_PATTERNS: { day: TimetableWeekday; regex: RegExp }[] = [
  { day: 1, regex: /^(?:월(?:요일)?|mon(?:day)?)$/i },
  { day: 2, regex: /^(?:화(?:요일)?|tue(?:sday)?)$/i },
  { day: 3, regex: /^(?:수(?:요일)?|wed(?:nesday)?)$/i },
  { day: 4, regex: /^(?:목(?:요일)?|thu(?:rsday)?)$/i },
  { day: 5, regex: /^(?:금(?:요일)?|fri(?:day)?)$/i },
];

const EXPLICIT_FREE_KEYWORDS = /^(?:공강|빈\s*시간|빈시간|자체\s*공강|휴강)$/;
const EMPTY_PLACEHOLDER = /^(?:없음|[-—–]+)$/;
const FIXED_DUTY_KEYWORDS =
  /(?:교직원\s*회의|회의|동아리|계발|자치|고정\s*업무|업무|당직|연수|상담|창체|보직)/;
const TIME_RANGE_REGEX =
  /([01]?\d|2[0-3]):([0-5]\d)\s*[~\-–—]\s*([01]?\d|2[0-3]):([0-5]\d)/;

// Matches 3-1, 3-02, 1-10, 2학년 3반, 3학년1반, 3-1반, 3반
const CLASS_NAME_REGEX =
  /^(?:\d{1,2}\s*학년\s*\d{1,2}\s*반|\d{1,2}-\d{1,2}(?:반)?|\d-\d[가-힣]?|\d{1,2}반)$/;

// Matches 301호, 과학실, 본관 2층, 음악실, 컴퓨터실, 체육관, 특별실
const CLASSROOM_REGEX =
  /(?:\d{2,4}호$|\d+층$|실$|관$|교무실|운동장|강당|도서관|시청각실|특별실|멀티실|컴퓨터실|과학실|음악실|미술실)/;

export function detectWeekdayFromHeader(raw: string): TimetableWeekday | null {
  const cleaned = raw
    .replace(/\r\n/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[()[\]{}]/g, '')
    .replace(/(?:요일).*$/, '요일');

  for (const item of WEEKDAY_HEADER_PATTERNS) {
    if (item.regex.test(cleaned)) {
      return item.day;
    }
  }
  return null;
}

export function detectPeriodFromLabel(raw: string): number | null {
  const cleaned = raw.replace(/\r\n/g, ' ').replace(/\s+/g, '');
  if (!cleaned) return null;

  // Handle "1교시(09:00~09:45)" or "1교시09:00~09:45"
  const gyoMatch = /^(\d{1,2})교시/.exec(cleaned);
  if (gyoMatch) {
    const num = Number(gyoMatch[1]);
    return num >= 1 && num <= VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX ? num : null;
  }

  // Handle "1" or "1." or "1(09:00~09:45)"
  const numOnly = /^(\d{1,2})(?:교시|차시|\.)?(?:\(|$)/.exec(cleaned);
  if (numOnly) {
    const num = Number(numOnly[1]);
    return num >= 1 && num <= VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX ? num : null;
  }

  return null;
}

export function extractTimeRangeFromText(
  raw: string,
): { startTime: string; endTime: string } | null {
  const collapsed = raw.replace(/\s*\n\s*/g, '');
  const match = TIME_RANGE_REGEX.exec(collapsed) ?? TIME_RANGE_REGEX.exec(raw);
  if (!match) return null;
  const startTime = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  const endTime = `${String(Number(match[3])).padStart(2, '0')}:${match[4]}`;
  if (endTime <= startTime) return null;
  return { startTime, endTime };
}

function splitCellTokens(normalized: string): string[] {
  // Expand "3-1(과학실)" or "국어(3-1)" into distinct tokens before parsing
  const expanded = normalized
    .replace(/[()[\]]/g, ' ')
    .replace(/[\/|,]/g, '\n');
  const lines = expanded
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean);
    // Recombine "2학년 3반" if adjacent
    for (let i = 0; i < words.length; i++) {
      if (
        /^\d{1,2}학년$/.test(words[i]) &&
        words[i + 1] &&
        /^\d{1,2}반$/.test(words[i + 1])
      ) {
        tokens.push(`${words[i]} ${words[i + 1]}`);
        i += 1;
      } else {
        tokens.push(words[i]);
      }
    }
  }
  return tokens;
}

/**
 * Parses raw text inside a timetable cell according to Section 4 rules:
 * 1. "3-1", "3-2", "3-4", "2학년 1반" -> className field (kind: 'class').
 * 2. Empty cell or "-" -> kind: 'free', subject: '' (NEVER auto-inserts '공강').
 * 3. Extracts subject & classroom into separate fields when present.
 * 4. Marks unparseable / ambiguous content as needsConfirmation without guessing.
 * 5. Never sets workAvailable: true automatically.
 */
export function parseTimetableCellText(rawText: string): {
  kind: TimetableSlotKind;
  subject: string;
  className: string;
  classroom: string;
  note: string;
  workAvailable: boolean;
  status: TimetableCellStatus;
  needsConfirmation: boolean;
  reasons: string[];
} {
  const normalized = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();

  if (!normalized || EMPTY_PLACEHOLDER.test(normalized)) {
    return {
      kind: 'free',
      subject: '',
      className: '',
      classroom: '',
      note: '',
      workAvailable: false,
      status: 'empty',
      needsConfirmation: false,
      reasons: [],
    };
  }

  if (EXPLICIT_FREE_KEYWORDS.test(normalized)) {
    return {
      kind: 'free',
      subject: sanitizeSingleLine(normalized, VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN),
      className: '',
      classroom: '',
      note: '',
      workAvailable: false,
      status: 'recognized',
      needsConfirmation: false,
      reasons: [],
    };
  }

  const tokens = splitCellTokens(normalized);
  let className = '';
  let classroom = '';
  const subjectParts: string[] = [];

  for (const token of tokens) {
    const clean = token.trim();
    if (!clean) continue;
    if (!className && CLASS_NAME_REGEX.test(clean)) {
      className = sanitizeSingleLine(clean, VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN);
    } else if (!classroom && CLASSROOM_REGEX.test(clean) && (tokens.length > 1 || /\d/.test(clean) || clean.endsWith('실'))) {
      classroom = sanitizeSingleLine(clean, VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN);
    } else {
      subjectParts.push(clean);
    }
  }

  let subject = sanitizeSingleLine(
    subjectParts.join(' '),
    VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN,
  );

  // If cell only had classroom (rare) and no class/subject, keep as subject and flag confirmation
  if (!subject && !className && classroom) {
    subject = classroom;
    classroom = '';
  }

  let kind: TimetableSlotKind = 'class';
  const reasons: string[] = [];
  let status: TimetableCellStatus = 'recognized';
  let needsConfirmation = false;

  if (FIXED_DUTY_KEYWORDS.test(normalized)) {
    kind = 'fixed_duty';
    status = 'needs_confirmation';
    needsConfirmation = true;
    reasons.push('수업 외 고정 업무 또는 기타 일정인지 구분을 확인해 주세요.');
  } else if (!className && !classroom && (subject.length <= 1 || /^[^가-힣a-zA-Z0-9]+$/.test(subject))) {
    status = 'needs_confirmation';
    needsConfirmation = true;
    reasons.push('인식된 문구가 짧거나 기호 형태여서 직접 확인이 필요합니다.');
  }

  return {
    kind,
    subject,
    className,
    classroom,
    note: '',
    workAvailable: false,
    status,
    needsConfirmation,
    reasons,
  };
}

export function analyzeTimetableMatrix(params: {
  sourceType: Exclude<TimetableSourceType, 'manual'>;
  extractionMode: 'excel' | 'hwpx_xml' | 'pdf_text';
  grid: string[][];
  mergedCells?: Map<string, MergedCellSpan>;
  warnings?: string[];
  sheetNames?: string[];
  selectedSheetName?: string;
  tableOptions?: TimetableTableOption[];
  selectedTableId?: string;
}): TimetableImportPreview {
  const {
    sourceType,
    extractionMode,
    grid,
    mergedCells = new Map(),
    warnings: initialWarnings = [],
    sheetNames,
    selectedSheetName,
    tableOptions,
    selectedTableId,
  } = params;

  const warnings = [...initialWarnings];
  const maxRows = grid.length;
  const maxCols = grid.reduce((m, row) => Math.max(m, row.length), 0);

  // 1. Locate header row containing weekdays (Mon..Fri)
  let bestHeaderRow = -1;
  let bestDayCols = new Map<TimetableWeekday, number>();

  for (let r = 0; r < maxRows; r++) {
    const foundCols = new Map<TimetableWeekday, number>();
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const day = detectWeekdayFromHeader(grid[r][c] ?? '');
      if (day && !foundCols.has(day)) {
        foundCols.set(day, c);
      }
    }
    if (foundCols.size > bestDayCols.size) {
      bestDayCols = foundCols;
      bestHeaderRow = r;
    }
  }

  const headerMissingAll = bestHeaderRow === -1 || bestDayCols.size < 2;
  if (headerMissingAll) {
    warnings.push(
      '표에서 월~금 요일 머리글을 명확히 찾지 못했습니다. 잘못 배치된 칸이 없는지 확인해 주세요.',
    );
  } else if (bestDayCols.size < 5) {
    const missing = TIMETABLE_WEEKDAYS.filter((w) => !bestDayCols.has(w.day))
      .map((w) => w.short)
      .join(', ');
    warnings.push(
      `일부 요일 머리글(${missing})이 문서 표에서 인식되지 않았습니다. 해당 요일은 확인 후 입력해 주세요.`,
    );
  }

  // 2. Locate period rows (rows below header containing 1교시..12교시 or numbers)
  const earliestDayCol =
    bestDayCols.size > 0 ? Math.min(...Array.from(bestDayCols.values())) : 1;
  const periodCandidateCols: number[] = [];
  for (let c = 0; c < Math.max(1, earliestDayCol); c++) {
    periodCandidateCols.push(c);
  }

  const rowToPeriod = new Map<number, number>();
  const extractedTimes = new Map<number, { startTime: string; endTime: string }>();

  const startDataRow = bestHeaderRow >= 0 ? bestHeaderRow + 1 : 0;
  for (let r = startDataRow; r < maxRows; r++) {
    let detectedPeriod: number | null = null;
    for (const c of periodCandidateCols) {
      const cellText = grid[r]?.[c] ?? '';
      if (!detectedPeriod) {
        detectedPeriod = detectPeriodFromLabel(cellText);
      }
    }
    if (detectedPeriod && !Array.from(rowToPeriod.values()).includes(detectedPeriod)) {
      rowToPeriod.set(r, detectedPeriod);
      for (const c of periodCandidateCols) {
        const timeRange = extractTimeRangeFromText(grid[r]?.[c] ?? '');
        if (timeRange && !extractedTimes.has(detectedPeriod)) {
          extractedTimes.set(detectedPeriod, timeRange);
        }
      }
    }
  }

  let periodRowFallbackUsed = false;
  if (rowToPeriod.size === 0 && bestHeaderRow >= 0) {
    let nextPeriod = 1;
    for (let r = bestHeaderRow + 1; r < maxRows && nextPeriod <= 10; r++) {
      const hasAnyValue = Array.from(bestDayCols.values()).some((c) =>
        Boolean((grid[r]?.[c] ?? '').trim()),
      );
      if (hasAnyValue) {
        rowToPeriod.set(r, nextPeriod);
        nextPeriod += 1;
      }
    }
    if (rowToPeriod.size > 0) {
      periodRowFallbackUsed = true;
      warnings.push(
        '교시 번호 열을 명확히 찾지 못해 행 순서대로 임시 배치했습니다. 각 교시 번호를 확인해 주세요.',
      );
    }
  }

  const maxDetectedPeriod =
    rowToPeriod.size > 0 ? Math.max(...Array.from(rowToPeriod.values())) : 7;
  const periodCount = Math.max(
    1,
    Math.min(VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX, maxDetectedPeriod),
  );
  const periodTimes = createDefaultPeriodTimes(periodCount);

  for (const [periodNum, rangeVal] of extractedTimes.entries()) {
    const key = String(periodNum);
    if (periodTimes[key]) {
      periodTimes[key] = {
        ...periodTimes[key],
        startTime: rangeVal.startTime,
        endTime: rangeVal.endTime,
      };
    }
  }

  const slots: Record<string, TimetableSlot> = {};
  const cellMeta: Record<string, TimetableImportCellMeta> = {};
  let needsConfirmationCount = 0;
  let recognitionFailedCount = 0;

  // Initialize every cell cleanly: missing weekday columns are recognition_failed,
  // while mapped columns default to clean empty until populated.
  for (const w of TIMETABLE_WEEKDAYS) {
    const hasDayColumn = bestDayCols.has(w.day);
    for (let p = 1; p <= periodCount; p++) {
      const sKey = makeSlotKey(w.day, p);
      slots[sKey] = {
        day: w.day,
        period: p,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: false,
      };

      if (headerMissingAll || !hasDayColumn) {
        cellMeta[sKey] = {
          status: 'recognition_failed',
          needsConfirmation: true,
          reasons: [
            headerMissingAll
              ? '표에서 요일 열을 식별하지 못해 인식에 실패했습니다.'
              : `${w.short}요일 열을 문서 표에서 찾지 못했습니다.`,
          ],
          rawText: '',
        };
        needsConfirmationCount += 1;
        recognitionFailedCount += 1;
      } else {
        cellMeta[sKey] = {
          status: 'empty',
          needsConfirmation: false,
          reasons: [],
          rawText: '',
        };
      }
    }
  }

  // Populate recognized rows
  for (const [rowIdx, periodNum] of rowToPeriod.entries()) {
    if (periodNum > periodCount) continue;
    for (const [day, colIdx] of bestDayCols.entries()) {
      const sKey = makeSlotKey(day, periodNum);
      const raw = grid[rowIdx]?.[colIdx] ?? '';
      const parsed = parseTimetableCellText(raw);
      const mergeInfo = mergedCells.get(`${rowIdx}_${colIdx}`);

      const reasons = [...parsed.reasons];
      let status = parsed.status;
      let needsConfirm = parsed.needsConfirmation;

      if (mergeInfo) {
        needsConfirm = true;
        status = 'needs_confirmation';
        reasons.push(
          mergeInfo.spanCols > 1
            ? '가로로 병합된 셀입니다. 여러 요일에 걸친 일정인지 확인해 주세요.'
            : '세로로 병합된 셀입니다. 연강 수업 또는 수업 없음 여부를 확인해 주세요.',
        );
      }

      if (periodRowFallbackUsed && raw.trim()) {
        needsConfirm = true;
        status = 'needs_confirmation';
        if (!reasons.includes('교시 번호 매핑 확인 필요')) {
          reasons.push('교시 번호가 명시되지 않아 행 위치로 배치되었습니다.');
        }
      }

      slots[sKey] = {
        day,
        period: periodNum,
        kind: parsed.kind,
        subject: parsed.subject,
        className: parsed.className,
        classroom: parsed.classroom,
        note: parsed.note,
        workAvailable: false,
      };

      cellMeta[sKey] = {
        status,
        needsConfirmation: needsConfirm,
        reasons,
        rawText: raw,
      };

      if (needsConfirm) {
        needsConfirmationCount += 1;
      }
    }
  }

  return {
    sourceType,
    extractionMode,
    sheetNames,
    selectedSheetName,
    tableOptions,
    selectedTableId,
    rawSourceRows: grid.slice(0, 25).map((r) => r.slice(0, Math.min(maxCols, 10))),
    periodCount,
    periodTimes,
    slots,
    cellMeta,
    warnings,
    needsConfirmationCount,
    recognitionFailedCount,
  };
}
