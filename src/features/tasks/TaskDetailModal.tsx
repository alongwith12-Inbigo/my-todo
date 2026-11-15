import { useEffect, useState, type FormEvent } from 'react';
import { Timestamp } from 'firebase/firestore';
import { Calendar, ExternalLink, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { STATUS_LABEL, timestampToDate } from '../../lib/briefing';
import {
  addKstDaysToDateKey,
  formatKstDateTime,
  formatKstEventTimeRange,
  formatKstShortDate,
  getKstDateInputValue,
  getKstDateParts,
  parseKstDateInput,
} from '../../lib/dateKst';
import { fetchSingleEvent } from '../../repositories/eventRepo';
import { TaskConcurrencyError } from '../../repositories/taskRepo';
import {
  VALIDATION_LIMITS,
  type CalendarEventRecord,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
} from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useEventData } from '../calendar/EventDataContext';
import { useTaskData } from './TaskDataContext';
import { formatTaskErrorMessage } from './taskErrors';

interface TaskDetailModalProps {
  task: TaskRecord | null;
  onClose: () => void;
  onTaskUpdated?: (updated: TaskRecord | null) => void;
  onOpenEvent?: (eventId: string) => void;
}

const ALL_STATUSES: TaskStatus[] = ['todo', 'doing', 'on_hold', 'done'];

