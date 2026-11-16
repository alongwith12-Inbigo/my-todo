import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import {
  makeTaskPageCacheKey,
  patchCachedTaskPages,
  removeTaskFromCachedPages,
  type CachedTaskPage,
} from '../../lib/taskCache';
import {
  createTask,
  fetchBriefingTaskSet,
  fetchMoreUndatedTasks,
  fetchSingleTask,
  fetchTasksPage,
  permanentlyDeleteTask,
  postponeTask,
  restoreTask,
  softDeleteTask,
  transitionTaskStatus,
  updateTaskDetails,
  type CreateTaskInput,
  type PostponeTaskPatch,
  type TaskFilterTab,
  type TaskQuerySortField,
  type UpdateTaskDetailsPatch,
} from '../../repositories/taskRepo';
import type { TaskRecord, TaskStatus } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { formatTaskErrorMessage } from './taskErrors';

interface TaskDataContextValue {
  briefingTasks: TaskRecord[];
  cachedDoneTasks: TaskRecord[];
  briefingLoading: boolean;
  briefingError: string | null;
  hasMoreUndated: boolean;
  loadingMoreUndated: boolean;
  usedIndexFallback: boolean;
  createSubmitting: boolean;
  isTaskPending: (taskId: string) => boolean;
  listVersion: number;
  taskPagesByKey: Record<string, CachedTaskPage>;
  taskPageLoadingKey: string | null;
  taskPageLoadingMoreKey: string | null;
  taskPageError: string | null;
  ensureTasksPageLoaded: (
    filter: TaskFilterTab,
    sortField: TaskQuerySortField,
    pageSize?: number,
  ) => Promise<void>;
  refreshTasksPage: (
    filter: TaskFilterTab,
    sortField: TaskQuerySortField,
    pageSize?: number,
  ) => Promise<void>;
  loadMoreTasksPage: (
    filter: TaskFilterTab,
    sortField: TaskQuerySortField,
    pageSize?: number,
  ) => Promise<void>;
  refreshBriefing: () => Promise<void>;
  loadMoreUndated: () => Promise<void>;
  refreshSingleTask: (taskId: string) => Promise<TaskRecord | null>;
  createNewTask: (input: CreateTaskInput) => Promise<TaskRecord>;
  saveTaskDetails: (
    taskId: string,
    expectedVersion: number,
    patch: UpdateTaskDetailsPatch,
  ) => Promise<TaskRecord | null>;
  postponeTaskDates: (
    taskId: string,
    expectedVersion: number,
    patch: PostponeTaskPatch,
  ) => Promise<TaskRecord | null>;
  changeTaskStatus: (
    taskId: string,
    expectedVersion: number,
    nextStatus: TaskStatus,
  ) => Promise<TaskRecord | null>;
  moveTaskToTrash: (
    taskId: string,
    expectedVersion: number,
  ) => Promise<TaskRecord | null>;
  restoreTaskFromTrash: (
    taskId: string,
    expectedVersion: number,
  ) => Promise<TaskRecord | null>;
  removeTaskPermanently: (taskId: string) => Promise<void>;
}

const TaskDataContext = createContext<TaskDataContextValue | null>(null);

function upsertTaskInList(list: TaskRecord[], task: TaskRecord): TaskRecord[] {
  const index = list.findIndex((item) => item.id === task.id);
  if (index === -1) {
    return [task, ...list];
  }
  const next = [...list];
  next[index] = task;
  return next;
}

