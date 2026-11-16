import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  type Timestamp,
} from 'firebase/firestore';
import { isValidFirestoreId, sanitizeMultiline } from '../lib/dateKst';
import { sortStickyNotes } from '../lib/notes';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type NoteColor,
  type StickyNoteRecord,
} from '../types/domain';
import {
  buildCreateTaskPayload,
  type CreateTaskInput,
} from './taskOperations';
import { isMissingIndexError } from './taskQueries';

const VALID_NOTE_COLORS: readonly NoteColor[] = [
  'butter',
  'mint',
  'sky',
  'peach',
  'lavender',
];

export class NoteConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `다른 창이나 기기에서 메모가 먼저 수정되었습니다. (예상 버전 ${expectedVersion}, 현재 버전 ${actualVersion})`,
    );
    this.name = 'NoteConcurrencyError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteValidationError';
  }
}

export interface CreateNoteInput {
  content: string;
  color?: NoteColor;
  isPinned?: boolean;
  sortOrder?: number;
}

export interface UpdateNotePatch {
  content?: string;
  color?: NoteColor;
  isPinned?: boolean;
  sortOrder?: number;
}

export interface NotesQueryResult {
  notes: StickyNoteRecord[];
  usedIndexFallback: boolean;
}

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new NoteValidationError('유효하지 않은 메모 버전입니다.');
  }
}

function assertValidOwnerAndNoteId(uid: string, noteId: string): void {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(noteId)) {
    throw new NoteValidationError('유효하지 않은 사용자 또는 메모 식별자입니다.');
  }
}

function assertValidColor(color: NoteColor): NoteColor {
  if (!VALID_NOTE_COLORS.includes(color)) {
    throw new NoteValidationError('지원하지 않는 메모 색상입니다.');
  }
  return color;
}

function assertValidSortOrder(sortOrder: number): number {
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
    throw new NoteValidationError('메모 정렬 순서 값이 올바르지 않습니다.');
  }
  return sortOrder;
}

