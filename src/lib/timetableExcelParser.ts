import * as XLSX from 'xlsx';
import {
  createDefaultPeriodTimes,
  makeSlotKey,
  TIMETABLE_WEEKDAYS,
} from './timetable';
import { sanitizeSingleLine } from './dateKst';
import {
  VALIDATION_LIMITS,
  type TimetablePeriodTime,
  type TimetableSlot,
  type TimetableSlotKind,
  type TimetableSourceType,
  type TimetableWeekday,
} from '../types/domain';

export interface TimetableImportCellMeta {
  needsConfirmation: boolean;
  reasons: string[];
  rawText: string;
}

export interface TimetableImportPreview {
  sourceType: Exclude<TimetableSourceType, 'manual'>;
  sheetNames?: string[];
  selectedSheetName?: string;
  periodCount: number;
  periodTimes: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableSlot>;
  cellMeta: Record<string, TimetableImportCellMeta>;
  warnings: string[];
  needsConfirmationCount: number;
}

const WEEKDAY_HEADER_PATTERNS: { day: TimetableWeekday; regex: RegExp }[] = [
  { day: 1, regex: /^(?:월(?:요일)?|mon(?:day)?)$/i },
  { day: 2, regex: /^(?:화(?:요일)?|tue(?:sday)?)$/i },
  { day: 3, regex: /^(?:수(?:요일)?|wed(?:nesday)?)$/i },
  { day: 4, regex: /^(?:목(?:요일)?|thu(?:rsday)?)$/i },
  { day: 5, regex: /^(?:금(?:요일)?|fri(?:day)?)$/i },
];

const FREE_KEYWORDS = /^(?:공강|빈\s*시간|빈시간|자체\s*공강|휴강|없음|-|—)$/;
const FIXED_DUTY_KEYWORDS = /(?:교직원\s*회의|회의|동아리|계발|자치|고정\s*업무|업무|당직|연수|상담|창체|보직)/;
const TIME_RANGE_REGEX =
  /([01]?\d|2[0-3]):([0-5]\d)\s*[~\-–—]\s*([01]?\d|2[0-3]):([0-5]\d)/;

export function detectWeekdayFromHeader(raw: string): TimetableWeekday | null {
  const cleaned = raw.replace(/\s+/g, '').replace(/[()[\]]/g, '');
  for (const item of WEEKDAY_HEADER_PATTERNS) {
    if (item.regex.test(cleaned)) {
      return item.day;
    }
  }
  return null;
}

export function detectPeriodFromLabel(raw: string): number | null {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned) return null;

  const gyoMatch = /^(\d{1,2})교시/.exec(cleaned);
  if (gyoMatch) {
    const num = Number(gyoMatch[1]);
    return num >= 1 && num <= VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX ? num : null;
  }

  const numOnly = /^(\d{1,2})(?:교시|차시|\.)?$/.exec(cleaned);
  if (numOnly) {
    const num = Number(numOnly[1]);
    return num >= 1 && num <= VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX ? num : null;
  }

  return null;
}

export function extractTimeRangeFromText(
  raw: string,
): { startTime: string; endTime: string } | null {
  const match = TIME_RANGE_REGEX.exec(raw);
  if (!match) return null;
  const startTime = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  const endTime = `${String(Number(match[3])).padStart(2, '0')}:${match[4]}`;
  if (endTime <= startTime) return null;
  return { startTime, endTime };
}

