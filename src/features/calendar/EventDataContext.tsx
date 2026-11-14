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
import { compareEventsChronological } from '../../lib/calendar';
import {
  addKstDaysToDateKey,
  getKstDateParts,
  getKstDayRangeMs,
} from '../../lib/dateKst';
import {
  createEvent,
  deleteEvent,
  fetchEventsInRange,
  fetchSingleEvent,
  updateEvent,
  type CreateEventInput,
  type UpdateEventPatch,
} from '../../repositories/eventRepo';
import type { CalendarEventRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useTaskData } from '../tasks/TaskDataContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';

interface EventDataContextValue {
  events: CalendarEventRecord[];
  eventsLoading: boolean;
  eventsError: string | null;
  isEventPending: (eventId: string) => boolean;
  refreshEvents: () => Promise<void>;
  ensureRangeLoaded: (startMs: number, endMs: number) => Promise<void>;
  refreshSingleEvent: (eventId: string) => Promise<CalendarEventRecord | null>;
  createNewEvent: (input: CreateEventInput) => Promise<CalendarEventRecord>;
  saveEvent: (
    eventId: string,
    expectedVersion: number,
    patch: UpdateEventPatch,
  ) => Promise<CalendarEventRecord | null>;
  removeEvent: (eventId: string) => Promise<void>;
}

const EventDataContext = createContext<EventDataContextValue | null>(null);

function getDefaultInitialRange(): { startMs: number; endMs: number } {
  const todayKey = getKstDateParts().dateKey;
  const startKey = addKstDaysToDateKey(todayKey, -14);
  const endKey = addKstDaysToDateKey(todayKey, 45);
  return {
    startMs: getKstDayRangeMs(startKey).startMs,
    endMs: getKstDayRangeMs(endKey).endMs,
  };
}

