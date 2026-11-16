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
import {
  expandTimetableDraftPeriods,
  timetableRecordToDraft,
  type TimetableDraft,
} from '../../lib/timetable';
import {
  createTimetable,
  deleteTimetable,
  deleteTimetableOverride,
  fetchAllTimetableOverrides,
  fetchAllTimetables,
  fetchSingleTimetable,
  fetchSingleTimetableOverride,
  updateTimetable,
  upsertTimetableOverride,
  type UpsertTimetableOverrideInput,
} from '../../repositories/timetableRepo';
import type {
  TimetableOverrideRecord,
  TimetableRecord,
} from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';

interface TimetableDataContextValue {
  timetables: TimetableRecord[];
  overrides: TimetableOverrideRecord[];
  overridesByDate: Record<string, TimetableOverrideRecord>;
  timetablesLoading: boolean;
  timetablesError: string | null;
  refreshTimetables: () => Promise<void>;
  createNewTimetable: (draft: TimetableDraft) => Promise<TimetableRecord>;
  saveTimetable: (
    timetableId: string,
    expectedVersion: number,
    draft: TimetableDraft,
  ) => Promise<TimetableRecord | null>;
  extendTimetableToPeriodCount: (
    timetableId: string,
    targetPeriodCount: number,
  ) => Promise<TimetableRecord | null>;
  removeTimetable: (timetableId: string) => Promise<void>;
  saveDateOverride: (
    input: UpsertTimetableOverrideInput,
    expectedVersion?: number,
  ) => Promise<void>;
  removeDateOverride: (dateKey: string) => Promise<void>;
}

const TimetableDataContext = createContext<TimetableDataContextValue | null>(
  null,
);