export function TaskDataProvider({ children }: { children: ReactNode }) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';
  const imminentDays = workspace?.preferences.imminentDays ?? 3;

  const [briefingTasks, setBriefingTasks] = useState<TaskRecord[]>([]);
  const [sessionCompletedTasks, setSessionCompletedTasks] = useState<TaskRecord[]>([]);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [hasMoreUndated, setHasMoreUndated] = useState(false);
  const [loadingMoreUndated, setLoadingMoreUndated] = useState(false);
  const [usedIndexFallback, setUsedIndexFallback] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [listVersion, setListVersion] = useState(0);
  const [taskPagesByKey, setTaskPagesByKey] = useState<
    Record<string, CachedTaskPage>
  >({});
  const [taskPageLoadingKey, setTaskPageLoadingKey] = useState<string | null>(null);
  const [taskPageLoadingMoreKey, setTaskPageLoadingMoreKey] = useState<string | null>(
    null,
  );
  const [taskPageError, setTaskPageError] = useState<string | null>(null);

  const undatedCursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const inFlightSetRef = useRef<Set<string>>(new Set());
  const createInFlightRef = useRef(false);
  const inFlightPageKeysRef = useRef<Set<string>>(new Set());
  const taskPagesRef = useRef<Record<string, CachedTaskPage>>({});
  taskPagesRef.current = taskPagesByKey;
  const briefingTasksRef = useRef<TaskRecord[]>([]);
  briefingTasksRef.current = briefingTasks;

  const markPending = useCallback((taskId: string, active: boolean) => {
    if (active) {
      inFlightSetRef.current.add(taskId);
    } else {
      inFlightSetRef.current.delete(taskId);
    }
    setPendingIds(Array.from(inFlightSetRef.current));
  }, []);

  const isTaskPending = useCallback(
    (taskId: string) => pendingIds.includes(taskId),
    [pendingIds],
  );

  const refreshBriefing = useCallback(async () => {
    if (!uid || !isActive) return;
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const result = await fetchBriefingTaskSet(uid, {
        imminentDays,
        undatedPageSize: 30,
      });
      setBriefingTasks(result.tasks);
      setHasMoreUndated(result.hasMoreUndated);
      setUsedIndexFallback(result.usedIndexFallback);
      undatedCursorRef.current = result.undatedCursor;
      loadedKeyRef.current = `${uid}:${imminentDays}`;
    } catch (err) {
      setBriefingError(formatTaskErrorMessage(err));
    } finally {
      setBriefingLoading(false);
    }
  }, [uid, isActive, imminentDays]);

  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      setBriefingTasks([]);
      setSessionCompletedTasks([]);
      setBriefingError(null);
      setHasMoreUndated(false);
      setTaskPagesByKey({});
      setTaskPageError(null);
      setTaskPageLoadingKey(null);
      setTaskPageLoadingMoreKey(null);
      undatedCursorRef.current = null;
      loadedKeyRef.current = null;
      inFlightPageKeysRef.current.clear();
      return;
    }

    const loadKey = `${uid}:${imminentDays}`;
    if (loadedKeyRef.current === loadKey) {
      return;
    }
    setTaskPagesByKey({});
    void refreshBriefing();
  }, [uid, isActive, workspace, imminentDays, refreshBriefing]);

  const loadTasksPageInternal = useCallback(
    async (
      filter: TaskFilterTab,
      sortField: TaskQuerySortField,
      pageSize = 25,
      forceRefresh = false,
    ) => {
      if (!uid || !isActive) return;
      const key = makeTaskPageCacheKey(filter, sortField);
      if (!forceRefresh && taskPagesRef.current[key]) {
        return;
      }
      if (inFlightPageKeysRef.current.has(key)) {
        return;
      }

      inFlightPageKeysRef.current.add(key);
      setTaskPageLoadingKey(key);
      setTaskPageError(null);
      try {
        const result = await fetchTasksPage(uid, {
          filter,
          sortField,
          pageSize,
        });
        setTaskPagesByKey((prev) => ({
          ...prev,
          [key]: {
            tasks: result.tasks,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
            usedIndexFallback: result.usedIndexFallback,
          },
        }));
      } catch (err) {
        setTaskPageError(formatTaskErrorMessage(err));
      } finally {
        inFlightPageKeysRef.current.delete(key);
        setTaskPageLoadingKey((cur) => (cur === key ? null : cur));
      }
    },
    [uid, isActive],
  );

  const ensureTasksPageLoaded = useCallback(
    (
      filter: TaskFilterTab,
      sortField: TaskQuerySortField,
      pageSize = 25,
    ) => loadTasksPageInternal(filter, sortField, pageSize, false),
    [loadTasksPageInternal],
  );

  const refreshTasksPage = useCallback(
    (
      filter: TaskFilterTab,
      sortField: TaskQuerySortField,
      pageSize = 25,
    ) => loadTasksPageInternal(filter, sortField, pageSize, true),
    [loadTasksPageInternal],
  );

  const loadMoreTasksPage = useCallback(
    async (
      filter: TaskFilterTab,
      sortField: TaskQuerySortField,
      pageSize = 25,
    ) => {
      if (!uid || !isActive) return;
      const key = makeTaskPageCacheKey(filter, sortField);
      const existing = taskPagesRef.current[key];
      if (!existing?.nextCursor || inFlightPageKeysRef.current.has(key)) {
        return;
      }

      inFlightPageKeysRef.current.add(key);
      setTaskPageLoadingMoreKey(key);
      setTaskPageError(null);
      try {
        const next = await fetchTasksPage(uid, {
          filter,
          sortField,
          pageSize,
          cursor: existing.nextCursor,
        });
        setTaskPagesByKey((prev) => {
          const cur = prev[key];
          if (!cur) return prev;
          const merged = new Map<string, TaskRecord>();
          for (const item of cur.tasks) merged.set(item.id, item);
          for (const item of next.tasks) merged.set(item.id, item);
          return {
            ...prev,
            [key]: {
              tasks: Array.from(merged.values()),
              hasMore: next.hasMore,
              nextCursor: next.nextCursor,
              usedIndexFallback: cur.usedIndexFallback || next.usedIndexFallback,
            },
          };
        });
      } catch (err) {
        setTaskPageError(formatTaskErrorMessage(err));
      } finally {
        inFlightPageKeysRef.current.delete(key);
        setTaskPageLoadingMoreKey((cur) => (cur === key ? null : cur));
      }
    },
    [uid, isActive],
  );

  const loadMoreUndated = useCallback(async () => {
    if (!uid || !isActive || !undatedCursorRef.current || loadingMoreUndated) return;
    setLoadingMoreUndated(true);
    setBriefingError(null);
    try {
      const next = await fetchMoreUndatedTasks(uid, undatedCursorRef.current, 30);
      undatedCursorRef.current = next.undatedCursor;
      setHasMoreUndated(next.hasMoreUndated);
      setBriefingTasks((prev) => {
        const merged = new Map<string, TaskRecord>();
        for (const item of prev) merged.set(item.id, item);
        for (const item of next.tasks) merged.set(item.id, item);
        return Array.from(merged.values());
      });
    } catch (err) {
      setBriefingError(formatTaskErrorMessage(err));
    } finally {
      setLoadingMoreUndated(false);
    }
  }, [uid, isActive, loadingMoreUndated]);

  const refreshSingleTask = useCallback(
    async (taskId: string): Promise<TaskRecord | null> => {
      if (!uid) return null;
      const fresh = await fetchSingleTask(uid, taskId);
      if (fresh && !fresh.isDeleted && fresh.status !== 'done') {
        setBriefingTasks((prev) => upsertTaskInList(prev, fresh));
        setSessionCompletedTasks((prev) => prev.filter((item) => item.id !== taskId));
      } else {
        setBriefingTasks((prev) => prev.filter((item) => item.id !== taskId));
        if (fresh && !fresh.isDeleted && fresh.status === 'done') {
          setSessionCompletedTasks((prev) => upsertTaskInList(prev, fresh));
        } else {
          setSessionCompletedTasks((prev) => prev.filter((item) => item.id !== taskId));
        }
      }
      if (fresh) {
        setTaskPagesByKey((prev) => patchCachedTaskPages(prev, fresh));
      } else {
        setTaskPagesByKey((prev) => removeTaskFromCachedPages(prev, taskId));
      }
      setListVersion((v) => v + 1);
      return fresh;
    },
    [uid],
  );

  const createNewTask = useCallback(
    async (input: CreateTaskInput): Promise<TaskRecord> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 업무를 등록할 수 있습니다.');
      }
      if (createInFlightRef.current) {
        throw new Error('업무 등록 요청이 이미 처리 중입니다.');
      }
      createInFlightRef.current = true;
      setCreateSubmitting(true);
      try {
        const created = await createTask(uid, input);
        const fresh = await fetchSingleTask(uid, created.id);
        if (!fresh) {
          throw new Error('등록된 업무를 불러오지 못했습니다.');
        }
        if (!fresh.isDeleted && fresh.status !== 'done') {
          setBriefingTasks((prev) => upsertTaskInList(prev, fresh));
        }
        setTaskPagesByKey((prev) => patchCachedTaskPages(prev, fresh));
        setListVersion((v) => v + 1);
        return fresh;
      } finally {
        createInFlightRef.current = false;
        setCreateSubmitting(false);
      }
    },
    [uid, isActive],
  );

  const findCachedTaskById = useCallback((taskId: string): TaskRecord | null => {
    const inBriefing = briefingTasksRef.current.find((t) => t.id === taskId);
    if (inBriefing) return inBriefing;
    for (const page of Object.values(taskPagesRef.current)) {
      const found = page.tasks.find((t) => t.id === taskId);
      if (found) return found;
    }
    return null;
  }, []);

  const runTaskMutation = useCallback(
    async (
      taskId: string,
      action: () => Promise<{ unchanged?: boolean } | unknown>,
    ): Promise<TaskRecord | null> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 업무를 변경할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(taskId)) {
        throw new Error('이미 처리 중인 업무 요청이 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      markPending(taskId, true);
      try {
        const res = await action();
        if (
          res &&
          typeof res === 'object' &&
          'unchanged' in res &&
          (res as { unchanged?: boolean }).unchanged === true
        ) {
          const cached = findCachedTaskById(taskId);
          if (cached) {
            return cached;
          }
        }
        return await refreshSingleTask(taskId);
      } finally {
        markPending(taskId, false);
      }
    },
    [uid, isActive, markPending, findCachedTaskById, refreshSingleTask],
  );

  const saveTaskDetails = useCallback(
    (taskId: string, expectedVersion: number, patch: UpdateTaskDetailsPatch) =>
      runTaskMutation(taskId, () =>
        updateTaskDetails(uid!, taskId, expectedVersion, patch),
      ),
    [uid, runTaskMutation],
  );

  const postponeTaskDates = useCallback(
    (taskId: string, expectedVersion: number, patch: PostponeTaskPatch) =>
      runTaskMutation(taskId, () =>
        postponeTask(uid!, taskId, expectedVersion, patch),
      ),
    [uid, runTaskMutation],
  );

  const changeTaskStatus = useCallback(
    (taskId: string, expectedVersion: number, nextStatus: TaskStatus) =>
      runTaskMutation(taskId, () =>
        transitionTaskStatus(uid!, taskId, expectedVersion, nextStatus),
      ),
    [uid, runTaskMutation],
  );

  const moveTaskToTrash = useCallback(
    (taskId: string, expectedVersion: number) =>
      runTaskMutation(taskId, () =>
        softDeleteTask(uid!, taskId, expectedVersion),
      ),
    [uid, runTaskMutation],
  );

  const restoreTaskFromTrash = useCallback(
    (taskId: string, expectedVersion: number) =>
      runTaskMutation(taskId, () =>
        restoreTask(uid!, taskId, expectedVersion),
      ),
    [uid, runTaskMutation],
  );

  const removeTaskPermanently = useCallback(
    async (taskId: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 업무를 삭제할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(taskId)) {
        throw new Error('이미 처리 중인 업무 요청이 있습니다.');
      }
      markPending(taskId, true);
      try {
        await permanentlyDeleteTask(uid, taskId);
        setBriefingTasks((prev) => prev.filter((item) => item.id !== taskId));
        setSessionCompletedTasks((prev) => prev.filter((item) => item.id !== taskId));
        setTaskPagesByKey((prev) => removeTaskFromCachedPages(prev, taskId));
        setListVersion((v) => v + 1);
      } finally {
        markPending(taskId, false);
      }
    },
    [uid, isActive, markPending],
  );

  const cachedDoneTasks = useMemo(() => {
    const map = new Map<string, TaskRecord>();
    for (const page of Object.values(taskPagesByKey)) {
      for (const t of page.tasks) {
        if (!t.isDeleted && t.status === 'done') {
          map.set(t.id, t);
        }
      }
    }
    for (const t of sessionCompletedTasks) {
      if (!t.isDeleted && t.status === 'done') {
        map.set(t.id, t);
      }
    }
    return Array.from(map.values());
  }, [taskPagesByKey, sessionCompletedTasks]);

  const value = useMemo<TaskDataContextValue>(
    () => ({
      briefingTasks,
      cachedDoneTasks,
      briefingLoading,
      briefingError,
      hasMoreUndated,
      loadingMoreUndated,
      usedIndexFallback,
      createSubmitting,
      isTaskPending,
      listVersion,
      taskPagesByKey,
      taskPageLoadingKey,
      taskPageLoadingMoreKey,
      taskPageError,
      ensureTasksPageLoaded,
      refreshTasksPage,
      loadMoreTasksPage,
      refreshBriefing,
      loadMoreUndated,
      refreshSingleTask,
      createNewTask,
      saveTaskDetails,
      postponeTaskDates,
      changeTaskStatus,
      moveTaskToTrash,
      restoreTaskFromTrash,
      removeTaskPermanently,
    }),
    [
      briefingTasks,
      cachedDoneTasks,
      briefingLoading,
      briefingError,
      hasMoreUndated,
      loadingMoreUndated,
      usedIndexFallback,
      createSubmitting,
      isTaskPending,
      listVersion,
      taskPagesByKey,
      taskPageLoadingKey,
      taskPageLoadingMoreKey,
      taskPageError,
      ensureTasksPageLoaded,
      refreshTasksPage,
      loadMoreTasksPage,
      refreshBriefing,
      loadMoreUndated,
      refreshSingleTask,
      createNewTask,
      saveTaskDetails,
      postponeTaskDates,
      changeTaskStatus,
      moveTaskToTrash,
      restoreTaskFromTrash,
      removeTaskPermanently,
    ],
  );

  return (
    <TaskDataContext.Provider value={value}>{children}</TaskDataContext.Provider>
  );
}

export function useTaskData(): TaskDataContextValue {
  const ctx = useContext(TaskDataContext);
  if (!ctx) {
    throw new Error('useTaskData는 TaskDataProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