export function parseTimetableCellText(rawText: string): {
  kind: TimetableSlotKind;
  subject: string;
  className: string;
  classroom: string;
  note: string;
  workAvailable: boolean;
  needsConfirmation: boolean;
  reasons: string[];
} {
  const normalized = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();

  if (!normalized || FREE_KEYWORDS.test(normalized)) {
    return {
      kind: 'free',
      subject: FREE_KEYWORDS.test(normalized) && normalized !== '-' && normalized !== '—'
        ? '공강'
        : '',
      className: '',
      classroom: '',
      note: '',
      // Free periods MUST NEVER be auto-assumed as workable
      workAvailable: false,
      needsConfirmation: false,
      reasons: [],
    };
  }

  const lines = normalized
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tokens =
    lines.length > 1
      ? lines
      : normalized
          .split(/\s*[\/|,]\s*|\s{2,}/)
          .map((t) => t.trim())
          .filter(Boolean);

  let className = '';
  let classroom = '';
  const subjectParts: string[] = [];

  const classRegex =
    /^(?:\d학년\s*\d{1,2}반|\d{1,2}-\d{1,2}(?:반)?|\d-\d[가-힣]?|\d{1,2}반)$/;
  const roomRegex =
    /(?:\d{3,4}호|실$|관$|실\)|교무실|운동장|강당|도서관|시청각실|특별실)/;

  const workingTokens =
    tokens.length > 1 ? tokens : normalized.split(/\s+/).filter(Boolean);

  for (const token of workingTokens) {
    const cleanToken = token.replace(/[()[\]]/g, '').trim();
    if (!className && classRegex.test(cleanToken)) {
      className = sanitizeSingleLine(cleanToken, VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN);
    } else if (!classroom && roomRegex.test(cleanToken) && workingTokens.length > 1) {
      classroom = sanitizeSingleLine(cleanToken, VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN);
    } else {
      subjectParts.push(token);
    }
  }

  const subject = sanitizeSingleLine(
    subjectParts.join(' ') || normalized,
    VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN,
  );

  let kind: TimetableSlotKind = 'class';
  const reasons: string[] = [];
  let needsConfirmation = false;

  if (FIXED_DUTY_KEYWORDS.test(normalized)) {
    kind = 'fixed_duty';
    needsConfirmation = true;
    reasons.push('수업 외 고정 업무 또는 기타 일정인지 구분을 확인해 주세요.');
  } else if (subject.length <= 1 || /^[^가-힣a-zA-Z0-9]+$/.test(subject)) {
    needsConfirmation = true;
    reasons.push('인식된 내용이 불명확하여 직접 확인이 필요합니다.');
  }

  return {
    kind,
    subject,
    className,
    classroom,
    note: '',
    workAvailable: false,
    needsConfirmation,
    reasons,
  };
}

export interface ParseExcelOptions {
  sheetName?: string;
}