export function EventDataProvider({ children }: { children: ReactNode }) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const { refreshSingleTask } = useTaskData();

  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';

  const [eventsMap, setEventsMap] = useState<Map<string, CalendarEventRecord>>(
    () => new Map(),
  );
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const loadedRangeRef = useRef<{ startMs: number; endMs: number } | null>(null);
  const loadedUidRef = useRef<string | null>(null);
  const inFlightSetRef = useRef<Set<string>>(new Set());
  const createInFlightRef = useRef(false);

  const markPending = useCallback((eventId: string, active: boolean) => {
    if (active) {
      inFlightSetRef.current.add(eventId);
    } else {
      inFlightSetRef.current.delete(eventId);
    }
    setPendingIds(Array.from(inFlightSetRef.current));
  }, []);

  const isEventPending = useCallback(
    (eventId: string) => pendingIds.includes(eventId),
    [pendingIds],
  );

  const loadRange = useCallback(
    async (startMs: number, endMs: number, replace = false) => {
      if (!uid || !isActive) return;
      setEventsLoading(true);
      setEventsError(null);
      try {
        const fetched = await fetchEventsInRange(uid, startMs, endMs, 250);
        setEventsMap((prev) => {
          const next = replace ? new Map<string, CalendarEventRecord>() : new Map(prev);
          for (const item of fetched) {
            next.set(item.id, item);
          }
          return next;
        });

        const prevRange = loadedRangeRef.current;
        if (replace || !prevRange) {
          loadedRangeRef.current = { startMs, endMs };
        } else {
          loadedRangeRef.current = {
            startMs: Math.min(prevRange.startMs, startMs),
            endMs: Math.max(prevRange.endMs, endMs),
          };
        }
        loadedUidRef.current = uid;
      } catch (err) {
        setEventsError(formatTaskErrorMessage(err));
      } finally {
        setEventsLoading(false);
      }
    },
    [uid, isActive],
  );

  const refreshEvents = useCallback(async () => {
    const target = loadedRangeRef.current ?? getDefaultInitialRange();
    await loadRange(target.startMs, target.endMs, true);
  }, [loadRange]);

  const ensureRangeLoaded = useCallback(
    async (startMs: number, endMs: number) => {
      if (!uid || !isActive) return;
      const current = loadedRangeRef.current;
      if (
        loadedUidRef.current === uid &&
        current &&
        startMs >= current.startMs &&
        endMs <= current.endMs
      ) {
        return;
      }
      await loadRange(startMs, endMs, false);
    },
    [uid, isActive, loadRange],
  );

  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      setEventsMap(new Map());
      setEventsError(null);
      loadedRangeRef.current = null;
      loadedUidRef.current = null;
      return;
    }
    if (loadedUidRef.current === uid && loadedRangeRef.current) {
      return;
    }
    const initial = getDefaultInitialRange();
    void loadRange(initial.startMs, initial.endMs, true);
  }, [uid, isActive, workspace, loadRange]);

  const refreshSingleEvent = useCallback(
    async (eventId: string): Promise<CalendarEventRecord | null> => {
      if (!uid) return null;
      const fresh = await fetchSingleEvent(uid, eventId);
      setEventsMap((prev) => {
        const next = new Map(prev);
        if (fresh) {
          next.set(fresh.id, fresh);
        } else {
          next.delete(eventId);
        }
        return next;
      });
      return fresh;
    },
    [uid],
  );

  const createNewEvent = useCallback(
    async (input: CreateEventInput): Promise<CalendarEventRecord> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 일정을 등록할 수 있습니다.');
      }
      if (createInFlightRef.current) {
        throw new Error('일정 등록 요청이 이미 처리 중입니다.');
      }
      createInFlightRef.current = true;
      try {
        const created = await createEvent(uid, input);
        const fresh = await fetchSingleEvent(uid, created.id);
        if (!fresh) {
          throw new Error('등록된 일정을 불러오지 못했습니다.');
        }
        setEventsMap((prev) => {
          const next = new Map(prev);
          next.set(fresh.id, fresh);
          return next;
        });
        return fresh;
      } finally {
        createInFlightRef.current = false;
      }
    },
    [uid, isActive],
  );

  const saveEvent = useCallback(
    async (
      eventId: string,
      expectedVersion: number,
      patch: UpdateEventPatch,
    ): Promise<CalendarEventRecord | null> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 일정을 수정할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(eventId)) {
        throw new Error('이미 처리 중인 일정 요청이 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      markPending(eventId, true);
      try {
        await updateEvent(uid, eventId, expectedVersion, patch);
        return await refreshSingleEvent(eventId);
      } finally {
        markPending(eventId, false);
      }
    },
    [uid, isActive, markPending, refreshSingleEvent],
  );

  const removeEvent = useCallback(
    async (eventId: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 일정을 삭제할 수 있습니다.');
      }
      if (inFlightSetRef.current.has(eventId)) {
        throw new Error('이미 처리 중인 일정 요청이 있습니다.');
      }
      markPending(eventId, true);
      try {
        const result = await deleteEvent(uid, eventId);
        setEventsMap((prev) => {
          const next = new Map(prev);
          next.delete(eventId);
          return next;
        });
        if (result.clearedTaskId) {
          void refreshSingleTask(result.clearedTaskId);
        }
      } finally {
        markPending(eventId, false);
      }
    },
    [uid, isActive, markPending, refreshSingleTask],
  );

  const events = useMemo(
    () => Array.from(eventsMap.values()).sort(compareEventsChronological),
    [eventsMap],
  );

  const value = useMemo<EventDataContextValue>(
    () => ({
      events,
      eventsLoading,
      eventsError,
      isEventPending,
      refreshEvents,
      ensureRangeLoaded,
      refreshSingleEvent,
      createNewEvent,
      saveEvent,
      removeEvent,
    }),
    [
      events,
      eventsLoading,
      eventsError,
      isEventPending,
      refreshEvents,
      ensureRangeLoaded,
      refreshSingleEvent,
      createNewEvent,
      saveEvent,
      removeEvent,
    ],
  );

  return (
    <EventDataContext.Provider value={value}>{children}</EventDataContext.Provider>
  );
}

export function useEventData(): EventDataContextValue {
  const ctx = useContext(EventDataContext);
  if (!ctx) {
    throw new Error('useEventData는 EventDataProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
