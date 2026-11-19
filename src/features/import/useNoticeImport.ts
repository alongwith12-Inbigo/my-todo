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
import { buildMinimalExistingContext } from '../../lib/aiBriefing';
import { normalizeAiNoticeCandidates } from '../../lib/aiImportValidator';
import {
  getStoredAiEnabled,
  subscribeAiEnabledChange,
} from '../../lib/aiPreferences';
import { AI_LIMITS } from '../../lib/aiTypes';
import {
  getKstDateInputValue,
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
import {
  inspectAndMaskPrivacy,
  type PrivacyInspectionResult,
} from '../../lib/privacyGuard';
import {
  classifyNoticeAiError,
  getNoticeAiErrorCategoryLabel,
  type ClassifiedNoticeAiError,
} from '../../lib/aiNoticeError';
import { requestAiNoticeAnalysis } from '../../services/aiClient';
import { useAuth } from '../auth/AuthContext';
import { useEventData } from '../calendar/EventDataContext';
import { useOptionalAiWorkspace } from '../tasks/AiWorkspaceContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { useTaskData } from '../tasks/TaskDataContext';
import type { CandidateSaveState } from './ImportCandidateCard';

export interface BatchSaveSummary {
  succeededTasks: number;
  succeededEvents: number;
  failedCount: number;
}

export interface PendingAiConsentState {
  rawSourceText: string;
  sourceOrigin: 'text' | 'ocr';
  inspection: PrivacyInspectionResult;
}

export function useNoticeImport() {
  const { firebaseUser } = useAuth();
  const { briefingTasks, createNewTask } = useTaskData();
  const { events, createNewEvent } = useEventData();
  const aiWorkspace = useOptionalAiWorkspace();

  const [aiEnabled, setAiEnabled] = useState(() =>
    getStoredAiEnabled(firebaseUser?.uid),
  );

  useEffect(() => {
    setAiEnabled(getStoredAiEnabled(firebaseUser?.uid));
    return subscribeAiEnabledChange(firebaseUser?.uid, setAiEnabled);
  }, [firebaseUser?.uid]);

  // Image + Browser OCR state (local memory only; never auto-uploaded or auto-saved)
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
  const [batchSummary, setBatchSummary] = useState<BatchSaveSummary | null>(null);

  // Step 5 AI state
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiErrorState] = useState<string | null>(null);
  const [aiErrorInfo, setAiErrorInfo] = useState<ClassifiedNoticeAiError | null>(
    null,
  );
  const [aiModelUsed, setAiModelUsed] = useState<string | null>(null);
  const [aiPendingConsent, setAiPendingConsent] =
    useState<PendingAiConsentState | null>(null);
  const [lastAiFallbackSource, setLastAiFallbackSource] = useState<{
    text: string;
    origin: 'text' | 'ocr';
  } | null>(null);

  const ocrAbortRef = useRef<AbortController | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const submitLockRef = useRef(false);

  const ocrSupported = useMemo(() => isBrowserOcrSupported(), []);

  const setAiError = useCallback((next: string | null) => {
    setAiErrorState(next);
    if (next === null) {
      setAiErrorInfo(null);
    }
  }, []);

  const applyClassifiedAiError = useCallback((info: ClassifiedNoticeAiError) => {
    setAiErrorState(info.message);
    setAiErrorInfo(info);
  }, []);

  useEffect(() => {
    return () => {
      ocrAbortRef.current?.abort();
      aiAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  const executeOcrForFile = useCallback(
    async (file: File) => {
      if (!ocrSupported) {
        setOcrError(
          '현재 브라우저 환경에서 WebAssembly 기반 OCR이 지원되지 않습니다. 이미지를 보며 텍스트를 직접 입력해 주세요.',
        );
        return;
      }

      ocrAbortRef.current?.abort();
      const controller = new AbortController();
      ocrAbortRef.current = controller;

      setOcrError(null);
      setOcrLowQuality(false);
      setOcrConfidence(null);
      setOcrProgress({ status: 'OCR 엔진 초기화 중', progress: 0 });
      setOcrRunning(true);

      try {
        const result = await runInBrowserOcr(file, {
          signal: controller.signal,
          onProgress: setOcrProgress,
        });
        if (controller.signal.aborted) return;
        setOcrEditedText(result.text);
        setOcrConfidence(Math.round(result.confidence));
        setOcrLowQuality(result.lowConfidence);
        if (!result.text) {
          setOcrError(
            '이미지에서 글자를 충분히 인식하지 못했습니다. 왼쪽 이미지를 보며 추출 텍스트 칸에 직접 입력해 주세요.',
          );
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setOcrError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (ocrAbortRef.current === controller) {
          ocrAbortRef.current = null;
          setOcrRunning(false);
          setOcrProgress(null);
        }
      }
    },
    [ocrSupported],
  );

  const attachImageFile = useCallback(
    (file: File | null, options: { autoRunOcr?: boolean } = { autoRunOcr: true }) => {
      if (!file) return false;
      const err = validateOcrImageFile(file);
      if (err) {
        setOcrError(err);
        return false;
      }

      ocrAbortRef.current?.abort();
      setOcrRunning(false);
      setOcrProgress(null);
      setOcrConfidence(null);
      setOcrLowQuality(false);
      setOcrError(null);
      setParseError(null);
      setAiError(null);

      const nextUrl = URL.createObjectURL(file);
      setImageFile(file);
      setImagePreviewUrl(nextUrl);

      if (options.autoRunOcr !== false) {
        void executeOcrForFile(file);
      }
      return true;
    },
    [executeOcrForFile],
  );

  const rerunOcr = useCallback(() => {
    if (!imageFile || ocrRunning) return;
    void executeOcrForFile(imageFile);
  }, [imageFile, ocrRunning, executeOcrForFile]);

  const cancelOcr = useCallback(() => {
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    setOcrRunning(false);
    setOcrProgress(null);
  }, []);

  const clearImage = useCallback(() => {
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    setOcrRunning(false);
    setOcrProgress(null);
    setOcrConfidence(null);
    setOcrLowQuality(false);
    setOcrError(null);
    setOcrEditedText('');
    setImageFile(null);
    setImagePreviewUrl(null);
  }, []);

  const extractClipboardImageFile = useCallback(
    (e: ClipboardEvent<HTMLElement>): File | null => {
      const items = e.clipboardData?.items;
      if (!items) return null;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            return blob;
          }
        }
      }
      return null;
    },
    [],
  );

  const handleImageDrop = useCallback(
    (e: DragEvent<HTMLElement>): boolean => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return false;
      const file = files[0];
      if (!file.type.startsWith('image/')) {
        return false;
      }
      e.preventDefault();
      attachImageFile(file);
      return true;
    },
    [attachImageFile],
  );

  const cancelAiAnalysis = useCallback(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiRunning(false);
  }, []);

  const resetAnalysis = useCallback(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiRunning(false);
    setAiError(null);
    setAiModelUsed(null);
    setAiPendingConsent(null);
    setLastAiFallbackSource(null);
    setCandidates([]);
    setUnparsedLines([]);
    setAnalysisMode(null);
    setParseError(null);
    setSaveStates({});
    setBatchSummary(null);
  }, []);

  const resetAll = useCallback(() => {
    clearImage();
    resetAnalysis();
  }, [clearImage, resetAnalysis]);

  const analyzeNoticeText = useCallback(
    (sourceText: string, mode: 'text' | 'ocr') => {
      setParseError(null);
      setAiError(null);
      setAiModelUsed(null);
      setLastAiFallbackSource(null);
      setBatchSummary(null);

      if (!sourceText.trim()) {
        setParseError(
          mode === 'ocr'
            ? '추출된 텍스트가 비어 있습니다. 텍스트를 확인·입력한 뒤 내용 분석을 눌러 주세요.'
            : '분석할 안내문이나 쪽지 내용을 입력해 주세요.',
        );
        return false;
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
        setAnalysisMode(mode);
        return false;
      }

      setCandidates(
        parsed.candidates.map((c) => ({ ...c, origin: 'rule' })),
      );
      setUnparsedLines(parsed.unparsedLines);
      setAnalysisMode(mode);
      setSaveStates({});
      return true;
    },
    [briefingTasks, events],
  );

  const requestAiAnalysis = useCallback(
    (sourceText: string, sourceOrigin: 'text' | 'ocr') => {
      setParseError(null);
      setAiError(null);
      setBatchSummary(null);

      if (!aiEnabled) {
        applyClassifiedAiError({
          category: 'setting_or_input',
          categoryLabel: getNoticeAiErrorCategoryLabel('setting_or_input'),
          message:
            '설정에서 AI 스마트 업무비서 기능이 꺼져 있습니다. 설정에서 켜거나 기본 분석을 이용해 주세요.',
          guidance:
            '[설정 > AI 스마트 업무비서]에서 기능을 켜거나 아래 「기본 분석」을 이용해 주세요.',
          errorCode: 'ai_disabled_by_user',
        });
        return false;
      }

      const trimmed = sourceText.trim();
      if (!trimmed) {
        setParseError(
          sourceOrigin === 'ocr'
            ? '추출된 텍스트가 비어 있습니다. 텍스트를 확인·입력한 뒤 분석을 눌러 주세요.'
            : '분석할 안내문이나 쪽지 내용을 입력해 주세요.',
        );
        return false;
      }

      if (trimmed.length > AI_LIMITS.MAX_NOTICE_CHARS) {
        applyClassifiedAiError({
          category: 'setting_or_input',
          categoryLabel: getNoticeAiErrorCategoryLabel('setting_or_input'),
          message: `AI 분석은 한 번에 최대 ${AI_LIMITS.MAX_NOTICE_CHARS.toLocaleString()}자까지 지원합니다. 내용을 나누어 분석하거나 기본 분석을 이용해 주세요.`,
          guidance:
            '내용을 나누어 입력하거나 아래 「대신 기본 분석 실행」을 이용해 주세요.',
          errorCode: 'input_too_long',
        });
        setLastAiFallbackSource({ text: trimmed, origin: sourceOrigin });
        return false;
      }

      const inspection = inspectAndMaskPrivacy(trimmed);
      setAiPendingConsent({
        rawSourceText: trimmed,
        sourceOrigin,
        inspection,
      });
      return true;
    },
    [aiEnabled],
  );

  const dismissAiConsent = useCallback(() => {
    setAiPendingConsent(null);
  }, []);

  const fallbackFromConsentToRule = useCallback(() => {
    if (!aiPendingConsent) return;
    const { rawSourceText, sourceOrigin } = aiPendingConsent;
    setAiPendingConsent(null);
    analyzeNoticeText(rawSourceText, sourceOrigin);
  }, [aiPendingConsent, analyzeNoticeText]);

  const confirmAiAnalysis = useCallback(
    async (applyMasking: boolean) => {
      if (!aiPendingConsent) return;
      const { rawSourceText, sourceOrigin, inspection } = aiPendingConsent;

      if (inspection.hasHighRisk && !applyMasking) {
        applyClassifiedAiError({
          category: 'setting_or_input',
          categoryLabel: getNoticeAiErrorCategoryLabel('setting_or_input'),
          message:
            '고위험 민감정보가 가려지지 않아 외부 AI 전송이 차단되었습니다. 가림 처리 후 다시 시도하거나 기본 분석을 이용해 주세요.',
          guidance:
            '민감정보 자동 가림 처리를 선택하거나 아래 「대신 기본 분석 실행」을 이용해 주세요.',
          errorCode: 'privacy_high_risk',
        });
        return;
      }

      const payloadText = applyMasking
        ? inspection.maskedText
        : inspection.originalText;

      setAiPendingConsent(null);
      setParseError(null);
      setAiError(null);
      setLastAiFallbackSource({ text: rawSourceText, origin: sourceOrigin });

      aiAbortRef.current?.abort();
      const controller = new AbortController();
      aiAbortRef.current = controller;
      setAiRunning(true);

      try {
        const now = new Date();
        const todayKey = getKstDateInputValue(now);
        const existingItems = buildMinimalExistingContext(briefingTasks, events);

        const response = await requestAiNoticeAnalysis(
          {
            text: payloadText,
            todayKey,
            existingItems,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        aiWorkspace?.recordNoticeAnalysisSuccess(response);

        const normalized = normalizeAiNoticeCandidates(response.rawOutput, {
          now,
          existingTasks: briefingTasks,
          existingEvents: events,
        });

        if (normalized.candidates.length === 0) {
          applyClassifiedAiError({
            category: 'setting_or_input',
            categoryLabel: getNoticeAiErrorCategoryLabel('setting_or_input'),
            message:
              'AI가 업무나 일정 후보를 추출하지 못했습니다. 아래 버튼으로 기본 분석을 실행하거나 문장을 보완해 보세요.',
            guidance:
              '날짜·제출·회의 등 구체적인 행동 표현을 보완하거나 「대신 기본 분석 실행」을 이용해 주세요.',
            errorCode: 'ai_no_candidates',
            errorDetail: { model: response.model },
          });
          return;
        }

        setCandidates(normalized.candidates);
        setUnparsedLines(normalized.unparsedLines);
        setAnalysisMode('ai');
        setAiModelUsed(response.model);
        setSaveStates({});
      } catch (err) {
        if (controller.signal.aborted) return;
        applyClassifiedAiError(classifyNoticeAiError(err));
      } finally {
        if (aiAbortRef.current === controller) {
          aiAbortRef.current = null;
          setAiRunning(false);
        }
      }
    },
    [
      aiPendingConsent,
      aiWorkspace,
      applyClassifiedAiError,
      briefingTasks,
      events,
      setAiError,
    ],
  );

  const runRuleFallbackAfterAiError = useCallback(() => {
    if (!lastAiFallbackSource) return;
    const { text, origin } = lastAiFallbackSource;
    setAiError(null);
    analyzeNoticeText(text, origin);
  }, [lastAiFallbackSource, analyzeNoticeText]);

  const updateCandidate = useCallback(
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

  const deleteCandidate = useCallback(
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

  const selectAllPending = useCallback(
    (selected: boolean) => {
      setCandidates((prev) =>
        prev.map((c) => {
          if (saveStates[c.id]?.status === 'saved') return c;
          return { ...c, selected };
        }),
      );
    },
    [saveStates],
  );

  const registerSelected = useCallback(async () => {
    if (submitLockRef.current || isSubmitting) return null;
    const targets = candidates.filter(
      (c) => c.selected && saveStates[c.id]?.status !== 'saved',
    );
    if (targets.length === 0) return null;

    submitLockRef.current = true;
    setIsSubmitting(true);
    setBatchSummary(null);

    let succeededTasks = 0;
    let succeededEvents = 0;
    let failedCount = 0;
    const sourceType =
      analysisMode === 'ai'
        ? 'import_ai'
        : analysisMode === 'ocr'
          ? 'import_ocr'
          : 'import_text';

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

      const summary = {
        succeededTasks,
        succeededEvents,
        failedCount,
      };
      setBatchSummary(summary);
      return summary;
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    candidates,
    saveStates,
    analysisMode,
    createNewTask,
    createNewEvent,
  ]);

  return {
    // OCR & Image state
    imageFile,
    imagePreviewUrl,
    ocrSupported,
    ocrRunning,
    ocrProgress,
    ocrConfidence,
    ocrLowQuality,
    ocrError,
    ocrEditedText,
    setOcrEditedText,
    attachImageFile,
    rerunOcr,
    cancelOcr,
    clearImage,
    extractClipboardImageFile,
    handleImageDrop,
    // Analysis & Candidates
    analysisMode,
    candidates,
    unparsedLines,
    parseError,
    setParseError,
    saveStates,
    isSubmitting,
    batchSummary,
    analyzeNoticeText,
    updateCandidate,
    deleteCandidate,
    selectAllPending,
    registerSelected,
    resetAnalysis,
    resetAll,
    // Step 5 AI state & actions
    aiEnabled,
    aiRunning,
    aiError,
    aiErrorInfo,
    setAiError,
    aiModelUsed,
    activePlannerModel: aiWorkspace?.activePlannerModel ?? null,
    aiPendingConsent,
    canFallbackToRule: Boolean(lastAiFallbackSource),
    requestAiAnalysis,
    dismissAiConsent,
    fallbackFromConsentToRule,
    confirmAiAnalysis,
    cancelAiAnalysis,
    runRuleFallbackAfterAiError,
  };
}
