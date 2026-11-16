import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { TaskRecord, TaskStatus } from '../types/domain';
import {
  createTask as createTaskOp,
  permanentlyDeleteTask as permanentlyDeleteTaskOp,
  postponeTask as postponeTaskOp,
  restoreTask as restoreTaskOp,
  softDeleteTask as softDeleteTaskOp,
  TaskConcurrencyError,
  TaskValidationError,
  transitionTaskStatus as transitionTaskStatusOp,
  updateTaskDetails as updateTaskDetailsOp,
  type CreateTaskInput,
  type PostponeTaskPatch,
  type UpdateTaskDetailsPatch,
} from './taskOperations';
import {
  fetchBriefingTaskSet as fetchBriefingTaskSetOp,
  fetchMoreUndatedTasks as fetchMoreUndatedTasksOp,
  fetchSingleTask as fetchSingleTaskOp,
  fetchTasksPage as fetchTasksPageOp,
  type BriefingQueryResult,
  type TaskFilterTab,
  type TaskPageResult,
  type TaskQuerySortField,
} from './taskQueries';

export {
  TaskConcurrencyError,
  TaskValidationError,
  type BriefingQueryResult,
  type CreateTaskInput,
  type PostponeTaskPatch,
  type TaskFilterTab,
  type TaskPageResult,
  type TaskQuerySortField,
  type UpdateTaskDetailsPatch,
};

function rethrowTaskError(error: unknown, operation: OperationType, path: string): never {
  if (error instanceof TaskConcurrencyError || error instanceof TaskValidationError) {
    throw error;
  }
  handleFirestoreError(error, operation, path);
}

export async function fetchSingleTask(
  uid: string,
  taskId: string,
): Promise<TaskRecord | null> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await fetchSingleTaskOp(db, uid, taskId);
  } catch (error) {
    rethrowTaskError(error, OperationType.GET, path);
  }
}

export async function fetchBriefingTaskSet(
  uid: string,
  options: {
    imminentDays?: number;
    now?: Date;
    undatedPageSize?: number;
  } = {},
): Promise<BriefingQueryResult> {
  const path = `users/${uid}/tasks`;
  try {
    return await fetchBriefingTaskSetOp(db, uid, options);
  } catch (error) {
    rethrowTaskError(error, OperationType.LIST, path);
  }
}

export async function fetchMoreUndatedTasks(
  uid: string,
  cursor: QueryDocumentSnapshot<DocumentData>,
  pageSize = 30,
) {
  const path = `users/${uid}/tasks`;
  try {
    return await fetchMoreUndatedTasksOp(db, uid, cursor, pageSize);
  } catch (error) {
    rethrowTaskError(error, OperationType.LIST, path);
  }
}

export async function fetchTasksPage(
  uid: string,
  options: {
    filter: TaskFilterTab;
    sortField?: TaskQuerySortField;
    pageSize?: number;
    cursor?: QueryDocumentSnapshot<DocumentData> | null;
  },
): Promise<TaskPageResult> {
  const path = `users/${uid}/tasks`;
  try {
    return await fetchTasksPageOp(db, uid, options);
  } catch (error) {
    rethrowTaskError(error, OperationType.LIST, path);
  }
}

export async function createTask(
  uid: string,
  input: CreateTaskInput,
  explicitTaskId?: string,
): Promise<{ id: string; version: number }> {
  const path = explicitTaskId ? `users/${uid}/tasks/${explicitTaskId}` : `users/${uid}/tasks`;
  try {
    return await createTaskOp(db, uid, input, explicitTaskId);
  } catch (error) {
    rethrowTaskError(error, OperationType.CREATE, path);
  }
}

export async function updateTaskDetails(
  uid: string,
  taskId: string,
  expectedVersion: number,
  patch: UpdateTaskDetailsPatch,
): Promise<{ id: string; version: number; unchanged?: boolean }> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await updateTaskDetailsOp(db, uid, taskId, expectedVersion, patch);
  } catch (error) {
    rethrowTaskError(error, OperationType.UPDATE, path);
  }
}

export async function postponeTask(
  uid: string,
  taskId: string,
  expectedVersion: number,
  datesPatch: PostponeTaskPatch,
): Promise<{ id: string; version: number; unchanged?: boolean }> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await postponeTaskOp(db, uid, taskId, expectedVersion, datesPatch);
  } catch (error) {
    rethrowTaskError(error, OperationType.UPDATE, path);
  }
}

export async function transitionTaskStatus(
  uid: string,
  taskId: string,
  expectedVersion: number,
  nextStatus: TaskStatus,
): Promise<{ id: string; version: number; status: TaskStatus }> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await transitionTaskStatusOp(db, uid, taskId, expectedVersion, nextStatus);
  } catch (error) {
    rethrowTaskError(error, OperationType.UPDATE, path);
  }
}

export async function softDeleteTask(
  uid: string,
  taskId: string,
  expectedVersion: number,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await softDeleteTaskOp(db, uid, taskId, expectedVersion);
  } catch (error) {
    rethrowTaskError(error, OperationType.UPDATE, path);
  }
}

export async function restoreTask(
  uid: string,
  taskId: string,
  expectedVersion: number,
): Promise<{ id: string; version: number }> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    return await restoreTaskOp(db, uid, taskId, expectedVersion);
  } catch (error) {
    rethrowTaskError(error, OperationType.UPDATE, path);
  }
}

export async function permanentlyDeleteTask(uid: string, taskId: string): Promise<void> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    await permanentlyDeleteTaskOp(db, uid, taskId);
  } catch (error) {
    rethrowTaskError(error, OperationType.DELETE, path);
  }
}
