import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Pin, Plus, RefreshCw, Search, StickyNote } from 'lucide-react';
import { formatKstTodayHeader } from '../../lib/dateKst';
import { NOTE_COLORS } from '../../lib/notes';
import {
  VALIDATION_LIMITS,
  type NoteColor,
  type StickyNoteRecord,
} from '../../types/domain';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { ConvertNoteModal } from './ConvertNoteModal';
import { NoteCard } from './NoteCard';
import { useNoteData } from './NoteDataContext';

interface NotesViewProps {
  todayKey: string;
  now: Date;
  onOpenTask?: (taskId: string) => void;
}

export function NotesView({ now, onOpenTask }: NotesViewProps) {
  const {
    notes,
    notesLoading,
    notesError,
    usedIndexFallback,
    ensureNotesLoaded,
    refreshNotes,
    createNewNote,
  } = useNoteData();

  const [newContent, setNewContent] = useState('');
  const [newColor, setNewColor] = useState<NoteColor>('butter');
  const [newPinned, setNewPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [convertingNote, setConvertingNote] = useState<StickyNoteRecord | null>(
    null,
  );

  useEffect(() => {
    void ensureNotesLoaded();
  }, [ensureNotesLoaded]);

  const filteredNotes = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.content.toLowerCase().includes(q));
  }, [notes, searchTerm]);

  const pinnedNotes = useMemo(
    () => filteredNotes.filter((n) => n.isPinned),
    [filteredNotes],
  );
  const regularNotes = useMemo(
    () => filteredNotes.filter((n) => !n.isPinned),
    [filteredNotes],
  );

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setComposeError(null);

    const trimmed = newContent.trim();
    if (!trimmed) {
      setComposeError('메모 내용을 입력해 주세요.');
      return;
    }

    setSubmitting(true);
    try {
      await createNewNote({
        content: newContent,
        color: newColor,
        isPinned: newPinned,
      });
      setNewContent('');
      setNewPinned(false);
    } catch (err) {
      setComposeError(formatTaskErrorMessage(err));
    } finally {
      setSubmitting(false);
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
            포스트잇 메모
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            교실·교무실의 짧은 생각과 전달 사항을 붙여 두고, 필요하면 바로 업무로 전환하세요.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="notes-search" className="sr-only">
              메모 검색
            </label>
            <input
              id="notes-search"
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="메모 내용 검색"
              className="pl-8 pr-3 py-2 text-xs border border-slate-300 rounded-lg bg-white w-44 sm:w-52 focus:outline-none focus:border-teal-700"
            />
          </div>

          <button
            type="button"
            disabled={notesLoading}
            onClick={() => void refreshNotes()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${notesLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>새로고침</span>
          </button>
        </div>
      </div>

      {usedIndexFallback && (
        <div
          role="status"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900"
        >
          Firestore 포스트잇 복합 색인이 아직 배포되지 않아 기본 정렬 모드로 표시 중입니다.
          운영 프로젝트에 <code className="font-mono">firestore.indexes.json</code>의
          <code className="font-mono mx-1">notes</code> 색인을 추가하면 서버 정렬로 더 빠르게 조회됩니다.
        </div>
      )}

      {notesError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 flex items-center justify-between gap-3"
        >
          <span>{notesError}</span>
          <button
            type="button"
            onClick={() => void refreshNotes()}
            className="px-3 py-1 text-xs font-semibold bg-white border border-red-200 rounded-md hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* Quick Sticky Composer */}
      <form
        onSubmit={handleCreateSubmit}
        className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="new-note-content"
            className="text-xs font-semibold text-slate-800"
          >
            새 포스트잇 메모 붙이기
          </label>
          <span className="text-[11px] text-slate-400 tabular-nums">
            {newContent.length}/{VALIDATION_LIMITS.NOTE_CONTENT_MAX_LEN}
          </span>
        </div>

        <textarea
          id="new-note-content"
          rows={3}
          maxLength={VALIDATION_LIMITS.NOTE_CONTENT_MAX_LEN}
          value={newContent}
          onChange={(e) => {
            setNewContent(e.target.value);
            if (composeError) setComposeError(null);
          }}
          placeholder="예: 3학년 현장체험학습 버스 배차 확인, 학부모 상담 희망 시간 취합..."
          className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
        />

        {composeError && (
          <p role="alert" className="text-xs text-red-700">
            {composeError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-4">
            <div
              role="group"
              aria-label="새 메모 색상 선택"
              className="flex items-center gap-2"
            >
              <span className="text-xs text-slate-600">색상</span>
              {NOTE_COLORS.map((c) => {
                const selected = newColor === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setNewColor(c.id)}
                    aria-label={`새 메모 ${c.label}`}
                    aria-pressed={selected}
                    title={c.label}
                    className={`w-5 h-5 rounded-full border cursor-pointer transition-transform ${c.swatchBg} ${
                      selected
                        ? 'border-slate-900 scale-110 ring-2 ring-slate-900/20'
                        : 'border-slate-300 hover:scale-105'
                    }`}
                  />
                );
              })}
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={newPinned}
                onChange={(e) => setNewPinned(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
              />
              <span>상단 고정</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{submitting ? '붙이는 중...' : '메모 붙이기'}</span>
          </button>
        </div>
      </form>

      {/* Notes Grid */}
      {notesLoading && notes.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          포스트잇 메모를 불러오는 중입니다...
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <StickyNote
            className="w-8 h-8 text-slate-300 mx-auto"
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold text-slate-900">
            {searchTerm.trim()
              ? '검색어와 일치하는 메모가 없습니다'
              : '아직 붙여 둔 포스트잇 메모가 없습니다'}
          </h2>
          <p className="text-sm text-slate-500">
            {searchTerm.trim()
              ? '다른 키워드로 검색하거나 검색어를 지워 전체 메모를 확인하세요.'
              : '위 입력 창에 메모를 적어 붙이면 자동 저장되며, 원할 때 업무로 바로 전환할 수 있습니다.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {pinnedNotes.length > 0 && (
            <section aria-label="고정된 메모" className="space-y-3">
              <div className="flex items-center gap-2">
                <Pin className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h2 className="text-sm font-bold text-slate-900">고정된 메모</h2>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {pinnedNotes.length}장
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {pinnedNotes.map((note, idx) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    canMoveUp={!searchTerm.trim() && idx > 0}
                    canMoveDown={!searchTerm.trim() && idx < pinnedNotes.length - 1}
                    onRequestConvert={setConvertingNote}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </div>
            </section>
          )}

          {regularNotes.length > 0 && (
            <section aria-label="일반 메모" className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900">
                  {pinnedNotes.length > 0 ? '일반 메모' : '전체 메모'}
                </h2>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {regularNotes.length}장
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {regularNotes.map((note, idx) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    canMoveUp={!searchTerm.trim() && idx > 0}
                    canMoveDown={!searchTerm.trim() && idx < regularNotes.length - 1}
                    onRequestConvert={setConvertingNote}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <ConvertNoteModal
        note={convertingNote}
        onClose={() => setConvertingNote(null)}
        onConverted={onOpenTask}
      />
    </div>
  );
}
