import type { BrowserOcrWordBox } from './ocrProcessor';
import { createDefaultPeriodTimes, makeSlotKey, TIMETABLE_WEEKDAYS } from './timetable';
import {
  detectPeriodFromLabel,
  detectWeekdayFromHeader,
  extractTimeRangeFromText,
  parseTimetableCellText,
  type TimetableImportCellMeta,
  type TimetableImportPreview,
} from './timetableExcelParser';
import {
  VALIDATION_LIMITS,
  type TimetableSlot,
  type TimetableWeekday,
} from '../types/domain';

interface HeaderAnchor {
  day: TimetableWeekday;
  centerX: number;
  centerY: number;
}

interface RowAnchor {
  period: number;
  centerY: number;
  x1: number;
  timeRange?: { startTime: string; endTime: string } | null;
}

function centerX(word: BrowserOcrWordBox): number {
  return (word.bbox.x0 + word.bbox.x1) / 2;
}

function centerY(word: BrowserOcrWordBox): number {
  return (word.bbox.y0 + word.bbox.y1) / 2;
}

/**
 * Reconstructs weekly timetable grid from OCR word bounding boxes (rows = periods, cols = 월~금).
 * Explicitly flags uncertain alignment, low-confidence text, or wide multi-column spans
 * instead of silently guessing unclear cells.
 */
