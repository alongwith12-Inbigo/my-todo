import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Timestamp } from 'firebase/firestore';
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  ImagePlus,
  Plus,
  ScanText,
  Sparkles,
} from 'lucide-react';
import { AI_LIMITS } from '../../lib/aiTypes';
import {
  addKstDaysToDateKey,
  getKstDateParts,
  parseKstDateInput,
} from '../../lib/dateKst';
import {
  VALIDATION_LIMITS,
  type TaskPriority,
  type TaskRecord,
} from '../../types/domain';
import { AiPrivacyConsentModal } from '../import/AiPrivacyConsentModal';
import { ImportCandidatesSection } from '../import/ImportCandidatesSection';
import { ImportImageOcrBox } from '../import/ImportImageOcrBox';
import { useNoticeImport } from '../import/useNoticeImport';
import { useTaskData } from './TaskDataContext';
import { formatTaskErrorMessage } from './taskErrors';

interface TaskQuickAddBarProps {
  onCreated?: (task: TaskRecord) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenEvent?: (eventId: string) => void;
  onGoToTasksView?: () => void;
  onGoToCalendarView?: () => void;
}

export function TaskQuickAddBar({
  onCreated,
  onOpenTask,
  onOpenEvent,
  onGoToTasksView,
  onGoToCalendarView,
}: TaskQuickAddBarProps) {
  const { createNewTask, createSubmitting } = useTaskData();
  const noticeImport = useNoticeImport();

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [showDetails, setShowDetails] = useState(false);
  const [description, setDescription] = useState('');
  const [dueDateStr, setDueDateStr] = useState('');
  const [scheduledDateStr, setScheduledDateStr] = useState('');
  const [remindDateStr, setRemindDateStr] = useState('');
  const [estimatedMinutesStr, setEstimatedMinutesStr] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const todayKey = getKstDateParts().dateKey;
  const hasNewlines = title.includes('\n');
  const trimmedTitleLength = title.trim().length;
  const isTooLongForSingleTask = trimmedTitleLength > VALIDATION_LIMITS.TITLE_MAX_LEN;
  const isMultilineOrLong = hasNewlines || trimmedTitleLength >= 80;
  const lineCount = title ? title.split(/\r?\n/).length : 1;
  const combinedTextSource = [title.trim(), description.trim()]
    .filter(Boolean)
    .join('\n');
  const hasTextInput = combinedTextSource.length > 0;

  async function submitSimpleTask() {
    if (createSubmitting) return;

    setFeedback(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFeedback({ type: 'error', message: '업무 제목을 입력해 주세요.' });
      return;
    }
    if (trimmedTitle.length > VALIDATION_LIMITS.TITLE_MAX_LEN) {
      setFeedback({
        type: 'error',
        message: `단일 업무 제목은 ${VALIDATION_LIMITS.TITLE_MAX_LEN}자까지 등록할 수 있습니다. 긴 목록이나 여러 줄 공지는 [기본 분석] 또는 [AI로 분석]을 이용해 주세요.`,
      });
      return;
    }

    try {
      const dueDate = parseKstDateInput(dueDateStr, 'due');
      const scheduledDate = parseKstDateInput(scheduledDateStr, 'schedule');
      const remindDate = parseKstDateInput(remindDateStr, 'remind');
      const parsedEstimated =
        estimatedMinutesStr.trim() !== ''
          ? Number(estimatedMinutesStr.trim())
          : null;

      const created = await createNewTask({
        title: trimmedTitle,
        description,
        priority,
        dueAt: dueDate ? Timestamp.fromDate(dueDate) : null,
        scheduledAt: scheduledDate ? Timestamp.fromDate(scheduledDate) : null,
        remindAt: remindDate ? Timestamp.fromDate(remindDate) : null,
        estimatedMinutes: parsedEstimated,
      });

      // Clear inputs ONLY after confirmed server write
      setTitle('');
      setDescription('');
      setPriority('normal');
      setDueDateStr('');
      setScheduledDateStr('');
      setRemindDateStr('');
      setEstimatedMinutesStr('');
      setFeedback({
        type: 'success',
        message: `"${created.title}" 업무를 등록했습니다.`,
      });
      onCreated?.(created);
    } catch (err) {
      // Preserve all entered fields so the user never loses work on error
      setFeedback({
        type: 'error',
        message: formatTaskErrorMessage(err),
      });
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submitSimpleTask();
  }

  function handleTitleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !isMultilineOrLong
    ) {
      e.preventDefault();
      void submitSimpleTask();
    }
  }

  function handleSectionPaste(e: ClipboardEvent<HTMLElement>) {
    const pastedImage = noticeImport.extractClipboardImageFile(e);
    if (pastedImage) {
      e.preventDefault();
      setFeedback(null);
      noticeImport.attachImageFile(pastedImage);
    }
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDraggingFile(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    setIsDraggingFile(false);
    if (noticeImport.handleImageDrop(e)) {
      setFeedback(null);
    }
  }

  function handleAnalyzeText() {
    setFeedback(null);
    noticeImport.analyzeNoticeText(combinedTextSource, 'text');
  }

  function handleAnalyzeAi() {
    setFeedback(null);
    noticeImport.requestAiAnalysis(combinedTextSource, 'text');
  }

  function handleClearText() {
    setTitle('');
    setDescription('');
    setFeedback(null);
    noticeImport.setParseError(null);
  }

  return (
    <section
      aria-label="빠른 업무 등록 및 쪽지·이미지 분석"
      onPaste={handleSectionPaste}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`bg-white border rounded-xl p-4 sm:p-5 space-y-3.5 transition-colors ${
        isDraggingFile ? 'border-teal-600 bg-teal-50/30' : 'border-slate-200'
      }`}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <label htmlFor="quick-task-title" className="sr-only">
              업무 제목 또는 학교 쪽지·공지 내용
            </label>
            <textarea
              id="quick-task-title"
              rows={isMultilineOrLong ? Math.min(14, Math.max(6, lineCount + 1)) : 1}
              maxLength={AI_LIMITS.NOTICE_INPUT_MAX_CHARS}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (noticeImport.parseError) noticeImport.setParseError(null);
              }}
              onKeyDown={handleTitleKeyDown}
              placeholder="업무 제목을 입력해 바로 등록하거나, 긴 쪽지·공지·업무 목록·캡처 이미지(Ctrl+V)를 붙여넣으세요"
              className={`w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 leading-relaxed ${
                isMultilineOrLong
                  ? 'max-h-[420px] overflow-y-auto resize-y'
                  : 'resize-none overflow-hidden'
              }`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div>
              <label htmlFor="quick-task-priority" className="sr-only">
                우선순위
              </label>
              <select
                id="quick-task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-700"
              >
                <option value="normal">보통</option>
                <option value="high">높음</option>
                <option value="urgent">긴급</option>
                <option value="low">낮음</option>
              </select>
            </div>

            <label
              htmlFor={fileInputId}
              title="안내문·쪽지 이미지 첨부 (드래그 앤 드롭 또는 Ctrl+V 가능)"
              className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ImagePlus className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
              <span>이미지</span>
            </label>
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/bmp"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (file) {
                  setFeedback(null);
                  noticeImport.attachImageFile(file);
                }
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="sr-only"
            />

            <button
              type="button"
              onClick={() => setShowDetails((prev) => !prev)}
              aria-expanded={showDetails}
              className="inline-flex items-center gap-1 px-3 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>상세·날짜</span>
              {showDetails ? (
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>

            {hasTextInput && (
              <>
                <button
                  type="button"
                  disabled={noticeImport.aiRunning}
                  onClick={handleAnalyzeText}
                  className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                    isMultilineOrLong
                      ? 'bg-teal-50 text-teal-800 border border-teal-300 hover:bg-teal-100'
                      : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <ScanText className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                  <span>기본 분석</span>
                </button>

                {noticeImport.aiEnabled && (
                  <button
                    type="button"
                    disabled={noticeImport.aiRunning}
                    onClick={handleAnalyzeAi}
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{noticeImport.aiRunning ? 'AI 분석 중...' : 'AI로 분석'}</span>
                  </button>
                )}
              </>
            )}

            {!hasNewlines && !isTooLongForSingleTask && (
              <button
                type="submit"
                disabled={createSubmitting}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{createSubmitting ? '등록 중...' : '등록'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Helpful strip when user pastes a long / multi-line notice */}
        {isMultilineOrLong && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
            <div className="space-y-0.5">
              <p>
                긴 문장이나 여러 줄 공지가 입력되었습니다. <strong>기본 분석</strong> 또는{' '}
                <strong>AI로 분석</strong>을 선택해 업무와 일정을 나누어 검토할 수 있습니다. (원문은 저장되지 않습니다)
              </p>
              <p className="text-[11px] text-slate-500 tabular-nums">
                현재 {title.length.toLocaleString()}자 · {lineCount}줄 (입력 최대{' '}
                {AI_LIMITS.NOTICE_INPUT_MAX_CHARS.toLocaleString()}자 · AI 분석{' '}
                {AI_LIMITS.MAX_NOTICE_CHARS.toLocaleString()}자)
                {combinedTextSource.length > AI_LIMITS.MAX_NOTICE_CHARS &&
                  ' · AI 분석 한도를 넘어 기본 분석을 권장합니다.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleClearText}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 whitespace-nowrap cursor-pointer"
              >
                <Eraser className="w-3 h-3" aria-hidden="true" />
                <span>입력 지우기</span>
              </button>
              <button
                type="button"
                disabled={noticeImport.aiRunning}
                onClick={handleAnalyzeText}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-md hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                <ScanText className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                <span>기본 분석</span>
              </button>
              {noticeImport.aiEnabled && (
                <button
                  type="button"
                  disabled={noticeImport.aiRunning}
                  onClick={handleAnalyzeAi}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{noticeImport.aiRunning ? 'AI 분석 중...' : 'AI로 분석'}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {showDetails && (
          <div className="pt-3 border-t border-slate-100 space-y-4">
            <div>
              <label
                htmlFor="quick-task-description"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                상세 내용 (선택 · 긴 안내문을 붙여넣어 분석할 수도 있습니다)
              </label>
              <textarea
                id="quick-task-description"
                rows={2}
                maxLength={VALIDATION_LIMITS.DESCRIPTION_MAX_LEN}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="관련 학급, 공문 번호, 참고 사항 등을 기록하세요."
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="quick-task-due"
                    className="text-xs font-medium text-slate-800"
                  >
                    마감일 <span className="text-slate-400 font-normal">(실제 기한)</span>
                  </label>
                  {dueDateStr && (
                    <button
                      type="button"
                      onClick={() => setDueDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                    >
                      지우기
                    </button>
                  )}
                </div>
                <input
                  id="quick-task-due"
                  type="date"
                  value={dueDateStr}
                  onChange={(e) => setDueDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                />
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
                  <button
                    type="button"
                    onClick={() => setDueDateStr(todayKey)}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    오늘
                  </button>
                  <button
                    type="button"
                    onClick={() => setDueDateStr(addKstDaysToDateKey(todayKey, 1))}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    내일
                  </button>
                  <button
                    type="button"
                    onClick={() => setDueDateStr(addKstDaysToDateKey(todayKey, 3))}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    3일 후
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="quick-task-scheduled"
                    className="text-xs font-medium text-slate-800"
                  >
                    처리 예정일 <span className="text-slate-400 font-normal">(작업 계획)</span>
                  </label>
                  {scheduledDateStr && (
                    <button
                      type="button"
                      onClick={() => setScheduledDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                    >
                      지우기
                    </button>
                  )}
                </div>
                <input
                  id="quick-task-scheduled"
                  type="date"
                  value={scheduledDateStr}
                  onChange={(e) => setScheduledDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                />
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
                  <button
                    type="button"
                    onClick={() => setScheduledDateStr(todayKey)}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    오늘
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduledDateStr(addKstDaysToDateKey(todayKey, 1))}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    내일
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="quick-task-remind"
                    className="text-xs font-medium text-slate-800"
                  >
                    재확인일 <span className="text-slate-400 font-normal">(다시 확인)</span>
                  </label>
                  {remindDateStr && (
                    <button
                      type="button"
                      onClick={() => setRemindDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                    >
                      지우기
                    </button>
                  )}
                </div>
                <input
                  id="quick-task-remind"
                  type="date"
                  value={remindDateStr}
                  onChange={(e) => setRemindDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                />
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
                  <button
                    type="button"
                    onClick={() => setRemindDateStr(todayKey)}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    오늘
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemindDateStr(addKstDaysToDateKey(todayKey, 1))}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    내일
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemindDateStr(addKstDaysToDateKey(todayKey, 7))}
                    className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                  >
                    1주 후
                  </button>
                </div>
              </div>
            </div>
            <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-3">
              <label
                htmlFor="quick-task-estimated"
                className="text-xs font-medium text-slate-800 shrink-0"
              >
                예상 소요 시간 (선택)
              </label>
              <select
                id="quick-task-estimated"
                value={estimatedMinutesStr}
                onChange={(e) => setEstimatedMinutesStr(e.target.value)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-800 tabular-nums focus:outline-none focus:border-teal-700"
              >
                <option value="">미지정</option>
                <option value="10">10분</option>
                <option value="20">20분</option>
                <option value="30">30분</option>
                <option value="45">45분</option>
                <option value="60">1시간 (60분)</option>
                <option value="90">1시간 30분 (90분)</option>
                <option value="120">2시간 (120분)</option>
              </select>
            </div>
          </div>
        )}
      </form>

      {/* Non-intrusive OCR error even before an image preview is set (e.g. invalid file type/size) */}
      {noticeImport.ocrError && !noticeImport.imageFile && (
        <div
          role="alert"
          className="px-3.5 py-2.5 rounded-lg border border-red-200 bg-red-50 text-xs font-medium text-red-800"
        >
          {noticeImport.ocrError}
        </div>
      )}

      {/* Automatic Image + In-browser OCR Preview & Editable Extraction */}
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

      {/* Extracted Candidates (Both Tasks and Events can be reviewed & registered here) */}
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
        onGoToTasksView={onGoToTasksView}
        onGoToCalendarView={onGoToCalendarView}
      />

      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          className={`px-3.5 py-2.5 rounded-lg border text-xs font-medium ${
            feedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <AiPrivacyConsentModal
        isOpen={Boolean(noticeImport.aiPendingConsent)}
        inspection={noticeImport.aiPendingConsent?.inspection ?? null}
        onCancel={noticeImport.dismissAiConsent}
        onFallbackToRule={noticeImport.fallbackFromConsentToRule}
        onConfirmSend={(applyMasking) =>
          void noticeImport.confirmAiAnalysis(applyMasking)
        }
      />
    </section>
  );
}