export function parseTimetableFromExcelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: ParseExcelOptions = {},
): TimetableImportPreview {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    throw new Error('엑셀 파일에 읽을 수 있는 시트가 없습니다.');
  }

  const selectedSheetName =
    options.sheetName && sheetNames.includes(options.sheetName)
      ? options.sheetName
      : sheetNames[0];
  const sheet = workbook.Sheets[selectedSheetName];
  if (!sheet) {
    throw new Error('선택한 시트를 읽을 수 없습니다.');
  }

  const ref = sheet['!ref'];
  if (!ref) {
    throw new Error('선택한 시트가 비어 있습니다.');
  }

  const range = XLSX.utils.decode_range(ref);
  const maxRows = Math.min(range.e.r + 1, 60);
  const maxCols = Math.min(range.e.c + 1, 20);

  const grid: string[][] = Array.from({ length: maxRows }, () =>
    Array.from({ length: maxCols }, () => ''),
  );
  const mergedCells = new Map<string, { masterRow: number; masterCol: number; spanRows: number; spanCols: number }>();

  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null) {
        grid[r][c] = String(cell.w ?? cell.v).trim();
      }
    }
  }

  const merges = sheet['!merges'] ?? [];
  for (const merge of merges) {
    const masterVal = grid[merge.s.r]?.[merge.s.c] ?? '';
    const spanRows = merge.e.r - merge.s.r + 1;
    const spanCols = merge.e.c - merge.s.c + 1;
    for (let r = merge.s.r; r <= Math.min(merge.e.r, maxRows - 1); r++) {
      for (let c = merge.s.c; c <= Math.min(merge.e.c, maxCols - 1); c++) {
        if (!grid[r][c] && masterVal) {
          grid[r][c] = masterVal;
        }
        if (spanRows > 1 || spanCols > 1) {
          mergedCells.set(`${r}_${c}`, {
            masterRow: merge.s.r,
            masterCol: merge.s.c,
            spanRows,
            spanCols,
          });
        }
      }
    }
  }

  const warnings: string[] = [];
  if (sheetNames.length > 1) {
    warnings.push(
      `총 ${sheetNames.length}개 시트 중 '${selectedSheetName}' 시트를 기준으로 분석했습니다.`,
    );
  }

  // Locate header row containing weekdays (Mon..Fri)
  let bestHeaderRow = -1;
  let bestDayCols = new Map<TimetableWeekday, number>();

  for (let r = 0; r < maxRows; r++) {
    const foundCols = new Map<TimetableWeekday, number>();
    for (let c = 0; c < maxCols; c++) {
      const day = detectWeekdayFromHeader(grid[r][c]);
      if (day && !foundCols.has(day)) {
        foundCols.set(day, c);
      }
    }
    if (foundCols.size > bestDayCols.size) {
      bestDayCols = foundCols;
      bestHeaderRow = r;
    }
  }

  if (bestHeaderRow === -1 || bestDayCols.size < 2) {
    warnings.push(
      '월~금 요일 머리글을 명확히 찾지 못해 기본 1~5열 매핑 또는 빈 미리보기를 생성했습니다. 요일과 교시 배치를 확인해 주세요.',
    );
  } else if (bestDayCols.size < 5) {
    const missing = TIMETABLE_WEEKDAYS.filter((w) => !bestDayCols.has(w.day))
      .map((w) => w.short)
      .join(', ');
    warnings.push(`일부 요일 머리글(${missing})이 인식되지 않았습니다. 빈 칸은 확인 후 입력해 주세요.`);
  }

  // Determine period column (left of earliest weekday column)
  const earliestDayCol =
    bestDayCols.size > 0 ? Math.min(...Array.from(bestDayCols.values())) : 1;
  const periodCandidateCols: number[] = [];
  for (let c = 0; c < earliestDayCol; c++) {
    periodCandidateCols.push(c);
  }
  if (periodCandidateCols.length === 0) {
    periodCandidateCols.push(0);
  }

  const rowToPeriod = new Map<number, number>();
  const extractedTimes = new Map<number, { startTime: string; endTime: string }>();

  const startDataRow = bestHeaderRow >= 0 ? bestHeaderRow + 1 : 0;
  for (let r = startDataRow; r < maxRows; r++) {
    let detectedPeriod: number | null = null;
    for (const c of periodCandidateCols) {
      const cellText = grid[r][c];
      if (!detectedPeriod) {
        detectedPeriod = detectPeriodFromLabel(cellText);
      }
      const timeRange = extractTimeRangeFromText(cellText);
      if (timeRange && detectedPeriod) {
        extractedTimes.set(detectedPeriod, timeRange);
      }
    }

    if (detectedPeriod && !Array.from(rowToPeriod.values()).includes(detectedPeriod)) {
      rowToPeriod.set(r, detectedPeriod);
      // Also check adjacent left columns for time string like "09:00~09:45"
      for (const c of periodCandidateCols) {
        const timeRange = extractTimeRangeFromText(grid[r][c]);
        if (timeRange && !extractedTimes.has(detectedPeriod)) {
          extractedTimes.set(detectedPeriod, timeRange);
        }
      }
    }
  }

  // Fallback sequential row mapping ONLY if header exists and no explicit period numbers found
  if (rowToPeriod.size === 0 && bestHeaderRow >= 0) {
    let nextPeriod = 1;
    for (let r = bestHeaderRow + 1; r < maxRows && nextPeriod <= 7; r++) {
      const hasAnyValue = Array.from(bestDayCols.values()).some((c) => Boolean(grid[r][c]));
      if (hasAnyValue) {
        rowToPeriod.set(r, nextPeriod);
        nextPeriod += 1;
      }
    }
    if (rowToPeriod.size > 0) {
      warnings.push('교시 번호 열이 불명확하여 위에서 아래 행 순서로 임시 배치했습니다. 각 교시 번호를 확인해 주세요.');
    }
  }

  const maxDetectedPeriod =
    rowToPeriod.size > 0 ? Math.max(...Array.from(rowToPeriod.values())) : 7;
  const periodCount = Math.max(1, Math.min(VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX, maxDetectedPeriod));
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

  for (const w of TIMETABLE_WEEKDAYS) {
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
      cellMeta[sKey] = {
        needsConfirmation: false,
        reasons: [],
        rawText: '',
      };
    }
  }

  for (const [rowIdx, periodNum] of rowToPeriod.entries()) {
    if (periodNum > periodCount) continue;
    for (const [day, colIdx] of bestDayCols.entries()) {
      const sKey = makeSlotKey(day, periodNum);
      const raw = grid[rowIdx]?.[colIdx] ?? '';
      const parsed = parseTimetableCellText(raw);
      const mergeInfo = mergedCells.get(`${rowIdx}_${colIdx}`);

      const reasons = [...parsed.reasons];
      let needsConfirm = parsed.needsConfirmation;

      if (mergeInfo) {
        needsConfirm = true;
        reasons.push(
          mergeInfo.spanCols > 1
            ? '가로로 병합된 셀입니다. 여러 요일에 걸친 일정인지 확인해 주세요.'
            : '세로로 병합된 셀입니다. 연강 수업 또는 공강 여부를 확인해 주세요.',
        );
      }

      if (bestDayCols.size < 5) {
        needsConfirm = true;
        if (!reasons.includes('요일 열 매핑을 확인해 주세요.')) {
          reasons.push('일부 요일 열이 불명확하여 매핑 확인이 필요합니다.');
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
    sourceType: 'excel',
    sheetNames,
    selectedSheetName,
    periodCount,
    periodTimes,
    slots,
    cellMeta,
    warnings,
    needsConfirmationCount,
  };
}
