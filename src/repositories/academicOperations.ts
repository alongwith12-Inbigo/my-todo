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
  where,
  writeBatch,
  type DocumentData,
  type FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  type Timestamp,
} from 'firebase/firestore';
import {
  buildAcademicDedupeKey,
  getSchoolYearQueryBounds,
  validateAcademicEventDraft,
  type AcademicEventDraft,
} from '../lib/academicCalendar';
import {
  isValidDateInputString,
  isValidFirestoreId,
  sanitizeSingleLine,
} from '../lib/dateKst';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type AcademicEventCategory,
  type AcademicEventRecord,
  type AcademicEventSourceType,
  type AcademicTimetableImpact,
} from '../types/domain';

export class AcademicEventConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `다른 창이나 기기에서 학사일정이 먼저 수정되었습니다. (예상 버전 ${expectedVersion}, 현재 버전 ${actualVersion})`,
    );
    this.name = 'AcademicEventConcurrencyError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class AcademicEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcademicEventValidationError';
  }
}

const VALID_CATEGORIES = new Set<AcademicEventCategory>([
  'exam',
  'school_event',
  'vacation',
  'discretionary_holiday',
  'shortened_schedule',
  'other',
]);

const VALID_SOURCES = new Set<AcademicEventSourceType>([
  'manual',
  'excel',
  'hwpx',
  'pdf',
  'ocr',
]);

const VALID_IMPACTS = new Set<AcademicTimetableImpact>([
  'none',
  'needs_check',
  'override_applied',
]);

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new AcademicEventValidationError('유효하지 않은 학사일정 버전입니다.');
  }
}

