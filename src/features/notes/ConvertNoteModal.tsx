import { useEffect, useState, type FormEvent } from 'react';
import { Timestamp } from 'firebase/firestore';
import { ArrowRightCircle, X } from 'lucide-react';
import { addKstDaysToDateKey, getKstDateParts, parseKstDateInput } from '../../lib/dateKst';
import { buildDefaultTaskTitleFromNote } from '../../lib/notes';
import {
  VALIDATION_LIMITS,
  type StickyNoteRecord,
  type TaskPriority,
} from '../../types/domain';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { useNoteData } from './NoteDataContext';

interface ConvertNoteModalProps {
  note: StickyNoteRecord | null;
  onClose: () => void;
  onConverted?: (taskId: string) => void;
}

export function ConvertNoteModal({
  note,
  onClose,
  onConverted,
}: ConvertNoteModalProps) {
  const { convertNote, isNotePending } = useNoteData();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [dueDateStr, setDueDateStr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    setTitle(buildDefaultTaskTitleFromNote(note.content));
    setDescription(note.content);
    setPriority('normal');
    setDueDateStr('');
    setSubmitting(false);
    setError(null);
  }, [note]);

  useEffect(() => {
    if (!note) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [note, onClose]);

  if (!note) return null;

  const pending = submitting || isNotePending(note.id);
  const todayKey = getKstDateParts().dateKey;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!note || pending) return;
    setError(null);

    if (note.convertedTaskId) {
      setError('이미 업무로 전환된 메모입니다.');
      return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('업무 제목을 1자 이상 입력해 주세요.');
      return;
    }

    setSubmitting(true);
    try {
      const dueDate = dueDateStr ? parseKstDateInput(dueDateStr, 'due') : null;
      const result = await convertNote(note.id, note.version, {
        title: trimmedTitle,
        description,
        priority,
        dueAt: dueDate ? Timestamp.fromDate(dueDate) : null,
      });
      onClose();
      onConverted?.(result.taskId);
    } catch (err) {
      setError(formatTaskErrorMessage(err));
    } finally {
      setSubmitting(false);
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
        aria-labelledby="convert-note-title"
        className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden my-auto"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowRightCircle
              className="w-4 h-4 text-teal-700 shrink-0"
              aria-hidden="true"
            />
            <h2
              id="convert-note-title"
              className="text-base font-bold text-slate-900 truncate"
            >
              메모를 업무로 전환
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="업무 전환 창 닫기"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="p-3 rounded-lg border border-teal-200 bg-teal-50/70 text-xs text-teal-950 leading-relaxed">
            전환 후에도 <strong>원본 포스트잇 메모는 삭제되지 않고 그대로 보관</strong>됩니다.
            같은 메모에서 중복 업무가 생성되지 않도록 1회만 전환할 수 있습니다.
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="convert-task-title"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              새 업무 제목
            </label>
            <input
              id="convert-task-title"
              type="text"
              required
              maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
            />
          </div>

          <div>
            <label
              htmlFor="convert-task-description"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              상세 내용
            </label>
            <textarea
              id="convert-task-description"
              rows={3}
              maxLength={VALIDATION_LIMITS.DESCRIPTION_MAX_LEN}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="convert-task-priority"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                우선순위
              </label>
              <select
                id="convert-task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
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
                  htmlFor="convert-task-due"
                  className="text-xs font-medium text-slate-700"
                >
                  마감일 (선택)
                </label>
                {dueDateStr && (
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
                id="convert-task-due"
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
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={pending}
              className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
            >
              {pending ? '전환 중...' : '업무로 생성하기'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
