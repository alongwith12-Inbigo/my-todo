import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import { Timestamp } from 'firebase/firestore';
import {
  Calendar,
  Eraser,
  ExternalLink,
  FileText,
  ImagePlus,
  MapPin,
  RefreshCw,
  ScanText,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { timestampToDate } from '../../lib/briefing';
import { getDefaultEventDraftForDate } from '../../lib/calendar';
import {
  formatKstDateTime,
  getKstDateInputValue,
  getKstDateParts,
  getKstTimeInputValue,
  parseKstAllDayRange,
  parseKstDateTimeInput,
} from '../../lib/dateKst';
import { EventConcurrencyError } from '../../repositories/eventRepo';
import { fetchSingleTask } from '../../repositories/taskRepo';
import {
  VALIDATION_LIMITS,
  type CalendarEventRecord,
  type TaskRecord,
} from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { AiPrivacyConsentModal } from '../import/AiPrivacyConsentModal';
import { ImportCandidatesSection } from '../import/ImportCandidatesSection';
import { ImportImageOcrBox } from '../import/ImportImageOcrBox';
import { useNoticeImport } from '../import/useNoticeImport';
import { useTaskData } from '../tasks/TaskDataContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { useEventData } from './EventDataContext';

interface EventModalProps {
  isOpen: boolean;
  event: CalendarEventRecord | null;
  initialDateKey?: string;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenEvent?: (eventId: string) => void;
}

export function EventModal({
  isOpen,
  event,
  initialDateKey,
  onClose,
  onOpenTask,
  onOpenEvent,
}: EventModalProps) {
  const { firebaseUser } = useAuth();
  const { briefingTasks, refreshSingleTask } = useTaskData();
  const {
    isEventPending,
    createNewEvent,
    saveEvent,
    removeEvent,
    refreshSingleEvent,
  } = useEventData();
  const noticeImport = useNoticeImport();
  const { resetAll: resetNoticeImport } = noticeImport;

  const [currentEvent, setCurrentEvent] = useState<CalendarEventRecord | null>(event);
  const [title, setTitle] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('10:00');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [relatedTaskId, setRelatedTaskId] = useState<string>('');
  const [linkedTaskLookup, setLinkedTaskLookup] = useState<TaskRecord | null>(null);
  const [linkedTaskMissing, setLinkedTaskMissing] = useState(false);

  const [showNoticeBox, setShowNoticeBox] = useState(false);
  const [noticeText, setNoticeText] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const imageInputId = useId();
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasConcurrencyConflict, setHasConcurrencyConflict] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  function syncFromRecord(target: CalendarEventRecord | null, fallbackDateKey: string) {
    if (!target) {
      const draft = getDefaultEventDraftForDate(fallbackDateKey);
      setTitle('');
      setAllDay(false);
      setStartDate(draft.startDate);
      setStartTime(draft.startTime);
      setEndDate(draft.endDate);
      setEndTime(draft.endTime);
      setLocation('');
      setDescription('');
      setRelatedTaskId('');
      return;
    }

    const sDate = timestampToDate(target.startsAt);
    const eDate = timestampToDate(target.endsAt);
    setTitle(target.title);
    setAllDay(target.allDay);
    setStartDate(getKstDateInputValue(sDate) || fallbackDateKey);
    setEndDate(getKstDateInputValue(eDate) || fallbackDateKey);
    setStartTime(target.allDay ? '09:00' : getKstTimeInputValue(sDate));
    setEndTime(target.allDay ? '10:00' : getKstTimeInputValue(eDate));
    setLocation(target.location);
    setDescription(target.description);
    setRelatedTaskId(target.relatedTaskId ?? '');
  }

  useEffect(() => {
    if (!isOpen) {
      resetNoticeImport();
      setShowNoticeBox(false);
      setNoticeText('');
      setIsDraggingFile(false);
      return;
    }
    const fallbackKey = initialDateKey || getKstDateParts().dateKey;
    setCurrentEvent(event);
    setFeedback(null);
    setConfirmDelete(false);
    setHasConcurrencyConflict(false);
    setSubmitting(false);
    setShowNoticeBox(false);
    setNoticeText('');
    setIsDraggingFile(false);
    resetNoticeImport();
    syncFromRecord(event, fallbackKey);
  }, [isOpen, event, initialDateKey, resetNoticeImport]);

  useEffect(() => {
    if (!isOpen || !relatedTaskId || !firebaseUser?.uid) {
      setLinkedTaskLookup(null);
      setLinkedTaskMissing(false);
      return;
    }

    const cached = briefingTasks.find((t) => t.id === relatedTaskId);
    if (cached) {
      setLinkedTaskLookup(cached);
      setLinkedTaskMissing(false);
      return;
    }

    let cancelled = false;
    void fetchSingleTask(firebaseUser.uid, relatedTaskId)
      .then((found) => {
        if (cancelled) return;
        if (found && !found.isDeleted) {
          setLinkedTaskLookup(found);
          setLinkedTaskMissing(false);
        } else {
          setLinkedTaskLookup(null);
          setLinkedTaskMissing(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedTaskLookup(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, relatedTaskId, briefingTasks, firebaseUser?.uid]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isEditMode = currentEvent !== null;
  const pending =
    submitting || (currentEvent ? isEventPending(currentEvent.id) : false);

  async function handleReloadLatest() {
    if (!currentEvent) return;
    setFeedback(null);
    try {
      const fresh = await refreshSingleEvent(currentEvent.id);
      if (!fresh) {
        onClose();
        return;
      }
      setCurrentEvent(fresh);
      syncFromRecord(fresh, initialDateKey || getKstDateParts().dateKey);
      setHasConcurrencyConflict(false);
      setFeedback({
        type: 'success',
        message: '최신 일정 내용을 불러왔습니다. 변경 사항을 확인한 뒤 저장해 주세요.',
      });
    } catch (err) {
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setFeedback(null);
    setHasConcurrencyConflict(false);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFeedback({ type: 'error', message: '일정 제목을 1자 이상 입력해 주세요.' });
      return;
    }

    try {
      let startsDate: Date;
      let endsDate: Date;

      if (allDay) {
        const range = parseKstAllDayRange(startDate, endDate || startDate);
        startsDate = range.startsAt;
        endsDate = range.endsAt;
      } else {
        startsDate = parseKstDateTimeInput(startDate, startTime);
        endsDate = parseKstDateTimeInput(endDate || startDate, endTime);
      }

      if (endsDate.getTime() < startsDate.getTime()) {
        setFeedback({
          type: 'error',
          message: '종료 날짜·시간은 시작 날짜·시간보다 빠를 수 없습니다.',
        });
        return;
      }

      setSubmitting(true);
      const nextRelatedTaskId = relatedTaskId.trim() || null;

      if (!currentEvent) {
        await createNewEvent({
          title: trimmedTitle,
          startsAt: Timestamp.fromDate(startsDate),
          endsAt: Timestamp.fromDate(endsDate),
          allDay,
          location,
          description,
          relatedTaskId: nextRelatedTaskId,
        });
        onClose();
      } else {
        const updated = await saveEvent(currentEvent.id, currentEvent.version, {
          title: trimmedTitle,
          startsAt: Timestamp.fromDate(startsDate),
          endsAt: Timestamp.fromDate(endsDate),
          allDay,
          location,
          description,
          relatedTaskId: nextRelatedTaskId,
        });
        if (updated) {
          setCurrentEvent(updated);
          syncFromRecord(updated, startDate);
          setFeedback({ type: 'success', message: '일정을 저장했습니다.' });
        }
        if (nextRelatedTaskId) {
          void refreshSingleTask(nextRelatedTaskId);
        }
      }
    } catch (err) {
      if (err instanceof EventConcurrencyError) {
        setHasConcurrencyConflict(true);
      }
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!currentEvent || pending) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await removeEvent(currentEvent.id);
      onClose();
    } catch (err) {
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  const selectableTasks = briefingTasks.filter(
    (t) => !t.isDeleted && t.status !== 'done',
  );

  const hasExpandedImport =
    !isEditMode &&
    (Boolean(noticeImport.imageFile) ||
      noticeImport.candidates.length > 0 ||
      Boolean(noticeImport.parseError) ||
      showNoticeBox);

  function handleModalPaste(e: ClipboardEvent<HTMLElement>) {
    if (isEditMode) return;
    const pastedImage = noticeImport.extractClipboardImageFile(e);
    if (pastedImage) {
      e.preventDefault();
      setFeedback(null);
      noticeImport.attachImageFile(pastedImage);
    }
  }

  function handleModalDragOver(e: DragEvent<HTMLElement>) {
    if (isEditMode) return;
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  }

  function handleModalDragLeave(e: DragEvent<HTMLElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDraggingFile(false);
  }

  function handleModalDrop(e: DragEvent<HTMLElement>) {
    if (isEditMode) return;
    setIsDraggingFile(false);
    if (noticeImport.handleImageDrop(e)) {
      setFeedback(null);
    }
  }

  function handleTitlePaste(e: ClipboardEvent<HTMLInputElement>) {
    if (isEditMode) return;
    const pastedImage = noticeImport.extractClipboardImageFile(e);
    if (pastedImage) {
      e.preventDefault();
      setFeedback(null);
      noticeImport.attachImageFile(pastedImage);
      return;
    }
    const pastedText = e.clipboardData?.getData('text/plain') ?? '';
    if (pastedText.includes('\n') || pastedText.trim().length >= 60) {
      e.preventDefault();
      setNoticeText((prev) =>
        prev.trim() ? `${prev.trim()}\n\n${pastedText.trim()}` : pastedText.trim(),
      );
      setShowNoticeBox(true);
      noticeImport.setParseError(null);
    }
  }

  function handleAnalyzeNoticeText() {
    setFeedback(null);
    const source =
      noticeText.trim() || [title.trim(), description.trim()].filter(Boolean).join('\n');
    noticeImport.analyzeNoticeText(source, 'text');
  }

  function handleAnalyzeNoticeAi() {
    setFeedback(null);
    const source =
      noticeText.trim() || [title.trim(), description.trim()].filter(Boolean).join('\n');
    noticeImport.requestAiAnalysis(source, 'text');
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-modal-title"
        onPaste={handleModalPaste}
        onDragOver={handleModalDragOver}
        onDragLeave={handleModalDragLeave}
        onDrop={handleModalDrop}
        className={`w-full bg-white border rounded-xl shadow-lg overflow-hidden my-auto transition-[max-width] duration-150 ${
          hasExpandedImport ? 'max-w-3xl' : 'max-w-xl'
        } ${isDraggingFile ? 'border-teal-600' : 'border-slate-200'}`}
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-2.5">
            <Calendar className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
            <div>
              <h2
                id="event-modal-title"
                className="text-base font-bold text-slate-900"
              >
                {isEditMode ? '일정 상세 및 수정' : '새 일정 등록'}
              </h2>
              {currentEvent && (
                <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                  버전 v{currentEvent.version}
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                  수정 {formatKstDateTime(timestampToDate(currentEvent.updatedAt))}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="일정 창 닫기"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {feedback && (
            <div
              role={feedback.type === 'error' ? 'alert' : 'status'}
              className={`p-3.5 rounded-lg border text-xs space-y-2 ${
                feedback.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-teal-200 bg-teal-50 text-teal-900'
              }`}
            >
              <p className="font-medium">{feedback.message}</p>
              {hasConcurrencyConflict && (
                <button
                  type="button"
                  onClick={handleReloadLatest}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-red-300 text-red-800 rounded-md font-semibold hover:bg-red-50 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>최신 내용 불러오기</span>
                </button>
              )}
            </div>
          )}

          {/* Unified Notice Text / Image Input Strip (Create Mode Only) */}
          {!isEditMode && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-700">
                  <strong className="text-slate-900">쪽지·공지 자동 추출 (선택):</strong>{' '}
                  긴 안내문이나 캡처 이미지(Ctrl+V · 드래그)를 첨부하면 일정과 업무를 함께 분석합니다.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <label
                    htmlFor={imageInputId}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                  >
                    <ImagePlus className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                    <span>이미지 첨부</span>
                  </label>
                  <input
                    ref={imageInputRef}
                    id={imageInputId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/bmp"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      if (file) {
                        setFeedback(null);
                        noticeImport.attachImageFile(file);
                      }
                      if (imageInputRef.current) imageInputRef.current.value = '';
                    }}
                    className="sr-only"
                  />

                  <button
                    type="button"
                    onClick={() => setShowNoticeBox((prev) => !prev)}
                    aria-expanded={showNoticeBox}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap cursor-pointer ${
                      showNoticeBox
                        ? 'bg-teal-50 text-teal-800 border-teal-300'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                    <span>{showNoticeBox ? '텍스트 입력 접기' : '긴 글 붙여넣기'}</span>
                  </button>
                </div>
              </div>

              {showNoticeBox && (
                <div className="space-y-2 pt-1">
                  <label htmlFor="event-notice-text" className="sr-only">
                    안내문·쪽지 원문 붙여넣기
                  </label>
                  <textarea
                    id="event-notice-text"
                    rows={4}
                    maxLength={10000}
                    value={noticeText}
                    onChange={(e) => {
                      setNoticeText(e.target.value);
                      if (noticeImport.parseError) noticeImport.setParseError(null);
                    }}
                    placeholder="여러 일정이나 업무가 담긴 공지·메신저 내용을 그대로 붙여넣으세요. (원문은 저장되지 않습니다)"
                    className="w-full px-3 py-2 text-sm leading-relaxed border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
                  />
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {noticeText && (
                      <button
                        type="button"
                        onClick={() => {
                          setNoticeText('');
                          noticeImport.setParseError(null);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                      >
                        <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>입력 지우기</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={noticeImport.aiRunning}
                      onClick={handleAnalyzeNoticeText}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                    >
                      <ScanText className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                      <span>기본 분석</span>
                    </button>
                    {noticeImport.aiEnabled && (
                      <button
                        type="button"
                        disabled={noticeImport.aiRunning}
                        onClick={handleAnalyzeNoticeAi}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{noticeImport.aiRunning ? 'AI 분석 중...' : 'AI로 분석'}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {noticeImport.ocrError && !noticeImport.imageFile && (
                <div
                  role="alert"
                  className="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
                >
                  {noticeImport.ocrError}
                </div>
              )}

              {noticeImport.imageFile && noticeImport.imagePreviewUrl && (
                <ImportImageOcrBox
                  imageFile={noticeImport.imageFile}
                  imagePreviewUrl={noticeImport.imagePreviewUrl}
                  ocrSupported={noticeImport.ocrSupported}
                  ocrRunning={noticeImport.ocrRunning}
                  ocrProgress={noticeImport.ocrProgress}
                  ocrConfidence={noticeImport.ocrConfidence}
                  ocrLowQuality={noticeImport.ocrLowQuality}
                  ocrError={noticeImport.ocrError}
                  ocrEditedText={noticeImport.ocrEditedText}
                  aiEnabled={noticeImport.aiEnabled}
                  aiRunning={noticeImport.aiRunning}
                  onChangeText={noticeImport.setOcrEditedText}
                  onReplaceImage={(file) => noticeImport.attachImageFile(file)}
                  onClearImage={noticeImport.clearImage}
                  onRerunOcr={noticeImport.rerunOcr}
                  onCancelOcr={noticeImport.cancelOcr}
                  onAnalyze={() =>
                    noticeImport.analyzeNoticeText(noticeImport.ocrEditedText, 'ocr')
                  }
                  onAnalyzeAi={() =>
                    noticeImport.requestAiAnalysis(noticeImport.ocrEditedText, 'ocr')
                  }
                />
              )}

              <ImportCandidatesSection
                candidates={noticeImport.candidates}
                unparsedLines={noticeImport.unparsedLines}
                parseError={noticeImport.parseError}
                saveStates={noticeImport.saveStates}
                isSubmitting={noticeImport.isSubmitting}
                batchSummary={noticeImport.batchSummary}
                analysisMode={noticeImport.analysisMode}
                aiRunning={noticeImport.aiRunning}
                aiError={noticeImport.aiError}
                aiModelUsed={noticeImport.aiModelUsed}
                canFallbackToRule={noticeImport.canFallbackToRule}
                onCancelAi={noticeImport.cancelAiAnalysis}
                onFallbackToRule={noticeImport.runRuleFallbackAfterAiError}
                onDismissAiError={() => noticeImport.setAiError(null)}
                onChangeCandidate={noticeImport.updateCandidate}
                onDeleteCandidate={noticeImport.deleteCandidate}
                onSelectAllPending={noticeImport.selectAllPending}
                onCancelAnalysis={noticeImport.resetAnalysis}
                onRegisterSelected={() => void noticeImport.registerSelected()}
                onOpenTask={(taskId) => onOpenTask?.(taskId)}
                onOpenEvent={(eventId) => onOpenEvent?.(eventId)}
              />
            </div>
          )}

          <div>
            <label
              htmlFor="event-title"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              일정 제목
            </label>
            <input
              id="event-title"
              type="text"
              required
              maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onPaste={handleTitlePaste}
              placeholder="예: 교직원 연수, 학부모 상담, 부장회의"
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="flex items-center justify-between gap-3 py-2 px-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <label
              htmlFor="event-all-day"
              className="text-xs font-semibold text-slate-800 cursor-pointer select-none"
            >
              종일 일정으로 지정 (Asia/Seoul 기준 하루 전체)
            </label>
            <input
              id="event-all-day"
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label
                htmlFor="event-start-date"
                className="block text-xs font-medium text-slate-700"
              >
                시작 날짜
              </label>
              <input
                id="event-start-date"
                type="date"
                required
                value={startDate}
                onChange={(e) => {
                  const next = e.target.value;
                  setStartDate(next);
                  if (!endDate || endDate < next) {
                    setEndDate(next);
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
              />
              {!allDay && (
                <div>
                  <label
                    htmlFor="event-start-time"
                    className="block text-xs text-slate-600 mb-1"
                  >
                    시작 시간
                  </label>
                  <input
                    id="event-start-time"
                    type="time"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="event-end-date"
                className="block text-xs font-medium text-slate-700"
              >
                종료 날짜
              </label>
              <input
                id="event-end-date"
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
              />
              {!allDay && (
                <div>
                  <label
                    htmlFor="event-end-time"
                    className="block text-xs text-slate-600 mb-1"
                  >
                    종료 시간
                  </label>
                  <input
                    id="event-end-time"
                    type="time"
                    required
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                  />
                </div>
              )}
            </div>
          </div>

          <div>
            <label
              htmlFor="event-location"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              장소 (선택)
            </label>
            <div className="relative">
              <MapPin
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="event-location"
                type="text"
                maxLength={VALIDATION_LIMITS.LOCATION_MAX_LEN}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="예: 본관 2층 회의실, 3-2 교실, 온라인 Zoom"
                className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="event-description"
                className="block text-xs font-medium text-slate-700"
              >
                상세 내용 (선택)
              </label>
              {!isEditMode && description.trim().length > 0 && !showNoticeBox && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={noticeImport.aiRunning}
                    onClick={() =>
                      noticeImport.analyzeNoticeText(
                        [title.trim(), description.trim()].filter(Boolean).join('\n'),
                        'text',
                      )
                    }
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-teal-800 cursor-pointer"
                  >
                    <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>기본 분석</span>
                  </button>
                  {noticeImport.aiEnabled && (
                    <button
                      type="button"
                      disabled={noticeImport.aiRunning}
                      onClick={() =>
                        noticeImport.requestAiAnalysis(
                          [title.trim(), description.trim()].filter(Boolean).join('\n'),
                          'text',
                        )
                      }
                      className="inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:text-teal-950 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>AI로 분석</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <textarea
              id="event-description"
              rows={3}
              maxLength={VALIDATION_LIMITS.DESCRIPTION_MAX_LEN}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="준비물, 참석 대상, 전달 사항 등"
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="event-related-task"
                className="text-xs font-medium text-slate-700"
              >
                관련 업무 연결 (선택)
              </label>
              {relatedTaskId && (
                <button
                  type="button"
                  onClick={() => setRelatedTaskId('')}
                  className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  연결 해제
                </button>
              )}
            </div>

            <select
              id="event-related-task"
              value={relatedTaskId}
              onChange={(e) => setRelatedTaskId(e.target.value)}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
            >
              <option value="">연결할 업무 없음 (독립 일정)</option>
              {selectableTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
              {relatedTaskId &&
                !selectableTasks.some((t) => t.id === relatedTaskId) && (
                  <option value={relatedTaskId}>
                    {linkedTaskLookup
                      ? `${linkedTaskLookup.title} (${linkedTaskLookup.status === 'done' ? '완료됨' : '연결됨'})`
                      : '연결된 업무 (찾을 수 없음 또는 삭제됨)'}
                  </option>
                )}
            </select>

            {linkedTaskLookup && onOpenTask && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                <span className="text-slate-700 truncate">
                  연결된 업무: <strong className="font-semibold">{linkedTaskLookup.title}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onOpenTask(linkedTaskLookup.id)}
                  className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>업무 열기</span>
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}

            {linkedTaskMissing && relatedTaskId && (
              <p className="text-xs text-amber-800">
                연결되었던 업무를 찾을 수 없습니다. 그대로 두시거나 연결 해제를 선택해 주세요.
              </p>
            )}

            <p className="text-xs text-slate-500">
              연결된 업무를 완료하거나 이 일정을 삭제해도 서로의 데이터는 손상되지 않습니다.
            </p>
          </div>

          <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            {isEditMode ? (
              !confirmDelete ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>일정 삭제</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={handleDelete}
                    className="px-3.5 py-2 text-xs font-semibold text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                  >
                    삭제 확인
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2.5 py-2 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    취소
                  </button>
                </div>
              )
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                닫기
              </button>
              <button
                type="submit"
                disabled={pending}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
              >
                {pending ? '저장 중...' : isEditMode ? '일정 저장' : '일정 등록'}
              </button>
            </div>
          </div>
        </form>
      </div>

      <AiPrivacyConsentModal
        isOpen={Boolean(noticeImport.aiPendingConsent)}
        inspection={noticeImport.aiPendingConsent?.inspection ?? null}
        onCancel={noticeImport.dismissAiConsent}
        onFallbackToRule={noticeImport.fallbackFromConsentToRule}
        onConfirmSend={(applyMasking) =>
          void noticeImport.confirmAiAnalysis(applyMasking)
        }
      />
    </div>
  );
}