export function TimetableDataProvider({ children }: { children: ReactNode }) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';

  const [timetables, setTimetables] = useState<TimetableRecord[]>([]);
  const [overrides, setOverrides] = useState<TimetableOverrideRecord[]>([]);
  const [timetablesLoading, setTimetablesLoading] = useState(false);
  const [timetablesError, setTimetablesError] = useState<string | null>(null);
  const loadedUidRef = useRef<string | null>(null);
  const timetablesRef = useRef<TimetableRecord[]>([]);
  timetablesRef.current = timetables;

  const refreshTimetables = useCallback(async () => {
    if (!uid || !isActive) return;
    setTimetablesLoading(true);
    setTimetablesError(null);
    try {
      const [ttList, ovList] = await Promise.all([
        fetchAllTimetables(uid),
        fetchAllTimetableOverrides(uid),
      ]);
      setTimetables(ttList);
      setOverrides(ovList);
      loadedUidRef.current = uid;
    } catch (err) {
      setTimetablesError(formatTaskErrorMessage(err));
    } finally {
      setTimetablesLoading(false);
    }
  }, [uid, isActive]);

  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      setTimetables([]);
      setOverrides([]);
      setTimetablesError(null);
      loadedUidRef.current = null;
      return;
    }
    if (loadedUidRef.current === uid) return;
    void refreshTimetables();
  }, [uid, isActive, workspace, refreshTimetables]);

  const deactivateOtherActiveTimetables = useCallback(
    async (activeId: string): Promise<Map<string, TimetableRecord>> => {
      const updatedMap = new Map<string, TimetableRecord>();
      if (!uid || !isActive) return updatedMap;

      const others = timetablesRef.current.filter(
        (item) => item.id !== activeId && item.isActive,
      );
      if (others.length === 0) return updatedMap;

      for (const other of others) {
        try {
          await updateTimetable(uid, other.id, other.version, {
            ...timetableRecordToDraft(other),
            isActive: false,
          });
          const refreshed = await fetchSingleTimetable(uid, other.id);
          if (refreshed) {
            updatedMap.set(other.id, refreshed);
          }
        } catch {
          // Best-effort cleanup; ignore secondary concurrency error
        }
      }
      return updatedMap;
    },
    [uid, isActive],
  );

  const createNewTimetable = useCallback(
    async (draft: TimetableDraft): Promise<TimetableRecord> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 시간표를 저장할 수 있습니다.');
      }
      const created = await createTimetable(uid, draft);
      const fresh = await fetchSingleTimetable(uid, created.id);
      if (!fresh) {
        throw new Error('저장된 시간표를 불러오지 못했습니다.');
      }
      const deactivated = fresh.isActive
        ? await deactivateOtherActiveTimetables(fresh.id)
        : new Map<string, TimetableRecord>();
      setTimetables((prev) =>
        [
          fresh,
          ...prev
            .filter((item) => item.id !== fresh.id)
            .map((item) => deactivated.get(item.id) ?? item),
        ].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
      );
      return fresh;
    },
    [uid, isActive, deactivateOtherActiveTimetables],
  );

  const saveTimetable = useCallback(
    async (
      timetableId: string,
      expectedVersion: number,
      draft: TimetableDraft,
    ): Promise<TimetableRecord | null> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 시간표를 수정할 수 있습니다.');
      }
      await updateTimetable(uid, timetableId, expectedVersion, draft);
      const fresh = await fetchSingleTimetable(uid, timetableId);
      const deactivated = fresh?.isActive
        ? await deactivateOtherActiveTimetables(fresh.id)
        : new Map<string, TimetableRecord>();
      setTimetables((prev) => {
        const mappedPrev = prev
          .filter((item) => item.id !== timetableId)
          .map((item) => deactivated.get(item.id) ?? item);
        if (!fresh) return mappedPrev;
        return [fresh, ...mappedPrev].sort((a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom),
        );
      });
      return fresh;
    },
    [uid, isActive, deactivateOtherActiveTimetables],
  );

  const extendTimetableToPeriodCount = useCallback(
    async (
      timetableId: string,
      targetPeriodCount: number,
    ): Promise<TimetableRecord | null> => {
      const target = timetablesRef.current.find((t) => t.id === timetableId);
      if (!target) return null;
      const expanded = expandTimetableDraftPeriods(
        timetableRecordToDraft(target),
        targetPeriodCount,
      );
      return saveTimetable(target.id, target.version, expanded);
    },
    [saveTimetable],
  );

  const removeTimetable = useCallback(
    async (timetableId: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 시간표를 삭제할 수 있습니다.');
      }
      await deleteTimetable(uid, timetableId);
      setTimetables((prev) => prev.filter((item) => item.id !== timetableId));
    },
    [uid, isActive],
  );

  const saveDateOverride = useCallback(
    async (input: UpsertTimetableOverrideInput, expectedVersion?: number) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 임시 변경을 저장할 수 있습니다.');
      }
      await upsertTimetableOverride(uid, input, expectedVersion);
      const fresh = await fetchSingleTimetableOverride(uid, input.dateKey);
      if (fresh) {
        setOverrides((prev) =>
          [fresh, ...prev.filter((item) => item.dateKey !== fresh.dateKey)].sort(
            (a, b) => b.dateKey.localeCompare(a.dateKey),
          ),
        );
      }
    },
    [uid, isActive],
  );

  const removeDateOverride = useCallback(
    async (dateKey: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 임시 변경을 삭제할 수 있습니다.');
      }
      await deleteTimetableOverride(uid, dateKey);
      setOverrides((prev) => prev.filter((item) => item.dateKey !== dateKey));
    },
    [uid, isActive],
  );

  const overridesByDate = useMemo(() => {
    const map: Record<string, TimetableOverrideRecord> = {};
    for (const item of overrides) {
      map[item.dateKey] = item;
    }
    return map;
  }, [overrides]);

  const value = useMemo<TimetableDataContextValue>(
    () => ({
      timetables,
      overrides,
      overridesByDate,
      timetablesLoading,
      timetablesError,
      refreshTimetables,
      createNewTimetable,
      saveTimetable,
      extendTimetableToPeriodCount,
      removeTimetable,
      saveDateOverride,
      removeDateOverride,
    }),
    [
      timetables,
      overrides,
      overridesByDate,
      timetablesLoading,
      timetablesError,
      refreshTimetables,
      createNewTimetable,
      saveTimetable,
      extendTimetableToPeriodCount,
      removeTimetable,
      saveDateOverride,
      removeDateOverride,
    ],
  );

  return (
    <TimetableDataContext.Provider value={value}>
      {children}
    </TimetableDataContext.Provider>
  );
}

export function useTimetableData(): TimetableDataContextValue {
  const ctx = useContext(TimetableDataContext);
  if (!ctx) {
    throw new Error(
      'useTimetableData는 TimetableDataProvider 내부에서만 사용할 수 있습니다.',
    );
  }
  return ctx;
}
