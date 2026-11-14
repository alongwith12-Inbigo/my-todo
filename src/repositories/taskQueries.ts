import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { getKstDayBounds, isValidFirestoreId } from '../lib/dateKst';
import type { TaskRecord, TaskStatus } from '../types/domain';
import { TaskValidationError } from './taskOperations';

export const ACTIVE_INCOMPLETE_STATUSES: TaskStatus[] = ['todo', 'doing', 'on_hold'];

export type TaskFilterTab =
  | 'active'
  | 'todo'
  | 'doing'
  | 'on_hold'
  | 'done'
  | 'unreminded'
  | 'trash';

export type TaskQuerySortField = 'updatedAt' | 'dueAt';

export interface BriefingQueryResult {
  tasks: TaskRecord[];
  hasMoreUndated: boolean;
  undatedCursor: QueryDocumentSnapshot<DocumentData> | null;
  usedIndexFallback: boolean;
}

export interface TaskPageResult {
  tasks: TaskRecord[];
  hasMore: boolean;
  nextCursor: QueryDocumentSnapshot<DocumentData> | null;
  usedIndexFallback: boolean;
}

function mapTaskDoc(snap: QueryDocumentSnapshot<DocumentData>): TaskRecord {
  const data = snap.data();
  return {
    id: snap.id,
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    status: data.status as TaskStatus,
    priority: data.priority,
    dueAt: (data.dueAt ?? null) as Timestamp | null,
    scheduledAt: (data.scheduledAt ?? null) as Timestamp | null,
    remindAt: (data.remindAt ?? null) as Timestamp | null,
    completedAt: (data.completedAt ?? null) as Timestamp | null,
    sourceType: data.sourceType,
    relatedEventId: (data.relatedEventId ?? null) as string | null,
    isDeleted: Boolean(data.isDeleted),
    deletedAt: (data.deletedAt ?? null) as Timestamp | null,
    version: Number(data.version ?? 1),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    schemaVersion: Number(data.schemaVersion ?? 1),
  };
}

export function isMissingIndexError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const msg = error instanceof Error ? error.message : String(error);
  return code === 'failed-precondition' || msg.includes('requires an index');
}

