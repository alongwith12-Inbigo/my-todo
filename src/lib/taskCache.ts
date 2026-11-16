import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { TaskFilterTab, TaskQuerySortField } from '../repositories/taskQueries.ts';
import type { TaskRecord } from '../types/domain.ts';

export interface CachedTaskPage {
  tasks: TaskRecord[];
  hasMore: boolean;
  nextCursor: QueryDocumentSnapshot<DocumentData> | null;
  usedIndexFallback: boolean;
}

export function makeTaskPageCacheKey(
  filter: TaskFilterTab,
  sortField: TaskQuerySortField,
): string {
  return `${filter}:${sortField}`;
}

export function doesTaskMatchFilterTab(
  task: TaskRecord,
  filter: TaskFilterTab,
): boolean {
  if (filter === 'trash') {
    return task.isDeleted;
  }
  if (task.isDeleted) {
    return false;
  }
  if (filter === 'active') {
    return task.status !== 'done';
  }
  if (filter === 'unreminded') {
    return task.status !== 'done' && task.remindAt === null;
  }
  return task.status === filter;
}

export function patchCachedTaskPages(
  pages: Record<string, CachedTaskPage>,
  task: TaskRecord,
): Record<string, CachedTaskPage> {
  const keys = Object.keys(pages);
  if (keys.length === 0) return pages;

  let changed = false;
  const next: Record<string, CachedTaskPage> = { ...pages };

  for (const key of keys) {
    const [filterPart] = key.split(':') as [TaskFilterTab, TaskQuerySortField];
    const page = pages[key];
    const existingIdx = page.tasks.findIndex((item) => item.id === task.id);
    const shouldInclude = doesTaskMatchFilterTab(task, filterPart);

    if (shouldInclude) {
      if (existingIdx >= 0) {
        const updatedTasks = [...page.tasks];
        updatedTasks[existingIdx] = task;
        next[key] = { ...page, tasks: updatedTasks };
        changed = true;
      } else {
        next[key] = { ...page, tasks: [task, ...page.tasks] };
        changed = true;
      }
    } else if (existingIdx >= 0) {
      next[key] = {
        ...page,
        tasks: page.tasks.filter((item) => item.id !== task.id),
      };
      changed = true;
    }
  }

  return changed ? next : pages;
}

export function removeTaskFromCachedPages(
  pages: Record<string, CachedTaskPage>,
  taskId: string,
): Record<string, CachedTaskPage> {
  const keys = Object.keys(pages);
  if (keys.length === 0) return pages;

  let changed = false;
  const next: Record<string, CachedTaskPage> = { ...pages };

  for (const key of keys) {
    const page = pages[key];
    if (page.tasks.some((item) => item.id === taskId)) {
      next[key] = {
        ...page,
        tasks: page.tasks.filter((item) => item.id !== taskId),
      };
      changed = true;
    }
  }

  return changed ? next : pages;
}
