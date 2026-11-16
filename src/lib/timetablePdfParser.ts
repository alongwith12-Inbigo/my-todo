import type { BrowserOcrProgress } from './ocrProcessor';
import { runInBrowserStructuredOcr } from './ocrProcessor';
import { createDefaultPeriodTimes, makeSlotKey, TIMETABLE_WEEKDAYS } from './timetable';
import {
  detectPeriodFromLabel,
  detectWeekdayFromHeader,
  extractTimeRangeFromText,
  parseTimetableCellText,
  type TimetableImportCellMeta,
  type TimetableImportPreview,
} from './timetableGridParser';
import { parseTimetableFromOcrData } from './timetableOcrParser';
import {
  VALIDATION_LIMITS,
  type TimetableSlot,
  type TimetableWeekday,
} from '../types/domain';

export interface PdfTextToken {
  text: string;
  x: number;
  topY: number;
  width: number;
  height: number;
}

export interface PdfExtractedPage {
  pageNumber: number;
  width: number;
  height: number;
  tokens: PdfTextToken[];
}

interface PdfHeaderAnchor {
  day: TimetableWeekday;
  centerX: number;
  centerY: number;
}

interface PdfRowAnchor {
  period: number;
  centerY: number;
  timeRange?: { startTime: string; endTime: string } | null;
}

function tokenCenterX(t: PdfTextToken): number {
  return t.x + t.width / 2;
}

function tokenCenterY(t: PdfTextToken): number {
  return t.topY + t.height / 2;
}

/**
 * Reconstructs weekly timetable grid from positioned PDF text tokens (text-based PDF).
 * Keeps strict coordinate alignment (row = period, col = 월~금) and separates clean empty
 * cells from recognition failures.
 */
