import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  type FieldValue,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import {
  isValidFirestoreId,
  sanitizeMultiline,
  sanitizeSingleLine,
} from '../lib/dateKst';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type TaskPriority,
  type TaskRecord,
  type TaskSourceType,
  type TaskStatus,
} from '../types/domain';

const VALID_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'on_hold'];
const VALID_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const VALID_SOURCES: readonly TaskSourceType[] = [
  'manual',
  'note',
  'import_text',
  'import_ocr',
  'import_ai',
];

export class TaskConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `다른 창이나 기기에서 업무가 먼저 수정되었습니다. (예상 버전 ${expectedVersion}, 현재 버전 ${actualVersion})`,
    );
    this.name = 'TaskConcurrencyError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: Timestamp | null;
  scheduledAt?: Timestamp | null;
  remindAt?: Timestamp | null;
  estimatedMinutes?: number | null;
  sourceType?: TaskSourceType;
  relatedEventId?: string | null;
}

export interface UpdateTaskDetailsPatch {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  dueAt?: Timestamp | null;
  scheduledAt?: Timestamp | null;
  remindAt?: Timestamp | null;
  estimatedMinutes?: number | null;
  relatedEventId?: string | null;
}

export interface PostponeTaskPatch {
  dueAt?: Timestamp | null;
  scheduledAt?: Timestamp | null;
  remindAt?: Timestamp | null;
}

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new TaskValidationError('유효하지 않은 문서 버전입니다.');
  }
}

function assertValidOwnerAndTaskId(uid: string, taskId: string): void {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(taskId)) {
    throw new TaskValidationError('유효하지 않은 사용자 또는 업무 식별자입니다.');
  }
}

function assertValidRelatedEventId(relatedEventId: string | null | undefined): string | null {
  if (relatedEventId === undefined || relatedEventId === null) {
    return null;
  }
  if (!isValidFirestoreId(relatedEventId)) {
    throw new TaskValidationError('유효하지 않은 연결 일정 식별자입니다.');
  }
  return relatedEventId;
}

function assertValidEstimatedMinutes(
  value: number | null | undefined,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < VALIDATION_LIMITS.TASK_ESTIMATED_MIN ||
    value > VALIDATION_LIMITS.TASK_ESTIMATED_MAX
  ) {
    throw new TaskValidationError(
      `예상 소요 시간은 ${VALIDATION_LIMITS.TASK_ESTIMATED_MIN}분부터 ${VALIDATION_LIMITS.TASK_ESTIMATED_MAX}분(8시간) 사이의 정수로 입력해 주세요.`,
    );
  }
  return value;
}

export function buildCreateTaskPayload(
  input: CreateTaskInput,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  const title = sanitizeSingleLine(input.title ?? '', VALIDATION_LIMITS.TITLE_MAX_LEN);
  if (title.length < VALIDATION_LIMITS.TITLE_MIN_LEN) {
    throw new TaskValidationError('업무 제목을 1자 이상 입력해 주세요.');
  }

  const description = sanitizeMultiline(
    input.description ?? '',
    VALIDATION_LIMITS.DESCRIPTION_MAX_LEN,
  );

  const status: TaskStatus = input.status ?? 'todo';
  if (!VALID_STATUSES.includes(status)) {
    throw new TaskValidationError('유효하지 않은 업무 상태입니다.');
  }

  const priority: TaskPriority = input.priority ?? 'normal';
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new TaskValidationError('유효하지 않은 우선순위입니다.');
  }

  const sourceType: TaskSourceType = input.sourceType ?? 'manual';
  if (!VALID_SOURCES.includes(sourceType)) {
    throw new TaskValidationError('유효하지 않은 업무 출처입니다.');
  }

  const relatedEventId = assertValidRelatedEventId(input.relatedEventId);
  const estimatedMinutes = assertValidEstimatedMinutes(input.estimatedMinutes);

  return {
    title,
    description,
    status,
    priority,
    dueAt: input.dueAt ?? null,
    scheduledAt: input.scheduledAt ?? null,
    remindAt: input.remindAt ?? null,
    completedAt: status === 'done' ? nowSentinel : null,
    estimatedMinutes,
    sourceType,
    relatedEventId,
    isDeleted: false,
    deletedAt: null,
    version: 1,
    createdAt: nowSentinel,
    updatedAt: nowSentinel,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function buildTaskDetailsPatch(
  currentVersion: number,
  patch: UpdateTaskDetailsPatch,
  nowSentinel: FieldValue = serverTimestamp(),
): Record<string, unknown> {
  assertValidVersion(currentVersion);

  const payload: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    const title = sanitizeSingleLine(patch.title, VALIDATION_LIMITS.TITLE_MAX_LEN);
    if (title.length < VALIDATION_LIMITS.TITLE_MIN_LEN) {
      throw new TaskValidationError('업무 제목을 1자 이상 입력해 주세요.');
    }
    payload.title = title;
  }

  if (patch.description !== undefined) {
    payload.description = sanitizeMultiline(
      patch.description,
      VALIDATION_LIMITS.DESCRIPTION_MAX_LEN,
    );
  }

  if (patch.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(patch.priority)) {
      throw new TaskValidationError('유효하지 않은 우선순위입니다.');
    }
    payload.priority = patch.priority;
  }

  if (patch.dueAt !== undefined) {
    payload.dueAt = patch.dueAt;
  }
  if (patch.scheduledAt !== undefined) {
    payload.scheduledAt = patch.scheduledAt;
  }
  if (patch.remindAt !== undefined) {
    payload.remindAt = patch.remindAt;
  }
  if (patch.estimatedMinutes !== undefined) {
    payload.estimatedMinutes = assertValidEstimatedMinutes(patch.estimatedMinutes);
  }
  if (patch.relatedEventId !== undefined) {
    payload.relatedEventId = assertValidRelatedEventId(patch.relatedEventId);
  }

  if (Object.keys(payload).length === 0) {
    throw new TaskValidationError('수정할 업무 항목이 지정되지 않았습니다.');
  }

  payload.version = currentVersion + 1;
  payload.updatedAt = nowSentinel;
  return payload;
}

