import { useState, type FormEvent } from 'react';
import { Timestamp } from 'firebase/firestore';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
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
import { useTaskData } from './TaskDataContext';
import { formatTaskErrorMessage } from './taskErrors';

interface TaskQuickAddBarProps {
  onCreated?: (task: TaskRecord) => void;
}

export function TaskQuickAddBar({ onCreated }: TaskQuickAddBarProps) {
  const { createNewTask, createSubmitting } = useTaskData();

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [showDetails, setShowDetails] = useState(false);
  const [description, setDescription] = useState('');
  const [dueDateStr, setDueDateStr] = useState('');
  const [scheduledDateStr, setScheduledDateStr] = useState('');
  const [remindDateStr, setRemindDateStr] = useState('');

  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const todayKey = getKstDateParts().dateKey;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (createSubmitting) return;

    setFeedback(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFeedback({ type: 'error', message: '업무 제목을 입력해 주세요.' });
      return;
    }

    try {
      const dueDate = parseKstDateInput(dueDateStr, 'due');
      const scheduledDate = parseKstDateInput(scheduledDateStr, 'schedule');
      const remindDate = parseKstDateInput(remindDateStr, 'remind');

      const created = await createNewTask({
        title: trimmedTitle,
        description,
        priority,
        dueAt: dueDate ? Timestamp.fromDate(dueDate) : null,
        scheduledAt: scheduledDate ? Timestamp.fromDate(scheduledDate) : null,
        remindAt: remindDate ? Timestamp.fromDate(remindDate) : null,
      });

      // Clear inputs ONLY after confirmed server write
      setTitle('');
      setDescription('');
      setPriority('normal');
      setDueDateStr('');
      setScheduledDateStr('');
      setRemindDateStr('');
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

  return (
    <section
      aria-label="빠른 업무 등록"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3"
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="flex-1">
            <label htmlFor="quick-task-title" className="sr-only">
              업무 제목
            </label>
            <input
              id="quick-task-title"
              type="text"
              maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="제목만 입력해도 바로 등록됩니다 (예: 학부모 상담 안내문 발송)"
              className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
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

            <button
              type="submit"
              disabled={createSubmitting}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>{createSubmitting ? '등록 중...' : '등록'}</span>
            </button>
          </div>
        </div>

        {showDetails && (
          <div className="pt-3 border-t border-slate-100 space-y-4">
            <div>
              <label
                htmlFor="quick-task-description"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                상세 내용 (선택)
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
          </div>
        )}
      </form>

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
    </section>
  );
}
