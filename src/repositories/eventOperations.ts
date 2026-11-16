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
  Timestamp,
  where,
  type DocumentData,
  type FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { compareEventsChronological } from '../lib/calendar';
import {
  isValidFirestoreId,
  sanitizeMultiline,
  sanitizeSingleLine,
} from '../lib/dateKst';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type CalendarEventRecord,
} from '../types/domain';

export class EventConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `다른 창이나 기기에서 일정이 먼저 수정되었습니다. (예상 버전 ${expectedVersion}, 현재 버전 ${actualVersion})`,
    );
    this.name = 'EventConcurrencyError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

export interface CreateEventInput {
  title: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  allDay: boolean;
  location?: string;
  description?: string;
  relatedTaskId?: string | null;
}

export interface UpdateEventPatch {
  title?: string;
  startsAt?: Timestamp;
  endsAt?: Timestamp;
  allDay?: boolean;
  location?: string;
  description?: string;
  relatedTaskId?: string | null;
}

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new EventValidationError('유효하지 않은 일정 버전입니다.');
  }
}

function assertValidOwnerAndEventId(uid: string, eventId: string): void {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(eventId)) {
    throw new EventValidationError('유효하지 않은 사용자 또는 일정 식별자입니다.');
  }
}

function assertValidRelatedTaskId(
  relatedTaskId: string | null | undefined,
): string | null {
  if (relatedTaskId === undefined || relatedTaskId === null) {
    return null;
  }
  if (!isValidFirestoreId(relatedTaskId)) {
    throw new EventValidationError('유효하지 않은 연결 업무 식별자입니다.');
  }
  return relatedTaskId;
}

function assertValidEventRange(startsAt: Timestamp, endsAt: Timestamp): void {
  if (!(startsAt instanceof Timestamp) || !(endsAt instanceof Timestamp)) {
    throw new EventValidationError('시작 시각과 종료 시각을 올바르게 지정해 주세요.');
  }
  if (endsAt.toMillis() < startsAt.toMillis()) {
    throw new EventValidationError('종료 시각은 시작 시각보다 빠를 수 없습니다.');
  }
}