export function TaskDetailModal({
  task,
  onClose,
  onTaskUpdated,
  onOpenEvent,
}: TaskDetailModalProps) {
  const { firebaseUser } = useAuth();
  const { events } = useEventData();
  const {
    isTaskPending,
    saveTaskDetails,
    changeTaskStatus,
    moveTaskToTrash,
    restoreTaskFromTrash,
    removeTaskPermanently,
    refreshSingleTask,
  } = useTaskData();

  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(task);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [estimatedMinutesStr, setEstimatedMinutesStr] = useState('');
  const [dueDateStr, setDueDateStr] = useState('');
  const [scheduledDateStr, setScheduledDateStr] = useState('');
  const [remindDateStr, setRemindDateStr] = useState('');
  const [relatedEventId, setRelatedEventId] = useState('');
  const [linkedEventLookup, setLinkedEventLookup] =
    useState<CalendarEventRecord | null>(null);
  const [linkedEventMissing, setLinkedEventMissing] = useState(false);

  const [hasConcurrencyConflict, setHasConcurrencyConflict] = useState(false);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  function syncFormFromTask(target: TaskRecord) {
    setTitle(target.title);
    setDescription(target.description);
    setPriority(target.priority);
    setEstimatedMinutesStr(
      typeof target.estimatedMinutes === 'number'
        ? String(target.estimatedMinutes)
        : '',
    );
    setDueDateStr(getKstDateInputValue(timestampToDate(target.dueAt)));
    setScheduledDateStr(getKstDateInputValue(timestampToDate(target.scheduledAt)));
    setRemindDateStr(getKstDateInputValue(timestampToDate(target.remindAt)));
    setRelatedEventId(target.relatedEventId ?? '');
  }

  useEffect(() => {
    setCurrentTask(task);
    setFeedback(null);
    setHasConcurrencyConflict(false);
    setConfirmPermanentDelete(false);
    if (task) {
      syncFormFromTask(task);
    }
  }, [task]);

  useEffect(() => {
    if (!currentTask || !relatedEventId || !firebaseUser?.uid) {
      setLinkedEventLookup(null);
      setLinkedEventMissing(false);
      return;
    }

    const cached = events.find((ev) => ev.id === relatedEventId);
    if (cached) {
      setLinkedEventLookup(cached);
      setLinkedEventMissing(false);
      return;
    }

    let cancelled = false;
    void fetchSingleEvent(firebaseUser.uid, relatedEventId)
      .then((found) => {
        if (cancelled) return;
        if (found) {
          setLinkedEventLookup(found);
          setLinkedEventMissing(false);
        } else {
          setLinkedEventLookup(null);
          setLinkedEventMissing(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedEventLookup(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentTask, relatedEventId, events, firebaseUser?.uid]);

  useEffect(() => {
    if (!currentTask) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTask, onClose]);

  if (!currentTask) return null;

  const activeTask = currentTask;
  const pending = isTaskPending(activeTask.id);
  const todayKey = getKstDateParts().dateKey;

  async function handleReloadLatest() {
    setFeedback(null);
    try {
      const fresh = await refreshSingleTask(activeTask.id);
      if (!fresh) {
        onTaskUpdated?.(null);
        onClose();
        return;
      }
      setCurrentTask(fresh);
      syncFormFromTask(fresh);
      setHasConcurrencyConflict(false);
      setFeedback({
        type: 'success',
        message: '최신 저장 내용을 불러왔습니다. 변경 사항을 다시 확인해 주세요.',
      });
    } catch (err) {
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  // Action Branch 2: Transition status ONLY
  async function handleStatusSelect(nextStatus: TaskStatus) {
    if (pending || activeTask.isDeleted || activeTask.status === nextStatus) return;
    setFeedback(null);
    setHasConcurrencyConflict(false);
    try {
      const updated = await changeTaskStatus(
        activeTask.id,
        activeTask.version,
        nextStatus,
      );
      if (updated) {
        setCurrentTask(updated);
        onTaskUpdated?.(updated);
        setFeedback({
          type: 'success',
          message: `진행 상태를 "${STATUS_LABEL[nextStatus]}"(으)로 변경했습니다.`,
        });
      }
    } catch (err) {
      if (err instanceof TaskConcurrencyError) {
        setHasConcurrencyConflict(true);
      }
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  // Action Branch 1: Save details and dates ONLY
  async function handleDetailsSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending || activeTask.isDeleted) return;
    setFeedback(null);
    setHasConcurrencyConflict(false);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFeedback({ type: 'error', message: '업무 제목을 1자 이상 입력해 주세요.' });
      return;
    }

    let parsedEstimatedMinutes: number | null = null;
    if (estimatedMinutesStr.trim() !== '') {
      const n = Number(estimatedMinutesStr.trim());
      if (
        !Number.isInteger(n) ||
        n < VALIDATION_LIMITS.TASK_ESTIMATED_MIN ||
        n > VALIDATION_LIMITS.TASK_ESTIMATED_MAX
      ) {
        setFeedback({
          type: 'error',
          message: `예상 소요 시간은 ${VALIDATION_LIMITS.TASK_ESTIMATED_MIN}~${VALIDATION_LIMITS.TASK_ESTIMATED_MAX}분 사이의 정수이거나 미지정으로 두어야 합니다.`,
        });
        return;
      }
      parsedEstimatedMinutes = n;
    }

    try {
      const dueDate = parseKstDateInput(dueDateStr, 'due');
      const scheduledDate = parseKstDateInput(scheduledDateStr, 'schedule');
      const remindDate = parseKstDateInput(remindDateStr, 'remind');

      const updated = await saveTaskDetails(activeTask.id, activeTask.version, {
        title: trimmedTitle,
        description,
        priority,
        dueAt: dueDate ? Timestamp.fromDate(dueDate) : null,
        scheduledAt: scheduledDate ? Timestamp.fromDate(scheduledDate) : null,
        remindAt: remindDate ? Timestamp.fromDate(remindDate) : null,
        estimatedMinutes: parsedEstimatedMinutes,
        relatedEventId: relatedEventId.trim() || null,
      });

      if (updated) {
        setCurrentTask(updated);
        syncFormFromTask(updated);
        onTaskUpdated?.(updated);
        setFeedback({
          type: 'success',
          message: '업무 상세 정보와 일정을 저장했습니다.',
        });
      }
    } catch (err) {
      // Preserve form inputs on error
      if (err instanceof TaskConcurrencyError) {
        setHasConcurrencyConflict(true);
      }
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  // Action Branch 3: Soft-delete to trash
  async function handleSoftDelete() {
    if (pending || activeTask.isDeleted) return;
    setFeedback(null);
    setHasConcurrencyConflict(false);
    try {
      const updated = await moveTaskToTrash(activeTask.id, activeTask.version);
      onTaskUpdated?.(updated);
      onClose();
    } catch (err) {
      if (err instanceof TaskConcurrencyError) {
        setHasConcurrencyConflict(true);
      }
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  // Action Branch 4: Restore from trash
  async function handleRestore() {
    if (pending || !activeTask.isDeleted) return;
    setFeedback(null);
    setHasConcurrencyConflict(false);
    try {
      const updated = await restoreTaskFromTrash(activeTask.id, activeTask.version);
      if (updated) {
        setCurrentTask(updated);
        syncFormFromTask(updated);
        onTaskUpdated?.(updated);
        setFeedback({
          type: 'success',
          message: '휴지통에서 업무를 복구했습니다.',
        });
      }
    } catch (err) {
      if (err instanceof TaskConcurrencyError) {
        setHasConcurrencyConflict(true);
      }
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
  }

  async function handlePermanentDelete() {
    if (pending || !activeTask.isDeleted) return;
    setFeedback(null);
    try {
      await removeTaskPermanently(activeTask.id);
      onTaskUpdated?.(null);
      onClose();
    } catch (err) {
      setFeedback({ type: 'error', message: formatTaskErrorMessage(err) });
    }
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
        aria-labelledby="task-detail-title"
        className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden my-auto"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="task-detail-title"
              className="text-base font-bold text-slate-900 truncate"
            >
              업무 상세 및 수정
            </h2>
            <p className="text-xs text-slate-500 tabular-nums mt-0.5">
              버전 v{activeTask.version}
              <span aria-hidden="true" className="mx-1.5">
                ·
              </span>
              수정 {formatKstDateTime(timestampToDate(activeTask.updatedAt))}
              {activeTask.completedAt && (
                <>
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                  완료 {formatKstDateTime(timestampToDate(activeTask.completedAt))}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="창 닫기"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
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

          {activeTask.isDeleted ? (
            <div className="p-4 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-3">
              <p className="font-semibold">
                현재 휴지통에 보관된 업무입니다. 수정하려면 먼저 복구해 주세요.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={handleRestore}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-teal-700 text-white font-semibold rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>업무 복구하기</span>
                </button>

                {!confirmPermanentDelete ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirmPermanentDelete(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-red-300 text-red-700 font-semibold rounded-lg hover:bg-red-50 disabled:opacity-60 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>영구 삭제</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={handlePermanentDelete}
                      className="px-3.5 py-2 bg-red-700 text-white font-semibold rounded-lg hover:bg-red-800 disabled:opacity-60 cursor-pointer"
                    >
                      영구 삭제 확인
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmPermanentDelete(false)}
                      className="px-3 py-2 text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      취소
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* Section A: Separate Status Transition Action (Branch 2) */
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  진행 상태 전환
                </span>
                <span className="text-xs text-slate-500">
                  상태 변경은 즉시 반영됩니다
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-1 bg-slate-100 rounded-lg">
                {ALL_STATUSES.map((statusOption) => {
                  const selected = activeTask.status === statusOption;
                  return (
                    <button
                      key={statusOption}
                      type="button"
                      disabled={pending}
                      onClick={() => handleStatusSelect(statusOption)}
                      aria-pressed={selected}
                      className={`px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                        selected
                          ? 'bg-white text-teal-800 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {STATUS_LABEL[statusOption]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section B: Separate Details & Date Edit Form (Branch 1) */}
          <form onSubmit={handleDetailsSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="detail-task-title"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                제목
              </label>
              <input
                id="detail-task-title"
                type="text"
                required
                disabled={activeTask.isDeleted}
                maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor="detail-task-description"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                상세 내용
              </label>
              <textarea
                id="detail-task-description"
                rows={4}
                disabled={activeTask.isDeleted}
                maxLength={VALIDATION_LIMITS.DESCRIPTION_MAX_LEN}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="업무 메모, 진행 경과, 관련 학생·학급 메모"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="detail-task-priority"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  우선순위
                </label>
                <select
                  id="detail-task-priority"
                  disabled={activeTask.isDeleted}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                >
                  <option value="urgent">긴급</option>
                  <option value="high">높음</option>
                  <option value="normal">보통</option>
                  <option value="low">낮음</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="detail-task-estimated-minutes"
                    className="text-xs font-medium text-slate-700"
                  >
                    예상 소요 시간 (선택 · 분)
                  </label>
                  {estimatedMinutesStr && !activeTask.isDeleted && (
                    <button
                      type="button"
                      onClick={() => setEstimatedMinutesStr('')}
                      className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                    >
                      미지정
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="detail-task-estimated-minutes"
                    type="number"
                    min={VALIDATION_LIMITS.TASK_ESTIMATED_MIN}
                    max={VALIDATION_LIMITS.TASK_ESTIMATED_MAX}
                    step={5}
                    disabled={activeTask.isDeleted}
                    value={estimatedMinutesStr}
                    onChange={(e) => setEstimatedMinutesStr(e.target.value)}
                    placeholder="미지정 (예: 30)"
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                  />
                  <span className="text-xs text-slate-500 shrink-0">분</span>
                </div>
                {!activeTask.isDeleted && (
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-600">
                    {[15, 30, 60, 120].map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        onClick={() => setEstimatedMinutesStr(String(mins))}
                        className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                      >
                        {mins >= 60 ? `${mins / 60}시간` : `${mins}분`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="detail-task-due"
                    className="text-xs font-medium text-slate-800"
                  >
                    마감일 (실제 마감)
                  </label>
                  {dueDateStr && !activeTask.isDeleted && (
                    <button
                      type="button"
                      onClick={() => setDueDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                    >
                      해제
                    </button>
                  )}
                </div>
                <input
                  id="detail-task-due"
                  type="date"
                  disabled={activeTask.isDeleted}
                  value={dueDateStr}
                  onChange={(e) => setDueDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                />
                {!activeTask.isDeleted && (
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-600">
                    <button
                      type="button"
                      onClick={() => setDueDateStr(todayKey)}
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      오늘
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDueDateStr(
                          addKstDaysToDateKey(dueDateStr || todayKey, 1),
                        )
                      }
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      +1일 연기
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDueDateStr(
                          addKstDaysToDateKey(dueDateStr || todayKey, 3),
                        )
                      }
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      +3일 연기
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="detail-task-scheduled"
                    className="text-xs font-medium text-slate-800"
                  >
                    처리 예정일 (작업일)
                  </label>
                  {scheduledDateStr && !activeTask.isDeleted && (
                    <button
                      type="button"
                      onClick={() => setScheduledDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                    >
                      해제
                    </button>
                  )}
                </div>
                <input
                  id="detail-task-scheduled"
                  type="date"
                  disabled={activeTask.isDeleted}
                  value={scheduledDateStr}
                  onChange={(e) => setScheduledDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                />
                {!activeTask.isDeleted && (
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-600">
                    <button
                      type="button"
                      onClick={() => setScheduledDateStr(todayKey)}
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      오늘
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setScheduledDateStr(addKstDaysToDateKey(todayKey, 1))
                      }
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      내일
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="detail-task-remind"
                    className="text-xs font-medium text-slate-800"
                  >
                    재확인일 (다시 확인)
                  </label>
                  {remindDateStr && !activeTask.isDeleted && (
                    <button
                      type="button"
                      onClick={() => setRemindDateStr('')}
                      className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                    >
                      해제
                    </button>
                  )}
                </div>
                <input
                  id="detail-task-remind"
                  type="date"
                  disabled={activeTask.isDeleted}
                  value={remindDateStr}
                  onChange={(e) => setRemindDateStr(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                />
                {!activeTask.isDeleted && (
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-600">
                    <button
                      type="button"
                      onClick={() => setRemindDateStr(todayKey)}
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      오늘
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRemindDateStr(addKstDaysToDateKey(todayKey, 1))
                      }
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      내일
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRemindDateStr(addKstDaysToDateKey(todayKey, 7))
                      }
                      className="hover:text-teal-700 underline underline-offset-2 cursor-pointer"
                    >
                      +7일
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="detail-task-related-event"
                  className="text-xs font-medium text-slate-800"
                >
                  관련 일정 연결 (선택)
                </label>
                {relatedEventId && !activeTask.isDeleted && (
                  <button
                    type="button"
                    onClick={() => setRelatedEventId('')}
                    className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    연결 해제
                  </button>
                )}
              </div>

              <select
                id="detail-task-related-event"
                disabled={activeTask.isDeleted}
                value={relatedEventId}
                onChange={(e) => setRelatedEventId(e.target.value)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
              >
                <option value="">연결된 일정 없음</option>
                {events.map((ev) => {
                  const startDate = timestampToDate(ev.startsAt);
                  const endDate = timestampToDate(ev.endsAt);
                  return (
                    <option key={ev.id} value={ev.id}>
                      {ev.title} ({formatKstShortDate(startDate)}{' '}
                      {formatKstEventTimeRange(startDate, endDate, ev.allDay)})
                    </option>
                  );
                })}
                {relatedEventId && !events.some((ev) => ev.id === relatedEventId) && (
                  <option value={relatedEventId}>
                    {linkedEventLookup
                      ? `${linkedEventLookup.title} (${formatKstShortDate(timestampToDate(linkedEventLookup.startsAt))})`
                      : '연결된 일정 (삭제되었거나 찾을 수 없음)'}
                  </option>
                )}
              </select>

              {linkedEventLookup && onOpenEvent && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                  <span className="inline-flex items-center gap-1.5 text-slate-700 truncate">
                    <Calendar className="w-3.5 h-3.5 text-teal-700 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      연결된 일정: <strong className="font-semibold">{linkedEventLookup.title}</strong>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenEvent(linkedEventLookup.id);
                    }}
                    className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <span>일정 보기</span>
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </button>
                </div>
              )}

              {linkedEventMissing && relatedEventId && (
                <p className="text-xs text-amber-800">
                  연결되었던 일정을 찾을 수 없습니다. 연결 해제를 누른 뒤 저장하거나 새 일정을 선택해 주세요.
                </p>
              )}
            </div>

            {!activeTask.isDeleted && (
              <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={handleSoftDelete}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>휴지통으로 이동</span>
                </button>

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
                    {pending ? '저장 중...' : '상세·일정 저장'}
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