export function parseTimetableFromPdfPageTokens(
  page: PdfExtractedPage,
  totalPages = 1,
): TimetableImportPreview {
  const tokens = page.tokens.filter((t) => t.text.trim().length > 0);
  const warnings: string[] = [];

  if (totalPages > 1) {
    warnings.push(
      `총 ${totalPages}페이지 중 ${page.pageNumber}페이지를 분석했습니다. 다른 페이지에 시간표가 있다면 페이지를 변경해 주세요.`,
    );
  }

  // Group text tokens into lines for raw side-by-side comparison
  const sortedForLines = [...tokens].sort((a, b) => a.topY - b.topY || a.x - b.x);
  const textLines: PdfTextToken[][] = [];
  for (const tok of sortedForLines) {
    const last = textLines[textLines.length - 1];
    if (last && Math.abs(last[0].topY - tok.topY) <= 6) {
      last.push(tok);
    } else {
      textLines.push([tok]);
    }
  }
  const rawSourceText = textLines
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((t) => t.text)
        .join(' '),
    )
    .join('\n');

  // 1. Find weekday header band (월~금)
  const headerCandidates: PdfHeaderAnchor[] = [];
  for (const tok of tokens) {
    const day = detectWeekdayFromHeader(tok.text);
    if (day) {
      headerCandidates.push({
        day,
        centerX: tokenCenterX(tok),
        centerY: tokenCenterY(tok),
      });
    }
  }

  headerCandidates.sort((a, b) => a.centerY - b.centerY);
  let bestBand: PdfHeaderAnchor[] = [];
  for (const anchor of headerCandidates) {
    const band = headerCandidates.filter((h) => Math.abs(h.centerY - anchor.centerY) <= 18);
    const uniqueDays = new Set(band.map((b) => b.day));
    if (uniqueDays.size > new Set(bestBand.map((b) => b.day)).size) {
      bestBand = band;
    }
  }

  const dayColumns = new Map<TimetableWeekday, PdfHeaderAnchor>();
  for (const h of bestBand.sort((a, b) => a.centerX - b.centerX)) {
    if (!dayColumns.has(h.day)) {
      dayColumns.set(h.day, h);
    }
  }

  const orderedColumns = Array.from(dayColumns.values()).sort(
    (a, b) => a.centerX - b.centerX,
  );
  const headerMissingAll = orderedColumns.length < 2;

  if (headerMissingAll) {
    warnings.push(
      'PDF에서 요일(월~금) 열 머리글을 명확히 찾지 못했습니다. 문서 표 형식을 확인해 주세요.',
    );
  } else if (orderedColumns.length < 5) {
    const missing = TIMETABLE_WEEKDAYS.filter((w) => !dayColumns.has(w.day))
      .map((w) => w.short)
      .join(', ');
    warnings.push(`일부 요일 열(${missing})이 인식되지 않았습니다.`);
  }

  const headerBottomY =
    orderedColumns.length > 0
      ? Math.max(...orderedColumns.map((c) => c.centerY)) + 8
      : 0;

  // Column bounds
  const avgColWidth =
    orderedColumns.length >= 2
      ? (orderedColumns[orderedColumns.length - 1].centerX - orderedColumns[0].centerX) /
        Math.max(1, orderedColumns.length - 1)
      : 90;
  const colBounds: { day: TimetableWeekday; minX: number; maxX: number }[] = [];
  for (let i = 0; i < orderedColumns.length; i++) {
    const curr = orderedColumns[i];
    const prev = orderedColumns[i - 1];
    const next = orderedColumns[i + 1];
    colBounds.push({
      day: curr.day,
      minX: prev ? (prev.centerX + curr.centerX) / 2 : curr.centerX - avgColWidth / 2,
      maxX: next ? (curr.centerX + next.centerX) / 2 : curr.centerX + avgColWidth / 2,
    });
  }

  // 2. Find period row anchors left of Monday column
  const leftAreaMaxX =
    colBounds.length > 0 ? colBounds[0].minX + 10 : page.width * 0.25;
  const bodyTokens = tokens
    .filter((t) => tokenCenterY(t) > headerBottomY)
    .sort((a, b) => tokenCenterY(a) - tokenCenterY(b));

  const rowAnchors: PdfRowAnchor[] = [];
  const seenPeriods = new Set<number>();

  for (const tok of bodyTokens) {
    if (tok.x > leftAreaMaxX) continue;
    const period = detectPeriodFromLabel(tok.text);
    if (period && !seenPeriods.has(period)) {
      // Avoid picking up footer page numbers at bottom margin far below previous periods
      const prevAnchor = rowAnchors[rowAnchors.length - 1];
      if (
        prevAnchor &&
        tokenCenterY(tok) - prevAnchor.centerY > 280 &&
        tokenCenterY(tok) > page.height * 0.88 &&
        !/교시|차시/.test(tok.text)
      ) {
        continue;
      }
      seenPeriods.add(period);
      rowAnchors.push({
        period,
        centerY: tokenCenterY(tok),
        timeRange: null,
      });
    }
  }

  // Extract time ranges near period rows on the left side
  for (const row of rowAnchors) {
    const nearLeft = bodyTokens.filter(
      (t) => t.x <= leftAreaMaxX + 25 && Math.abs(tokenCenterY(t) - row.centerY) <= 18,
    );
    const combined = nearLeft
      .sort((a, b) => a.x - b.x)
      .map((t) => t.text)
      .join(' ');
    const timeRange = extractTimeRangeFromText(combined);
    if (timeRange) {
      row.timeRange = timeRange;
    }
  }

  rowAnchors.sort((a, b) => a.centerY - b.centerY);

  let rowFallbackUsed = false;
  if (rowAnchors.length === 0 && !headerMissingAll) {
    rowFallbackUsed = true;
    warnings.push(
      '교시 행 번호를 찾지 못해 세로 위치 기준으로 임시 배치했습니다. 교시 번호를 확인해 주세요.',
    );
    const yBands: number[] = [];
    for (const tok of bodyTokens) {
      if (colBounds.length > 0 && tokenCenterX(tok) < colBounds[0].minX) continue;
      const cy = tokenCenterY(tok);
      if (!yBands.some((existingY) => Math.abs(existingY - cy) < 20)) {
        yBands.push(cy);
      }
    }
    yBands.sort((a, b) => a - b);
    yBands.slice(0, VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX).forEach((cy, idx) => {
      rowAnchors.push({ period: idx + 1, centerY: cy });
    });
  }

  const avgRowHeight =
    rowAnchors.length >= 2
      ? (rowAnchors[rowAnchors.length - 1].centerY - rowAnchors[0].centerY) /
        Math.max(1, rowAnchors.length - 1)
      : 45;
  const rowBounds: { period: number; minY: number; maxY: number }[] = [];
  for (let i = 0; i < rowAnchors.length; i++) {
    const curr = rowAnchors[i];
    const prev = rowAnchors[i - 1];
    const next = rowAnchors[i + 1];
    rowBounds.push({
      period: curr.period,
      minY: prev ? (prev.centerY + curr.centerY) / 2 : curr.centerY - avgRowHeight / 2,
      maxY: next ? (curr.centerY + next.centerY) / 2 : curr.centerY + avgRowHeight / 2,
    });
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

  // 3. Bucket tokens into (day, period) cells
  const cellTokens = new Map<string, { tokens: PdfTextToken[]; spanAlert: boolean }>();
  for (const tok of bodyTokens) {
    if (headerMissingAll || rowBounds.length === 0) continue;
    const cx = tokenCenterX(tok);
    const cy = tokenCenterY(tok);
    const col = colBounds.find((c) => cx >= c.minX && cx < c.maxX);
    const row = rowBounds.find((r) => cy >= r.minY && cy < r.maxY);
    if (!col || !row) continue;

    const key = makeSlotKey(col.day, row.period);
    const bucket = cellTokens.get(key) ?? { tokens: [], spanAlert: false };
    bucket.tokens.push(tok);
    if (tok.width > (col.maxX - col.minX) * 1.15) {
      bucket.spanAlert = true;
    }
    cellTokens.set(key, bucket);
  }

  const slots: Record<string, TimetableSlot> = {};
  const cellMeta: Record<string, TimetableImportCellMeta> = {};
  let needsConfirmationCount = 0;
  let recognitionFailedCount = 0;

  for (const w of TIMETABLE_WEEKDAYS) {
    const hasCol = dayColumns.has(w.day);
    for (let p = 1; p <= periodCount; p++) {
      const key = makeSlotKey(w.day, p);
      const bucket = cellTokens.get(key);

      if (headerMissingAll || !hasCol || rowAnchors.length === 0) {
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
              ? 'PDF에서 요일 열 구조를 찾지 못해 인식에 실패했습니다.'
              : !hasCol
                ? `${w.short}요일 열이 인식되지 않았습니다.`
                : '교시 행 구조를 찾지 못해 인식에 실패했습니다.',
          ],
          rawText: '',
        };
        needsConfirmationCount += 1;
        recognitionFailedCount += 1;
        continue;
      }

      if (!bucket || bucket.tokens.length === 0) {
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

      const sortedToks = [...bucket.tokens].sort((a, b) => a.topY - b.topY);
      const groupedLines: PdfTextToken[][] = [];
      for (const tok of sortedToks) {
        const last = groupedLines[groupedLines.length - 1];
        if (last && Math.abs(last[0].topY - tok.topY) <= 6) {
          last.push(tok);
        } else {
          groupedLines.push([tok]);
        }
      }
      const rawText = groupedLines
        .map((line) =>
          line
            .sort((a, b) => a.x - b.x)
            .map((t) => t.text)
            .join(' '),
        )
        .join('\n');

      const parsed = parseTimetableCellText(rawText);
      const reasons = [...parsed.reasons];
      let status = parsed.status;
      let needsConfirm = parsed.needsConfirmation;

      if (bucket.spanAlert) {
        status = 'needs_confirmation';
        needsConfirm = true;
        reasons.push('텍스트가 옆 요일 열까지 걸쳐 있어 병합 셀 여부를 확인해 주세요.');
      }
      if (rowFallbackUsed) {
        status = 'needs_confirmation';
        needsConfirm = true;
        reasons.push('교시 행 번호가 불명확해 세로 위치 기준으로 배치되었습니다.');
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
    }
  }

  return {
    sourceType: 'pdf',
    extractionMode: 'pdf_text',
    pageCount: totalPages,
    selectedPage: page.pageNumber,
    rawSourceText,
    periodCount,
    periodTimes,
    slots,
    cellMeta,
    warnings,
    needsConfirmationCount,
    recognitionFailedCount,
  };
}

