import { useState } from 'react';
import { Timestamp } from 'firebase/firestore';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  timestampToDate,
} from '../../lib/briefing';
import {
  addKstDaysToDateKey,
  formatKstShortDate,
  formatRelativeKstDueLabel,
  getKstDateInputValue,
  getKstDateParts,
  parseKstDateInput,
} from '../../lib/dateKst';
import type { TaskRecord, TaskStatus } from '../../types/domain';
import { useTaskData } from './TaskDataContext';
import { formatTaskErrorMessage } from './taskErrors';

interface TaskRowProps {
  task: TaskRecord;
  onSelect: (task: TaskRecord) => void;
  onError?: (message: string) => void;
  compact?: boolean;
}

export function TaskRow({ task, onSelect, onError, compact = false }: TaskRowProps) {
  const {
    isTaskPending,
    changeTaskStatus,
    postponeTaskDates,
    restoreTaskFromTrash,
    removeTaskPermanently,
  } = useTaskData();

  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const pending = isTaskPending(task.id);

  const dueDate = timestampToDate(task.dueAt);
  const scheduledDate = timestampToDate(task.scheduledAt);
  const remindDate = timestampToDate(task.remindAt);
  const dueRelative = formatRelativeKstDueLabel(dueDate);
  const isDone = task.status === 'done';

  const todayKey = getKstDateParts().dateKey;
  const isRemindDueOrPast =
    !isDone &&
    !task.isDeleted &&
    remindDate !== null &&
    getKstDateInputValue(remindDate) <= todayKey;

  async function handleToggleDone() {
    if (pending || task.isDeleted) return;
    const nextStatus: TaskStatus = isDone ? 'todo' : 'done';
    try {
      await changeTaskStatus(task.id, task.version, nextStatus);
    } catch (err) {
      onError?.(formatTaskErrorMessage(err));
    }
  }

  async function handlePostponeOneDay() {
    if (pending || task.isDeleted) return;
    try {
      const baseKey = dueDate ? getKstDateInputValue(dueDate) : todayKey;
      const targetKey = baseKey < todayKey ? addKstDaysToDateKey(todayKey, 1) : addKstDaysToDateKey(baseKey, 1);
      const nextDueDate = parseKstDateInput(targetKey, 'due');
      if (!nextDueDate) return;
      await postponeTaskDates(task.id, task.version, {
        dueAt: Timestamp.fromDate(nextDueDate),
      });
    } catch (err) {
      onError?.(formatTaskErrorMessage(err));
    }
  }

  async function handleQuickRemindTomorrow() {
    if (pending || task.isDeleted) return;
    try {
      const nextDate = parseKstDateInput(addKstDaysToDateKey(todayKey, 1), 'remind');
      if (!nextDate) return;
      await postponeTaskDates(task.id, task.version, {
        remindAt: Timestamp.fromDate(nextDate),
      });
    } catch (err) {
      onError?.(formatTaskErrorMessage(err));
    }
  }

  async function handleRestore() {
    if (pending || !task.isDeleted) return;
    try {
      await restoreTaskFromTrash(task.id, task.version);
    } catch (err) {
      onError?.(formatTaskErrorMessage(err));
    }
  }

  async function handlePermanentDelete() {
    if (pending || !task.isDeleted) return;
    try {
      await removeTaskPermanently(task.id);
    } catch (err) {
      onError?.(formatTaskErrorMessage(err));
    }
  }

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 px-4 border rounded-lg transition-colors ${
        dueRelative.isOverdue && !isDone && !task.isDeleted
          ? 'border-red-200 bg-red-50/40'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {!task.isDeleted && (
          <button
            type="button"
            disabled={pending}
            onClick={handleToggleDone}
            aria-label={isDone ? `"${task.title}" 완료 취소` : `"${task.title}" 완료 처리`}
            aria-pressed={isDone}
            className={`mt-0.5 w-6 h-6 rounded-md border flex items-center justify-center shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
              isDone
                ? 'bg-teal-700 border-teal-700 text-white'
                : 'border-slate-300 bg-white text-transparent hover:border-teal-700'
            }`}
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => onSelect(task)}
              className={`text-left text-sm font-medium cursor-pointer hover:text-teal-700 transition-colors ${
                isDone || task.isDeleted
                  ? 'line-through text-slate-400'
                  : 'text-slate-900'
              }`}
            >
              {task.title}
            </button>

            {(task.priority === 'urgent' || task.priority === 'high') && !isDone && (
              <span
                className={`text-xs font-semibold ${
                  task.priority === 'urgent' ? 'text-red-700' : 'text-amber-700'
                }`}
              >
                {PRIORITY_LABEL[task.priority]}
              </span>
            )}

            {dueRelative.isOverdue && !isDone && !task.isDeleted && (
              <span className="text-xs font-semibold text-red-700 tabular-nums">
                기한 초과 ({dueRelative.label})
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 tabular-nums">
            <span
              className={
                task.status === 'doing'
                  ? 'font-medium text-teal-700'
                  : task.status === 'on_hold'
                    ? 'text-amber-700'
                    : ''
              }
            >
              {STATUS_LABEL[task.status]}
            </span>

            {dueDate && (
              <>
                <span aria-hidden="true">·</span>
                <span className={dueRelative.isToday && !isDone ? 'font-medium text-slate-800' : ''}>
                  마감 {formatKstShortDate(dueDate)} ({dueRelative.label})
                </span>
              </>
            )}

            {!compact && scheduledDate && (
              <>
                <span aria-hidden="true">·</span>
                <span>예정 {formatKstShortDate(scheduledDate)}</span>
              </>
            )}

            {remindDate && (
              <>
                <span aria-hidden="true">·</span>
                <span className={isRemindDueOrPast ? 'font-medium text-amber-700' : ''}>
                  재확인 {formatKstShortDate(remindDate)}
                  {isRemindDueOrPast ? ' (확인 필요)' : ''}
                </span>
              </>
            )}

            {typeof task.estimatedMinutes === 'number' && !task.isDeleted && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  예상{' '}
                  {task.estimatedMinutes >= 60 && task.estimatedMinutes % 60 === 0
                    ? `${task.estimatedMinutes / 60}시간`
                    : `${task.estimatedMinutes}분`}
                </span>
              </>
            )}

            {!dueDate && !scheduledDate && !remindDate && !task.isDeleted && (
              <>
                <span aria-hidden="true">·</span>
                <span>날짜 미지정</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
        {!task.isDeleted ? (
          <>
            {!isDone && !compact && (
              <button
                type="button"
                disabled={pending}
                onClick={handlePostponeOneDay}
                aria-label={`"${task.title}" 마감일 하루 미루기`}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {dueDate ? '마감 +1일' : '내일 마감'}
              </button>
            )}
            {!isDone && !remindDate && (
              <button
                type="button"
                disabled={pending}
                onClick={handleQuickRemindTomorrow}
                aria-label={`"${task.title}" 내일 재확인으로 지정`}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                내일 재확인
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => onSelect(task)}
              aria-label={`"${task.title}" 상세 보기 및 수정`}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              상세·수정
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={handleRestore}
              aria-label={`"${task.title}" 휴지통에서 복구`}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-800 border border-teal-200 rounded-md hover:bg-teal-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>복구</span>
            </button>

            {!confirmPermanent ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmPermanent(true)}
                aria-label={`"${task.title}" 영구 삭제`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>영구 삭제</span>
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={pending}
                  onClick={handlePermanentDelete}
                  className="px-2.5 py-1.5 text-xs font-semibold text-white bg-red-700 rounded-md hover:bg-red-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  삭제 확인
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmPermanent(false)}
                  className="px-2 py-1.5 text-xs text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  취소
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
