import type { BrowserOcrWordBox } from './ocrProcessor';
import { createDefaultPeriodTimes, makeSlotKey, TIMETABLE_WEEKDAYS } from './timetable';
import {
  detectPeriodFromLabel,
  detectWeekdayFromHeader,
  extractTimeRangeFromText,
  parseTimetableCellText,
  type TimetableImportCellMeta,
  type TimetableImportPreview,
} from './timetableGridParser';
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
 * Strictly honors Section 4 rules:
 * - Never fabricates weekday/period mappings when headers are unreadable.
 * - Marks unmapped/failed cells as recognition_failed (distinct from genuine empty cells).
 * - Never auto-inserts '공강' on blank cells and never enables workAvailable automatically.
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
    let failedCount = 0;

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
          status: 'recognition_failed',
          needsConfirmation: true,
          reasons: ['이미지에서 표 좌표를 추출하지 못했습니다.'],
          rawText: '',
        };
        failedCount += 1;
      }
    }
    warnings.push(
      '이미지에서 표 좌표 정보를 추출하지 못했습니다. 엑셀·한글(HWPX)·PDF 파일을 사용하거나 선명한 표 이미지를 업로드해 주세요.',
    );
    return {
      sourceType: 'ocr',
      extractionMode: 'image_ocr',
      rawSourceText: input.text,
      periodCount: 7,
      periodTimes,
      slots,
      cellMeta,
      warnings,
      needsConfirmationCount: failedCount,
      recognitionFailedCount: failedCount,
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
  const headerMissingAll = orderedColumns.length < 2;
  const headerBottomY =
    orderedColumns.length > 0
      ? Math.max(...orderedColumns.map((c) => c.centerY)) + 12
      : 0;

  if (headerMissingAll) {
    warnings.push(
      '이미지에서 요일(월~금) 열 머리글을 충분히 인식하지 못해 임의로 요일을 확정하지 않았습니다. 직접 확인하거나 문서 파일(엑셀·HWPX·PDF)을 업로드해 주세요.',
    );
  } else if (orderedColumns.length < 5) {
    const missing = TIMETABLE_WEEKDAYS.filter((w) => !dayColumns.has(w.day))
      .map((w) => w.short)
      .join(', ');
    warnings.push(
      `일부 요일 열(${missing})이 인식되지 않아 해당 요일은 '인식 실패'로 표시했습니다.`,
    );
  }

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

  // 2. Detect period rows (1교시..12교시)
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
  const rowMissingAll = rowAnchors.length === 0;
  if (rowMissingAll) {
    warnings.push(
      '이미지에서 교시 행(1교시, 2교시 등)을 찾지 못해 교시를 임의로 확정하지 않았습니다. 직접 확인해 주세요.',
    );
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

  const cellWords = new Map<string, { words: BrowserOcrWordBox[]; spanAlert: boolean }>();
  for (const word of sortedBodyWords) {
    if (headerMissingAll || rowMissingAll) continue;
    const cx = centerX(word);
    const cy = centerY(word);

    const col = colBounds.find((c) => cx >= c.minX && cx < c.maxX);
    const row = rowBounds.find((r) => cy >= r.minY && cy < r.maxY);
    if (!col || !row) continue;

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
  let recognitionFailedCount = 0;

  if ((input.confidence ?? 100) < 60) {
    warnings.push(
      `이미지 OCR 전체 신뢰도가 낮습니다(${Math.round(input.confidence ?? 0)}%). 흐리거나 기울어진 글자는 직접 수정해 주세요.`,
    );
  }

  for (const w of TIMETABLE_WEEKDAYS) {
    const hasCol = dayColumns.has(w.day);
    for (let p = 1; p <= periodCount; p++) {
      const key = makeSlotKey(w.day, p);
      const bucket = cellWords.get(key);

      if (headerMissingAll || !hasCol || rowMissingAll) {
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
          status: 'recognition_failed',
          needsConfirmation: true,
          reasons: [
            headerMissingAll
              ? '요일 열 머리글을 찾지 못해 인식에 실패했습니다.'
              : !hasCol
                ? `${w.short}요일 열을 이미지에서 찾지 못했습니다.`
                : '교시 행 위치를 찾지 못해 인식에 실패했습니다.',
          ],
          rawText: '',
        };
        needsConfirmationCount += 1;
        recognitionFailedCount += 1;
        continue;
      }

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
        cellMeta[key] = {
          status: 'empty',
          needsConfirmation: false,
          reasons: [],
          rawText: '',
        };
        continue;
      }

      const sorted = [...bucket.words].sort((a, b) => centerY(a) - centerY(b));
      const lines: BrowserOcrWordBox[][] = [];
      for (const word of sorted) {
        const lastLine = lines[lines.length - 1];
        if (lastLine && Math.abs(centerY(lastLine[0]) - centerY(word)) <= 14) {
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
      let status = parsed.status;
      let needsConfirm = parsed.needsConfirmation;

      if (bucket.spanAlert) {
        status = 'needs_confirmation';
        needsConfirm = true;
        reasons.push('셀이 옆 열까지 걸쳐 있어 병합 셀 또는 열 경계 오인식 여부를 확인해 주세요.');
      }
      if (avgConf < 65) {
        status = avgConf < 40 ? 'recognition_failed' : 'needs_confirmation';
        needsConfirm = true;
        reasons.push(`OCR 인식 신뢰도가 낮아(${Math.round(avgConf)}%) 글자 확인이 필요합니다.`);
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
        status,
        needsConfirmation: needsConfirm,
        reasons,
        rawText,
      };
      if (needsConfirm) needsConfirmationCount += 1;
      if (status === 'recognition_failed') recognitionFailedCount += 1;
    }
  }

  return {
    sourceType: 'ocr',
    extractionMode: 'image_ocr',
    rawSourceText: input.text,
    periodCount,
    periodTimes,
    slots,
    cellMeta,
    warnings,
    needsConfirmationCount,
    recognitionFailedCount,
  };
}
