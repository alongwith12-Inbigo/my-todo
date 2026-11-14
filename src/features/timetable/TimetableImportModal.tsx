import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Columns2,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Upload,
  X,
} from 'lucide-react';
import {
  runInBrowserStructuredOcr,
  validateOcrImageFile,
  type BrowserOcrProgress,
} from '../../lib/ocrProcessor';
import {
  makeSlotKey,
  SLOT_KIND_LABELS,
  TIMETABLE_WEEKDAYS,
} from '../../lib/timetable';
import {
  parseTimetableFromExcelBuffer,
  type TimetableImportPreview,
} from '../../lib/timetableExcelParser';
import {
  detectTimetableFileKind,
  type TimetableCellStatus,
} from '../../lib/timetableGridParser';
import {
  buildHwpxPreviewFromTables,
  parseTimetableFromHwpxBuffer,
  type HwpxExtractedTable,
} from '../../lib/timetableHwpxParser';
import { parseTimetableFromOcrData } from '../../lib/timetableOcrParser';
import { parseTimetableFromPdfBuffer } from '../../lib/timetablePdfParser';
import type { TimetableSlot, TimetableSlotKind } from '../../types/domain';
import { TimetableSlotEditorModal } from './TimetableSlotEditorModal';

interface TimetableImportModalProps {
  isOpen: boolean;
  hasExistingTimetable: boolean;
  existingTimetableName?: string;
  onClose: () => void;
  onApplyPreview: (
    preview: TimetableImportPreview,
    mode: 'overwrite_current' | 'create_new',
  ) => void;
}

const MAX_TIMETABLE_FILE_BYTES = 15 * 1024 * 1024;

function getExtractionModeBadge(mode: TimetableImportPreview['extractionMode']): string {
  switch (mode) {
    case 'excel':
      return '엑셀 표 직접 분석';
    case 'hwpx_xml':
      return '한글(HWPX) XML 표 분석';
    case 'pdf_text':
      return 'PDF 텍스트 좌표 분석';
    case 'pdf_ocr':
      return '스캔 PDF OCR 표 분석';
    case 'image_ocr':
      return '이미지 OCR 표 분석';
    default:
      return '시간표 분석';
  }
}