function mapEventDoc(
  snap: QueryDocumentSnapshot<DocumentData>,
): CalendarEventRecord {
  const data = snap.data();
  return {
    id: snap.id,
    title: String(data.title ?? ''),
    startsAt: data.startsAt as Timestamp,
    endsAt: data.endsAt as Timestamp,
    allDay: Boolean(data.allDay),
    location: String(data.location ?? ''),
    description: String(data.description ?? ''),
    relatedTaskId: (data.relatedTaskId ?? null) as string | null,
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

export function buildCreateEventPayload(
  input: CreateEventInput,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const title = sanitizeSingleLine(
    input.title ?? '',
    VALIDATION_LIMITS.TITLE_MAX_LEN,
  );
  if (title.length < VALIDATION_LIMITS.TITLE_MIN_LEN) {
    throw new EventValidationError('일정 제목을 1자 이상 입력해 주세요.');
  }

  assertValidEventRange(input.startsAt, input.endsAt);

  const location = sanitizeSingleLine(
    input.location ?? '',
    VALIDATION_LIMITS.LOCATION_MAX_LEN,
  );
  const description = sanitizeMultiline(
    input.description ?? '',
    VALIDATION_LIMITS.DESCRIPTION_MAX_LEN,
  );
  const relatedTaskId = assertValidRelatedTaskId(input.relatedTaskId);

  return {
    title,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    allDay: Boolean(input.allDay),
    location,
    description,
    relatedTaskId,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

export async function fetchSingleEvent(
  db: Firestore,
  uid: string,
  eventId: string,
): Promise<CalendarEventRecord | null> {
  assertValidOwnerAndEventId(uid, eventId);
  const snap = await getDoc(doc(db, 'users', uid, 'events', eventId));
  if (!snap.exists()) return null;
  return mapEventDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function fetchEventsInRange(
  db: Firestore,
  uid: string,
  rangeStartMs: number,
  rangeEndMs: number,
  maxRows = 250,
): Promise<CalendarEventRecord[]> {
  if (!isValidFirestoreId(uid)) {
    throw new EventValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) {
    throw new EventValidationError('조회 기간이 올바르지 않습니다.');
  }
  const safeLimit = Math.min(Math.max(1, maxRows), 300);
  const eventsCol = collection(db, 'users', uid, 'events');
  const q = query(
    eventsCol,
    where('endsAt', '>=', Timestamp.fromMillis(rangeStartMs)),
    orderBy('endsAt', 'asc'),
    limit(safeLimit),
  );
  const snap = await getDocs(q);
  return snap.docs
    .map(mapEventDoc)
    .filter((item) => item.startsAt.toMillis() <= rangeEndMs)
    .sort(compareEventsChronological);
}

export async function createEvent(
  db: Firestore,
  uid: string,
  input: CreateEventInput,
  explicitEventId?: string,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new EventValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const eventsCol = collection(db, 'users', uid, 'events');
  const eventRef = explicitEventId
    ? doc(eventsCol, explicitEventId)
    : doc(eventsCol);
  if (!isValidFirestoreId(eventRef.id)) {
    throw new EventValidationError('유효하지 않은 일정 식별자입니다.');
  }

  const payload = buildCreateEventPayload(input);
  await setDoc(eventRef, payload);
  return { id: eventRef.id, version: 1 };
}

export async function updateEvent(
  db: Firestore,
  uid: string,
  eventId: string,
  expectedVersion: number,
  patch: UpdateEventPatch,
): Promise<{ id: string; version: number; unchanged?: boolean }> {
  assertValidOwnerAndEventId(uid, eventId);
  assertValidVersion(expectedVersion);

  const eventRef = doc(db, 'users', uid, 'events', eventId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) {
      throw new EventValidationError('수정할 일정을 찾을 수 없습니다.');
    }

    const current = snap.data() as CalendarEventRecord;
    if (current.version !== expectedVersion) {
      throw new EventConcurrencyError(expectedVersion, current.version);
    }

    const nextTitle =
      patch.title !== undefined
        ? sanitizeSingleLine(patch.title, VALIDATION_LIMITS.TITLE_MAX_LEN)
        : current.title;
    if (nextTitle.length < VALIDATION_LIMITS.TITLE_MIN_LEN) {
      throw new EventValidationError('일정 제목을 1자 이상 입력해 주세요.');
    }

    const nextStartsAt =
      patch.startsAt !== undefined ? patch.startsAt : current.startsAt;
    const nextEndsAt =
      patch.endsAt !== undefined ? patch.endsAt : current.endsAt;
    assertValidEventRange(nextStartsAt, nextEndsAt);

    const nextAllDay =
      patch.allDay !== undefined ? Boolean(patch.allDay) : current.allDay;
    const nextLocation =
      patch.location !== undefined
        ? sanitizeSingleLine(patch.location, VALIDATION_LIMITS.LOCATION_MAX_LEN)
        : current.location;
    const nextDescription =
      patch.description !== undefined
        ? sanitizeMultiline(patch.description, VALIDATION_LIMITS.DESCRIPTION_MAX_LEN)
        : current.description;
    const nextRelatedTaskId =
      patch.relatedTaskId !== undefined
        ? assertValidRelatedTaskId(patch.relatedTaskId)
        : current.relatedTaskId;

    if (
      nextTitle === current.title &&
      nextStartsAt.toMillis() === current.startsAt.toMillis() &&
      nextEndsAt.toMillis() === current.endsAt.toMillis() &&
      nextAllDay === Boolean(current.allDay) &&
      nextLocation === (current.location ?? '') &&
      nextDescription === (current.description ?? '') &&
      (nextRelatedTaskId ?? null) === (current.relatedTaskId ?? null)
    ) {
      return { id: eventId, version: current.version, unchanged: true };
    }

    const nextVersion = current.version + 1;
    tx.update(eventRef, {
      title: nextTitle,
      startsAt: nextStartsAt,
      endsAt: nextEndsAt,
      allDay: nextAllDay,
      location: nextLocation,
      description: nextDescription,
      relatedTaskId: nextRelatedTaskId,
      version: nextVersion,
      updatedAt: serverTimestamp(),
    });

    return { id: eventId, version: nextVersion };
  });
}

/**
 * Deletes the event and safely detaches `relatedEventId` on a linked task
 * if (and only if) that task exists and points to this deleted event.
 * Never deletes or alters the task's core status, dates, or content.
 */
export async function deleteEvent(
  db: Firestore,
  uid: string,
  eventId: string,
): Promise<{ clearedTaskId: string | null }> {
  assertValidOwnerAndEventId(uid, eventId);
  const eventRef = doc(db, 'users', uid, 'events', eventId);
  const eventSnap = await getDoc(eventRef);
  if (!eventSnap.exists()) {
    throw new EventValidationError('삭제할 일정을 찾을 수 없습니다.');
  }

  const relatedTaskId = (eventSnap.data().relatedTaskId ?? null) as string | null;
  await deleteDoc(eventRef);

  if (!relatedTaskId || !isValidFirestoreId(relatedTaskId)) {
    return { clearedTaskId: null };
  }

  const taskRef = doc(db, 'users', uid, 'tasks', relatedTaskId);
  try {
    let cleared = false;
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists()) return;
      const taskData = taskSnap.data();
      if (taskData.isDeleted === true) return;
      if (taskData.relatedEventId !== eventId) return;
      tx.update(taskRef, {
        relatedEventId: null,
        version: Number(taskData.version ?? 1) + 1,
        updatedAt: serverTimestamp(),
      });
      cleared = true;
    });
    return { clearedTaskId: cleared ? relatedTaskId : null };
  } catch {
    // Task detachment is best-effort; event deletion remains successful without harming the task.
    return { clearedTaskId: null };
  }
}