export function buildTaskStatusPatch(
  currentVersion: number,
  nextStatus: TaskStatus,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  assertValidVersion(currentVersion);
  if (!VALID_STATUSES.includes(nextStatus)) {
    throw new TaskValidationError('유효하지 않은 업무 상태입니다.');
  }

  return {
    status: nextStatus,
    completedAt: nextStatus === 'done' ? nowSentinel : null,
    version: currentVersion + 1,
    updatedAt: nowSentinel,
  };
}

export function buildSoftDeletePatch(
  currentVersion: number,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  assertValidVersion(currentVersion);
  return {
    isDeleted: true,
    deletedAt: nowSentinel,
    version: currentVersion + 1,
    updatedAt: nowSentinel,
  };
}

export function buildRestorePatch(
  currentVersion: number,
  nowSentinel: FieldValue = serverTimestamp(),
) {
  assertValidVersion(currentVersion);
  return {
    isDeleted: false,
    deletedAt: null,
    version: currentVersion + 1,
    updatedAt: nowSentinel,
  };
}

export async function createTask(
  db: Firestore,
  uid: string,
  input: CreateTaskInput,
  explicitTaskId?: string,
): Promise<{ id: string; version: number }> {
  if (!isValidFirestoreId(uid)) {
    throw new TaskValidationError('유효하지 않은 사용자 식별자입니다.');
  }

  const tasksCol = collection(db, 'users', uid, 'tasks');
  const taskRef = explicitTaskId ? doc(tasksCol, explicitTaskId) : doc(tasksCol);
  if (!isValidFirestoreId(taskRef.id)) {
    throw new TaskValidationError('유효하지 않은 업무 식별자입니다.');
  }

  const payload = buildCreateTaskPayload(input);
  await setDoc(taskRef, payload);
  return { id: taskRef.id, version: 1 };
}

export async function updateTaskDetails(
  db: Firestore,
  uid: string,
  taskId: string,
  expectedVersion: number,
  patch: UpdateTaskDetailsPatch,
): Promise<{ id: string; version: number }> {
  assertValidOwnerAndTaskId(uid, taskId);
  assertValidVersion(expectedVersion);

  const taskRef = doc(db, 'users', uid, 'tasks', taskId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists()) {
      throw new TaskValidationError('대상 업무를 찾을 수 없습니다.');
    }
    const existing = snap.data() as TaskRecord;
    if (existing.isDeleted) {
      throw new TaskValidationError('휴지통에 있는 업무는 수정할 수 없습니다. 먼저 복구해 주세요.');
    }
    if (existing.version !== expectedVersion) {
      throw new TaskConcurrencyError(expectedVersion, existing.version);
    }

    const nextPayload = buildTaskDetailsPatch(existing.version, patch);
    tx.update(taskRef, nextPayload);
    return { id: taskId, version: existing.version + 1 };
  });
}

