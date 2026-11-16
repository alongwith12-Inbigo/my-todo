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
  buildAcademicDedupeKey,
  getKoreanSchoolYearForDateKey,
  type AcademicEventDraft,
} from '../../lib/academicCalendar';
import { getKstDateParts } from '../../lib/dateKst';
import {
  createAcademicEvent,
  createAcademicEventsBatch,
  deleteAcademicEvent,
  fetchAcademicEventsBySchoolYear,
  fetchSingleAcademicEvent,
  updateAcademicEvent,
} from '../../repositories/academicRepo';
import type { AcademicEventRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { formatTaskErrorMessage } from '../tasks/taskErrors';

interface AcademicEventDataContextValue {
  academicEvents: AcademicEventRecord[];
  academicLoading: boolean;
  academicError: string | null;
  loadedSchoolYears: number[];
  ensureSchoolYearLoaded: (schoolYear: number) => Promise<void>;
  refreshSchoolYear: (schoolYear: number) => Promise<void>;
  createOne: (draft: AcademicEventDraft) => Promise<AcademicEventRecord>;
  batchImport: (
    drafts: AcademicEventDraft[],
  ) => Promise<{ createdCount: number; skippedDuplicateCount: number }>;
  updateOne: (
    eventId: string,
    expectedVersion: number,
    draft: AcademicEventDraft,
  ) => Promise<AcademicEventRecord | null>;
  removeOne: (eventId: string) => Promise<void>;
  markOverrideApplied: (eventId: string, dateKey: string) => Promise<void>;
}

const AcademicEventDataContext =
  createContext<AcademicEventDataContextValue | null>(null);

function sortAcademicEvents(list: AcademicEventRecord[]): AcademicEventRecord[] {
  return [...list].sort((a, b) => {
    if (a.startDate !== b.startDate) {
      return a.startDate.localeCompare(b.startDate);
    }
    if ((a.startTime ?? '') !== (b.startTime ?? '')) {
      return (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
    }
    return a.title.localeCompare(b.title, 'ko');
  });
}

export function AcademicEventDataProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';

  const [academicEvents, setAcademicEvents] = useState<AcademicEventRecord[]>([]);
  const [academicLoading, setAcademicLoading] = useState(false);
  const [academicError, setAcademicError] = useState<string | null>(null);
  const [loadedSchoolYears, setLoadedSchoolYears] = useState<number[]>([]);

  const loadedUidRef = useRef<string | null>(null);
  const loadedYearsRef = useRef<Set<number>>(new Set());
  const inFlightYearsRef = useRef<Set<number>>(new Set());

  const loadSchoolYearInternal = useCallback(
    async (schoolYear: number, force = false) => {
      if (!uid || !isActive) return;
      if (!force && loadedYearsRef.current.has(schoolYear)) return;
      if (inFlightYearsRef.current.has(schoolYear)) return;

      inFlightYearsRef.current.add(schoolYear);
      setAcademicLoading(true);
      setAcademicError(null);

      try {
        const fetched = await fetchAcademicEventsBySchoolYear(uid, schoolYear);
        loadedYearsRef.current.add(schoolYear);
        setLoadedSchoolYears(Array.from(loadedYearsRef.current).sort());

        setAcademicEvents((prev) => {
          const byId = new Map<string, AcademicEventRecord>();
          // Keep events from other schoolYears, replace events in this year cleanly on refresh
          for (const item of prev) {
            if (item.schoolYear !== schoolYear) {
              byId.set(item.id, item);
            }
          }
          for (const item of fetched) {
            byId.set(item.id, item);
          }
          return sortAcademicEvents(Array.from(byId.values()));
        });
      } catch (err) {
        setAcademicError(formatTaskErrorMessage(err));
      } finally {
        inFlightYearsRef.current.delete(schoolYear);
        setAcademicLoading(false);
      }
    },
    [uid, isActive],
  );

  // Initial load for current Korean schoolYear once workspace is active
  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      setAcademicEvents([]);
      setAcademicError(null);
      setLoadedSchoolYears([]);
      loadedUidRef.current = null;
      loadedYearsRef.current = new Set();
      inFlightYearsRef.current = new Set();
      return;
    }

    if (loadedUidRef.current !== uid) {
      loadedUidRef.current = uid;
      loadedYearsRef.current = new Set();
      inFlightYearsRef.current = new Set();
      const currentSchoolYear = getKoreanSchoolYearForDateKey(
        getKstDateParts(new Date()).dateKey,
      );
      void loadSchoolYearInternal(currentSchoolYear, true);
    }
  }, [uid, isActive, workspace, loadSchoolYearInternal]);

  const ensureSchoolYearLoaded = useCallback(
    async (schoolYear: number) => {
      await loadSchoolYearInternal(schoolYear, false);
    },
    [loadSchoolYearInternal],
  );

  const refreshSchoolYear = useCallback(
    async (schoolYear: number) => {
      await loadSchoolYearInternal(schoolYear, true);
    },
    [loadSchoolYearInternal],
  );

  const createOne = useCallback(
    async (draft: AcademicEventDraft): Promise<AcademicEventRecord> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 학사일정을 등록할 수 있습니다.');
      }
      const created = await createAcademicEvent(uid, draft);
      const fresh = await fetchSingleAcademicEvent(uid, created.id);
      if (!fresh) {
        throw new Error('저장된 학사일정을 불러오지 못했습니다.');
      }
      loadedYearsRef.current.add(fresh.schoolYear);
      setAcademicEvents((prev) =>
        sortAcademicEvents([
          fresh,
          ...prev.filter((item) => item.id !== fresh.id),
        ]),
      );
      return fresh;
    },
    [uid, isActive],
  );

  const batchImport = useCallback(
    async (
      drafts: AcademicEventDraft[],
    ): Promise<{ createdCount: number; skippedDuplicateCount: number }> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 학사일정을 저장할 수 있습니다.');
      }

      // Refresh target schoolYears once if not yet loaded to ensure accurate server-side dedupe
      const targetYears = Array.from(new Set(drafts.map((d) => d.schoolYear)));
      for (const y of targetYears) {
        if (!loadedYearsRef.current.has(y)) {
          await loadSchoolYearInternal(y, false);
        }
      }

      const existingKeys = new Set(
        academicEvents.map(
          (ev) =>
            ev.dedupeKey ||
            buildAcademicDedupeKey(ev.startDate, ev.endDate, ev.title),
        ),
      );

      const res = await createAcademicEventsBatch(uid, drafts, existingKeys);
      if (res.createdIds.length > 0) {
        const yearsWithNewEvents = Array.from(
          new Set(
            drafts
              .filter(
                (d) =>
                  !existingKeys.has(
                    buildAcademicDedupeKey(d.startDate, d.endDate, d.title),
                  ),
              )
              .map((d) => d.schoolYear),
          ),
        );
        for (const y of yearsWithNewEvents) {
          await loadSchoolYearInternal(y, true);
        }
      }
      return {
        createdCount: res.createdIds.length,
        skippedDuplicateCount: res.skippedDuplicateCount,
      };
    },
    [uid, isActive, academicEvents, loadSchoolYearInternal],
  );

  const updateOne = useCallback(
    async (
      eventId: string,
      expectedVersion: number,
      draft: AcademicEventDraft,
    ): Promise<AcademicEventRecord | null> => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 학사일정을 수정할 수 있습니다.');
      }
      const res = await updateAcademicEvent(uid, eventId, expectedVersion, draft);
      if (res.unchanged) {
        return academicEvents.find((item) => item.id === eventId) ?? null;
      }
      const fresh = await fetchSingleAcademicEvent(uid, eventId);
      setAcademicEvents((prev) => {
        if (!fresh) return prev.filter((item) => item.id !== eventId);
        return sortAcademicEvents([
          fresh,
          ...prev.filter((item) => item.id !== eventId),
        ]);
      });
      return fresh;
    },
    [uid, isActive, academicEvents],
  );

  const removeOne = useCallback(
    async (eventId: string) => {
      if (!uid || !isActive) {
        throw new Error('활성화된 교사 계정만 학사일정을 삭제할 수 있습니다.');
      }
      await deleteAcademicEvent(uid, eventId);
      setAcademicEvents((prev) => prev.filter((item) => item.id !== eventId));
    },
    [uid, isActive],
  );

  const markOverrideApplied = useCallback(
    async (eventId: string, dateKey: string) => {
      const target = academicEvents.find((ev) => ev.id === eventId);
      if (!target) return;
      if (
        target.timetableImpact === 'override_applied' &&
        target.overrideDateKey === dateKey
      ) {
        return;
      }
      await updateOne(eventId, target.version, {
        title: target.title,
        category: target.category,
        startDate: target.startDate,
        endDate: target.endDate,
        startTime: target.startTime,
        endTime: target.endTime,
        location: target.location,
        schoolYear: target.schoolYear,
        sourceType: target.sourceType,
        sourceLabel: target.sourceLabel,
        sourceText: target.sourceText,
        timetableImpact: 'override_applied',
        overrideDateKey: dateKey,
      });
    },
    [academicEvents, updateOne],
  );

  const value = useMemo<AcademicEventDataContextValue>(
    () => ({
      academicEvents,
      academicLoading,
      academicError,
      loadedSchoolYears,
      ensureSchoolYearLoaded,
      refreshSchoolYear,
      createOne,
      batchImport,
      updateOne,
      removeOne,
      markOverrideApplied,
    }),
    [
      academicEvents,
      academicLoading,
      academicError,
      loadedSchoolYears,
      ensureSchoolYearLoaded,
      refreshSchoolYear,
      createOne,
      batchImport,
      updateOne,
      removeOne,
      markOverrideApplied,
    ],
  );

  return (
    <AcademicEventDataContext.Provider value={value}>
      {children}
    </AcademicEventDataContext.Provider>
  );
}

export function useAcademicEventData(): AcademicEventDataContextValue {
  const ctx = useContext(AcademicEventDataContext);
  if (!ctx) {
    throw new Error(
      'useAcademicEventData는 AcademicEventDataProvider 내부에서만 사용할 수 있습니다.',
    );
  }
  return ctx;
}
