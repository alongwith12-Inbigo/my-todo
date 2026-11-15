import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckSquare,
  FileSpreadsheet,
  FileText,
  GraduationCap,
  Loader2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  ACADEMIC_CATEGORY_OPTIONS,
  buildAcademicDedupeKey,
  getKoreanSchoolYearForDateKey,
  TIMETABLE_IMPACT_SHORT_LABELS,
  validateAcademicEventDraft,
  type AcademicEventDraft,
} from '../../lib/academicCalendar';
import {
  markDuplicatesOnCandidates,
  parseAcademicScheduleFile,
  type AcademicImportCandidate,
  type AcademicImportPreview,
} from '../../lib/academicFileParser';
import { isValidDateInputString } from '../../lib/dateKst';
import type { BrowserOcrProgress } from '../../lib/ocrProcessor';
import {
  VALIDATION_LIMITS,
  type AcademicEventCategory,
  type AcademicEventRecord,
  type AcademicTimetableImpact,
} from '../../types/domain';
import { useAcademicEventData } from './AcademicEventDataContext';

interface AcademicImportModalProps {
  isOpen: boolean;
  defaultSchoolYear: number;
  existingEvents: AcademicEventRecord[];
  onClose: (importedCount?: number) => void;
}

type PreviewFilterMode = 'all' | 'needs_confirmation' | 'duplicate';

