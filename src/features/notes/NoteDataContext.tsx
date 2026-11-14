import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  computeReorderedNoteUpdates,
  getNextNoteSortOrder,
  sortStickyNotes,
} from '../../lib/notes';
import {
  convertNoteToTask,
  createNote,
  deleteNote,
  fetchAllNotes,
  fetchSingleNote,
  reorderNotes,
  updateNote,
  type CreateNoteInput,
  type UpdateNotePatch,
} from '../../repositories/noteRepo';
import type { CreateTaskInput } from '../../repositories/taskRepo';
import type { StickyNoteRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useTaskData } from '../tasks/TaskDataContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';

interface NoteDataContextValue {
  notes: StickyNoteRecord[];
  notesLoading: boolean;
  notesError: string | null;
  usedIndexFallback: boolean;
  hasLoadedOnce: boolean;
  isNotePending: (noteId: string) => boolean;
  ensureNotesLoaded: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  refreshSingleNote: (noteId: string) => Promise<StickyNoteRecord | null>;
  createNewNote: (input: CreateNoteInput) => Promise<StickyNoteRecord>;
  saveNotePatch: (
    noteId: string,
    expectedVersion: number,
    patch: UpdateNotePatch,
  ) => Promise<StickyNoteRecord | null>;
  moveNoteOrder: (
    noteId: string,
    direction: 'up' | 'down',
  ) => Promise<void>;
  removeNote: (noteId: string) => Promise<void>;
  convertNote: (
    noteId: string,
    expectedVersion: number,
    taskInput: Omit<CreateTaskInput, 'sourceType'>,
  ) => Promise<{ taskId: string; note: StickyNoteRecord | null }>;
}

const NoteDataContext = createContext<NoteDataContextValue | null>(null);