function mapNoteDoc(snap: QueryDocumentSnapshot<DocumentData>): StickyNoteRecord {
  const data = snap.data();
  return {
    id: snap.id,
    content: String(data.content ?? ''),
    color: (data.color ?? 'butter') as NoteColor,
    isPinned: Boolean(data.isPinned),
    sortOrder: Number(data.sortOrder ?? 0),
    convertedTaskId: (data.convertedTaskId ?? null) as string | null,
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

export function buildCreateNotePayload(
  input: CreateNoteInput,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const content = sanitizeMultiline(
    input.content ?? '',
    VALIDATION_LIMITS.NOTE_CONTENT_MAX_LEN,
  );
  if (content.length === 0) {
    throw new NoteValidationError('메모 내용을 입력해 주세요.');
  }

  const color = assertValidColor(input.color ?? 'butter');
  const sortOrder = assertValidSortOrder(input.sortOrder ?? 0);

  return {
    content,
    color,
    isPinned: Boolean(input.isPinned ?? false),
    sortOrder,
    convertedTaskId: null,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

export async function fetchAllNotes(
  db: Firestore,
  uid: string,
  maxRows = 200,
): Promise<NotesQueryResult> {
  if (!isValidFirestoreId(uid)) {
    throw new NoteValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const safeLimit = Math.min(Math.max(1, maxRows), 250);
  const notesCol = collection(db, 'users', uid, 'notes');

  try {
    const q = query(
      notesCol,
      orderBy('isPinned', 'desc'),
      orderBy('sortOrder', 'asc'),
      orderBy('updatedAt', 'desc'),
      limit(safeLimit),
    );
    const snap = await getDocs(q);
    return {
      notes: sortStickyNotes(snap.docs.map(mapNoteDoc)),
      usedIndexFallback: false,
    };
  } catch (error) {
    if (!isMissingIndexError(error)) {
      throw error;
    }
    const fallbackSnap = await getDocs(query(notesCol, limit(safeLimit)));
    return {
      notes: sortStickyNotes(fallbackSnap.docs.map(mapNoteDoc)),
      usedIndexFallback: true,
    };
  }
}

export async function fetchSingleNote(
  db: Firestore,
  uid: string,
  noteId: string,
): Promise<StickyNoteRecord | null> {
  assertValidOwnerAndNoteId(uid, noteId);
  const snap = await getDoc(doc(db, 'users', uid, 'notes', noteId));
  if (!snap.exists()) return null;
  return mapNoteDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function createNote(
  db: Firestore,
  uid: string,
  input: CreateNoteInput,
  explicitNoteId?: string,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new NoteValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const notesCol = collection(db, 'users', uid, 'notes');
  const noteRef = explicitNoteId ? doc(notesCol, explicitNoteId) : doc(notesCol);
  if (!isValidFirestoreId(noteRef.id)) {
    throw new NoteValidationError('유효하지 않은 메모 식별자입니다.');
  }

  const payload = buildCreateNotePayload(input);
  await setDoc(noteRef, payload);
  return { id: noteRef.id, version: 1 };
}

export async function updateNote(
  db: Firestore,
  uid: string,
  noteId: string,
  expectedVersion: number,
  patch: UpdateNotePatch,
): Promise<{ id: string; version: number; unchanged?: boolean }> {
  assertValidOwnerAndNoteId(uid, noteId);
  assertValidVersion(expectedVersion);

  const noteRef = doc(db, 'users', uid, 'notes', noteId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(noteRef);
    if (!snap.exists()) {
      throw new NoteValidationError('수정할 메모를 찾을 수 없습니다.');
    }

    const current = snap.data() as StickyNoteRecord;
    if (current.version !== expectedVersion) {
      throw new NoteConcurrencyError(expectedVersion, current.version);
    }

    const nextContent =
      patch.content !== undefined
        ? sanitizeMultiline(patch.content, VALIDATION_LIMITS.NOTE_CONTENT_MAX_LEN)
        : current.content;
    if (patch.content !== undefined && nextContent.length === 0) {
      throw new NoteValidationError('메모 내용을 비워둘 수 없습니다.');
    }

    const nextColor =
      patch.color !== undefined ? assertValidColor(patch.color) : current.color;
    const nextPinned =
      patch.isPinned !== undefined ? Boolean(patch.isPinned) : current.isPinned;
    const nextSortOrder =
      patch.sortOrder !== undefined
        ? assertValidSortOrder(patch.sortOrder)
        : current.sortOrder;

    if (
      nextContent === current.content &&
      nextColor === current.color &&
      nextPinned === Boolean(current.isPinned) &&
      nextSortOrder === Number(current.sortOrder ?? 0)
    ) {
      return { id: noteId, version: current.version, unchanged: true };
    }

    const nextVersion = current.version + 1;
    tx.update(noteRef, {
      content: nextContent,
      color: nextColor,
      isPinned: nextPinned,
      sortOrder: nextSortOrder,
      version: nextVersion,
      updatedAt: serverTimestamp(),
    });

    return { id: noteId, version: nextVersion };
  });
}

export async function reorderNotes(
  db: Firestore,
  uid: string,
  updates: { id: string; expectedVersion: number; sortOrder: number }[],
): Promise<void> {
  if (!isValidFirestoreId(uid)) {
    throw new NoteValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  if (updates.length === 0) return;

  for (const item of updates) {
    assertValidOwnerAndNoteId(uid, item.id);
    assertValidVersion(item.expectedVersion);
    assertValidSortOrder(item.sortOrder);
  }

  await runTransaction(db, async (tx) => {
    const snaps = await Promise.all(
      updates.map((item) => tx.get(doc(db, 'users', uid, 'notes', item.id))),
    );

    snaps.forEach((snap, idx) => {
      const target = updates[idx];
      if (!snap.exists()) {
        throw new NoteValidationError('순서를 변경할 메모를 찾을 수 없습니다.');
      }
      const current = snap.data() as StickyNoteRecord;
      if (current.version !== target.expectedVersion) {
        throw new NoteConcurrencyError(target.expectedVersion, current.version);
      }
      tx.update(snap.ref, {
        sortOrder: target.sortOrder,
        version: current.version + 1,
        updatedAt: serverTimestamp(),
      });
    });
  });
}

export async function deleteNote(
  db: Firestore,
  uid: string,
  noteId: string,
): Promise<void> {
  assertValidOwnerAndNoteId(uid, noteId);
  const noteRef = doc(db, 'users', uid, 'notes', noteId);
  const snap = await getDoc(noteRef);
  if (!snap.exists()) {
    throw new NoteValidationError('삭제할 메모를 찾을 수 없습니다.');
  }
  await deleteDoc(noteRef);
}

/**
 * Atomically converts a sticky note into a Task (sourceType='note') and links
 * `convertedTaskId` on the note without deleting the original note.
 * Rejects duplicate conversions if `convertedTaskId` is already set.
 */
export async function convertNoteToTask(
  db: Firestore,
  uid: string,
  noteId: string,
  expectedVersion: number,
  taskInput: Omit<CreateTaskInput, 'sourceType'>,
  explicitTaskId?: string,
): Promise<{ taskId: string; noteVersion: number }> {
  assertValidOwnerAndNoteId(uid, noteId);
  assertValidVersion(expectedVersion);

  const noteRef = doc(db, 'users', uid, 'notes', noteId);
  const tasksCol = collection(db, 'users', uid, 'tasks');
  const taskRef = explicitTaskId ? doc(tasksCol, explicitTaskId) : doc(tasksCol);
  if (!isValidFirestoreId(taskRef.id)) {
    throw new NoteValidationError('유효하지 않은 업무 식별자입니다.');
  }

  const taskPayload = buildCreateTaskPayload({
    ...taskInput,
    sourceType: 'note',
  });

  return runTransaction(db, async (tx) => {
    const noteSnap = await tx.get(noteRef);
    if (!noteSnap.exists()) {
      throw new NoteValidationError('업무로 전환할 메모를 찾을 수 없습니다.');
    }

    const current = noteSnap.data() as StickyNoteRecord;
    if (current.version !== expectedVersion) {
      throw new NoteConcurrencyError(expectedVersion, current.version);
    }
    if (current.convertedTaskId !== null) {
      throw new NoteValidationError(
        '이미 업무로 전환된 메모입니다. 중복 생성을 방지하기 위해 새 업무를 만들지 않았습니다.',
      );
    }

    const nextNoteVersion = current.version + 1;
    tx.set(taskRef, taskPayload);
    tx.update(noteRef, {
      convertedTaskId: taskRef.id,
      version: nextNoteVersion,
      updatedAt: serverTimestamp(),
    });

    return { taskId: taskRef.id, noteVersion: nextNoteVersion };
  });
}
