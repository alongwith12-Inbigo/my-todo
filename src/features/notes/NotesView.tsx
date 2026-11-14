import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Archive, Pin, Plus, RefreshCw, Search, StickyNote } from 'lucide-react';
import { formatKstTodayHeader } from '../../lib/dateKst';
import {
  filterNotesByQuery,
  NOTE_COLORS,
  partitionNotesByConversion,
} from '../../lib/notes';
import {
  VALIDATION_LIMITS,
  type NoteColor,
  type StickyNoteRecord,
} from '../../types/domain';
import { formatTaskErrorMessage } from '../tasks/taskErrors';
import { ConvertNoteModal } from './ConvertNoteModal';
import { NoteCard } from './NoteCard';
import { useNoteData } from './NoteDataContext';

type NotesViewTab = 'active' | 'converted';

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

  const [viewTab, setViewTab] = useState<NotesViewTab>('active');
  const [newContent, setNewContent] = useState('');
  const [newColor, setNewColor] = useState<NoteColor>('butter');
  const [newPinned, setNewPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [convertingNote, setConvertingNote] = useState<StickyNoteRecord | null>(
    null,
  );
  const [lastConvertedTaskId, setLastConvertedTaskId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    void ensureNotesLoaded();
  }, [ensureNotesLoaded]);

  const { activeNotes, convertedNotes } = useMemo(
    () => partitionNotesByConversion(notes),
    [notes],
  );

  const visibleActiveNotes = useMemo(
    () => filterNotesByQuery(activeNotes, searchTerm),
    [activeNotes, searchTerm],
  );

  const visibleConvertedNotes = useMemo(
    () => filterNotesByQuery(convertedNotes, searchTerm),
    [convertedNotes, searchTerm],
  );

  const pinnedNotes = useMemo(
    () => visibleActiveNotes.filter((n) => n.isPinned),
    [visibleActiveNotes],
  );
  const regularNotes = useMemo(
    () => visibleActiveNotes.filter((n) => !n.isPinned),
    [visibleActiveNotes],
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
            교실·교무실의 짧은 생각과 전달 사항을 붙여 두고, 업무로 전환한 원본은 따로 보관합니다.
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

      {/* View Tab Bar: Active Notes vs Converted Archive */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="메모 목록 보기 선택"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewTab === 'active'}
            onClick={() => setViewTab('active')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewTab === 'active'
                ? 'bg-white text-teal-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>메모 목록</span>
            <span className="tabular-nums text-[11px] opacity-80">
              {activeNotes.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={viewTab === 'converted'}
            onClick={() => {
              setViewTab('converted');
              setLastConvertedTaskId(null);
            }}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewTab === 'converted'
                ? 'bg-white text-teal-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Archive className="w-3.5 h-3.5" aria-hidden="true" />
            <span>전환된 메모 보기</span>
            <span className="tabular-nums text-[11px] opacity-80">
              {convertedNotes.length}
            </span>
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

      {lastConvertedTaskId && viewTab === 'active' && (
        <div
          role="status"
          className="p-3.5 rounded-lg border border-teal-200 bg-teal-50/70 text-xs text-teal-950 flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            메모를 업무로 전환했습니다. 기본 목록에서 숨겨졌으며, &apos;전환된 메모 보기&apos;에서 원본을 다시 확인할 수 있습니다.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {onOpenTask && (
              <button
                type="button"
                onClick={() => onOpenTask(lastConvertedTaskId)}
                className="px-3 py-1 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 whitespace-nowrap cursor-pointer"
              >
                업무 보기
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setViewTab('converted');
                setLastConvertedTaskId(null);
              }}
              className="px-3 py-1 text-xs font-semibold bg-white border border-teal-200 text-teal-900 rounded-md hover:bg-teal-100 whitespace-nowrap cursor-pointer"
            >
              전환된 메모 보기
            </button>
            <button
              type="button"
              onClick={() => setLastConvertedTaskId(null)}
              className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900 whitespace-nowrap cursor-pointer"
            >
              닫기
            </button>
          </div>
        </div>
      )}

      {viewTab === 'active' ? (
        <>
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

          {/* Active Notes Grid */}
          {notesLoading && notes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              포스트잇 메모를 불러오는 중입니다...
            </div>
          ) : visibleActiveNotes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
              <StickyNote
                className="w-8 h-8 text-slate-300 mx-auto"
                aria-hidden="true"
              />
              <h2 className="text-base font-semibold text-slate-900">
                {searchTerm.trim()
                  ? '기본 메모 목록에 일치하는 메모가 없습니다'
                  : convertedNotes.length > 0
                    ? '기본 메모 목록에 남은 메모가 없습니다'
                    : '아직 붙여 둔 포스트잇 메모가 없습니다'}
              </h2>
              <p className="text-sm text-slate-500">
                {searchTerm.trim()
                  ? '다른 키워드로 검색하거나 전환된 메모 보기에서 찾아보세요.'
                  : convertedNotes.length > 0
                    ? '업무로 전환된 원본 메모는 삭제되지 않고 전환된 메모 보기에 안전하게 보관되어 있습니다.'
                    : '위 입력 창에 메모를 적어 붙이면 자동 저장되며, 원할 때 업무로 바로 전환할 수 있습니다.'}
              </p>
              {convertedNotes.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setViewTab('converted')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap cursor-pointer"
                  >
                    <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>전환된 메모 보기 ({convertedNotes.length}건)</span>
                  </button>
                </div>
              )}
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
        </>
      ) : (
        /* Converted Notes Archive Tab */
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl border border-slate-200 bg-white text-xs text-slate-600 leading-relaxed">
            업무로 전환된 원본 메모입니다. 전환 후에도 원본은 삭제되지 않고 보관되며, 같은 메모에서 업무가 중복 생성되지 않도록 전환이 잠겨 있습니다. 각 카드의 <strong>업무 보기</strong>를 누르면 연결된 업무 상세 화면으로 이동합니다.
          </div>

          {notesLoading && notes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              전환된 메모를 불러오는 중입니다...
            </div>
          ) : visibleConvertedNotes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
              <Archive
                className="w-8 h-8 text-slate-300 mx-auto"
                aria-hidden="true"
              />
              <h2 className="text-base font-semibold text-slate-900">
                {searchTerm.trim()
                  ? '검색어와 일치하는 전환된 메모가 없습니다'
                  : '아직 업무로 전환된 메모가 없습니다'}
              </h2>
              <p className="text-sm text-slate-500">
                {searchTerm.trim()
                  ? '검색어를 지우거나 기본 메모 목록에서 확인해 주세요.'
                  : '메모 목록에서 메모의 "업무로 전환"을 누르면 원본은 이곳으로 이동해 보관됩니다.'}
              </p>
              {!searchTerm.trim() && (
                <div>
                  <button
                    type="button"
                    onClick={() => setViewTab('active')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap cursor-pointer"
                  >
                    <span>메모 목록으로 돌아가기</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <section aria-label="전환된 메모 목록" className="space-y-3">
              <div className="flex items-center gap-2">
                <Archive className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h2 className="text-sm font-bold text-slate-900">
                  업무로 전환된 원본 메모
                </h2>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {visibleConvertedNotes.length}장
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {visibleConvertedNotes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    canMoveUp={false}
                    canMoveDown={false}
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
        onConverted={(taskId) => setLastConvertedTaskId(taskId)}
      />
    </div>
  );
}
