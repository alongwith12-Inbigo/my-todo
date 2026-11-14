import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { CalendarEventRecord } from '../types/domain';
import {
  createEvent as createEventOp,
  deleteEvent as deleteEventOp,
  EventConcurrencyError,
  EventValidationError,
  fetchEventsInRange as fetchEventsInRangeOp,
  fetchSingleEvent as fetchSingleEventOp,
  updateEvent as updateEventOp,
  type CreateEventInput,
  type UpdateEventPatch,
} from './eventOperations';

export {
  EventConcurrencyError,
  EventValidationError,
  type CreateEventInput,
  type UpdateEventPatch,
};

function rethrowEventError(
  error: unknown,
  operation: OperationType,
  path: string,
): never {
  if (
    error instanceof EventConcurrencyError ||
    error instanceof EventValidationError
  ) {
    throw error;
  }
  handleFirestoreError(error, operation, path);
}

export async function fetchSingleEvent(
  uid: string,
  eventId: string,
): Promise<CalendarEventRecord | null> {
  const path = `users/${uid}/events/${eventId}`;
  try {
    return await fetchSingleEventOp(db, uid, eventId);
  } catch (error) {
    rethrowEventError(error, OperationType.GET, path);
  }
}

export async function fetchEventsInRange(
  uid: string,
  rangeStartMs: number,
  rangeEndMs: number,
  maxRows = 250,
): Promise<CalendarEventRecord[]> {
  const path = `users/${uid}/events`;
  try {
    return await fetchEventsInRangeOp(db, uid, rangeStartMs, rangeEndMs, maxRows);
  } catch (error) {
    rethrowEventError(error, OperationType.LIST, path);
  }
}

export async function createEvent(
  uid: string,
  input: CreateEventInput,
  explicitEventId?: string,
): Promise<{ id: string; version: number }> {
  const path = explicitEventId
    ? `users/${uid}/events/${explicitEventId}`
    : `users/${uid}/events`;
  try {
    return await createEventOp(db, uid, input, explicitEventId);
  } catch (error) {
    rethrowEventError(error, OperationType.CREATE, path);
  }
}

export async function updateEvent(
  uid: string,
  eventId: string,
  expectedVersion: number,
  patch: UpdateEventPatch,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/events/${eventId}`;
  try {
    return await updateEventOp(db, uid, eventId, expectedVersion, patch);
  } catch (error) {
    rethrowEventError(error, OperationType.UPDATE, path);
  }
}

export async function deleteEvent(
  uid: string,
  eventId: string,
): Promise<{ clearedTaskId: string | null }> {
  const path = `users/${uid}/events/${eventId}`;
  try {
    return await deleteEventOp(db, uid, eventId);
  } catch (error) {
    rethrowEventError(error, OperationType.DELETE, path);
  }
}