export function NoteDataProvider({ children }: { children: ReactNode }) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const { refreshSingleTask } = useTaskData();

  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';

  const [notes, setNotes] = useState<StickyNoteRecord[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [usedIndexFallback, setUsedIndexFallback] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const loadedUidRef = useRef<string | null>(null);
  const inFlightSetRef = useRef<Set<string>>(new Set());
  const createInFlightRef = useRef(false);

  const markPending = useCallback((noteId: string, active: boolean) => {
    if (active) {
      inFlightSetRef.current.add(noteId);
    } else {
      inFlightSetRef.current.delete(noteId);
    }
    setPendingIds(Array.from(inFlightSetRef.current));
  }, []);

  const isNotePending = useCallback(
    (noteId: string) => pendingIds.includes(noteId),
    [pendingIds],
  );

  const refreshNotes = useCallback(async () => {
    if (!uid || !isActive) return;
    setNotesLoading(true);
    setNotesError(null);
    try {
      const result = await fetchAllNotes(uid, 200);
      setNotes(result.notes);
      setUsedIndexFallback(result.usedIndexFallback);
      setHasLoadedOnce(true);
      loadedUidRef.current = uid;
    } catch (err) {
      setNotesError(formatTaskErrorMessage(err));
    } finally {
      setNotesLoading(false);
    }
  }, [uid, isActive]);

  const ensureNotesLoaded = useCallback(async () => {
    if (!uid || !isActive) return;
    if (loadedUidRef.current === uid && hasLoadedOnce) return;
    await refreshNotes();
  }, [uid, isActive, hasLoadedOnce, refreshNotes]);

  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      setNotes([]);
      setNotesError(null);
      setUsedIndexFallback(false);
      setHasLoadedOnce(false);
      loadedUidRef.current = null;
    }
  }, [uid, isActive, workspace]);

  const refreshSingleNote = useCallback(
    async (noteId: string): Promise<StickyNoteRecord | null> => {
      if (!uid) return null;
      const fresh = await fetchSingleNote(uid, noteId);
      setNotes((prev) => {
        const filtered = prev.filter((item) => item.id !== noteId);
        return fresh ? sortStickyNotes([fresh, ...filtered]) : filtered;
      });
      return fresh;
    },
    [uid],
  );

  const createNewNote = useCallback(
    async (input: CreateNoteInput): Promise<StickyNoteRecord> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 메모를 작성할 수 있습니다.');
      }
      if (createInFlightRef.current) {
        throw new Error('메모 저장 요청이 이미 처리 중입니다.');
      }
      createInFlightRef.current = true;
      try {
        const sortOrder = input.sortOrder ?? getNextNoteSortOrder(notes);
        const created = await createNote(uid, { ...input, sortOrder });
        const fresh = await fetchSingleNote(uid, created.id);
        if (!fresh) {
          throw new Error('작성한 메모를 불러오지 못했습니다.');
        }
        setNotes((prev) => sortStickyNotes([fresh, ...prev]));
        setHasLoadedOnce(true);
        loadedUidRef.current = uid;
        return fresh;
      } finally {
        createInFlightRef.current = false;
      }
    },
    [uid, isActive, notes],
  );

  const saveNotePatch = useCallback(
    async (
      noteId: string,
      expectedVersion: number,
      patch: UpdateNotePatch,
    ): Promise<StickyNoteRecord | null> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 메모를 수정할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(noteId)) {
        throw new Error('이미 저장 중인 메모 요청이 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      markPending(noteId, true);
      try {
        await updateNote(uid, noteId, expectedVersion, patch);
        return await refreshSingleNote(noteId);
      } finally {
        markPending(noteId, false);
      }
    },
    [uid, isActive, markPending, refreshSingleNote],
  );

  const moveNoteOrder = useCallback(
    async (noteId: string, direction: 'up' | 'down') => {
      if (!uid || !isActive) return;
      const target = notes.find((n) => n.id === noteId);
      if (!target) return;

      const groupNotes = notes.filter((n) => n.isPinned === target.isPinned);
      const orderUpdates = computeReorderedNoteUpdates(groupNotes, noteId, direction);
      if (orderUpdates.length === 0) return;

      const txUpdates = orderUpdates
        .map((upd) => {
          const item = notes.find((n) => n.id === upd.id);
          if (!item) return null;
          return {
            id: item.id,
            expectedVersion: item.version,
            sortOrder: upd.sortOrder,
          };
        })
        .filter((item): item is { id: string; expectedVersion: number; sortOrder: number } => item !== null);

      if (txUpdates.length === 0) return;

      txUpdates.forEach((item) => markPending(item.id, true));
      try {
        await reorderNotes(uid, txUpdates);
        await refreshNotes();
      } finally {
        txUpdates.forEach((item) => markPending(item.id, false));
      }
    },
    [uid, isActive, notes, markPending, refreshNotes],
  );

  const removeNote = useCallback(
    async (noteId: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 메모를 삭제할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(noteId)) {
        throw new Error('이미 처리 중인 메모 요청이 있습니다.');
      }
      markPending(noteId, true);
      try {
        await deleteNote(uid, noteId);
        setNotes((prev) => prev.filter((item) => item.id !== noteId));
      } finally {
        markPending(noteId, false);
      }
    },
    [uid, isActive, markPending],
  );

  const convertNote = useCallback(
    async (
      noteId: string,
      expectedVersion: number,
      taskInput: Omit<CreateTaskInput, 'sourceType'>,
    ): Promise<{ taskId: string; note: StickyNoteRecord | null }> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 메모를 업무로 전환할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(noteId)) {
        throw new Error('이미 전환 처리 중인 메모입니다.');
      }
      markPending(noteId, true);
      try {
        const res = await convertNoteToTask(uid, noteId, expectedVersion, taskInput);
        const updatedNote = await refreshSingleNote(noteId);
        await refreshSingleTask(res.taskId);
        return { taskId: res.taskId, note: updatedNote };
      } finally {
        markPending(noteId, false);
      }
    },
    [uid, isActive, markPending, refreshSingleNote, refreshSingleTask],
  );

  const value = useMemo<NoteDataContextValue>(
    () => ({
      notes,
      notesLoading,
      notesError,
      usedIndexFallback,
      hasLoadedOnce,
      isNotePending,
      ensureNotesLoaded,
      refreshNotes,
      refreshSingleNote,
      createNewNote,
      saveNotePatch,
      moveNoteOrder,
      removeNote,
      convertNote,
    }),
    [
      notes,
      notesLoading,
      notesError,
      usedIndexFallback,
      hasLoadedOnce,
      isNotePending,
      ensureNotesLoaded,
      refreshNotes,
      refreshSingleNote,
      createNewNote,
      saveNotePatch,
      moveNoteOrder,
      removeNote,
      convertNote,
    ],
  );

  return (
    <NoteDataContext.Provider value={value}>{children}</NoteDataContext.Provider>
  );
}

export function useNoteData(): NoteDataContextValue {
  const ctx = useContext(NoteDataContext);
  if (!ctx) {
    throw new Error('useNoteData는 NoteDataProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