export function buildCreateAcademicEventPayload(
  draft: AcademicEventDraft,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const err = validateAcademicEventDraft(draft);
  if (err) {
    throw new AcademicEventValidationError(err);
  }

  const title = sanitizeSingleLine(draft.title, VALIDATION_LIMITS.TITLE_MAX_LEN);
  const category = VALID_CATEGORIES.has(draft.category) ? draft.category : 'other';
  const startDate = draft.startDate.trim();
  const endDate = draft.endDate.trim();
  const startTime = draft.startTime?.trim() || null;
  const endTime = draft.endTime?.trim() || null;
  const location = sanitizeSingleLine(
    draft.location ?? '',
    VALIDATION_LIMITS.LOCATION_MAX_LEN,
  );
  const sourceType = VALID_SOURCES.has(draft.sourceType)
    ? draft.sourceType
    : 'manual';
  const sourceLabel = sanitizeSingleLine(
    draft.sourceLabel || (sourceType === 'manual' ? '직접 입력' : '파일 가져오기'),
    VALIDATION_LIMITS.ACADEMIC_SOURCE_LABEL_MAX_LEN,
  );
  const sourceText = sanitizeSingleLine(
    draft.sourceText ?? '',
    VALIDATION_LIMITS.ACADEMIC_SOURCE_TEXT_MAX_LEN,
  );
  const timetableImpact = VALID_IMPACTS.has(draft.timetableImpact)
    ? draft.timetableImpact
    : 'none';
  const overrideDateKey =
    draft.overrideDateKey && isValidDateInputString(draft.overrideDateKey)
      ? draft.overrideDateKey.trim()
      : null;
  const dedupeKey = buildAcademicDedupeKey(startDate, endDate, title);

  return {
    title,
    category,
    startDate,
    endDate,
    startTime,
    endTime,
    location,
    schoolYear: draft.schoolYear,
    sourceType,
    sourceLabel,
    sourceText,
    timetableImpact,
    overrideDateKey,
    dedupeKey,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function buildUpdateAcademicEventFields(
  draft: AcademicEventDraft,
  nextVersion: number,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const validated = buildCreateAcademicEventPayload(draft, nowSentinel);
  return {
    title: validated.title,
    category: validated.category,
    startDate: validated.startDate,
    endDate: validated.endDate,
    startTime: validated.startTime,
    endTime: validated.endTime,
    location: validated.location,
    schoolYear: validated.schoolYear,
    timetableImpact: validated.timetableImpact,
    overrideDateKey: validated.overrideDateKey,
    dedupeKey: validated.dedupeKey,
    version: nextVersion,
    updatedAt: nowSentinel,
  };
}

function mapAcademicEventDoc(
  snap: QueryDocumentSnapshot<DocumentData>,
): AcademicEventRecord {
  const data = snap.data();
  return {
    id: snap.id,
    title: String(data.title ?? ''),
    category: VALID_CATEGORIES.has(data.category as AcademicEventCategory)
      ? (data.category as AcademicEventCategory)
      : 'other',
    startDate: String(data.startDate ?? ''),
    endDate: String(data.endDate ?? data.startDate ?? ''),
    startTime: (data.startTime ?? null) as string | null,
    endTime: (data.endTime ?? null) as string | null,
    location: String(data.location ?? ''),
    schoolYear: Number(data.schoolYear ?? 2026),
    sourceType: VALID_SOURCES.has(data.sourceType as AcademicEventSourceType)
      ? (data.sourceType as AcademicEventSourceType)
      : 'manual',
    sourceLabel: String(data.sourceLabel ?? ''),
    sourceText: String(data.sourceText ?? ''),
    timetableImpact: VALID_IMPACTS.has(
      data.timetableImpact as AcademicTimetableImpact,
    )
      ? (data.timetableImpact as AcademicTimetableImpact)
      : 'none',
    overrideDateKey: (data.overrideDateKey ?? null) as string | null,
    dedupeKey: String(data.dedupeKey ?? ''),
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

/**
 * Fetches academic events using a single-field range query on `startDate`
 * (zero composite indexes required) bounded to <= 400 docs.
 */
export async function fetchAcademicEventsBySchoolYear(
  db: Firestore,
  uid: string,
  schoolYear: number,
  maxRows = 400,
): Promise<AcademicEventRecord[]> {
  if (!isValidFirestoreId(uid)) {
    throw new AcademicEventValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const { rangeStart, rangeEnd } = getSchoolYearQueryBounds(schoolYear);
  const col = collection(db, 'users', uid, 'academicEvents');
  const q = query(
    col,
    where('startDate', '>=', rangeStart),
    where('startDate', '<=', rangeEnd),
    orderBy('startDate', 'asc'),
    limit(Math.max(1, Math.min(400, maxRows))),
  );
  const snap = await getDocs(q);
  return snap.docs.map(mapAcademicEventDoc);
}

export async function fetchSingleAcademicEvent(
  db: Firestore,
  uid: string,
  eventId: string,
): Promise<AcademicEventRecord | null> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(eventId)) {
    throw new AcademicEventValidationError('유효하지 않은 학사일정 식별자입니다.');
  }
  const snap = await getDoc(doc(db, 'users', uid, 'academicEvents', eventId));
  if (!snap.exists()) return null;
  return mapAcademicEventDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function createAcademicEvent(
  db: Firestore,
  uid: string,
  draft: AcademicEventDraft,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new AcademicEventValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const col = collection(db, 'users', uid, 'academicEvents');
  const ref = doc(col);
  if (!isValidFirestoreId(ref.id)) {
    throw new AcademicEventValidationError('유효하지 않은 학사일정 식별자입니다.');
  }
  const payload = buildCreateAcademicEventPayload(draft);
  await setDoc(ref, payload);
  return { id: ref.id, version: 1 };
}

export async function createAcademicEventsBatch(
  db: Firestore,
  uid: string,
  drafts: AcademicEventDraft[],
  existingDedupeKeys: Set<string>,
): Promise<{ createdIds: string[]; skippedDuplicateCount: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new AcademicEventValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  if (drafts.length > VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH) {
    throw new AcademicEventValidationError(
      `한 번에 최대 ${VALIDATION_LIMITS.ACADEMIC_MAX_IMPORT_BATCH}건까지만 일괄 등록할 수 있습니다.`,
    );
  }

  const seenKeys = new Set(existingDedupeKeys);
  const payloads: ReturnType<typeof buildCreateAcademicEventPayload>[] = [];
  let skippedDuplicateCount = 0;

  for (const draft of drafts) {
    const payload = buildCreateAcademicEventPayload(draft);
    if (seenKeys.has(payload.dedupeKey)) {
      skippedDuplicateCount += 1;
      continue;
    }
    seenKeys.add(payload.dedupeKey);
    payloads.push(payload);
  }

  if (payloads.length === 0) {
    return { createdIds: [], skippedDuplicateCount };
  }

  const col = collection(db, 'users', uid, 'academicEvents');
  const createdIds: string[] = [];

  // Firestore writeBatch supports up to 500 ops per commit; our max is 200.
  const batch = writeBatch(db);
  for (const payload of payloads) {
    const ref = doc(col);
    batch.set(ref, payload);
    createdIds.push(ref.id);
  }
  await batch.commit();

  return { createdIds, skippedDuplicateCount };
}

export async function updateAcademicEvent(
  db: Firestore,
  uid: string,
  eventId: string,
  expectedVersion: number,
  draft: AcademicEventDraft,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(eventId)) {
    throw new AcademicEventValidationError('유효하지 않은 학사일정 식별자입니다.');
  }
  assertValidVersion(expectedVersion);
  const previewFields = buildUpdateAcademicEventFields(draft, expectedVersion + 1);
  const ref = doc(db, 'users', uid, 'academicEvents', eventId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new AcademicEventValidationError('수정할 학사일정을 찾을 수 없습니다.');
    }
    const current = snap.data() as AcademicEventRecord;
    if (current.version !== expectedVersion) {
      throw new AcademicEventConcurrencyError(expectedVersion, current.version);
    }
    const nextVersion = current.version + 1;
    tx.update(ref, {
      ...previewFields,
      version: nextVersion,
      updatedAt: serverTimestamp(),
    });
    return { id: eventId, version: nextVersion };
  });
}

export async function deleteAcademicEvent(
  db: Firestore,
  uid: string,
  eventId: string,
): Promise<void> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(eventId)) {
    throw new AcademicEventValidationError('유효하지 않은 학사일정 식별자입니다.');
  }
  const ref = doc(db, 'users', uid, 'academicEvents', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return;
  }
  await deleteDoc(ref);
}
