import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRightCircle,
  ArrowUp,
  ExternalLink,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { timestampToDate } from '../../lib/briefing';
import { formatKstDateTime } from '../../lib/dateKst';
import { getNoteColorStyle, NOTE_COLORS } from '../../lib/notes';
import { NoteConcurrencyError } from '../../repositories/noteRepo';
import {
  VALIDATION_LIMITS,
  type NoteColor,
  type StickyNoteRecord,
} from '../../types/domain';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { useNoteData } from './NoteDataContext';

interface NoteCardProps {
  note: StickyNoteRecord;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRequestConvert: (note: StickyNoteRecord) => void;
  onOpenTask?: (taskId: string) => void;
}

export function NoteCard({
  note,
  canMoveUp,
  canMoveDown,
  onRequestConvert,
  onOpenTask,
}: NoteCardProps) {
  const {
    isNotePending,
    saveNotePatch,
    moveNoteOrder,
    removeNote,
    refreshSingleNote,
  } = useNoteData();

  const [draftContent, setDraftContent] = useState(note.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);

  const dirtyRef = useRef(false);
  const draftRef = useRef(note.content);
  const noteRef = useRef(note);
  const timerRef = useRef<number | null>(null);

  const isConverted = note.convertedTaskId !== null;
  noteRef.current = note;
  const pending = isNotePending(note.id);
  const style = getNoteColorStyle(note.color);

  // Sync external server updates when local draft has no unsaved edits
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraftContent(note.content);
      draftRef.current = note.content;
    }
  }, [note.content, note.version]);

  const flushContentSave = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;

    const latestNote = noteRef.current;
    if (latestNote.convertedTaskId !== null) {
      dirtyRef.current = false;
      return;
    }

    const nextText = draftRef.current.trim();
    if (!nextText) {
      setError('메모 내용은 비워둘 수 없습니다. 삭제하려면 휴지통 아이콘을 눌러 주세요.');
      return;
    }
    if (nextText === latestNote.content.trim()) {
      dirtyRef.current = false;
      setSaveState('idle');
      return;
    }

    setSaveState('saving');
    setError(null);
    setHasConflict(false);
    try {
      await saveNotePatch(latestNote.id, latestNote.version, {
        content: draftRef.current,
      });
      dirtyRef.current = false;
      setSaveState('saved');
    } catch (err) {
      if (err instanceof NoteConcurrencyError) {
        setHasConflict(true);
      }
      setError(formatTaskErrorMessage(err));
      setSaveState('idle');
    }
  }, [saveNotePatch]);

  // Clear saved indicator after 2 seconds
  useEffect(() => {
    if (saveState !== 'saved') return;
    const id = window.setTimeout(() => setSaveState('idle'), 2000);
    return () => window.clearTimeout(id);
  }, [saveState]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  function handleContentChange(value: string) {
    if (isConverted) return;
    setDraftContent(value);
    draftRef.current = value;
    dirtyRef.current = true;
    setSaveState('idle');
    setError(null);

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      void flushContentSave();
    }, 700);
  }

  async function handleColorChange(nextColor: NoteColor) {
    if (isConverted || pending || note.color === nextColor) return;
    setError(null);
    setHasConflict(false);
    try {
      await saveNotePatch(note.id, note.version, { color: nextColor });
    } catch (err) {
      if (err instanceof NoteConcurrencyError) setHasConflict(true);
      setError(formatTaskErrorMessage(err));
    }
  }

  async function handleTogglePin() {
    if (isConverted || pending) return;
    setError(null);
    setHasConflict(false);
    try {
      await saveNotePatch(note.id, note.version, { isPinned: !note.isPinned });
    } catch (err) {
      if (err instanceof NoteConcurrencyError) setHasConflict(true);
      setError(formatTaskErrorMessage(err));
    }
  }

  async function handleMove(direction: 'up' | 'down') {
    if (isConverted || pending) return;
    setError(null);
    setHasConflict(false);
    try {
      await moveNoteOrder(note.id, direction);
    } catch (err) {
      if (err instanceof NoteConcurrencyError) setHasConflict(true);
      setError(formatTaskErrorMessage(err));
    }
  }

  async function handleDelete() {
    if (pending) return;
    setError(null);
    try {
      await removeNote(note.id);
    } catch (err) {
      setError(formatTaskErrorMessage(err));
    }
  }

  async function handleReloadLatest() {
    setError(null);
    setHasConflict(false);
    dirtyRef.current = false;
    try {
      const fresh = await refreshSingleNote(note.id);
      if (fresh) {
        setDraftContent(fresh.content);
        draftRef.current = fresh.content;
      }
    } catch (err) {
      setError(formatTaskErrorMessage(err));
    }
  }

  const contentPreview = note.content.slice(0, 12).replace(/\s+/g, ' ') || '메모';

  return (
    <article
      className={`rounded-xl border p-4 flex flex-col gap-3 shadow-xs transition-colors ${style.cardBg} ${style.cardBorder}`}
    >
      {/* Top Action Row */}
      <div className="flex items-center justify-between gap-2">
        {isConverted ? (
          <span className="text-[11px] font-semibold text-teal-900">
            업무 전환됨 · 원본 보관
          </span>
        ) : (
          <div
            role="group"
            aria-label={`${contentPreview} 색상 변경`}
            className="flex items-center gap-1.5"
          >
            {NOTE_COLORS.map((c) => {
              const active = note.color === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={pending}
                  onClick={() => void handleColorChange(c.id)}
                  aria-label={`${c.label} 색상`}
                  aria-pressed={active}
                  title={c.label}
                  className={`w-4 h-4 rounded-full border cursor-pointer transition-transform ${c.swatchBg} ${
                    active
                      ? 'border-slate-900 scale-110 ring-1 ring-slate-900/30'
                      : 'border-slate-400/60 hover:scale-105'
                  }`}
                />
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-1">
          {!isConverted && (
            <>
              <button
                type="button"
                disabled={pending || !canMoveUp}
                onClick={() => void handleMove('up')}
                aria-label={`${contentPreview} 순서 위로`}
                title="앞으로 이동"
                className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 rounded hover:bg-black/5 cursor-pointer disabled:cursor-default"
              >
                <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
              </button>

              <button
                type="button"
                disabled={pending || !canMoveDown}
                onClick={() => void handleMove('down')}
                aria-label={`${contentPreview} 순서 아래로`}
                title="뒤로 이동"
                className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 rounded hover:bg-black/5 cursor-pointer disabled:cursor-default"
              >
                <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
              </button>

              <button
                type="button"
                disabled={pending}
                onClick={() => void handleTogglePin()}
                aria-label={note.isPinned ? `${contentPreview} 고정 해제` : `${contentPreview} 상단 고정`}
                aria-pressed={note.isPinned}
                title={note.isPinned ? '고정 해제' : '상단 고정'}
                className={`p-1 rounded hover:bg-black/5 cursor-pointer ${
                  note.isPinned ? 'text-teal-800' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {note.isPinned ? (
                  <PinOff className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            </>
          )}

          {!confirmDelete ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
              aria-label={`${contentPreview} 삭제`}
              title="메모 삭제"
              className="p-1 text-slate-500 hover:text-red-700 rounded hover:bg-black/5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : (
            <div className="flex items-center gap-1 ml-1">
              <button
                type="button"
                disabled={pending}
                onClick={() => void handleDelete()}
                className="px-2 py-0.5 text-[11px] font-semibold bg-red-700 text-white rounded hover:bg-red-800 cursor-pointer"
              >
                삭제
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-1.5 py-0.5 text-[11px] text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                취소
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Note Content (Editable when active, Read-only archive when converted) */}
      <div>
        <label htmlFor={`note-textarea-${note.id}`} className="sr-only">
          {isConverted ? '전환된 원본 포스트잇 메모 내용' : '포스트잇 메모 내용'}
        </label>
        <textarea
          id={`note-textarea-${note.id}`}
          rows={4}
          maxLength={VALIDATION_LIMITS.NOTE_CONTENT_MAX_LEN}
          readOnly={isConverted}
          aria-readonly={isConverted}
          value={draftContent}
          onChange={(e) => handleContentChange(e.target.value)}
          onBlur={() => void flushContentSave()}
          className={`w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-500 leading-relaxed resize-y rounded-md p-1 -m-1 focus:outline-none ${
            isConverted
              ? 'cursor-default focus:ring-0'
              : 'focus:ring-1 focus:ring-slate-900/20'
          }`}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="p-2.5 rounded-lg border border-red-300 bg-white/90 text-[11px] text-red-800 space-y-1.5"
        >
          <p>{error}</p>
          {hasConflict && (
            <button
              type="button"
              onClick={() => void handleReloadLatest()}
              className="inline-flex items-center gap-1 px-2 py-1 bg-red-50 border border-red-200 rounded font-semibold hover:bg-red-100 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              <span>최신 내용 불러오기</span>
            </button>
          )}
        </div>
      )}

      {/* Footer: Timestamp / Auto-save status + Task action */}
      <div className="pt-2 border-t border-black/10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-700">
        <div className="tabular-nums">
          {saveState === 'saving' ? (
            <span className="font-medium text-teal-800">저장 중...</span>
          ) : saveState === 'saved' ? (
            <span className="font-medium text-teal-800">저장됨</span>
          ) : (
            <span>{formatKstDateTime(timestampToDate(note.updatedAt))}</span>
          )}
        </div>

        {note.convertedTaskId ? (
          onOpenTask ? (
            <button
              type="button"
              onClick={() => onOpenTask(note.convertedTaskId!)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-teal-900 bg-white/85 border border-teal-700/30 rounded-md hover:bg-white hover:text-teal-950 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>업무 보기</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </button>
          ) : (
            <span className="font-medium text-teal-900">업무 전환됨</span>
          )
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => onRequestConvert(note)}
            className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:text-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowRightCircle className="w-3.5 h-3.5 text-teal-800" aria-hidden="true" />
            <span>업무로 전환</span>
          </button>
        )}
      </div>
    </article>
  );
}
