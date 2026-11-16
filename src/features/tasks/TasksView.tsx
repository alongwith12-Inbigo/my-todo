import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { sortTasks, type TaskSortMode } from '../../lib/briefing';
import { formatKstTodayHeader } from '../../lib/dateKst';
import { makeTaskPageCacheKey } from '../../lib/taskCache';
import type { TaskFilterTab, TaskQuerySortField } from '../../repositories/taskRepo';
import type { TaskRecord } from '../../types/domain';
import { useTaskData } from './TaskDataContext';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskQuickAddBar } from './TaskQuickAddBar';
import { TaskRow } from './TaskRow';
import { formatTaskErrorMessage } from './taskErrors';

interface TasksViewProps {
  initialFilter?: TaskFilterTab;
  focusedTaskId?: string | null;
  onClearFocusedTask?: () => void;
  onOpenEvent?: (eventId: string) => void;
}

const FILTER_TABS: { id: TaskFilterTab; label: string }[] = [
  { id: 'active', label: '미완료 전체' },
  { id: 'todo', label: '미착수' },
  { id: 'doing', label: '진행 중' },
  { id: 'on_hold', label: '보류' },
  { id: 'done', label: '완료' },
  { id: 'unreminded', label: '재확인 미지정' },
  { id: 'trash', label: '휴지통' },
];

const PAGE_SIZE = 25;

