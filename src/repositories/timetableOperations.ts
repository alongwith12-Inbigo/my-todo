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
import {
  isValidDateInputString,
  isValidFirestoreId,
  isValidTimeInputString,
  sanitizeSingleLine,
} from '../lib/dateKst';
import {
  makeSlotKey,
  TIMETABLE_WEEKDAYS,
  validateTimetableDraft,
  type TimetableDraft,
} from '../lib/timetable';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type TimetableOverrideRecord,
  type TimetableOverrideSlot,
  type TimetablePeriodTime,
  type TimetableRecord,
  type TimetableSlot,
  type TimetableSlotKind,
  type TimetableSourceType,
  type TimetableWeekday,
} from '../types/domain';

export class TimetableConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `다른 창이나 기기에서 시간표가 먼저 수정되었습니다. (예상 버전 ${expectedVersion}, 현재 버전 ${actualVersion})`,
    );
    this.name = 'TimetableConcurrencyError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class TimetableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimetableValidationError';
  }
}

export interface UpsertTimetableOverrideInput {
  dateKey: string;
  baseTimetableId: string | null;
  reason?: string;
  workStart?: string | null;
  workEnd?: string | null;
  lunchStart?: string | null;
  lunchEnd?: string | null;
  periodTimes?: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableOverrideSlot>;
}

const VALID_KINDS = new Set<TimetableSlotKind>([
  'class',
  'free',
  'fixed_duty',
  'other',
]);

const VALID_SOURCES = new Set<TimetableSourceType>([
  'manual',
  'excel',
  'hwpx',
  'pdf',
  'ocr',
]);

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new TimetableValidationError('유효하지 않은 시간표 버전입니다.');
  }
}

function sanitizeSlotKind(kind: unknown): TimetableSlotKind {
  if (typeof kind === 'string' && VALID_KINDS.has(kind as TimetableSlotKind)) {
    return kind as TimetableSlotKind;
  }
  return 'free';
}

function sanitizePeriodTimesMap(
  rawMap: Record<string, TimetablePeriodTime>,
  periodCount: number,
): Record<string, TimetablePeriodTime> {
  const result: Record<string, TimetablePeriodTime> = {};
  for (let p = 1; p <= periodCount; p++) {
    const key = String(p);
    const entry = rawMap[key];
    if (!entry) {
      throw new TimetableValidationError(`${p}교시 시간 정보가 누락되었습니다.`);
    }
    if (
      !isValidTimeInputString(entry.startTime) ||
      !isValidTimeInputString(entry.endTime) ||
      entry.endTime <= entry.startTime
    ) {
      throw new TimetableValidationError(`${p}교시 시작·종료 시각이 올바르지 않습니다.`);
    }
    result[key] = {
      period: p,
      label: sanitizeSingleLine(entry.label || `${p}교시`, 20) || `${p}교시`,
      startTime: entry.startTime.trim(),
      endTime: entry.endTime.trim(),
    };
  }
  return result;
}

function sanitizeSlotsMap(
  rawSlots: Record<string, TimetableSlot>,
  periodCount: number,
): Record<string, TimetableSlot> {
  const result: Record<string, TimetableSlot> = {};
  for (const w of TIMETABLE_WEEKDAYS) {
    for (let p = 1; p <= periodCount; p++) {
      const key = makeSlotKey(w.day, p);
      const raw = rawSlots[key];
      const kind = sanitizeSlotKind(raw?.kind);
      const subject = sanitizeSingleLine(
        raw?.subject ?? '',
        VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN,
      );
      const className = sanitizeSingleLine(
        raw?.className ?? '',
        VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN,
      );
      const classroom = sanitizeSingleLine(
        raw?.classroom ?? '',
        VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN,
      );
      const note = sanitizeSingleLine(
        raw?.note ?? '',
        VALIDATION_LIMITS.TIMETABLE_NOTE_MAX_LEN,
      );
      // Only free or other slots may be marked workable, and never automatically
      const workAvailable =
        kind === 'class' || kind === 'fixed_duty'
          ? false
          : Boolean(raw?.workAvailable);

      result[key] = {
        day: w.day as TimetableWeekday,
        period: p,
        kind,
        subject,
        className,
        classroom,
        note,
        workAvailable,
      };
    }
  }
  return result;
}

