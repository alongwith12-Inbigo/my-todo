import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { TimetableDraft } from '../lib/timetable';
import type {
  TimetableOverrideRecord,
  TimetableRecord,
} from '../types/domain';
import {
  createTimetable as createTimetableOp,
  deleteTimetable as deleteTimetableOp,
  deleteTimetableOverride as deleteTimetableOverrideOp,
  fetchAllTimetableOverrides as fetchAllTimetableOverridesOp,
  fetchAllTimetables as fetchAllTimetablesOp,
  fetchSingleTimetable as fetchSingleTimetableOp,
  fetchSingleTimetableOverride as fetchSingleTimetableOverrideOp,
  TimetableConcurrencyError,
  TimetableValidationError,
  updateTimetable as updateTimetableOp,
  upsertTimetableOverride as upsertTimetableOverrideOp,
  type UpsertTimetableOverrideInput,
} from './timetableOperations';

export {
  TimetableConcurrencyError,
  TimetableValidationError,
  type UpsertTimetableOverrideInput,
};

function rethrowTimetableError(
  error: unknown,
  operation: OperationType,
  path: string,
): never {
  if (
    error instanceof TimetableConcurrencyError ||
    error instanceof TimetableValidationError
  ) {
    throw error;
  }
  handleFirestoreError(error, operation, path);
}

export async function fetchAllTimetables(uid: string): Promise<TimetableRecord[]> {
  const path = `users/${uid}/timetables`;
  try {
    return await fetchAllTimetablesOp(db, uid);
  } catch (error) {
    rethrowTimetableError(error, OperationType.LIST, path);
  }
}

export async function fetchSingleTimetable(
  uid: string,
  timetableId: string,
): Promise<TimetableRecord | null> {
  const path = `users/${uid}/timetables/${timetableId}`;
  try {
    return await fetchSingleTimetableOp(db, uid, timetableId);
  } catch (error) {
    rethrowTimetableError(error, OperationType.GET, path);
  }
}

export async function createTimetable(
  uid: string,
  draft: TimetableDraft,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/timetables`;
  try {
    return await createTimetableOp(db, uid, draft);
  } catch (error) {
    rethrowTimetableError(error, OperationType.CREATE, path);
  }
}

export async function updateTimetable(
  uid: string,
  timetableId: string,
  expectedVersion: number,
  draft: TimetableDraft,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/timetables/${timetableId}`;
  try {
    return await updateTimetableOp(db, uid, timetableId, expectedVersion, draft);
  } catch (error) {
    rethrowTimetableError(error, OperationType.UPDATE, path);
  }
}

export async function deleteTimetable(
  uid: string,
  timetableId: string,
): Promise<void> {
  const path = `users/${uid}/timetables/${timetableId}`;
  try {
    return await deleteTimetableOp(db, uid, timetableId);
  } catch (error) {
    rethrowTimetableError(error, OperationType.DELETE, path);
  }
}

export async function fetchAllTimetableOverrides(
  uid: string,
): Promise<TimetableOverrideRecord[]> {
  const path = `users/${uid}/timetableOverrides`;
  try {
    return await fetchAllTimetableOverridesOp(db, uid);
  } catch (error) {
    rethrowTimetableError(error, OperationType.LIST, path);
  }
}

export async function fetchSingleTimetableOverride(
  uid: string,
  dateKey: string,
): Promise<TimetableOverrideRecord | null> {
  const path = `users/${uid}/timetableOverrides/${dateKey}`;
  try {
    return await fetchSingleTimetableOverrideOp(db, uid, dateKey);
  } catch (error) {
    rethrowTimetableError(error, OperationType.GET, path);
  }
}

export async function upsertTimetableOverride(
  uid: string,
  input: UpsertTimetableOverrideInput,
  expectedVersion?: number,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/timetableOverrides/${input.dateKey}`;
  try {
    return await upsertTimetableOverrideOp(db, uid, input, expectedVersion);
  } catch (error) {
    rethrowTimetableError(error, OperationType.WRITE, path);
  }
}

export async function deleteTimetableOverride(
  uid: string,
  dateKey: string,
): Promise<void> {
  const path = `users/${uid}/timetableOverrides/${dateKey}`;
  try {
    return await deleteTimetableOverrideOp(db, uid, dateKey);
  } catch (error) {
    rethrowTimetableError(error, OperationType.DELETE, path);
  }
}
