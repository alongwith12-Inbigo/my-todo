import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { Timestamp } from 'firebase/firestore';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Eraser,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  ScanText,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  formatKstTodayHeader,
  parseKstAllDayRange,
  parseKstDateInput,
  parseKstDateTimeInput,
} from '../../lib/dateKst';
import {
  parseSchoolNoticeText,
  recomputeDuplicateWarnings,
  type ImportCandidate,
  type ImportSourceMode,
} from '../../lib/importParser';
import {
  isBrowserOcrSupported,
  runInBrowserOcr,
  validateOcrImageFile,
  type BrowserOcrProgress,
} from '../../lib/ocrProcessor';
import { useEventData } from '../calendar/EventDataContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { useTaskData } from '../tasks/TaskDataContext';
import {
  ImportCandidateCard,
  type CandidateSaveState,
} from './ImportCandidateCard';

interface ImportViewProps {
  now: Date;
  todayKey: string;
  onOpenTask: (taskId: string) => void;
  onOpenCalendar: (eventId?: string) => void;
}

export function ImportView({
  now,
  onOpenTask,
  onOpenCalendar,
}: ImportViewProps) {
  const { briefingTasks, createNewTask } = useTaskData();
  const { events, createNewEvent } = useEventData();

  const [inputMode, setInputMode] = useState<ImportSourceMode>('text');

  // Text paste state (local memory only, never auto-saved to Firestore)
  const [rawText, setRawText] = useState('');
  const [showTextPreview, setShowTextPreview] = useState(false);

  // Image + Browser OCR state (local memory only, never uploaded to server)
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<BrowserOcrProgress | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrLowQuality, setOcrLowQuality] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrEditedText, setOcrEditedText] = useState('');

  // Extraction & candidate review state
  const [analysisMode, setAnalysisMode] = useState<ImportSourceMode | null>(null);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [unparsedLines, setUnparsedLines] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, CandidateSaveState>>(
    {},
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [batchSummary, setBatchSummary] = useState<{
    succeededTasks: number;
    succeededEvents: number;
    failedCount: number;
  } | null>(null);

  const ocrAbortRef = useRef<AbortController | null>(null);
  const submitLockRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const ocrSupported = useMemo(() => isBrowserOcrSupported(), []);

  // Cleanup object URL and any active OCR worker on unmount
  useEffect(() => {
    return () => {
      ocrAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  const activeTextLineCount = useMemo(() => {
    if (!rawText.trim()) return 0;
    return rawText.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  }, [rawText]);

  const taskCandidates = useMemo(
    () => candidates.filter((c) => c.kind === 'task'),
    [candidates],
  );
  const eventCandidates = useMemo(
    () => candidates.filter((c) => c.kind === 'event'),
    [candidates],
  );

  const pendingCandidates = useMemo(
    () => candidates.filter((c) => saveStates[c.id]?.status !== 'saved'),
    [candidates, saveStates],
  );
  const selectedPendingCount = useMemo(
    () => pendingCandidates.filter((c) => c.selected).length,
    [pendingCandidates],
  );
  const confirmationNeededCount = useMemo(
    () =>
      pendingCandidates.filter(
        (c) => c.selected && (c.needsConfirmation || c.confirmationReasons.length > 0),
      ).length,
    [pendingCandidates],
  );

  function resetCandidatesState() {
    setCandidates([]);
    setUnparsedLines([]);
    setAnalysisMode(null);
    setParseError(null);
    setSaveStates({});
    setBatchSummary(null);
  }

  function handleClearTextInput() {
    setRawText('');
    setShowTextPreview(false);
    setParseError(null);
  }

  function handleSelectImageFile(file: File | null) {
    if (!file) return;
    const err = validateOcrImageFile(file);
    if (err) {
      setOcrError(err);
      return;
    }

    ocrAbortRef.current?.abort();
    setOcrRunning(false);
    setOcrProgress(null);
    setOcrConfidence(null);
    setOcrLowQuality(false);
    setOcrError(null);

    const nextUrl = URL.createObjectURL(file);
    setImageFile(file);
    setImagePreviewUrl(nextUrl);
  }

  function handleClearImage() {
    ocrAbortRef.current?.abort();
    setOcrRunning(false);
    setOcrProgress(null);
    setOcrConfidence(null);
    setOcrLowQuality(false);
    setOcrError(null);
    setImageFile(null);
    setImagePreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handleImageDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0] ?? null;
    handleSelectImageFile(file);
  }

  function handleImagePaste(e: ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          handleSelectImageFile(blob);
          return;
        }
      }
    }
  }

  async function handleRunOcr() {
    if (!imageFile || ocrRunning) return;
    setOcrError(null);
    setOcrLowQuality(false);
    setOcrConfidence(null);
    setOcrProgress({ status: 'OCR 엔진 초기화 중', progress: 0 });
    setOcrRunning(true);

    const controller = new AbortController();
    ocrAbortRef.current = controller;

    try {
      const result = await runInBrowserOcr(imageFile, {
        signal: controller.signal,
        onProgress: setOcrProgress,
      });
      setOcrEditedText(result.text);
      setOcrConfidence(Math.round(result.confidence));
      setOcrLowQuality(result.lowConfidence);
      if (!result.text) {
        setOcrError(
          '이미지에서 글자를 충분히 인식하지 못했습니다. 왼쪽 이미지를 보며 아래 칸에 텍스트를 직접 입력하거나 텍스트 입력 모드로 전환해 주세요.',
        );
      }
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : String(err));
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
      ocrAbortRef.current = null;
    }
  }

  function handleCancelOcr() {
    ocrAbortRef.current?.abort();
    setOcrRunning(false);
    setOcrProgress(null);
  }

  function handleSwitchToDirectTextFromOcr() {
    if (ocrEditedText.trim()) {
      setRawText((prev) =>
        prev.trim() ? `${prev.trim()}\n\n${ocrEditedText.trim()}` : ocrEditedText.trim(),
      );
    }
    setInputMode('text');
  }

  function handleRunAnalysis(sourceMode: ImportSourceMode) {
    const sourceText = sourceMode === 'text' ? rawText : ocrEditedText;
    setParseError(null);
    setBatchSummary(null);

    if (!sourceText.trim()) {
      setParseError(
        sourceMode === 'text'
          ? '분석할 학교 쪽지나 공지 내용을 먼저 붙여넣어 주세요.'
          : 'OCR로 추출했거나 직접 입력한 텍스트가 비어 있습니다. 텍스트를 입력한 뒤 분석을 실행해 주세요.',
      );
      return;
    }

    const parsed = parseSchoolNoticeText(sourceText, {
      now: new Date(),
      existingTasks: briefingTasks,
      existingEvents: events,
    });

    if (parsed.candidates.length === 0) {
      setParseError(
        '업무나 일정으로 추출할 수 있는 문장을 찾지 못했습니다. 날짜나 행동 표현(예: 제출, 회의, 11월 20일까지)이 포함되도록 내용을 수정해 다시 분석해 주세요.',
      );
      setCandidates([]);
      setUnparsedLines(parsed.unparsedLines);
      setAnalysisMode(sourceMode);
      return;
    }

    setCandidates(parsed.candidates);
    setUnparsedLines(parsed.unparsedLines);
    setAnalysisMode(sourceMode);
    setSaveStates({});
  }

  const handleCandidateChange = useCallback(
    (id: string, updater: (prev: ImportCandidate) => ImportCandidate) => {
      setCandidates((prev) => {
        const updated = prev.map((item) => (item.id === id ? updater(item) : item));
        return recomputeDuplicateWarnings(updated, briefingTasks, events);
      });
      setSaveStates((prev) => {
        const existing = prev[id];
        if (!existing || existing.status !== 'error') return prev;
        return { ...prev, [id]: { status: 'idle' } };
      });
    },
    [briefingTasks, events],
  );

  const handleDeleteCandidate = useCallback(
    (id: string) => {
      setCandidates((prev) =>
        recomputeDuplicateWarnings(
          prev.filter((item) => item.id !== id),
          briefingTasks,
          events,
        ),
      );
      setSaveStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [briefingTasks, events],
  );

  function handleSelectAllPending(selected: boolean) {
    setCandidates((prev) =>
      prev.map((c) => {
        if (saveStates[c.id]?.status === 'saved') return c;
        return { ...c, selected };
      }),
    );
  }

  async function handleRegisterSelected() {
    if (submitLockRef.current || isSubmitting) return;
    const targets = candidates.filter(
      (c) => c.selected && saveStates[c.id]?.status !== 'saved',
    );
    if (targets.length === 0) return;

    submitLockRef.current = true;
    setIsSubmitting(true);
    setBatchSummary(null);

    let succeededTasks = 0;
    let succeededEvents = 0;
    let failedCount = 0;
    const sourceType = analysisMode === 'ocr' ? 'import_ocr' : 'import_text';

    try {
      for (const item of targets) {
        setSaveStates((prev) => ({
          ...prev,
          [item.id]: { status: 'saving' },
        }));

        try {
          const trimmedTitle = item.title.trim();
          if (!trimmedTitle) {
            throw new Error('제목을 1자 이상 입력해 주세요.');
          }

          if (item.kind === 'task') {
            const dueDate = item.dueDateStr
              ? parseKstDateInput(item.dueDateStr, 'due')
              : null;
            const created = await createNewTask({
              title: trimmedTitle,
              description: item.description,
              priority: item.priority,
              dueAt: dueDate ? Timestamp.fromDate(dueDate) : null,
              sourceType,
            });
            setSaveStates((prev) => ({
              ...prev,
              [item.id]: { status: 'saved', createdId: created.id },
            }));
            succeededTasks += 1;
          } else {
            if (!item.eventDateStr) {
              throw new Error('일정 시작 날짜를 지정해 주세요.');
            }
            let startsAtDate: Date;
            let endsAtDate: Date;
            if (item.allDay) {
              const range = parseKstAllDayRange(
                item.eventDateStr,
                item.eventEndDateStr || item.eventDateStr,
              );
              startsAtDate = range.startsAt;
              endsAtDate = range.endsAt;
            } else {
              startsAtDate = parseKstDateTimeInput(
                item.eventDateStr,
                item.startTimeStr || '09:00',
              );
              endsAtDate = parseKstDateTimeInput(
                item.eventDateStr,
                item.endTimeStr || '10:00',
              );
              if (endsAtDate.getTime() < startsAtDate.getTime()) {
                throw new Error('종료 시각은 시작 시각보다 빠를 수 없습니다.');
              }
            }

            const created = await createNewEvent({
              title: trimmedTitle,
              startsAt: Timestamp.fromDate(startsAtDate),
              endsAt: Timestamp.fromDate(endsAtDate),
              allDay: item.allDay,
              location: item.location,
              description: item.description,
              relatedTaskId: null,
            });
            setSaveStates((prev) => ({
              ...prev,
              [item.id]: { status: 'saved', createdId: created.id },
            }));
            succeededEvents += 1;
          }
        } catch (err) {
          failedCount += 1;
          setSaveStates((prev) => ({
            ...prev,
            [item.id]: {
              status: 'error',
              error: formatTaskErrorMessage(err),
            },
          }));
        }
      }

      setBatchSummary({
        succeededTasks,
        succeededEvents,
        failedCount,
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            {formatKstTodayHeader(now)}
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            <span>Asia/Seoul</span>
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            쪽지·공지 가져오기
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            학교 쪽지나 안내문 텍스트·이미지를 불러와 업무와 일정 후보를 추출한 뒤, 직접 검토하고 선택 등록합니다.
          </p>
        </div>

        {/* Mode Switch */}
        <div
          role="tablist"
          aria-label="가져오기 입력 방식"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0"
        >
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'text'}
            onClick={() => setInputMode('text')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              inputMode === 'text'
                ? 'bg-white text-teal-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            <span>텍스트 붙여넣기</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'ocr'}
            onClick={() => setInputMode('ocr')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              inputMode === 'ocr'
                ? 'bg-white text-teal-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span>이미지 OCR</span>
          </button>
        </div>
      </div>

      {/* Privacy & Workflow Guide Strip */}
      <div className="p-3.5 rounded-xl border border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <div className="flex items-start gap-2">
          <ShieldCheck
            className="w-4 h-4 text-teal-700 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="leading-relaxed">
            <strong className="text-slate-900">개인정보 보호 원칙:</strong> 붙여넣은 원문과 업로드한 이미지는
            서버나 Firestore에 자동 저장되지 않으며, OCR 역시 브라우저 내부에서만 실행됩니다.
            사용자가 최종 선택한 후보만 업무·일정에 저장됩니다.
          </p>
        </div>
        <span className="text-slate-500 whitespace-nowrap shrink-0">
          입력·확인 → 분석 → 후보 수정 → 선택 등록
        </span>
      </div>

      {/* Input Area */}
      {inputMode === 'text' ? (
        <section
          aria-label="학교 쪽지·공지 텍스트 입력"
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="import-raw-text"
              className="text-sm font-bold text-slate-900"
            >
              안내문·쪽지 내용 붙여넣기
            </label>
            <div className="flex items-center gap-3 text-xs text-slate-500 tabular-nums">
              <span>{activeTextLineCount}줄</span>
              <span aria-hidden="true">·</span>
              <span>{rawText.length.toLocaleString()}자</span>
            </div>
          </div>

          <textarea
            id="import-raw-text"
            rows={7}
            maxLength={10000}
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              if (parseError) setParseError(null);
            }}
            placeholder={
              '메신저 쪽지, 가정통신문, 공문 일부를 그대로 붙여넣으세요.\n예:\n1. 11월 20일까지 학생 안전교육 이수증 제출\n2. 학년 협의회: 11/23(월) 13:10 본관 2층 대회의실\n3. 내일 5교시 학부모 상담 일정 확인'
            }
            className="w-full px-3.5 py-3 text-sm leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
          />

          {rawText.trim() && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowTextPreview((prev) => !prev)}
                className="text-xs font-medium text-teal-800 hover:text-teal-950 underline underline-offset-2 cursor-pointer"
              >
                {showTextPreview ? '붙여넣은 내용 미리보기 접기' : '붙여넣은 내용 미리보기'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleClearTextInput}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>입력 내용 지우기</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRunAnalysis('text')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>분석 실행</span>
                </button>
              </div>
            </div>
          )}

          {!rawText.trim() && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => handleRunAnalysis('text')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>분석 실행</span>
              </button>
            </div>
          )}

          {showTextPreview && rawText.trim() && (
            <div className="border-t border-slate-200 pt-3 space-y-1.5">
              <p className="text-xs font-semibold text-slate-700">
                붙여넣은 원문 미리보기 (자동 저장되지 않음)
              </p>
              <pre className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-800 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-60 overflow-y-auto">
                {rawText}
              </pre>
            </div>
          )}
        </section>
      ) : (
        <section
          aria-label="이미지 업로드 및 브라우저 OCR"
          onPaste={handleImagePaste}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-5"
        >
          {!ocrSupported && (
            <div
              role="alert"
              className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                현재 브라우저 환경에서 WebAssembly 기반 OCR이 지원되지 않습니다. 이미지를 보며 텍스트를 직접 입력하거나 텍스트 붙여넣기 모드로 전환해 주세요.
              </span>
              <button
                type="button"
                onClick={handleSwitchToDirectTextFromOcr}
                className="px-3 py-1.5 text-xs font-semibold bg-white border border-amber-300 rounded-md hover:bg-amber-100 whitespace-nowrap cursor-pointer"
              >
                텍스트 직접 입력으로 전환
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            {/* Left: Image Upload + Preview */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900">
                  1. 안내문·쪽지 이미지 선택
                </h2>
                {imageFile && (
                  <button
                    type="button"
                    onClick={handleClearImage}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-red-700 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>이미지 지우기</span>
                  </button>
                )}
              </div>

              {!imagePreviewUrl ? (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleImageDrop}
                  className="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center space-y-3 bg-slate-50/70 hover:border-teal-600 transition-colors"
                >
                  <Upload
                    className="w-7 h-7 text-slate-400 mx-auto"
                    aria-hidden="true"
                  />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-800">
                      PNG, JPG 이미지를 선택하거나 여기에 끌어다 놓으세요
                    </p>
                    <p className="text-xs text-slate-500">
                      캡처 이미지를 복사한 뒤 이 영역에서 Ctrl+V로 바로 붙여넣을 수도 있습니다. (최대 15MB, 서버 업로드 없음)
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="ocr-image-input"
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 cursor-pointer"
                    >
                      <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>이미지 파일 선택</span>
                    </label>
                    <input
                      ref={fileInputRef}
                      id="ocr-image-input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/bmp"
                      onChange={(e) =>
                        handleSelectImageFile(e.target.files?.[0] ?? null)
                      }
                      className="sr-only"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                    <img
                      src={imagePreviewUrl}
                      alt="업로드한 학교 안내문 이미지 미리보기"
                      className="w-full max-h-80 object-contain mx-auto"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="truncate max-w-[240px]">
                      {imageFile?.name || '붙여넣은 이미지'}
                    </span>

                    <div className="flex items-center gap-2 shrink-0">
                      <label
                        htmlFor="ocr-image-replace"
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                      >
                        다른 이미지
                      </label>
                      <input
                        id="ocr-image-replace"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/bmp"
                        onChange={(e) =>
                          handleSelectImageFile(e.target.files?.[0] ?? null)
                        }
                        className="sr-only"
                      />

                      {!ocrRunning ? (
                        <button
                          type="button"
                          disabled={!ocrSupported}
                          onClick={() => void handleRunOcr()}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                        >
                          <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>브라우저 OCR 실행</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleCancelOcr}
                          className="px-3.5 py-1.5 text-xs font-semibold bg-red-50 border border-red-200 text-red-800 rounded-lg hover:bg-red-100 whitespace-nowrap cursor-pointer"
                        >
                          OCR 중단
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {ocrRunning && ocrProgress && (
                <div
                  role="status"
                  className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1.5"
                >
                  <div className="flex items-center justify-between text-xs text-slate-700 tabular-nums">
                    <span>{ocrProgress.status}...</span>
                    <span className="font-semibold">{ocrProgress.progress}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-teal-700 transition-all duration-150"
                      style={{ width: `${ocrProgress.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {ocrError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 space-y-2"
                >
                  <p>{ocrError}</p>
                  <button
                    type="button"
                    onClick={handleSwitchToDirectTextFromOcr}
                    className="px-3 py-1 text-xs font-semibold bg-white border border-red-200 text-red-900 rounded-md hover:bg-red-100 cursor-pointer"
                  >
                    텍스트 직접 입력 화면으로 전환
                  </button>
                </div>
              )}
            </div>

            {/* Right: Extracted Text Confirmation & Edit */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="ocr-extracted-text"
                  className="text-sm font-bold text-slate-900"
                >
                  2. 추출된 텍스트 확인 및 수정
                </label>
                {ocrConfidence !== null && (
                  <span className="text-xs text-slate-500 tabular-nums">
                    인식 신뢰도 {ocrConfidence}%
                  </span>
                )}
              </div>

              {ocrLowQuality && (
                <div
                  role="status"
                  className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950"
                >
                  이미지 해상도나 글꼴 영향으로 일부 글자가 부정확하게 인식되었을 수 있습니다. 왼쪽 이미지를 확인하며 잘못 인식된 날짜·숫자·단어를 수정한 뒤 분석을 실행하세요.
                </div>
              )}

              <textarea
                id="ocr-extracted-text"
                rows={10}
                maxLength={10000}
                value={ocrEditedText}
                onChange={(e) => {
                  setOcrEditedText(e.target.value);
                  if (parseError) setParseError(null);
                }}
                placeholder="브라우저 OCR 실행 후 추출된 텍스트가 여기에 표시됩니다. 인식 품질이 낮거나 지원되지 않는 경우 왼쪽 이미지를 보고 직접 입력할 수도 있습니다."
                className="w-full px-3.5 py-2.5 text-sm leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handleSwitchToDirectTextFromOcr}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 underline underline-offset-2 cursor-pointer"
                >
                  텍스트 직접 입력 탭으로 옮기기
                </button>

                <div className="flex items-center gap-2">
                  {ocrEditedText && (
                    <button
                      type="button"
                      onClick={() => setOcrEditedText('')}
                      className="px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      텍스트 지우기
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={ocrRunning}
                    onClick={() => handleRunAnalysis('ocr')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>수정된 텍스트로 분석</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Parse Error */}
      {parseError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl border border-red-200 bg-red-50 text-xs text-red-800 flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{parseError}</span>
        </div>
      )}

      {/* Candidate Review & Registration Workspace */}
      {candidates.length > 0 && (
        <section
          aria-label="추출된 업무·일정 후보 검토"
          className="space-y-5 border-t border-slate-200 pt-5"
        >
          {/* Review Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <h2 className="text-base font-bold text-slate-900">
                분석 결과 검토 및 수정
              </h2>
              <p className="text-xs text-slate-600 tabular-nums">
                업무 후보 {taskCandidates.length}건 · 일정 후보 {eventCandidates.length}건 · 선택됨{' '}
                <strong className="text-teal-800">{selectedPendingCount}건</strong>
                {confirmationNeededCount > 0 && (
                  <span className="text-amber-800 font-semibold">
                    {' '}
                    · 확인 필요 {confirmationNeededCount}건
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSelectAllPending(true)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                전체 선택
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSelectAllPending(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                선택 해제
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={resetCandidatesState}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>분석 취소</span>
              </button>
              <button
                type="button"
                disabled={isSubmitting || selectedPendingCount === 0}
                onClick={() => void handleRegisterSelected()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {isSubmitting
                    ? '등록 중...'
                    : `선택한 ${selectedPendingCount}건 등록하기`}
                </span>
              </button>
            </div>
          </div>

          {/* Batch Save Result Banner */}
          {batchSummary && (
            <div
              role="status"
              className={`p-4 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-3 ${
                batchSummary.failedCount > 0
                  ? 'border-amber-200 bg-amber-50 text-amber-950'
                  : 'border-teal-200 bg-teal-50/70 text-teal-950'
              }`}
            >
              <div className="space-y-0.5 tabular-nums">
                <p className="font-semibold">
                  등록 처리 결과: 업무 {batchSummary.succeededTasks}건, 일정{' '}
                  {batchSummary.succeededEvents}건 저장 완료
                  {batchSummary.failedCount > 0
                    ? ` · ${batchSummary.failedCount}건 저장 실패`
                    : ''}
                </p>
                {batchSummary.failedCount > 0 && (
                  <p>
                    이미 저장된 항목은 중복 등록되지 않도록 잠겼습니다. 실패한 항목만 수정한 뒤 다시 등록해 주세요.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {batchSummary.succeededTasks > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenTask('')}
                    className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                  >
                    업무 화면으로 이동
                  </button>
                )}
                {batchSummary.succeededEvents > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenCalendar()}
                    className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                  >
                    일정 달력으로 이동
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Task Candidates Section */}
          {taskCandidates.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h3 className="text-sm font-bold text-slate-900">업무 후보</h3>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {taskCandidates.length}건
                </span>
              </div>
              <div className="space-y-3">
                {taskCandidates.map((cand) => (
                  <ImportCandidateCard
                    key={cand.id}
                    candidate={cand}
                    saveState={saveStates[cand.id] ?? { status: 'idle' }}
                    disabled={isSubmitting}
                    onChange={handleCandidateChange}
                    onDelete={handleDeleteCandidate}
                    onOpenTask={onOpenTask}
                    onOpenEvent={(eventId) => onOpenCalendar(eventId)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Event Candidates Section */}
          {eventCandidates.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h3 className="text-sm font-bold text-slate-900">일정 후보</h3>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {eventCandidates.length}건
                </span>
              </div>
              <div className="space-y-3">
                {eventCandidates.map((cand) => (
                  <ImportCandidateCard
                    key={cand.id}
                    candidate={cand}
                    saveState={saveStates[cand.id] ?? { status: 'idle' }}
                    disabled={isSubmitting}
                    onChange={handleCandidateChange}
                    onDelete={handleDeleteCandidate}
                    onOpenTask={onOpenTask}
                    onOpenEvent={(eventId) => onOpenCalendar(eventId)}
                  />
                ))}
              </div>
            </div>
          )}

          {unparsedLines.length > 0 && (
            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 text-xs text-slate-600 space-y-1">
              <p className="font-semibold text-slate-800">
                후보로 분류되지 않은 짧은 줄 ({unparsedLines.length}줄)
              </p>
              <p className="whitespace-pre-wrap break-words">
                {unparsedLines.join('\n')}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