export function buildCreateTimetablePayload(
  draft: TimetableDraft,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const validationErr = validateTimetableDraft(draft);
  if (validationErr) {
    throw new TimetableValidationError(validationErr);
  }

  const name = sanitizeSingleLine(
    draft.name,
    VALIDATION_LIMITS.TIMETABLE_NAME_MAX_LEN,
  );
  const semesterLabel = sanitizeSingleLine(
    draft.semesterLabel ?? '',
    VALIDATION_LIMITS.TIMETABLE_SEMESTER_MAX_LEN,
  );
  const sourceType = VALID_SOURCES.has(draft.sourceType)
    ? draft.sourceType
    : 'manual';

  const periodTimes = sanitizePeriodTimesMap(draft.periodTimes, draft.periodCount);
  const slots = sanitizeSlotsMap(draft.slots, draft.periodCount);

  return {
    name,
    semesterLabel,
    effectiveFrom: draft.effectiveFrom.trim(),
    effectiveTo: draft.effectiveTo.trim(),
    workStart: draft.workStart.trim(),
    workEnd: draft.workEnd.trim(),
    lunchStart: draft.lunchStart.trim(),
    lunchEnd: draft.lunchEnd.trim(),
    periodCount: draft.periodCount,
    periodTimes,
    slots,
    isActive: Boolean(draft.isActive),
    sourceType,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function buildCreateTimetableOverridePayload(
  input: UpsertTimetableOverrideInput,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const dateKey = input.dateKey.trim();
  if (!isValidDateInputString(dateKey)) {
    throw new TimetableValidationError('올바른 임시 변경 날짜(YYYY-MM-DD)가 아닙니다.');
  }

  const baseTimetableId = input.baseTimetableId
    ? isValidFirestoreId(input.baseTimetableId)
      ? input.baseTimetableId
      : (() => {
          throw new TimetableValidationError('유효하지 않은 기준 시간표 식별자입니다.');
        })()
    : null;

  const reason = sanitizeSingleLine(
    input.reason ?? '',
    VALIDATION_LIMITS.TIMETABLE_REASON_MAX_LEN,
  );

  const workStart = input.workStart?.trim() || null;
  const workEnd = input.workEnd?.trim() || null;
  if ((workStart && !workEnd) || (!workStart && workEnd)) {
    throw new TimetableValidationError('근무 시작·종료 시각은 함께 지정해야 합니다.');
  }
  if (workStart && workEnd) {
    if (
      !isValidTimeInputString(workStart) ||
      !isValidTimeInputString(workEnd) ||
      workEnd <= workStart
    ) {
      throw new TimetableValidationError('근무 시작 시각이 종료 시각보다 빨라야 합니다.');
    }
  }

  const lunchStart = input.lunchStart?.trim() || null;
  const lunchEnd = input.lunchEnd?.trim() || null;
  if ((lunchStart && !lunchEnd) || (!lunchStart && lunchEnd)) {
    throw new TimetableValidationError('점심 시작·종료 시각은 함께 지정해야 합니다.');
  }
  if (lunchStart && lunchEnd) {
    if (
      !isValidTimeInputString(lunchStart) ||
      !isValidTimeInputString(lunchEnd) ||
      lunchEnd <= lunchStart
    ) {
      throw new TimetableValidationError('점심 시작 시각이 종료 시각보다 빨라야 합니다.');
    }
  }

  const cleanPeriodTimes: Record<string, TimetablePeriodTime> = {};
  for (const [k, v] of Object.entries(input.periodTimes ?? {})) {
    const pNum = Number(k);
    if (!Number.isInteger(pNum) || pNum < 1 || pNum > VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX) {
      continue;
    }
    if (!isValidTimeInputString(v.startTime) || !isValidTimeInputString(v.endTime) || v.endTime <= v.startTime) {
      throw new TimetableValidationError(`${pNum}교시 임시 시각이 올바르지 않습니다.`);
    }
    cleanPeriodTimes[String(pNum)] = {
      period: pNum,
      label: sanitizeSingleLine(v.label || `${pNum}교시`, 20) || `${pNum}교시`,
      startTime: v.startTime.trim(),
      endTime: v.endTime.trim(),
    };
  }

  const cleanSlots: Record<string, TimetableOverrideSlot> = {};
  for (const [k, raw] of Object.entries(input.slots ?? {})) {
    const pNum = Number(k);
    if (!Number.isInteger(pNum) || pNum < 1 || pNum > VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX) {
      continue;
    }
    const kind = sanitizeSlotKind(raw.kind);
    cleanSlots[String(pNum)] = {
      period: pNum,
      kind,
      subject: sanitizeSingleLine(raw.subject ?? '', VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN),
      className: sanitizeSingleLine(raw.className ?? '', VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN),
      classroom: sanitizeSingleLine(raw.classroom ?? '', VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN),
      note: sanitizeSingleLine(raw.note ?? '', VALIDATION_LIMITS.TIMETABLE_NOTE_MAX_LEN),
      workAvailable:
        kind === 'class' || kind === 'fixed_duty'
          ? false
          : Boolean(raw.workAvailable),
    };
  }

  return {
    dateKey,
    baseTimetableId,
    reason,
    workStart,
    workEnd,
    lunchStart,
    lunchEnd,
    periodTimes: cleanPeriodTimes,
    slots: cleanSlots,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

function mapTimetableDoc(
  snap: QueryDocumentSnapshot<DocumentData>,
): TimetableRecord {
  const data = snap.data();
  return {
    id: snap.id,
    name: String(data.name ?? ''),
    semesterLabel: String(data.semesterLabel ?? ''),
    effectiveFrom: String(data.effectiveFrom ?? ''),
    effectiveTo: String(data.effectiveTo ?? ''),
    workStart: String(data.workStart ?? '08:30'),
    workEnd: String(data.workEnd ?? '16:30'),
    lunchStart: String(data.lunchStart ?? '12:20'),
    lunchEnd: String(data.lunchEnd ?? '13:20'),
    periodCount: Number(data.periodCount ?? 7),
    periodTimes: (data.periodTimes ?? {}) as Record<string, TimetablePeriodTime>,
    slots: (data.slots ?? {}) as Record<string, TimetableSlot>,
    isActive: Boolean(data.isActive),
    sourceType: (data.sourceType ?? 'manual') as TimetableSourceType,
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

function mapOverrideDoc(
  snap: QueryDocumentSnapshot<DocumentData>,
): TimetableOverrideRecord {
  const data = snap.data();
  return {
    id: snap.id,
    dateKey: String(data.dateKey ?? snap.id),
    baseTimetableId: (data.baseTimetableId ?? null) as string | null,
    reason: String(data.reason ?? ''),
    workStart: (data.workStart ?? null) as string | null,
    workEnd: (data.workEnd ?? null) as string | null,
    lunchStart: (data.lunchStart ?? null) as string | null,
    lunchEnd: (data.lunchEnd ?? null) as string | null,
    periodTimes: (data.periodTimes ?? {}) as Record<string, TimetablePeriodTime>,
    slots: (data.slots ?? {}) as Record<string, TimetableOverrideSlot>,
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

export async function fetchAllTimetables(
  db: Firestore,
  uid: string,
): Promise<TimetableRecord[]> {
  if (!isValidFirestoreId(uid)) {
    throw new TimetableValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const col = collection(db, 'users', uid, 'timetables');
  // Single-field orderBy requires ZERO Firestore composite indexes.
  const q = query(col, orderBy('effectiveFrom', 'desc'), limit(25));
  const snap = await getDocs(q);
  return snap.docs.map(mapTimetableDoc);
}

export async function fetchSingleTimetable(
  db: Firestore,
  uid: string,
  timetableId: string,
): Promise<TimetableRecord | null> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(timetableId)) {
    throw new TimetableValidationError('유효하지 않은 시간표 식별자입니다.');
  }
  const snap = await getDoc(doc(db, 'users', uid, 'timetables', timetableId));
  if (!snap.exists()) return null;
  return mapTimetableDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function createTimetable(
  db: Firestore,
  uid: string,
  draft: TimetableDraft,
  explicitId?: string,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new TimetableValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const col = collection(db, 'users', uid, 'timetables');
  const ref = explicitId ? doc(col, explicitId) : doc(col);
  if (!isValidFirestoreId(ref.id)) {
    throw new TimetableValidationError('유효하지 않은 시간표 식별자입니다.');
  }
  const payload = buildCreateTimetablePayload(draft);
  await setDoc(ref, payload);
  return { id: ref.id, version: 1 };
}

export async function updateTimetable(
  db: Firestore,
  uid: string,
  timetableId: string,
  expectedVersion: number,
  draft: TimetableDraft,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(timetableId)) {
    throw new TimetableValidationError('유효하지 않은 시간표 식별자입니다.');
  }
  assertValidVersion(expectedVersion);
  const validated = buildCreateTimetablePayload(draft);
  const ref = doc(db, 'users', uid, 'timetables', timetableId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new TimetableValidationError('수정할 시간표를 찾을 수 없습니다.');
    }
    const current = snap.data() as TimetableRecord;
    if (current.version !== expectedVersion) {
      throw new TimetableConcurrencyError(expectedVersion, current.version);
    }
    const nextVersion = current.version + 1;
    tx.update(ref, {
      name: validated.name,
      semesterLabel: validated.semesterLabel,
      effectiveFrom: validated.effectiveFrom,
      effectiveTo: validated.effectiveTo,
      workStart: validated.workStart,
      workEnd: validated.workEnd,
      lunchStart: validated.lunchStart,
      lunchEnd: validated.lunchEnd,
      periodCount: validated.periodCount,
      periodTimes: validated.periodTimes,
      slots: validated.slots,
      isActive: validated.isActive,
      sourceType: validated.sourceType,
      version: nextVersion,
      updatedAt: serverTimestamp(),
    });
    return { id: timetableId, version: nextVersion };
  });
}

export async function deleteTimetable(
  db: Firestore,
  uid: string,
  timetableId: string,
): Promise<void> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(timetableId)) {
    throw new TimetableValidationError('유효하지 않은 시간표 식별자입니다.');
  }
  const ref = doc(db, 'users', uid, 'timetables', timetableId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new TimetableValidationError('삭제할 시간표를 찾을 수 없습니다.');
  }
  await deleteDoc(ref);
}

export async function fetchAllTimetableOverrides(
  db: Firestore,
  uid: string,
): Promise<TimetableOverrideRecord[]> {
  if (!isValidFirestoreId(uid)) {
    throw new TimetableValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const col = collection(db, 'users', uid, 'timetableOverrides');
  const q = query(col, orderBy('dateKey', 'desc'), limit(120));
  const snap = await getDocs(q);
  return snap.docs.map(mapOverrideDoc);
}

export async function fetchSingleTimetableOverride(
  db: Firestore,
  uid: string,
  dateKey: string,
): Promise<TimetableOverrideRecord | null> {
  if (!isValidFirestoreId(uid) || !isValidDateInputString(dateKey)) {
    throw new TimetableValidationError('유효하지 않은 사용자 또는 날짜 식별자입니다.');
  }
  const snap = await getDoc(doc(db, 'users', uid, 'timetableOverrides', dateKey));
  if (!snap.exists()) return null;
  return mapOverrideDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function upsertTimetableOverride(
  db: Firestore,
  uid: string,
  input: UpsertTimetableOverrideInput,
  expectedVersion?: number,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new TimetableValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const payload = buildCreateTimetableOverridePayload(input);
  const ref = doc(db, 'users', uid, 'timetableOverrides', payload.dateKey);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      tx.set(ref, payload);
      return { id: payload.dateKey, version: 1 };
    }
    const current = snap.data() as TimetableOverrideRecord;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new TimetableConcurrencyError(expectedVersion, current.version);
    }
    const nextVersion = current.version + 1;
    tx.update(ref, {
      baseTimetableId: payload.baseTimetableId,
      reason: payload.reason,
      workStart: payload.workStart,
      workEnd: payload.workEnd,
      lunchStart: payload.lunchStart,
      lunchEnd: payload.lunchEnd,
      periodTimes: payload.periodTimes,
      slots: payload.slots,
      version: nextVersion,
      updatedAt: serverTimestamp(),
    });
    return { id: payload.dateKey, version: nextVersion };
  });
}

export async function deleteTimetableOverride(
  db: Firestore,
  uid: string,
  dateKey: string,
): Promise<void> {
  if (!isValidFirestoreId(uid) || !isValidDateInputString(dateKey)) {
    throw new TimetableValidationError('유효하지 않은 날짜입니다.');
  }
  const ref = doc(db, 'users', uid, 'timetableOverrides', dateKey);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await deleteDoc(ref);
}