export function TimetableImportModal({
  isOpen,
  hasExistingTimetable,
  existingTimetableName,
  onClose,
  onApplyPreview,
}: TimetableImportModalProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<BrowserOcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TimetableImportPreview | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');

  const [excelBuffer, setExcelBuffer] = useState<ArrayBuffer | null>(null);
  const [hwpxTables, setHwpxTables] = useState<HwpxExtractedTable[] | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);

  const [compareOpen, setCompareOpen] = useState(true);
  const [editingSlot, setEditingSlot] = useState<TimetableSlot | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (uploadedImageUrl) {
        URL.revokeObjectURL(uploadedImageUrl);
      }
    };
  }, [uploadedImageUrl]);

  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    setError(null);
    setConfirmOverwrite(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handlePaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            void processFile(blob);
            break;
          }
        }
      }
    }
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  });

  if (!isOpen) return null;

  function clearSourceBuffers() {
    setExcelBuffer(null);
    setHwpxTables(null);
    setPdfBuffer(null);
    setUploadedImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  async function processFile(file: File) {
    setError(null);
    setConfirmOverwrite(false);
    const kind = detectTimetableFileKind(file.name, file.type);

    if (kind === 'legacy_hwp') {
      clearSourceBuffers();
      setPreview(null);
      setError(
        "구형 한글 파일(.hwp)은 직접 분석을 지원하지 않습니다. 한글 프로그램에서 'HWPX(*.hwpx)' 또는 'PDF'로 다시 저장한 후 업로드해 주세요.",
      );
      return;
    }

    if (kind === 'unsupported') {
      setError(
        '지원하지 않는 파일 형식입니다. 지원 형식: 엑셀(.xlsx, .xls) · 한글(.hwpx) · PDF(.pdf) · 이미지(PNG, JPG)',
      );
      return;
    }

    if (file.size > MAX_TIMETABLE_FILE_BYTES) {
      setError('시간표 파일 용량은 15MB 이하만 처리할 수 있습니다.');
      return;
    }

    setSelectedFileName(file.name);
    clearSourceBuffers();

    if (kind === 'excel') {
      setAnalyzing(true);
      setOcrProgress(null);
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseTimetableFromExcelBuffer(buffer);
        setExcelBuffer(buffer);
        setPreview(parsed);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : '엑셀 시간표 파일을 분석하지 못했습니다.',
        );
      } finally {
        setAnalyzing(false);
      }
      return;
    }

    if (kind === 'hwpx') {
      setAnalyzing(true);
      setOcrProgress(null);
      try {
        const buffer = await file.arrayBuffer();
        const { tables, preview: parsed } = await parseTimetableFromHwpxBuffer(buffer);
        setHwpxTables(tables);
        setPreview(parsed);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : '한글(HWPX) 시간표 문서를 분석하지 못했습니다.',
        );
      } finally {
        setAnalyzing(false);
      }
      return;
    }

    if (kind === 'pdf') {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setAnalyzing(true);
      setOcrProgress(null);
      try {
        const buffer = await file.arrayBuffer();
        const parsed = await parseTimetableFromPdfBuffer(buffer, {
          pageNumber: 1,
          signal: controller.signal,
          onProgress: setOcrProgress,
        });
        if (controller.signal.aborted) return;
        setPdfBuffer(buffer);
        setPreview(parsed);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : 'PDF 시간표 문서를 분석하지 못했습니다.',
        );
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setAnalyzing(false);
          setOcrProgress(null);
        }
      }
      return;
    }

    const imageErr = validateOcrImageFile(file);
    if (imageErr) {
      setError(imageErr);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setUploadedImageUrl(objectUrl);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAnalyzing(true);
    setOcrProgress({ status: 'OCR 엔진 준비 중', progress: 0 });

    try {
      const ocrResult = await runInBrowserStructuredOcr(file, {
        signal: controller.signal,
        onProgress: setOcrProgress,
      });
      if (controller.signal.aborted) return;
      const parsed = parseTimetableFromOcrData({
        words: ocrResult.words,
        text: ocrResult.text,
        confidence: ocrResult.confidence,
      });
      setPreview(parsed);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error
          ? err.message
          : '이미지에서 시간표를 인식하지 못했습니다.',
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setAnalyzing(false);
        setOcrProgress(null);
      }
    }
  }

  function handleSelectSheet(sheetName: string) {
    if (!excelBuffer) return;
    try {
      const parsed = parseTimetableFromExcelBuffer(excelBuffer, { sheetName });
      setPreview(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '시트를 전환하지 못했습니다.');
    }
  }

  function handleSelectHwpxTable(tableId: string) {
    if (!hwpxTables) return;
    try {
      const parsed = buildHwpxPreviewFromTables(hwpxTables, tableId);
      setPreview(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '표를 전환하지 못했습니다.');
    }
  }

  async function handleSelectPdfPage(pageNumber: number) {
    if (!pdfBuffer) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAnalyzing(true);
    setOcrProgress(null);
    setError(null);
    try {
      const parsed = await parseTimetableFromPdfBuffer(pdfBuffer, {
        pageNumber,
        signal: controller.signal,
        onProgress: setOcrProgress,
      });
      if (controller.signal.aborted) return;
      setPreview(parsed);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'PDF 페이지를 전환하지 못했습니다.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setAnalyzing(false);
        setOcrProgress(null);
      }
    }
  }

  function handleSaveSlotEdit(updated: TimetableSlot) {
    if (!preview) return;
    const key = makeSlotKey(updated.day, updated.period);
    setPreview((prev) => {
      if (!prev) return null;
      const nextMeta = { ...prev.cellMeta };
      const prevCellMeta = nextMeta[key];
      const wasNeedsConfirm = prevCellMeta?.needsConfirmation ?? false;
      const wasFailed = prevCellMeta?.status === 'recognition_failed';
      const nextStatus: TimetableCellStatus =
        updated.kind === 'free' && !updated.subject ? 'empty' : 'recognized';

      nextMeta[key] = {
        status: nextStatus,
        needsConfirmation: false,
        reasons: [],
        rawText: prevCellMeta?.rawText ?? '',
      };

      return {
        ...prev,
        slots: {
          ...prev.slots,
          [key]: updated,
        },
        cellMeta: nextMeta,
        needsConfirmationCount: Math.max(
          0,
          prev.needsConfirmationCount - (wasNeedsConfirm ? 1 : 0),
        ),
        recognitionFailedCount: Math.max(
          0,
          prev.recognitionFailedCount - (wasFailed ? 1 : 0),
        ),
      };
    });
  }

  function handleApply(mode: 'overwrite_current' | 'create_new') {
    if (!preview) return;
    if (mode === 'overwrite_current' && hasExistingTimetable && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    onApplyPreview(preview, mode);
    onClose();
  }

  const comparisonImageUrl = uploadedImageUrl || preview?.originalPreviewImageUrl || null;
  const hasComparisonSource = Boolean(
    comparisonImageUrl ||
      (preview?.rawSourceRows && preview.rawSourceRows.length > 0) ||
      preview?.rawSourceText,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-timetable-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2
              id="import-timetable-title"
              className="text-base font-bold text-slate-900"
            >
              시간표 파일 가져오기
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              파일 선택 → 표 분석 → 시간표 미리보기 → 수정 → 저장 순으로 진행되며,
              원본 파일은 서버에 저장하지 않습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Step 1: Drop / File Picker */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) void processFile(dropped);
            }}
            className="border-2 border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/60 flex flex-col sm:flex-row items-center justify-between gap-4"
          >
            <div className="space-y-1.5 text-center sm:text-left">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs font-semibold text-slate-800">
                <span className="inline-flex items-center gap-1 text-teal-800">
                  <FileSpreadsheet className="w-4 h-4" />
                  엑셀 (.xlsx, .xls)
                </span>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-1 text-slate-800">
                  <FileText className="w-4 h-4 text-teal-700" />
                  한글 HWPX (.hwpx)
                </span>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-1 text-slate-800">
                  <FileText className="w-4 h-4 text-slate-600" />
                  PDF (.pdf)
                </span>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-1 text-slate-700">
                  <ImageIcon className="w-4 h-4" />
                  이미지 (PNG, JPG · Ctrl+V 가능)
                </span>
              </div>
              <p className="text-xs text-slate-600 font-medium">
                지원 형식: 엑셀 · 한글(HWPX) · PDF · 이미지
                {selectedFileName && (
                  <span className="ml-2 text-teal-800">
                    (선택된 파일: {selectedFileName})
                  </span>
                )}
              </p>
              <p className="text-[11px] text-slate-500">
                구형 .hwp 파일은 한글에서 HWPX 또는 PDF로 다시 저장한 뒤 올려 주세요.
                빈 칸에는 임의로 문구를 채우지 않으며 확인이 필요한 칸만 별도 표시합니다.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.hwpx,.pdf,.hwp,image/png,image/jpeg,image/webp,image/bmp"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) void processFile(picked);
                  e.target.value = '';
                }}
                className="hidden"
              />
              <button
                type="button"
                disabled={analyzing}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>파일 선택</span>
              </button>
            </div>
          </div>

          {analyzing && (
            <div className="p-4 rounded-xl border border-teal-200 bg-teal-50/60 flex items-center justify-between gap-4">
              <div className="space-y-1 flex-1">
                <p className="text-xs font-semibold text-teal-900">
                  {ocrProgress
                    ? `${ocrProgress.status} (${ocrProgress.progress}%)`
                    : '문서 표 구조와 시간표를 분석하고 있습니다...'}
                </p>
                {ocrProgress && (
                  <div className="h-1.5 w-full bg-teal-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-teal-700 transition-all"
                      style={{ width: `${ocrProgress.progress}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
              >
                분석 취소
              </button>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 leading-relaxed"
            >
              {error}
            </div>
          )}

          {/* Step 2 & 3: Preview & Side-by-Side Comparison */}
          {preview && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-900">
                    <CheckCircle2 className="w-4 h-4 text-teal-700" />
                    주간 시간표 미리보기
                  </span>
                  <span className="px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md">
                    {getExtractionModeBadge(preview.extractionMode)}
                  </span>
                  {preview.recognitionFailedCount > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold bg-red-50 text-red-900 border border-red-200 rounded-md tabular-nums">
                      <AlertTriangle className="w-3 h-3 text-red-700" />
                      인식 실패 {preview.recognitionFailedCount}칸
                    </span>
                  )}
                  {preview.needsConfirmationCount > 0 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold bg-amber-50 text-amber-900 border border-amber-200 rounded-md tabular-nums">
                      <AlertTriangle className="w-3 h-3 text-amber-700" />
                      확인 필요 {preview.needsConfirmationCount}칸
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-teal-800">
                      모든 칸이 정상 배치되었습니다 (클릭하여 수정 가능)
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {preview.sheetNames && preview.sheetNames.length > 1 && (
                    <div className="flex items-center gap-1.5">
                      <label
                        htmlFor="excel-sheet-select"
                        className="text-xs font-medium text-slate-600"
                      >
                        시트 선택:
                      </label>
                      <select
                        id="excel-sheet-select"
                        value={preview.selectedSheetName}
                        onChange={(e) => handleSelectSheet(e.target.value)}
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-md bg-white"
                      >
                        {preview.sheetNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {preview.tableOptions && preview.tableOptions.length > 1 && (
                    <div className="flex items-center gap-1.5">
                      <label
                        htmlFor="hwpx-table-select"
                        className="text-xs font-medium text-slate-600"
                      >
                        표 선택:
                      </label>
                      <select
                        id="hwpx-table-select"
                        value={preview.selectedTableId}
                        onChange={(e) => handleSelectHwpxTable(e.target.value)}
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-md bg-white"
                      >
                        {preview.tableOptions.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {preview.pageCount && preview.pageCount > 1 && (
                    <div className="flex items-center gap-1.5">
                      <label
                        htmlFor="pdf-page-select"
                        className="text-xs font-medium text-slate-600"
                      >
                        페이지 선택:
                      </label>
                      <select
                        id="pdf-page-select"
                        value={preview.selectedPage ?? 1}
                        onChange={(e) =>
                          void handleSelectPdfPage(Number(e.target.value))
                        }
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-md bg-white tabular-nums"
                      >
                        {Array.from(
                          { length: preview.pageCount },
                          (_, i) => i + 1,
                        ).map((pageNum) => (
                          <option key={pageNum} value={pageNum}>
                            {pageNum} / {preview.pageCount}페이지
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {hasComparisonSource && (
                    <button
                      type="button"
                      onClick={() => setCompareOpen((prev) => !prev)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Columns2 className="w-3.5 h-3.5 text-slate-500" />
                      <span>{compareOpen ? '원본 비교 닫기' : '원본 비교 보기'}</span>
                    </button>
                  )}
                </div>
              </div>

              {preview.warnings.length > 0 && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-900">
                      · {w}
                    </p>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-teal-600 inline-block" />
                  인식됨(수업)
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm border border-slate-300 bg-white inline-block" />
                  빈 칸(수업 없음)
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-amber-400 inline-block" />
                  확인 필요
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />
                  인식 실패
                </span>
              </div>

              <div
                className={
                  compareOpen && hasComparisonSource
                    ? 'grid grid-cols-1 lg:grid-cols-12 gap-4 items-start'
                    : 'block'
                }
              >
                {compareOpen && hasComparisonSource && (
                  <div className="lg:col-span-5 border border-slate-200 rounded-xl overflow-hidden bg-slate-50/70">
                    <div className="px-3.5 py-2.5 border-b border-slate-200 bg-slate-100/70 flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800">
                        원본 비교 ({selectedFileName || '첨부 파일'})
                      </span>
                      <span className="text-[11px] text-slate-500">
                        대조 후 오른쪽 칸 수정
                      </span>
                    </div>
                    <div className="p-3 max-h-[460px] overflow-auto">
                      {comparisonImageUrl ? (
                        <img
                          src={comparisonImageUrl}
                          alt="업로드한 원본 시간표"
                          className="w-full h-auto rounded-lg border border-slate-200 bg-white object-contain"
                        />
                      ) : preview.rawSourceRows && preview.rawSourceRows.length > 0 ? (
                        <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
                          <table className="w-full text-left border-collapse text-[11px]">
                            <tbody className="divide-y divide-slate-200">
                              {preview.rawSourceRows.map((row, rIdx) => (
                                <tr key={rIdx} className="divide-x divide-slate-200">
                                  {row.map((cell, cIdx) => (
                                    <td
                                      key={cIdx}
                                      className={`p-1.5 align-top whitespace-pre-line min-w-[56px] ${
                                        rIdx === 0
                                          ? 'bg-slate-50 font-semibold text-slate-700'
                                          : 'text-slate-700'
                                      }`}
                                    >
                                      {cell || (
                                        <span className="text-slate-300">-</span>
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <pre className="text-[11px] text-slate-700 whitespace-pre-wrap bg-white p-3 rounded-lg border border-slate-200 leading-relaxed">
                          {preview.rawSourceText}
                        </pre>
                      )}
                    </div>
                  </div>
                )}

                <div
                  className={
                    compareOpen && hasComparisonSource
                      ? 'lg:col-span-7 border border-slate-200 rounded-xl overflow-x-auto'
                      : 'border border-slate-200 rounded-xl overflow-x-auto'
                  }
                >
                  <table className="w-full text-left border-collapse min-w-[600px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                        <th className="py-2.5 px-3 w-28 border-r border-slate-200">
                          교시 · 시각
                        </th>
                        {TIMETABLE_WEEKDAYS.map((w) => (
                          <th
                            key={w.day}
                            className="py-2.5 px-3 text-center border-r last:border-r-0 border-slate-200"
                          >
                            {w.short}요일
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-xs">
                      {Array.from(
                        { length: preview.periodCount },
                        (_, i) => i + 1,
                      ).map((period) => {
                        const pt = preview.periodTimes[String(period)];
                        return (
                          <tr key={period}>
                            <td className="p-2.5 bg-slate-50/70 border-r border-slate-200 align-top">
                              <p className="font-bold text-slate-900">
                                {pt?.label ?? `${period}교시`}
                              </p>
                              {pt && (
                                <p className="text-[11px] text-slate-500 tabular-nums">
                                  {pt.startTime}~{pt.endTime}
                                </p>
                              )}
                            </td>
                            {TIMETABLE_WEEKDAYS.map((w) => {
                              const key = makeSlotKey(w.day, period);
                              const slot = preview.slots[key];
                              const meta = preview.cellMeta[key];
                              const status = meta?.status;
                              const isFailed = status === 'recognition_failed';
                              const needsConfirm =
                                !isFailed && (meta?.needsConfirmation ?? false);
                              const isEmpty =
                                !isFailed &&
                                !needsConfirm &&
                                (status === 'empty' ||
                                  (slot.kind === 'free' &&
                                    !slot.subject &&
                                    !slot.className));

                              const primaryTitle = isFailed
                                ? slot.subject || slot.className || '인식 실패'
                                : isEmpty
                                  ? '—'
                                  : slot.subject ||
                                    (slot.kind === 'class' && slot.className
                                      ? slot.className
                                      : SLOT_KIND_LABELS[
                                          slot.kind as TimetableSlotKind
                                        ]);

                              const secondaryLine = isEmpty
                                ? '수업 없음'
                                : [
                                    SLOT_KIND_LABELS[
                                      slot.kind as TimetableSlotKind
                                    ],
                                    slot.subject ? slot.className : '',
                                    slot.classroom,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ');

                              return (
                                <td
                                  key={key}
                                  className={`p-1.5 border-r last:border-r-0 border-slate-200 align-top ${
                                    isFailed
                                      ? 'bg-red-50/40'
                                      : needsConfirm
                                        ? 'bg-amber-50/60'
                                        : 'bg-white'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => setEditingSlot(slot)}
                                    className={`w-full text-left p-2 rounded-lg border transition-colors min-h-[60px] cursor-pointer ${
                                      isFailed
                                        ? 'border-red-300 bg-red-50/50 hover:border-red-500'
                                        : needsConfirm
                                          ? 'border-amber-300 hover:border-amber-500'
                                          : slot.kind === 'class'
                                            ? 'border-teal-200 bg-teal-50/40 hover:bg-teal-50'
                                            : slot.kind === 'fixed_duty'
                                              ? 'border-slate-300 bg-slate-100/70 hover:bg-slate-100'
                                              : 'border-slate-200 hover:bg-slate-50'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span
                                        className={`font-semibold truncate ${
                                          isFailed
                                            ? 'text-red-900'
                                            : isEmpty
                                              ? 'text-slate-400'
                                              : 'text-slate-900'
                                        }`}
                                      >
                                        {primaryTitle}
                                      </span>
                                      {isFailed && (
                                        <span className="text-[10px] font-bold text-red-700 shrink-0">
                                          인식 실패
                                        </span>
                                      )}
                                      {needsConfirm && (
                                        <span className="text-[10px] font-bold text-amber-800 shrink-0">
                                          확인 필요
                                        </span>
                                      )}
                                    </div>
                                    <p
                                      className={`text-[11px] truncate mt-0.5 ${
                                        isEmpty
                                          ? 'text-slate-400'
                                          : 'text-slate-500'
                                      }`}
                                    >
                                      {secondaryLine}
                                    </p>
                                    {(isFailed || needsConfirm) &&
                                      meta?.reasons[0] && (
                                        <p
                                          className={`text-[10px] mt-1 line-clamp-2 ${
                                            isFailed
                                              ? 'text-red-800'
                                              : 'text-amber-800'
                                          }`}
                                        >
                                          {meta.reasons[0]}
                                        </p>
                                      )}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {confirmOverwrite && hasExistingTimetable && (
                <div className="p-3.5 rounded-lg border border-amber-300 bg-amber-50 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-amber-950 space-y-0.5">
                    <p className="font-bold">
                      현재 선택된 &apos;{existingTimetableName || '기존 시간표'}&apos;
                      내용을 가져온 시간표로 덮어쓰시겠습니까?
                    </p>
                    <p className="text-amber-800">
                      기존 시간표를 유지하려면 오른쪽 &apos;새 시간표로 불러오기&apos;를
                      선택하세요.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmOverwrite(false)}
                      className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md cursor-pointer"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onApplyPreview(preview, 'overwrite_current');
                        onClose();
                      }}
                      className="px-3.5 py-1.5 text-xs font-semibold bg-amber-700 text-white rounded-md hover:bg-amber-800 cursor-pointer"
                    >
                      덮어쓰기 확인
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70">
          <p className="text-[11px] text-slate-500">
            미리보기에서 각 칸을 눌러 과목·학급·교실과 공강 업무 가능 여부를 먼저
            수정할 수 있습니다.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              닫기
            </button>
            {preview && (
              <>
                {hasExistingTimetable && (
                  <button
                    type="button"
                    onClick={() => handleApply('overwrite_current')}
                    className="px-3.5 py-2 text-xs font-semibold text-teal-800 bg-white border border-teal-300 rounded-lg hover:bg-teal-50 cursor-pointer"
                  >
                    현재 시간표에 덮어쓰기
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleApply('create_new')}
                  className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 cursor-pointer"
                >
                  {hasExistingTimetable
                    ? '새 학기 시간표로 불러오기'
                    : '편집기에 적용'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <TimetableSlotEditorModal
        isOpen={Boolean(editingSlot)}
        slot={editingSlot}
        periodLabel={
          editingSlot
            ? preview?.periodTimes[String(editingSlot.period)]?.label ??
              `${editingSlot.period}교시`
            : ''
        }
        periodTimeRange={
          editingSlot && preview?.periodTimes[String(editingSlot.period)]
            ? `${preview.periodTimes[String(editingSlot.period)].startTime} ~ ${
                preview.periodTimes[String(editingSlot.period)].endTime
              }`
            : ''
        }
        onClose={() => setEditingSlot(null)}
        onSave={handleSaveSlotEdit}
      />
    </div>
  );
}