export function parseTimetableFromOcrData(input: {
  words: BrowserOcrWordBox[];
  text: string;
  confidence?: number;
}): TimetableImportPreview {
  const words = input.words.filter((w) => w.text.trim().length > 0);
  const warnings: string[] = [];

  if (words.length === 0) {
    const periodTimes = createDefaultPeriodTimes(7);
    const slots: Record<string, TimetableSlot> = {};
    const cellMeta: Record<string, TimetableImportCellMeta> = {};
    for (const w of TIMETABLE_WEEKDAYS) {
      for (let p = 1; p <= 7; p++) {
        const key = makeSlotKey(w.day, p);
        slots[key] = {
          day: w.day,
          period: p,
          kind: 'free',
          subject: '',
          className: '',
          classroom: '',
          note: '',
          workAvailable: false,
        };
        cellMeta[key] = {
          needsConfirmation: false,
          reasons: [],
          rawText: '',
        };
      }
    }
    warnings.push(
      '이미지에서 표 좌표 정보를 추출하지 못했습니다. 직접 입력하거나 더 선명한 캡처 이미지를 사용해 주세요.',
    );
    return {
      sourceType: 'ocr',
      periodCount: 7,
      periodTimes,
      slots,
      cellMeta,
      warnings,
      needsConfirmationCount: 0,
    };
  }

  // 1. Detect weekday column headers (월~금)
  const headerCandidates: HeaderAnchor[] = [];
  for (const word of words) {
    const day = detectWeekdayFromHeader(word.text);
    if (day) {
      headerCandidates.push({
        day,
        centerX: centerX(word),
        centerY: centerY(word),
      });
    }
  }

  // Group header candidates that lie along a roughly horizontal header band
  headerCandidates.sort((a, b) => a.centerY - b.centerY);
  let bestBand: HeaderAnchor[] = [];
  for (let i = 0; i < headerCandidates.length; i++) {
    const anchorY = headerCandidates[i].centerY;
    const band = headerCandidates.filter((h) => Math.abs(h.centerY - anchorY) <= 45);
    const uniqueDays = new Set(band.map((b) => b.day));
    if (uniqueDays.size > new Set(bestBand.map((b) => b.day)).size) {
      bestBand = band;
    }
  }

  const dayColumns = new Map<TimetableWeekday, HeaderAnchor>();
  for (const h of bestBand.sort((a, b) => a.centerX - b.centerX)) {
    if (!dayColumns.has(h.day)) {
      dayColumns.set(h.day, h);
    }
  }

  const orderedColumns = Array.from(dayColumns.values()).sort(
    (a, b) => a.centerX - b.centerX,
  );
  const headerBottomY =
    orderedColumns.length > 0
      ? Math.max(...orderedColumns.map((c) => c.centerY)) + 12
      : 0;

  if (orderedColumns.length < 2) {
    warnings.push(
      '이미지에서 요일(월~금) 열 머리글을 충분히 인식하지 못했습니다. 각 칸의 요일 배치를 확인해 주세요.',
    );
  } else if (orderedColumns.length < 5) {
    const missing = TIMETABLE_WEEKDAYS.filter((w) => !dayColumns.has(w.day))
      .map((w) => w.short)
      .join(', ');
    warnings.push(
      `일부 요일 열(${missing})을 찾지 못했습니다. 누락된 요일은 직접 확인해 주세요.`,
    );
  }

  // Compute column boundaries
  const colLeftX =
    orderedColumns.length > 0 ? orderedColumns[0].centerX - 70 : 0;
  const colBounds: { day: TimetableWeekday; minX: number; maxX: number; centerX: number }[] = [];
  for (let i = 0; i < orderedColumns.length; i++) {
    const curr = orderedColumns[i];
    const prev = orderedColumns[i - 1];
    const next = orderedColumns[i + 1];
    const avgColWidth =
      orderedColumns.length >= 2
        ? (orderedColumns[orderedColumns.length - 1].centerX - orderedColumns[0].centerX) /
          Math.max(1, orderedColumns.length - 1)
        : 120;
    const minX = prev ? (prev.centerX + curr.centerX) / 2 : curr.centerX - avgColWidth / 2;
    const maxX = next ? (curr.centerX + next.centerX) / 2 : curr.centerX + avgColWidth / 2;
    colBounds.push({ day: curr.day, minX, maxX, centerX: curr.centerX });
  }

  // 2. Detect period rows (1교시..12교시 or numbers on left side)
  const leftAreaMaxX = colBounds.length > 0 ? colBounds[0].minX + 15 : colLeftX + 120;
  const rowAnchors: RowAnchor[] = [];
  const seenPeriods = new Set<number>();

  const sortedBodyWords = words
    .filter((w) => centerY(w) > headerBottomY)
    .sort((a, b) => centerY(a) - centerY(b));

  for (const w of sortedBodyWords) {
    if (w.bbox.x0 > leftAreaMaxX) continue;
    const period = detectPeriodFromLabel(w.text);
    if (period && !seenPeriods.has(period)) {
      seenPeriods.add(period);
      rowAnchors.push({
        period,
        centerY: centerY(w),
        x1: w.bbox.x1,
        timeRange: null,
      });
    }
  }

  // Look for time ranges near left column row bands
  for (const row of rowAnchors) {
    const rowWords = sortedBodyWords.filter(
      (w) => w.bbox.x0 <= leftAreaMaxX + 40 && Math.abs(centerY(w) - row.centerY) <= 28,
    );
    const combinedLeft = rowWords.map((w) => w.text).join(' ');
    const timeRange = extractTimeRangeFromText(combinedLeft);
    if (timeRange) {
      row.timeRange = timeRange;
    }
  }

  rowAnchors.sort((a, b) => a.centerY - b.centerY);
  if (rowAnchors.length === 0) {
    warnings.push(
      '교시 행(1교시, 2교시 등)을 찾지 못해 텍스트 줄 순서 기준으로 임시 배치했습니다.',
    );
    // Fallback cluster distinct y bands for words inside day columns
    const yClusters: number[] = [];
    for (const w of sortedBodyWords) {
      if (colBounds.length > 0 && centerX(w) < colBounds[0].minX) continue;
      const cy = centerY(w);
      if (!yClusters.some((existingY) => Math.abs(existingY - cy) < 28)) {
        yClusters.push(cy);
      }
    }
    yClusters.sort((a, b) => a - b);
    yClusters.slice(0, 8).forEach((cy, idx) => {
      rowAnchors.push({
        period: idx + 1,
        centerY: cy,
        x1: leftAreaMaxX,
      });
    });
  }

  const rowBounds: { period: number; minY: number; maxY: number; centerY: number }[] = [];
  for (let i = 0; i < rowAnchors.length; i++) {
    const curr = rowAnchors[i];
    const prev = rowAnchors[i - 1];
    const next = rowAnchors[i + 1];
    const avgHeight =
      rowAnchors.length >= 2
        ? (rowAnchors[rowAnchors.length - 1].centerY - rowAnchors[0].centerY) /
          Math.max(1, rowAnchors.length - 1)
        : 60;
    const minY = prev ? (prev.centerY + curr.centerY) / 2 : curr.centerY - avgHeight / 2;
    const maxY = next ? (curr.centerY + next.centerY) / 2 : curr.centerY + avgHeight / 2;
    rowBounds.push({ period: curr.period, minY, maxY, centerY: curr.centerY });
  }

  const maxPeriod =
    rowAnchors.length > 0 ? Math.max(...rowAnchors.map((r) => r.period)) : 7;
  const periodCount = Math.max(
    1,
    Math.min(VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX, maxPeriod),
  );
  const periodTimes = createDefaultPeriodTimes(periodCount);

  for (const row of rowAnchors) {
    if (row.timeRange && periodTimes[String(row.period)]) {
      periodTimes[String(row.period)] = {
        ...periodTimes[String(row.period)],
        startTime: row.timeRange.startTime,
        endTime: row.timeRange.endTime,
      };
    }
  }

  // 3. Bucket OCR words into (day, period) cells
  const cellWords = new Map<string, { words: BrowserOcrWordBox[]; spanAlert: boolean }>();

  for (const word of sortedBodyWords) {
    if (orderedColumns.length === 0 || rowBounds.length === 0) continue;
    const cx = centerX(word);
    const cy = centerY(word);

    const col = colBounds.find((c) => cx >= c.minX && cx < c.maxX);
    const row = rowBounds.find((r) => cy >= r.minY && cy < r.maxY);
    if (!col || !row) continue;

    // Skip if this word itself is the weekday header or period number
    if (detectWeekdayFromHeader(word.text) && cy <= headerBottomY + 10) continue;

    const key = makeSlotKey(col.day, row.period);
    const bucket = cellWords.get(key) ?? { words: [], spanAlert: false };
    bucket.words.push(word);

    const colWidth = col.maxX - col.minX;
    if (word.bbox.x1 - word.bbox.x0 > colWidth * 1.15) {
      bucket.spanAlert = true;
    }
    cellWords.set(key, bucket);
  }

  const slots: Record<string, TimetableSlot> = {};
  const cellMeta: Record<string, TimetableImportCellMeta> = {};
  let needsConfirmationCount = 0;

  if ((input.confidence ?? 100) < 60) {
    warnings.push(
      `이미지 OCR 전체 신뢰도가 낮습니다(${Math.round(input.confidence ?? 0)}%). 흐리거나 기울어진 글자는 직접 수정해 주세요.`,
    );
  }

  for (const w of TIMETABLE_WEEKDAYS) {
    for (let p = 1; p <= periodCount; p++) {
      const key = makeSlotKey(w.day, p);
      const bucket = cellWords.get(key);

      if (!bucket || bucket.words.length === 0) {
        slots[key] = {
          day: w.day,
          period: p,
          kind: 'free',
          subject: '',
          className: '',
          classroom: '',
          note: '',
          workAvailable: false,
        };
        const missingCol = !dayColumns.has(w.day);
        const reasons: string[] = [];
        if (missingCol) {
          reasons.push(`${w.short}요일 열을 이미지에서 찾지 못해 확인이 필요합니다.`);
        }
        cellMeta[key] = {
          needsConfirmation: missingCol,
          reasons,
          rawText: '',
        };
        if (missingCol) needsConfirmationCount += 1;
        continue;
      }

      // Group bucket words into lines by y proximity, then sort left-to-right
      const sorted = [...bucket.words].sort((a, b) => centerY(a) - centerY(b));
      const lines: BrowserOcrWordBox[][] = [];
      for (const word of sorted) {
        const lastLine = lines[lines.length - 1];
        if (
          lastLine &&
          Math.abs(centerY(lastLine[0]) - centerY(word)) <= 14
        ) {
          lastLine.push(word);
        } else {
          lines.push([word]);
        }
      }
      const rawText = lines
        .map((line) =>
          line
            .sort((a, b) => a.bbox.x0 - b.bbox.x0)
            .map((item) => item.text)
            .join(' '),
        )
        .join('\n');

      const parsed = parseTimetableCellText(rawText);
      const avgConf =
        bucket.words.reduce((acc, item) => acc + item.confidence, 0) /
        bucket.words.length;

      const reasons = [...parsed.reasons];
      let needsConfirm = parsed.needsConfirmation;

      if (bucket.spanAlert) {
        needsConfirm = true;
        reasons.push('셀이 옆 열까지 걸쳐 있어 병합 셀 또는 열 경계 오인식 여부를 확인해 주세요.');
      }
      if (avgConf < 65) {
        needsConfirm = true;
        reasons.push(`OCR 인식 신뢰도가 낮아(${Math.round(avgConf)}%) 글자 확인이 필요합니다.`);
      }
      if (orderedColumns.length < 5) {
        needsConfirm = true;
        if (!reasons.includes('요일 열 매핑을 확인해 주세요.')) {
          reasons.push('요일 열 경계가 일부 불확실하므로 배치를 확인해 주세요.');
        }
      }

      slots[key] = {
        day: w.day,
        period: p,
        kind: parsed.kind,
        subject: parsed.subject,
        className: parsed.className,
        classroom: parsed.classroom,
        note: parsed.note,
        workAvailable: false,
      };
      cellMeta[key] = {
        needsConfirmation: needsConfirm,
        reasons,
        rawText,
      };
      if (needsConfirm) needsConfirmationCount += 1;
    }
  }

  return {
    sourceType: 'ocr',
    periodCount,
    periodTimes,
    slots,
    cellMeta,
    warnings,
    needsConfirmationCount,
  };
}