export function AcademicImportModal({
  isOpen,
  defaultSchoolYear,
  existingEvents,
  onClose,
}: AcademicImportModalProps) {
  const { batchImport } = useAcademicEventData();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AcademicImportPreview | null>(null);
  const [candidates, setCandidates] = useState<AcademicImportCandidate[]>([]);
  const [filterMode, setFilterMode] = useState<PreviewFilterMode>('all');
  const [showRawExcerpt, setShowRawExcerpt] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<BrowserOcrProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stats = useMemo(() => {
    let selectedCount = 0;
    let needsConfirmationCount = 0;
    let duplicateCount = 0;

    for (const c of candidates) {
      if (c.selected) selectedCount += 1;
      if (c.needsConfirmation) needsConfirmationCount += 1;
      if (c.isDuplicate) duplicateCount += 1;
    }

    return {
      total: candidates.length,
      selectedCount,
      needsConfirmationCount,
      duplicateCount,
    };
  }, [candidates]);

  const filteredCandidates = useMemo(() => {
    if (filterMode === 'needs_confirmation') {
      return candidates.filter((c) => c.needsConfirmation);
    }
    if (filterMode === 'duplicate') {
      return candidates.filter((c) => c.isDuplicate);
    }
    return candidates;
  }, [candidates, filterMode]);

  if (!isOpen) return null;

  async function runAnalyze(
    file: File,
    opts?: { sheetName?: string; pageNumber?: number },
  ) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAnalyzing(true);
    setOcrProgress(null);
    setError(null);

    try {
      const result = await parseAcademicScheduleFile(file, {
        sheetName: opts?.sheetName,
        pageNumber: opts?.pageNumber,
        existingEvents,
        fallbackSchoolYear: defaultSchoolYear,
        onProgress: setOcrProgress,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      setPreview(result);
      setCandidates(result.candidates);
      setFilterMode('all');
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error
          ? err.message
          : '학사일정 파일을 분석하지 못했습니다.',
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setAnalyzing(false);
        setOcrProgress(null);
      }
    }
  }

  function handleFileSelected(file: File | null) {
    if (!file) return;
    setSelectedFile(file);
    void runAnalyze(file);
  }

  function handleCancelAnalysis() {
    abortRef.current?.abort();
    setAnalyzing(false);
    setOcrProgress(null);
  }

  function updateCandidate(
    tempId: string,
    patch: Partial<AcademicImportCandidate>,
  ) {
    setCandidates((prev) => {
      const updated = prev.map((item) => {
        if (item.tempId !== tempId) return item;
        const next: AcademicImportCandidate = {
          ...item,
          ...patch,
        };
        if (next.startDate && (!next.endDate || next.endDate < next.startDate)) {
          next.endDate = next.startDate;
        }
        if (isValidDateInputString(next.startDate)) {
          next.schoolYear = getKoreanSchoolYearForDateKey(next.startDate);
        }
        const validDate =
          isValidDateInputString(next.startDate) &&
          isValidDateInputString(next.endDate) &&
          next.endDate >= next.startDate;
        const validTitle = next.title.trim().length > 0;
        next.needsConfirmation = !(validDate && validTitle);
        next.confirmationReasons = next.needsConfirmation
          ? [
              !validDate
                ? '시작일·종료일(YYYY-MM-DD)을 입력해 주세요.'
                : '일정명을 입력해 주세요.',
            ]
          : [];
        next.dedupeKey = validDate
          ? buildAcademicDedupeKey(next.startDate, next.endDate, next.title)
          : next.dedupeKey;
        return next;
      });
      return markDuplicatesOnCandidates(updated, existingEvents).map((rechecked) => {
        // Preserve explicit selection edits on non-duplicate / edited target row
        if (rechecked.tempId === tempId && patch.selected !== undefined) {
          return { ...rechecked, selected: patch.selected };
        }
        // Keep user's explicit checkboxes unless duplicate/needsConfirm rule triggered on initial load
        const prevMatch = updated.find((u) => u.tempId === rechecked.tempId);
        if (prevMatch && rechecked.tempId !== tempId) {
          return { ...rechecked, selected: prevMatch.selected };
        }
        return rechecked;
      });
    });
  }

  function removeCandidateRow(tempId: string) {
    setCandidates((prev) => prev.filter((item) => item.tempId !== tempId));
  }

  function handleSelectSafeOnly() {
    setCandidates((prev) =>
      prev.map((c) => ({
        ...c,
        selected: !c.needsConfirmation && !c.isDuplicate,
      })),
    );
  }

  function handleClearSelection() {
    setCandidates((prev) => prev.map((c) => ({ ...c, selected: false })));
  }

  async function handleSaveSelected() {
    if (!preview) return;
    setError(null);

    const selected = candidates.filter((c) => c.selected);
    if (selected.length === 0) {
      setError('저장할 학사일정을 1건 이상 선택해 주세요.');
      return;
    }

    const drafts: AcademicEventDraft[] = [];
    for (const c of selected) {
      const draft: AcademicEventDraft = {
        title: c.title.trim(),
        category: c.category,
        startDate: c.startDate.trim(),
        endDate: (c.endDate || c.startDate).trim(),
        startTime: c.startTime,
        endTime: c.endTime,
        location: c.location.trim(),
        schoolYear: isValidDateInputString(c.startDate)
          ? getKoreanSchoolYearForDateKey(c.startDate)
          : c.schoolYear,
        sourceType: preview.sourceType,
        sourceLabel: preview.sourceLabel,
        sourceText: c.sourceText,
        timetableImpact: c.timetableImpact,
        overrideDateKey: null,
      };
      const err = validateAcademicEventDraft(draft);
      if (err) {
        setError(`'${c.title || '미지정'}' 항목 오류: ${err}`);
        return;
      }
      drafts.push(draft);
    }

    setSaving(true);
    try {
      const res = await batchImport(drafts);
      onClose(res.createdCount);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '선택한 학사일정을 저장하지 못했습니다.',
      );
    } finally {
      setSaving(false);
    }
  }

  function handleResetModal() {
    abortRef.current?.abort();
    setSelectedFile(null);
    setPreview(null);
    setCandidates([]);
    setError(null);
    setShowRawExcerpt(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="academic-import-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-indigo-700" aria-hidden="true" />
              <h2
                id="academic-import-title"
                className="text-base font-bold text-slate-900"
              >
                학교 학사일정 파일 가져오기
              </h2>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              파일은 브라우저 안에서만 분석되며 원본 파일은 서버나 Firebase에 저장되지 않습니다.
            </p>
          </div>

          <button
            type="button"
            onClick={handleResetModal}
            aria-label="닫기"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* File Selector */}
          <div className="p-4 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                {selectedFile ? selectedFile.name : '학사일정 파일 선택'}
              </p>
              <p className="text-xs text-slate-500">
                지원 형식: PDF (.pdf), 엑셀 (.xlsx, .xls), 한글 (.hwpx), 이미지 (.png, .jpg, .jpeg) · 최대 15MB
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.xlsx,.xls,.hwpx,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  handleFileSelected(f);
                }}
                className="hidden"
              />
              <button
                type="button"
                disabled={analyzing}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{selectedFile ? '다른 파일 선택' : '파일 선택 및 분석'}</span>
              </button>
            </div>
          </div>

          {analyzing && (
            <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50/50 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs text-indigo-950">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-700 shrink-0" />
                <div>
                  <p className="font-semibold">
                    {ocrProgress
                      ? `${ocrProgress.status} (${Math.round(ocrProgress.progress)}%)`
                      : '문서 표와 학사일정 날짜를 분석하는 중입니다...'}
                  </p>
                  <p className="text-indigo-800/80 mt-0.5">
                    추출이 끝나면 저장 전 미리보기 표에서 모든 항목을 수정·선택할 수 있습니다.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelAnalysis}
                className="px-3 py-1.5 text-xs font-semibold text-indigo-900 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 cursor-pointer"
              >
                분석 취소
              </button>
            </div>
          )}

          {preview && !analyzing && (
            <div className="space-y-4">
              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="p-3.5 rounded-lg border border-amber-200 bg-amber-50/80 space-y-1 text-xs text-amber-950">
                  {preview.warnings.map((w, i) => (
                    <p key={i}>• {w}</p>
                  ))}
                </div>
              )}

              {/* Sheet / Page Switcher + Raw Excerpt Toggle */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {preview.sheetNames && preview.sheetNames.length > 1 && (
                    <label className="inline-flex items-center gap-1.5 text-slate-700">
                      <FileSpreadsheet className="w-3.5 h-3.5 text-slate-500" />
                      <span className="font-semibold">시트 선택:</span>
                      <select
                        value={preview.selectedSheetName ?? preview.sheetNames[0]}
                        onChange={(e) => {
                          if (selectedFile) {
                            void runAnalyze(selectedFile, { sheetName: e.target.value });
                          }
                        }}
                        className="px-2.5 py-1 border border-slate-200 rounded-md bg-white text-xs"
                      >
                        {preview.sheetNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {preview.extractionMode === 'pdf_ocr' &&
                    preview.pageCount &&
                    preview.pageCount > 1 && (
                      <label className="inline-flex items-center gap-1.5 text-slate-700">
                        <FileText className="w-3.5 h-3.5 text-slate-500" />
                        <span className="font-semibold">페이지:</span>
                        <select
                          value={preview.selectedPage ?? 1}
                          onChange={(e) => {
                            if (selectedFile) {
                              void runAnalyze(selectedFile, {
                                pageNumber: Number(e.target.value),
                              });
                            }
                          }}
                          className="px-2.5 py-1 border border-slate-200 rounded-md bg-white text-xs tabular-nums"
                        >
                          {Array.from({ length: preview.pageCount }, (_, i) => i + 1).map(
                            (p) => (
                              <option key={p} value={p}>
                                {p} / {preview.pageCount}페이지
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    )}

                  {preview.detectedSchoolYear && (
                    <span className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 font-semibold tabular-nums">
                      감지된 연도·학년도: {preview.detectedSchoolYear}
                    </span>
                  )}
                </div>

                {preview.rawTextExcerpt && (
                  <button
                    type="button"
                    onClick={() => setShowRawExcerpt((prev) => !prev)}
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
                  >
                    {showRawExcerpt ? '추출 원문 접기' : '추출 원문 텍스트 확인'}
                  </button>
                )}
              </div>

              {showRawExcerpt && preview.rawTextExcerpt && (
                <pre className="p-3 rounded-lg bg-slate-900 text-slate-100 text-[11px] leading-relaxed overflow-x-auto max-h-40 whitespace-pre-wrap">
                  {preview.rawTextExcerpt}
                </pre>
              )}

              {/* Filter & Bulk Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ['all', `전체 (${stats.total})`],
                      [
                        'needs_confirmation',
                        `확인 필요 (${stats.needsConfirmationCount})`,
                      ],
                      ['duplicate', `중복 (${stats.duplicateCount})`],
                    ] as [PreviewFilterMode, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setFilterMode(mode)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer tabular-nums ${
                        filterMode === mode
                          ? 'bg-indigo-700 text-white'
                          : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={handleSelectSafeOnly}
                    className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer"
                  >
                    <CheckSquare className="w-3.5 h-3.5 text-indigo-700" />
                    <span>정상 항목만 모두 선택</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    className="px-2.5 py-1 font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer"
                  >
                    선택 해제
                  </button>
                </div>
              </div>

              {/* Editable Review Table */}
              {candidates.length === 0 ? (
                <div className="py-10 text-center border border-slate-200 rounded-xl space-y-1.5">
                  <p className="text-sm font-semibold text-slate-800">
                    자동으로 추출된 학사일정 항목이 없습니다
                  </p>
                  <p className="text-xs text-slate-500">
                    다른 시트·페이지를 선택하거나 &lsquo;+ 직접 추가&rsquo;로 학사일정을 등록해 주세요.
                  </p>
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[820px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                        <th className="py-2.5 px-3 w-10 text-center">선택</th>
                        <th className="py-2.5 px-2 w-36">시작일</th>
                        <th className="py-2.5 px-2 w-36">종료일</th>
                        <th className="py-2.5 px-2 min-w-[200px]">학사일정명</th>
                        <th className="py-2.5 px-2 w-28">유형</th>
                        <th className="py-2.5 px-2 w-28">장소</th>
                        <th className="py-2.5 px-2 w-28">시간표 영향</th>
                        <th className="py-2.5 px-2 w-28">검토 상태</th>
                        <th className="py-2.5 px-2 w-10 text-center">제외</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredCandidates.map((cand) => (
                        <tr
                          key={cand.tempId}
                          className={
                            cand.isDuplicate
                              ? 'bg-slate-50/70'
                              : cand.needsConfirmation
                                ? 'bg-amber-50/40'
                                : 'bg-white'
                          }
                        >
                          <td className="py-2 px-3 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${cand.title} 저장 선택`}
                              checked={cand.selected}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  selected: e.target.checked,
                                })
                              }
                              className="rounded border-slate-300 text-indigo-700"
                            />
                          </td>

                          <td className="py-2 px-2">
                            <input
                              type="date"
                              aria-label={`${cand.title} 시작일`}
                              value={cand.startDate}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  startDate: e.target.value,
                                })
                              }
                              className={`w-full px-2 py-1 text-xs border rounded tabular-nums ${
                                !isValidDateInputString(cand.startDate)
                                  ? 'border-amber-400 bg-amber-50'
                                  : 'border-slate-200 bg-white'
                              }`}
                            />
                          </td>

                          <td className="py-2 px-2">
                            <input
                              type="date"
                              aria-label={`${cand.title} 종료일`}
                              value={cand.endDate}
                              min={cand.startDate || undefined}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  endDate: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded tabular-nums bg-white"
                            />
                          </td>

                          <td className="py-2 px-2 space-y-1">
                            <input
                              type="text"
                              aria-label="학사일정명"
                              value={cand.title}
                              maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  title: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded bg-white font-medium text-slate-900"
                            />
                            {cand.confirmationReasons.length > 0 && (
                              <p className="text-[11px] text-amber-800">
                                {cand.confirmationReasons[0]}
                              </p>
                            )}
                            {cand.isDuplicate && cand.duplicateReason && (
                              <p className="text-[11px] text-slate-500">
                                {cand.duplicateReason}
                              </p>
                            )}
                          </td>

                          <td className="py-2 px-2">
                            <select
                              aria-label="일정 유형"
                              value={cand.category}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  category: e.target
                                    .value as AcademicEventCategory,
                                })
                              }
                              className="w-full px-1.5 py-1 text-xs border border-slate-200 rounded bg-white"
                            >
                              {ACADEMIC_CATEGORY_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="py-2 px-2">
                            <input
                              type="text"
                              aria-label="장소"
                              value={cand.location}
                              maxLength={VALIDATION_LIMITS.LOCATION_MAX_LEN}
                              placeholder="장소"
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  location: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded bg-white"
                            />
                          </td>

                          <td className="py-2 px-2">
                            <select
                              aria-label="시간표 영향"
                              value={cand.timetableImpact}
                              onChange={(e) =>
                                updateCandidate(cand.tempId, {
                                  timetableImpact: e.target
                                    .value as AcademicTimetableImpact,
                                })
                              }
                              className="w-full px-1.5 py-1 text-xs border border-slate-200 rounded bg-white"
                            >
                              {(['none', 'needs_check'] as AcademicTimetableImpact[]).map(
                                (val) => (
                                  <option key={val} value={val}>
                                    {TIMETABLE_IMPACT_SHORT_LABELS[val]}
                                  </option>
                                ),
                              )}
                            </select>
                          </td>

                          <td className="py-2 px-2">
                            {cand.isDuplicate ? (
                              <span className="inline-block px-2 py-0.5 text-[11px] font-semibold rounded border bg-slate-100 text-slate-700 border-slate-200 whitespace-nowrap">
                                중복 제외됨
                              </span>
                            ) : cand.needsConfirmation ? (
                              <span className="inline-block px-2 py-0.5 text-[11px] font-semibold rounded border bg-amber-50 text-amber-900 border-amber-200 whitespace-nowrap">
                                확인 필요
                              </span>
                            ) : (
                              <span className="inline-block px-2 py-0.5 text-[11px] font-semibold rounded border bg-emerald-50 text-emerald-800 border-emerald-200 whitespace-nowrap">
                                준비됨
                              </span>
                            )}
                          </td>

                          <td className="py-2 px-2 text-center">
                            <button
                              type="button"
                              aria-label={`${cand.title} 제외`}
                              onClick={() => removeCandidateRow(cand.tempId)}
                              className="p-1 text-slate-400 hover:text-red-700 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-600 tabular-nums">
            {preview
              ? `총 ${stats.total}건 중 ${stats.selectedCount}건 선택됨 (중복 ${stats.duplicateCount}건 · 확인 필요 ${stats.needsConfirmationCount}건)`
              : '파일을 선택하면 학사일정 목록을 추출해 미리보기로 표시합니다.'}
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetModal}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              닫기
            </button>
            {preview && (
              <button
                type="button"
                disabled={saving || analyzing || stats.selectedCount === 0}
                onClick={() => void handleSaveSelected()}
                className="px-4 py-2 text-xs font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {saving
                  ? '저장 중...'
                  : `선택한 ${stats.selectedCount}건 학사일정 저장`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
