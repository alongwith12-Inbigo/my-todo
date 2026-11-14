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
import type { TimetableDraft } from '../../lib/timetable';
import {
  createTimetable,
  deleteTimetable,
  deleteTimetableOverride,
  fetchAllTimetableOverrides,
  fetchAllTimetables,
  fetchSingleTimetable,
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
      setTimetables((prev) =>
        [fresh, ...prev.filter((item) => item.id !== fresh.id)].sort((a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom),
        ),
      );
      return fresh;
    },
    [uid, isActive],
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
      setTimetables((prev) => {
        if (!fresh) return prev.filter((item) => item.id !== timetableId);
        return [fresh, ...prev.filter((item) => item.id !== timetableId)].sort(
          (a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom),
        );
      });
      return fresh;
    },
    [uid, isActive],
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
      const freshList = await fetchAllTimetableOverrides(uid);
      setOverrides(freshList);
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