export async function postponeTask(
  db: Firestore,
  uid: string,
  taskId: string,
  expectedVersion: number,
  datesPatch: PostponeTaskPatch,
): Promise<{ id: string; version: number }> {
  if (
    datesPatch.dueAt === undefined &&
    datesPatch.scheduledAt === undefined &&
    datesPatch.remindAt === undefined
  ) {
    throw new TaskValidationError('연기할 날짜(마감일·예정일·다시알림)를 하나 이상 지정해 주세요.');
  }

  return updateTaskDetails(db, uid, taskId, expectedVersion, datesPatch);
}

export async function transitionTaskStatus(
  db: Firestore,
  uid: string,
  taskId: string,
  expectedVersion: number,
  nextStatus: TaskStatus,
): Promise<{ id: string; version: number; status: TaskStatus }> {
  assertValidOwnerAndTaskId(uid, taskId);
  assertValidVersion(expectedVersion);
  if (!VALID_STATUSES.includes(nextStatus)) {
    throw new TaskValidationError('유효하지 않은 업무 상태입니다.');
  }

  const taskRef = doc(db, 'users', uid, 'tasks', taskId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists()) {
      throw new TaskValidationError('대상 업무를 찾을 수 없습니다.');
    }
    const existing = snap.data() as TaskRecord;
    if (existing.isDeleted) {
      throw new TaskValidationError('휴지통에 있는 업무의 상태는 변경할 수 없습니다.');
    }
    if (existing.version !== expectedVersion) {
      throw new TaskConcurrencyError(expectedVersion, existing.version);
    }
    if (existing.status === nextStatus) {
      return { id: taskId, version: existing.version, status: existing.status };
    }

    tx.update(taskRef, buildTaskStatusPatch(existing.version, nextStatus));
    return { id: taskId, version: existing.version + 1, status: nextStatus };
  });
}

export async function softDeleteTask(
  db: Firestore,
  uid: string,
  taskId: string,
  expectedVersion: number,
): Promise<{ id: string; version: number }> {
  assertValidOwnerAndTaskId(uid, taskId);
  assertValidVersion(expectedVersion);

  const taskRef = doc(db, 'users', uid, 'tasks', taskId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists()) {
      throw new TaskValidationError('대상 업무를 찾을 수 없습니다.');
    }
    const existing = snap.data() as TaskRecord;
    if (existing.isDeleted) {
      throw new TaskValidationError('이미 휴지통으로 이동된 업무입니다.');
    }
    if (existing.version !== expectedVersion) {
      throw new TaskConcurrencyError(expectedVersion, existing.version);
    }

    tx.update(taskRef, buildSoftDeletePatch(existing.version));
    return { id: taskId, version: existing.version + 1 };
  });
}

export async function restoreTask(
  db: Firestore,
  uid: string,
  taskId: string,
  expectedVersion: number,
): Promise<{ id: string; version: number }> {
  assertValidOwnerAndTaskId(uid, taskId);
  assertValidVersion(expectedVersion);

  const taskRef = doc(db, 'users', uid, 'tasks', taskId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists()) {
      throw new TaskValidationError('대상 업무를 찾을 수 없습니다.');
    }
    const existing = snap.data() as TaskRecord;
    if (!existing.isDeleted) {
      throw new TaskValidationError('휴지통에 있는 업무만 복구할 수 있습니다.');
    }
    if (existing.version !== expectedVersion) {
      throw new TaskConcurrencyError(expectedVersion, existing.version);
    }

    tx.update(taskRef, buildRestorePatch(existing.version));
    return { id: taskId, version: existing.version + 1 };
  });
}

export async function permanentlyDeleteTask(
  db: Firestore,
  uid: string,
  taskId: string,
): Promise<void> {
  assertValidOwnerAndTaskId(uid, taskId);

  const taskRef = doc(db, 'users', uid, 'tasks', taskId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists()) {
      throw new TaskValidationError('대상 업무를 찾을 수 없습니다.');
    }
    const existing = snap.data() as TaskRecord;
    if (!existing.isDeleted) {
      throw new TaskValidationError('휴지통으로 먼저 이동한 업무만 영구 삭제할 수 있습니다.');
    }
    tx.delete(taskRef);
  });
}