export async function fetchSingleTask(
  db: Firestore,
  uid: string,
  taskId: string,
): Promise<TaskRecord | null> {
  if (!isValidFirestoreId(uid) || !isValidFirestoreId(taskId)) {
    throw new TaskValidationError('유효하지 않은 사용자 또는 업무 식별자입니다.');
  }
  const snap = await getDoc(doc(db, 'users', uid, 'tasks', taskId));
  if (!snap.exists()) return null;
  return mapTaskDoc(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function fetchBriefingTaskSet(
  db: Firestore,
  uid: string,
  options: {
    imminentDays?: number;
    now?: Date;
    undatedPageSize?: number;
  } = {},
): Promise<BriefingQueryResult> {
  if (!isValidFirestoreId(uid)) {
    throw new TaskValidationError('유효하지 않은 사용자 식별자입니다.');
  }

  const now = options.now ?? new Date();
  const imminentDays = options.imminentDays ?? 3;
  const undatedPageSize = Math.min(Math.max(1, options.undatedPageSize ?? 30), 100);
  const bounds = getKstDayBounds(now, imminentDays);
  const endOfTodayTs = Timestamp.fromMillis(bounds.endOfTodayMs);
  const endOfImminentTs = Timestamp.fromMillis(bounds.endOfImminentMs);
  const tasksCol = collection(db, 'users', uid, 'tasks');

  try {
    const dueQuery = query(
      tasksCol,
      where('isDeleted', '==', false),
      where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
      where('dueAt', '<=', endOfImminentTs),
      orderBy('dueAt', 'asc'),
      limit(100),
    );

    const remindQuery = query(
      tasksCol,
      where('isDeleted', '==', false),
      where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
      where('remindAt', '<=', endOfTodayTs),
      orderBy('remindAt', 'asc'),
      limit(100),
    );

    const doingQuery = query(
      tasksCol,
      where('isDeleted', '==', false),
      where('status', '==', 'doing'),
      orderBy('updatedAt', 'desc'),
      limit(50),
    );

    const undatedQuery = query(
      tasksCol,
      where('isDeleted', '==', false),
      where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
      where('dueAt', '==', null),
      orderBy('updatedAt', 'desc'),
      limit(undatedPageSize + 1),
    );

    const unremindedQuery = query(
      tasksCol,
      where('isDeleted', '==', false),
      where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
      where('remindAt', '==', null),
      limit(50),
    );

    const [dueSnap, remindSnap, doingSnap, undatedSnap, unremindedSnap] =
      await Promise.all([
        getDocs(dueQuery),
        getDocs(remindQuery),
        getDocs(doingQuery),
        getDocs(undatedQuery),
        getDocs(unremindedQuery),
      ]);

    const taskMap = new Map<string, TaskRecord>();
    for (const snap of [dueSnap, remindSnap, doingSnap, unremindedSnap]) {
      for (const d of snap.docs) {
        taskMap.set(d.id, mapTaskDoc(d));
      }
    }

    const hasMoreUndated = undatedSnap.docs.length > undatedPageSize;
    const undatedDocs = hasMoreUndated
      ? undatedSnap.docs.slice(0, undatedPageSize)
      : undatedSnap.docs;
    for (const d of undatedDocs) {
      taskMap.set(d.id, mapTaskDoc(d));
    }

    return {
      tasks: Array.from(taskMap.values()),
      hasMoreUndated,
      undatedCursor: undatedDocs.length > 0 ? undatedDocs[undatedDocs.length - 1] : null,
      usedIndexFallback: false,
    };
  } catch (error) {
    if (!isMissingIndexError(error)) {
      throw error;
    }

    // Bounded single-field fallback when composite indexes are not yet deployed on live Firestore
    const fallbackSnap = await getDocs(
      query(tasksCol, where('isDeleted', '==', false), limit(150)),
    );
    return {
      tasks: fallbackSnap.docs
        .map(mapTaskDoc)
        .filter((task) => task.status !== 'done'),
      hasMoreUndated: false,
      undatedCursor: null,
      usedIndexFallback: true,
    };
  }
}

export async function fetchMoreUndatedTasks(
  db: Firestore,
  uid: string,
  cursor: QueryDocumentSnapshot<DocumentData>,
  pageSize = 30,
): Promise<{
  tasks: TaskRecord[];
  hasMoreUndated: boolean;
  undatedCursor: QueryDocumentSnapshot<DocumentData> | null;
}> {
  if (!isValidFirestoreId(uid)) {
    throw new TaskValidationError('유효하지 않은 사용자 식별자입니다.');
  }
  const safeLimit = Math.min(Math.max(1, pageSize), 100);
  const tasksCol = collection(db, 'users', uid, 'tasks');
  const q = query(
    tasksCol,
    where('isDeleted', '==', false),
    where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
    where('dueAt', '==', null),
    orderBy('updatedAt', 'desc'),
    startAfter(cursor),
    limit(safeLimit + 1),
  );
  const snap = await getDocs(q);
  const hasMoreUndated = snap.docs.length > safeLimit;
  const docs = hasMoreUndated ? snap.docs.slice(0, safeLimit) : snap.docs;
  return {
    tasks: docs.map(mapTaskDoc),
    hasMoreUndated,
    undatedCursor: docs.length > 0 ? docs[docs.length - 1] : null,
  };
}

export async function fetchTasksPage(
  db: Firestore,
  uid: string,
  options: {
    filter: TaskFilterTab;
    sortField?: TaskQuerySortField;
    pageSize?: number;
    cursor?: QueryDocumentSnapshot<DocumentData> | null;
  },
): Promise<TaskPageResult> {
  if (!isValidFirestoreId(uid)) {
    throw new TaskValidationError('유효하지 않은 사용자 식별자입니다.');
  }

  const pageSize = Math.min(Math.max(1, options.pageSize ?? 25), 100);
  const sortField: TaskQuerySortField = options.sortField ?? 'updatedAt';
  const tasksCol = collection(db, 'users', uid, 'tasks');
  const constraints: QueryConstraint[] = [];

  if (options.filter === 'trash') {
    constraints.push(where('isDeleted', '==', true), orderBy('deletedAt', 'desc'));
  } else {
    constraints.push(where('isDeleted', '==', false));
    if (options.filter === 'active') {
      constraints.push(where('status', 'in', ACTIVE_INCOMPLETE_STATUSES));
      constraints.push(
        sortField === 'dueAt' ? orderBy('dueAt', 'asc') : orderBy('updatedAt', 'desc'),
      );
    } else if (options.filter === 'unreminded') {
      constraints.push(
        where('status', 'in', ACTIVE_INCOMPLETE_STATUSES),
        where('remindAt', '==', null),
      );
    } else {
      constraints.push(where('status', '==', options.filter));
      constraints.push(
        sortField === 'dueAt' ? orderBy('dueAt', 'asc') : orderBy('updatedAt', 'desc'),
      );
    }
  }

  if (options.cursor) {
    constraints.push(startAfter(options.cursor));
  }
  constraints.push(limit(pageSize + 1));

  try {
    const snap = await getDocs(query(tasksCol, ...constraints));
    const hasMore = snap.docs.length > pageSize;
    const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
    return {
      tasks: docs.map(mapTaskDoc),
      hasMore,
      nextCursor: docs.length > 0 ? docs[docs.length - 1] : null,
      usedIndexFallback: false,
    };
  } catch (error) {
    if (!isMissingIndexError(error)) {
      throw error;
    }

    const isTrash = options.filter === 'trash';
    const fallbackSnap = await getDocs(
      query(tasksCol, where('isDeleted', '==', isTrash), limit(150)),
    );
    const filtered = fallbackSnap.docs.map(mapTaskDoc).filter((task) => {
      if (options.filter === 'trash') return task.isDeleted;
      if (options.filter === 'active') return task.status !== 'done';
      if (options.filter === 'unreminded') {
        return task.status !== 'done' && task.remindAt === null;
      }
      return task.status === options.filter;
    });

    return {
      tasks: filtered,
      hasMore: false,
      nextCursor: null,
      usedIndexFallback: true,
    };
  }
}