let workerInitialized = false;

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && !workerInitialized) {
    const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    workerInitialized = true;
  }
  return pdfjs;
}

function isScannedPdfTokens(tokens: PdfTextToken[]): boolean {
  const meaningful = tokens.filter((t) => t.text.trim().length > 0);
  if (meaningful.length < 6) return true;
  const totalChars = meaningful.reduce((sum, t) => sum + t.text.trim().length, 0);
  return totalChars < 15;
}

export async function parseTimetableFromPdfBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: {
    pageNumber?: number;
    onProgress?: (progress: BrowserOcrProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<TimetableImportPreview> {
  const pdfjs = await getPdfJs();
  const dataCopy = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer.slice(0));

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

    const targetPageNum = Math.max(
      1,
      Math.min(pageCount, options.pageNumber ?? 1),
    );
    const page = await pdfDoc.getPage(targetPageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const tokens: PdfTextToken[] = [];
    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      const text = (item.str ?? '').trim();
      if (!text) continue;
      const tx = item.transform; // [a, b, c, d, x, y]
      const x = Number(tx?.[4] ?? 0);
      const yBottom = Number(tx?.[5] ?? 0);
      const height = Math.max(8, Number(item.height || Math.abs(tx?.[3] ?? 10)));
      const width = Math.max(4, Number(item.width ?? text.length * 6));
      const topY = viewport.height - yBottom - height;
      tokens.push({ text, x, topY, width, height });
    }

    if (!isScannedPdfTokens(tokens)) {
      return parseTimetableFromPdfPageTokens(
        {
          pageNumber: targetPageNum,
          width: viewport.width,
          height: viewport.height,
          tokens,
        },
        pageCount,
      );
    }

    // Scanned PDF fallback: render to canvas in browser and run structured OCR
    if (typeof document === 'undefined') {
      return {
        ...parseTimetableFromPdfPageTokens(
          {
            pageNumber: targetPageNum,
            width: viewport.width,
            height: viewport.height,
            tokens: [],
          },
          pageCount,
        ),
        extractionMode: 'pdf_ocr',
        warnings: [
          '텍스트 정보가 없는 스캔 PDF입니다. 브라우저 환경에서 OCR 인식이 필요합니다.',
        ],
      };
    }

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

    const previewDataUrl = canvas.toDataURL('image/png');
    const ocrRes = await runInBrowserStructuredOcr(blob, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
    const ocrPreview = parseTimetableFromOcrData({
      words: ocrRes.words,
      text: ocrRes.text,
      confidence: ocrRes.confidence,
    });

    return {
      ...ocrPreview,
      sourceType: 'pdf',
      extractionMode: 'pdf_ocr',
      pageCount,
      selectedPage: targetPageNum,
      originalPreviewImageUrl: previewDataUrl,
      warnings: [
        '스캔 이미지 형태의 PDF로 감지되어 OCR 표 인식을 실행했습니다. 표 구조가 불명확하거나 확인 필요로 표시된 칸은 원본 이미지를 보고 직접 확인해 주세요.',
        ...ocrPreview.warnings,
      ],
    };
  } finally {
    await loadingTask.destroy();
  }
}
