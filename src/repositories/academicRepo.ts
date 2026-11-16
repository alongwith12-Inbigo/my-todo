import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { AcademicEventDraft } from '../lib/academicCalendar';
import type { AcademicEventRecord } from '../types/domain';
import {
  AcademicEventConcurrencyError,
  AcademicEventValidationError,
  createAcademicEvent as createAcademicEventOp,
  createAcademicEventsBatch as createAcademicEventsBatchOp,
  deleteAcademicEvent as deleteAcademicEventOp,
  fetchAcademicEventsBySchoolYear as fetchAcademicEventsBySchoolYearOp,
  fetchSingleAcademicEvent as fetchSingleAcademicEventOp,
  updateAcademicEvent as updateAcademicEventOp,
} from './academicOperations';

export { AcademicEventConcurrencyError, AcademicEventValidationError };

function rethrowAcademicError(
  error: unknown,
  operation: OperationType,
  path: string,
): never {
  if (
    error instanceof AcademicEventConcurrencyError ||
    error instanceof AcademicEventValidationError
  ) {
    throw error;
  }
  handleFirestoreError(error, operation, path);
}

export async function fetchAcademicEventsBySchoolYear(
  uid: string,
  schoolYear: number,
): Promise<AcademicEventRecord[]> {
  const path = `users/${uid}/academicEvents`;
  try {
    return await fetchAcademicEventsBySchoolYearOp(db, uid, schoolYear);
  } catch (error) {
    rethrowAcademicError(error, OperationType.LIST, path);
  }
}

export async function fetchSingleAcademicEvent(
  uid: string,
  eventId: string,
): Promise<AcademicEventRecord | null> {
  const path = `users/${uid}/academicEvents/${eventId}`;
  try {
    return await fetchSingleAcademicEventOp(db, uid, eventId);
  } catch (error) {
    rethrowAcademicError(error, OperationType.GET, path);
  }
}

export async function createAcademicEvent(
  uid: string,
  draft: AcademicEventDraft,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/academicEvents`;
  try {
    return await createAcademicEventOp(db, uid, draft);
  } catch (error) {
    rethrowAcademicError(error, OperationType.CREATE, path);
  }
}

export async function createAcademicEventsBatch(
  uid: string,
  drafts: AcademicEventDraft[],
  existingDedupeKeys: Set<string>,
): Promise<{ createdIds: string[]; skippedDuplicateCount: number }> {
  const path = `users/${uid}/academicEvents`;
  try {
    return await createAcademicEventsBatchOp(
      db,
      uid,
      drafts,
      existingDedupeKeys,
    );
  } catch (error) {
    rethrowAcademicError(error, OperationType.WRITE, path);
  }
}

export async function updateAcademicEvent(
  uid: string,
  eventId: string,
  expectedVersion: number,
  draft: AcademicEventDraft,
): Promise<{ id: string; version: number; unchanged?: boolean }> {
  const path = `users/${uid}/academicEvents/${eventId}`;
  try {
    return await updateAcademicEventOp(
      db,
      uid,
      eventId,
      expectedVersion,
      draft,
    );
  } catch (error) {
    rethrowAcademicError(error, OperationType.UPDATE, path);
  }
}

export async function deleteAcademicEvent(
  uid: string,
  eventId: string,
): Promise<void> {
  const path = `users/${uid}/academicEvents/${eventId}`;
  try {
    return await deleteAcademicEventOp(db, uid, eventId);
  } catch (error) {
    rethrowAcademicError(error, OperationType.DELETE, path);
  }
}