export function TasksView({
  initialFilter = 'active',
  focusedTaskId,
  onClearFocusedTask,
  onOpenEvent,
}: TasksViewProps) {
  const {
    briefingTasks,
    refreshSingleTask,
    taskPagesByKey,
    taskPageLoadingKey,
    taskPageLoadingMoreKey,
    taskPageError,
    ensureTasksPageLoaded,
    refreshTasksPage,
    loadMoreTasksPage,
  } = useTaskData();

  const [filterTab, setFilterTab] = useState<TaskFilterTab>(initialFilter);
  const [sortMode, setSortMode] = useState<TaskSortMode>('priority');
  const [searchTerm, setSearchTerm] = useState('');

  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);

  const querySortField: TaskQuerySortField =
    sortMode === 'dueAt' ? 'dueAt' : 'updatedAt';
  const pageCacheKey = makeTaskPageCacheKey(filterTab, querySortField);
  const cachedPage = taskPagesByKey[pageCacheKey];
  const tasks = cachedPage?.tasks ?? [];
  const hasMore = cachedPage?.hasMore ?? false;
  const usedIndexFallback = cachedPage?.usedIndexFallback ?? false;
  const loading = taskPageLoadingKey === pageCacheKey;
  const loadingMore = taskPageLoadingMoreKey === pageCacheKey;
  const error = localError ?? taskPageError;

  const tasksRef = useRef<TaskRecord[]>([]);
  const briefingTasksRef = useRef<TaskRecord[]>([]);
  tasksRef.current = tasks;
  briefingTasksRef.current = briefingTasks;

  useEffect(() => {
    setFilterTab(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    if (!focusedTaskId) return;
    const cached =
      tasksRef.current.find((item) => item.id === focusedTaskId) ??
      briefingTasksRef.current.find((item) => item.id === focusedTaskId);
    if (cached) {
      setSelectedTask(cached);
      if (cached.isDeleted) {
        setFilterTab('trash');
      } else if (cached.status === 'done') {
        setFilterTab('done');
      }
      onClearFocusedTask?.();
      return;
    }

    let cancelled = false;
    void refreshSingleTask(focusedTaskId)
      .then((fetched) => {
        if (cancelled) return;
        if (fetched) {
          setSelectedTask(fetched);
          if (fetched.isDeleted) {
            setFilterTab('trash');
          } else if (fetched.status === 'done') {
            setFilterTab('done');
          }
        } else {
          setLocalError('연결된 업무를 찾을 수 없습니다. 이미 영구 삭제되었을 수 있습니다.');
        }
        onClearFocusedTask?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setLocalError(formatTaskErrorMessage(err));
        onClearFocusedTask?.();
      });

    return () => {
      cancelled = true;
    };
  }, [focusedTaskId, refreshSingleTask, onClearFocusedTask]);

  useEffect(() => {
    void ensureTasksPageLoaded(filterTab, querySortField, PAGE_SIZE);
  }, [filterTab, querySortField, ensureTasksPageLoaded]);

  const displayedTasks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = q
      ? tasks.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q),
        )
      : tasks;
    return sortTasks(filtered, sortMode);
  }, [tasks, searchTerm, sortMode]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            {formatKstTodayHeader()}
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            <span>Asia/Seoul</span>
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            업무 관리
          </h1>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLocalError(null);
            void refreshTasksPage(filterTab, querySortField, PAGE_SIZE);
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>목록 새로고침</span>
        </button>
      </div>

      <TaskQuickAddBar
        onOpenTask={(taskId) => {
          const cached =
            tasksRef.current.find((item) => item.id === taskId) ??
            briefingTasksRef.current.find((item) => item.id === taskId);
          if (cached) {
            setSelectedTask(cached);
          } else {
            void refreshSingleTask(taskId).then((fetched) => {
              if (fetched) setSelectedTask(fetched);
            });
          }
        }}
        onOpenEvent={(eventId) => onOpenEvent?.(eventId)}
        onGoToCalendarView={onOpenEvent ? () => onOpenEvent('') : undefined}
      />

      {usedIndexFallback && (
        <div
          role="status"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900"
        >
          Firestore 복합 색인이 아직 배포되지 않아 기본 범위 조회 모드로 표시 중입니다.
          운영 프로젝트에 <code className="font-mono">firestore.indexes.json</code>을
          배포해 주세요.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              void refreshTasksPage(filterTab, querySortField, PAGE_SIZE);
            }}
            className="px-3 py-1 text-xs font-semibold bg-white border border-red-200 rounded-md hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* Filter Tabs + Search & Sort Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="업무 상태 필터"
            className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {FILTER_TABS.map((tab) => {
              const active = filterTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilterTab(tab.id)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-white text-teal-800 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <label htmlFor="tasks-search" className="sr-only">
                업무 검색
              </label>
              <input
                id="tasks-search"
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="불러온 목록 내 검색"
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-44 sm:w-52 focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label htmlFor="tasks-sort" className="sr-only">
                정렬 기준
              </label>
              <select
                id="tasks-sort"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as TaskSortMode)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-700"
              >
                <option value="priority">우선순위순</option>
                <option value="dueAt">마감일순</option>
                <option value="updatedAt">최근 수정순</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 tabular-nums border-t border-slate-100 pt-3">
          <span>
            표시 중 {displayedTasks.length}건
            {hasMore ? ' (추가 페이지 있음)' : ''}
          </span>
          {filterTab === 'trash' && (
            <span>휴지통에서 복구하거나 영구 삭제할 수 있습니다.</span>
          )}
        </div>

        {loading && tasks.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">
            업무 목록을 불러오는 중입니다...
          </div>
        ) : displayedTasks.length === 0 ? (
          <div className="py-10 text-center space-y-1.5">
            <p className="text-sm font-semibold text-slate-800">
              {filterTab === 'trash'
                ? '휴지통이 비어 있습니다.'
                : filterTab === 'done'
                  ? '완료 처리한 업무가 아직 없습니다.'
                  : filterTab === 'unreminded'
                    ? '재확인일이 비어 있는 미완료 업무가 없습니다.'
                    : '해당 조건에 맞는 업무가 없습니다.'}
            </p>
            <p className="text-xs text-slate-500">
              {searchTerm.trim()
                ? '검색어를 지우거나 다른 상태 탭을 확인해 주세요.'
                : filterTab === 'trash'
                  ? '삭제한 업무는 휴지통에 안전하게 보관된 뒤 복구하거나 영구 삭제할 수 있습니다.'
                  : '상단 빠른 등록 창에서 새 업무를 등록해 보세요.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {displayedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onSelect={setSelectedTask}
                onError={setLocalError}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="pt-2 flex justify-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMoreTasksPage(filterTab, querySortField, PAGE_SIZE)}
              className="px-5 py-2 text-xs font-semibold text-teal-800 border border-teal-200 rounded-lg hover:bg-teal-50 disabled:opacity-60 cursor-pointer"
            >
              {loadingMore ? '불러오는 중...' : '이전 업무 더 불러오기'}
            </button>
          </div>
        )}
      </div>

      <TaskDetailModal
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onOpenEvent={onOpenEvent}
      />
    </div>
  );
}
