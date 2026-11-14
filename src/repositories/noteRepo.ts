import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { StickyNoteRecord } from '../types/domain';
import {
  convertNoteToTask as convertNoteToTaskOp,
  createNote as createNoteOp,
  deleteNote as deleteNoteOp,
  fetchAllNotes as fetchAllNotesOp,
  fetchSingleNote as fetchSingleNoteOp,
  NoteConcurrencyError,
  NoteValidationError,
  reorderNotes as reorderNotesOp,
  updateNote as updateNoteOp,
  type CreateNoteInput,
  type NotesQueryResult,
  type UpdateNotePatch,
} from './noteOperations';
import type { CreateTaskInput } from './taskOperations';

export {
  NoteConcurrencyError,
  NoteValidationError,
  type CreateNoteInput,
  type NotesQueryResult,
  type UpdateNotePatch,
};

function rethrowNoteError(
  error: unknown,
  operation: OperationType,
  path: string,
): never {
  if (
    error instanceof NoteConcurrencyError ||
    error instanceof NoteValidationError ||
    error?.constructor?.name === 'TaskValidationError'
  ) {
    throw error;
  }
  handleFirestoreError(error, operation, path);
}

export async function fetchAllNotes(
  uid: string,
  maxRows = 200,
): Promise<NotesQueryResult> {
  const path = `users/${uid}/notes`;
  try {
    return await fetchAllNotesOp(db, uid, maxRows);
  } catch (error) {
    rethrowNoteError(error, OperationType.LIST, path);
  }
}

export async function fetchSingleNote(
  uid: string,
  noteId: string,
): Promise<StickyNoteRecord | null> {
  const path = `users/${uid}/notes/${noteId}`;
  try {
    return await fetchSingleNoteOp(db, uid, noteId);
  } catch (error) {
    rethrowNoteError(error, OperationType.GET, path);
  }
}

export async function createNote(
  uid: string,
  input: CreateNoteInput,
  explicitNoteId?: string,
): Promise<{ id: string; version: number }> {
  const path = explicitNoteId
    ? `users/${uid}/notes/${explicitNoteId}`
    : `users/${uid}/notes`;
  try {
    return await createNoteOp(db, uid, input, explicitNoteId);
  } catch (error) {
    rethrowNoteError(error, OperationType.CREATE, path);
  }
}

export async function updateNote(
  uid: string,
  noteId: string,
  expectedVersion: number,
  patch: UpdateNotePatch,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/notes/${noteId}`;
  try {
    return await updateNoteOp(db, uid, noteId, expectedVersion, patch);
  } catch (error) {
    rethrowNoteError(error, OperationType.UPDATE, path);
  }
}

export async function reorderNotes(
  uid: string,
  updates: { id: string; expectedVersion: number; sortOrder: number }[],
): Promise<void> {
  const path = `users/${uid}/notes`;
  try {
    await reorderNotesOp(db, uid, updates);
  } catch (error) {
    rethrowNoteError(error, OperationType.UPDATE, path);
  }
}

export async function deleteNote(uid: string, noteId: string): Promise<void> {
  const path = `users/${uid}/notes/${noteId}`;
  try {
    await deleteNoteOp(db, uid, noteId);
  } catch (error) {
    rethrowNoteError(error, OperationType.DELETE, path);
  }
}

export async function convertNoteToTask(
  uid: string,
  noteId: string,
  expectedVersion: number,
  taskInput: Omit<CreateTaskInput, 'sourceType'>,
  explicitTaskId?: string,
): Promise<{ taskId: string; noteVersion: number }> {
  const path = `users/${uid}/notes/${noteId}`;
  try {
    return await convertNoteToTaskOp(
      db,
      uid,
      noteId,
      expectedVersion,
      taskInput,
      explicitTaskId,
    );
  } catch (error) {
    rethrowNoteError(error, OperationType.UPDATE, path);
  }
}
