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
  getStoredAiEnabled,
  getStoredPreferredPlannerModel,
  setStoredAiEnabled,
  subscribeAiEnabledChange,
  subscribePreferredPlannerModelChange,
} from '../../lib/aiPreferences';
import {
  buildAiPlannerContext,
  type PlanAdjustmentFilter,
  type PlannerContextResult,
  type ValidatedDayPlan,
} from '../../lib/aiPlanner';
import {
  AiPlannerSessionController,
  type AiPlannerSessionSnapshot,
} from '../../lib/aiPlannerSession';
import type {
  AiAnalyzeNoticeResponse,
  AiBriefingRequest,
  AiBriefingResponse,
  AiPlannerErrorDetail,
  AiStatusResponse,
  AiUsageSnapshot,
} from '../../lib/aiTypes';
import type { MinuteInterval } from '../../lib/timetable';
import {
  AiClientError,
  fetchAiServerStatus,
  requestAiDayPlan,
  requestAiTodayBriefing,
} from '../../services/aiClient';
import { useAuth } from '../auth/AuthContext';

export interface PlannerContextInputs {
  todayKey: string;
  now: Date;
  imminentDays: number;
  tasks: Parameters<typeof buildAiPlannerContext>[0]['tasks'];
  events: Parameters<typeof buildAiPlannerContext>[0]['events'];
  timetables: Parameters<typeof buildAiPlannerContext>[0]['timetables'];
  overridesByDate: Parameters<typeof buildAiPlannerContext>[0]['overridesByDate'];
  academicEvents: Parameters<typeof buildAiPlannerContext>[0]['academicEvents'];
}

interface AiWorkspaceContextValue {
  aiStatus: AiStatusResponse | null;
  aiStatusLoaded: boolean;
  aiStatusLoading: boolean;
  aiStatusError: string | null;
  aiEnabled: boolean;
  hasPersonalKey: boolean;
  refreshAiStatus: (force?: boolean) => Promise<AiStatusResponse | null>;
  patchAiStatus: (
    updater: (prev: AiStatusResponse | null) => AiStatusResponse | null,
  ) => void;
  recordNoticeAnalysisSuccess: (response: AiAnalyzeNoticeResponse) => void;
  setLocalAiEnabled: (enabled: boolean) => void;

  plannerVisible: boolean;
  plannerLoading: boolean;
  plannerError: string | null;
  plannerErrorCode: string | null;
  plannerErrorDetail: AiPlannerErrorDetail | null;
  activePlannerModel: string | null;
  plannerPlan: ValidatedDayPlan | null;
  plannerFilter: PlanAdjustmentFilter;
  generatedDataFingerprint: string | null;

  aiBriefingLoading: boolean;
  aiBriefingError: string | null;
  aiBriefingData: AiBriefingResponse | null;

  ensureTodayKeySynced: (todayKey: string) => void;
  runAiPlanner: (
    inputs: PlannerContextInputs,
    options?: { forceRefresh?: boolean; constraintText?: string },
  ) => Promise<void>;
  runDeterministicPlan: (
    inputs: PlannerContextInputs,
    nextFilter?: PlanAdjustmentFilter,
  ) => void;
  cancelAiPlanner: () => void;
  closeAiPlanner: () => void;
  applyQuickFilter: (
    nextFilter: PlanAdjustmentFilter,
    inputs: PlannerContextInputs,
  ) => void;
  movePlanItem: (
    taskId: string,
    direction: 'up' | 'down',
    availableIntervals: MinuteInterval[],
  ) => void;
  excludePlanItem: (
    taskId: string,
    availableIntervals: MinuteInterval[],
  ) => void;
  reassignPlanSlot: (
    taskId: string,
    intervalIndex: number,
    availableIntervals: MinuteInterval[],
  ) => void;
  resetLocalAdjustments: (inputs: PlannerContextInputs) => void;

  runAiBriefing: (payload: AiBriefingRequest) => Promise<void>;
  cancelAiBriefing: () => void;
  closeAiBriefing: () => void;
}

const AiWorkspaceContext = createContext<AiWorkspaceContextValue | null>(null);

export function AiWorkspaceProvider({
  todayKey,
  children,
}: {
  todayKey: string;
  children: ReactNode;
}) {
  const { firebaseUser, accessRecord, workspace } = useAuth();
  const uid = firebaseUser?.uid ?? null;
  const isActive = accessRecord?.status === 'active';

  const controllerRef = useRef<AiPlannerSessionController>(
    new AiPlannerSessionController(),
  );
  const [sessionState, setSessionState] = useState<AiPlannerSessionSnapshot>(() =>
    controllerRef.current.syncSession(uid, todayKey),
  );

  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [aiStatusLoaded, setAiStatusLoaded] = useState(false);
  const [aiStatusLoading, setAiStatusLoading] = useState(false);
  const [aiStatusError, setAiStatusError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(() => getStoredAiEnabled(uid));
  const [preferredPlannerModel, setPreferredPlannerModel] = useState<string | null>(() =>
    getStoredPreferredPlannerModel(uid),
  );
  const [hasPersonalKey, setHasPersonalKey] = useState(false);

  const [plannerLoading, setPlannerLoading] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [plannerErrorCode, setPlannerErrorCode] = useState<string | null>(null);
  const [plannerErrorDetail, setPlannerErrorDetail] =
    useState<AiPlannerErrorDetail | null>(null);

  const [aiBriefingLoading, setAiBriefingLoading] = useState(false);
  const [aiBriefingError, setAiBriefingError] = useState<string | null>(null);

  const statusPromiseRef = useRef<Promise<AiStatusResponse | null> | null>(null);
  const statusLoadedUidRef = useRef<string | null>(null);
  const plannerAbortRef = useRef<AbortController | null>(null);
  const aiBriefingAbortRef = useRef<AbortController | null>(null);
  const plannerInFlightRef = useRef(false);
  const briefingInFlightRef = useRef(false);

  const syncSnapshotState = useCallback((next: AiPlannerSessionSnapshot) => {
    setSessionState(next);
  }, []);

  // Sync persisted planner/briefing cache with active UID & KST dateKey
  useEffect(() => {
    if (!uid || !isActive || !workspace) {
      plannerAbortRef.current?.abort();
      aiBriefingAbortRef.current?.abort();
      plannerAbortRef.current = null;
      aiBriefingAbortRef.current = null;
      plannerInFlightRef.current = false;
      briefingInFlightRef.current = false;
      controllerRef.current.resetForSignOut();
      setSessionState(controllerRef.current.getSnapshot());
      setPlannerLoading(false);
      setPlannerError(null);
      setPlannerErrorCode(null);
      setPlannerErrorDetail(null);
      setAiBriefingLoading(false);
      setAiBriefingError(null);
      setAiStatus(null);
      setAiStatusLoaded(false);
      setAiStatusLoading(false);
      setAiStatusError(null);
      setHasPersonalKey(false);
      statusLoadedUidRef.current = null;
      statusPromiseRef.current = null;
      return;
    }

    const synced = controllerRef.current.syncSession(uid, todayKey);
    setSessionState(synced);
  }, [uid, isActive, workspace, todayKey]);

  useEffect(() => {
    setAiEnabled(getStoredAiEnabled(uid));
    setPreferredPlannerModel(getStoredPreferredPlannerModel(uid));
    const unsubEnabled = subscribeAiEnabledChange(uid, setAiEnabled);
    const unsubModel = subscribePreferredPlannerModelChange(
      uid,
      setPreferredPlannerModel,
    );
    return () => {
      unsubEnabled();
      unsubModel();
    };
  }, [uid]);

  const activePlannerModel =
    preferredPlannerModel || aiStatus?.plannerModel || aiStatus?.model || null;

  const refreshAiStatus = useCallback(
    async (force = false): Promise<AiStatusResponse | null> => {
      if (!uid || !isActive) return null;
      if (!force && statusLoadedUidRef.current === uid && aiStatus) {
        return aiStatus;
      }
      if (statusPromiseRef.current && !force) {
        return statusPromiseRef.current;
      }

      setAiStatusLoading(true);
      setAiStatusError(null);

      const req = fetchAiServerStatus()
        .then((next) => {
          setAiStatus(next);
          setHasPersonalKey(next.hasPersonalKey);
          setAiEnabled(next.aiEnabled);
          setStoredAiEnabled(uid, next.aiEnabled);
          setAiStatusLoaded(true);
          statusLoadedUidRef.current = uid;
          return next;
        })
        .catch((err) => {
          setAiStatusError(
            err instanceof Error
              ? err.message
              : 'AI 설정 및 사용량 상태를 불러오지 못했습니다.',
          );
          setAiStatusLoaded(true);
          return null;
        })
        .finally(() => {
          if (statusPromiseRef.current === req) {
            statusPromiseRef.current = null;
          }
          setAiStatusLoading(false);
        });

      statusPromiseRef.current = req;
      return req;
    },
    [uid, isActive, aiStatus],
  );

  // Fetch AI server status once per authenticated active session
  useEffect(() => {
    if (!uid || !isActive || !workspace) return;
    if (statusLoadedUidRef.current === uid) return;
    void refreshAiStatus(false);
  }, [uid, isActive, workspace, refreshAiStatus]);

  useEffect(() => {
    return () => {
      aiBriefingAbortRef.current?.abort();
      plannerAbortRef.current?.abort();
    };
  }, []);

  const patchAiStatus = useCallback(
    (updater: (prev: AiStatusResponse | null) => AiStatusResponse | null) => {
      setAiStatus((prev) => {
        const next = updater(prev);
        if (next) {
          setHasPersonalKey(next.hasPersonalKey);
          setAiEnabled(next.aiEnabled);
          setStoredAiEnabled(uid, next.aiEnabled);
        }
        return next;
      });
    },
    [uid],
  );

  const recordNoticeAnalysisSuccess = useCallback(
    (response: AiAnalyzeNoticeResponse) => {
      setAiStatus((prev) => {
        if (!prev) return prev;
        if (response.usageSnapshot) {
          return {
            ...prev,
            usage: response.usageSnapshot,
          };
        }
        const prevNotice =
          prev.usage.todayNoticeCount ??
          Math.max(0, prev.usage.todayTotalCount - prev.usage.todayPlanCount);
        const usageTokens = response.usage;
        return {
          ...prev,
          usage: {
            ...prev.usage,
            todayNoticeCount: prevNotice + 1,
            todayTotalCount: prev.usage.todayTotalCount + 1,
            monthTotalCount: prev.usage.monthTotalCount + 1,
            totalInputTokens:
              prev.usage.totalInputTokens + (usageTokens?.inputTokens ?? 0),
            totalOutputTokens:
              prev.usage.totalOutputTokens + (usageTokens?.outputTokens ?? 0),
            totalThoughtTokens:
              prev.usage.totalThoughtTokens + (usageTokens?.thoughtTokens ?? 0),
            lastModel: response.model || prev.usage.lastModel,
            lastUsedAtIso: new Date().toISOString(),
          },
        };
      });
    },
    [],
  );

  const setLocalAiEnabled = useCallback(
    (enabled: boolean) => {
      setAiEnabled(enabled);
      setStoredAiEnabled(uid, enabled);
      setAiStatus((prev) => (prev ? { ...prev, aiEnabled: enabled } : prev));
    },
    [uid],
  );

  const ensureTodayKeySynced = useCallback(
    (nextTodayKey: string) => {
      if (!uid) return;
      syncSnapshotState(controllerRef.current.syncSession(uid, nextTodayKey));
    },
    [uid, syncSnapshotState],
  );

  const buildContext = useCallback(
    (
      inputs: PlannerContextInputs,
      filter: PlanAdjustmentFilter,
    ): PlannerContextResult =>
      buildAiPlannerContext({
        uid: uid ?? 'anonymous',
        todayKey: inputs.todayKey,
        now: inputs.now,
        imminentDays: inputs.imminentDays,
        tasks: inputs.tasks,
        events: inputs.events,
        timetables: inputs.timetables,
        overridesByDate: inputs.overridesByDate,
        academicEvents: inputs.academicEvents,
        filter,
      }),
    [uid],
  );

  const runDeterministicPlan = useCallback(
    (
      inputs: PlannerContextInputs,
      nextFilter: PlanAdjustmentFilter = sessionState.plannerFilter,
    ) => {
      if (uid) {
        controllerRef.current.syncSession(uid, inputs.todayKey);
      }
      const ctx = buildContext(inputs, nextFilter);
      controllerRef.current.setPlannerFilter(nextFilter);
      controllerRef.current.setDeterministicPlan(ctx);
      setPlannerError(null);
      setPlannerErrorCode(null);
      setPlannerErrorDetail(null);
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [uid, sessionState.plannerFilter, buildContext, syncSnapshotState],
  );

  const runAiPlanner = useCallback(
    async (
      inputs: PlannerContextInputs,
      options?: { forceRefresh?: boolean; constraintText?: string },
    ) => {
      if (plannerInFlightRef.current || controllerRef.current.isInFlight()) {
        return;
      }

      const forceRefresh = Boolean(options?.forceRefresh);
      const constraintText = options?.constraintText;

      if (uid) {
        controllerRef.current.syncSession(uid, inputs.todayKey);
      }

      const nextFilter: PlanAdjustmentFilter = {
        ...controllerRef.current.getSnapshot().plannerFilter,
        constraintText: constraintText?.trim() || undefined,
      };
      if (constraintText !== undefined) {
        controllerRef.current.setPlannerFilter(nextFilter);
      }

      controllerRef.current.setPlannerVisible(true);
      syncSnapshotState(controllerRef.current.getSnapshot());
      setPlannerError(null);
      setPlannerErrorCode(null);
      setPlannerErrorDetail(null);

      let currentHasKey = hasPersonalKey;
      let currentEnabled = aiEnabled;
      if (!aiStatusLoaded && uid && isActive) {
        const fetchedStatus = await refreshAiStatus(false);
        if (fetchedStatus) {
          currentHasKey = fetchedStatus.hasPersonalKey;
          currentEnabled = fetchedStatus.aiEnabled;
        }
      }

      if (!currentEnabled || !currentHasKey) {
        // Keep existing deterministic/cached view hidden unless no plan exists; show setup prompt cleanly
        if (!controllerRef.current.getSnapshot().validatedPlan) {
          setPlannerErrorCode(
            !currentEnabled ? 'ai_disabled_by_user' : 'personal_key_required',
          );
        } else {
          setPlannerErrorCode(
            !currentEnabled ? 'ai_disabled_by_user' : 'personal_key_required',
          );
        }
        return;
      }

      const ctx = buildContext(inputs, nextFilter);
      const effectiveForceRefresh =
        forceRefresh ||
        Boolean(
          preferredPlannerModel &&
            controllerRef.current.getSnapshot().validatedPlan?.mode === 'ai' &&
            controllerRef.current.getSnapshot().validatedPlan?.model &&
            controllerRef.current.getSnapshot().validatedPlan?.model !==
              preferredPlannerModel,
        );

      // Reuse cached/persisted plan immediately without touching loading or network
      if (!effectiveForceRefresh) {
        const currentSnap = controllerRef.current.getSnapshot();
        if (
          ctx.compressedRequest.tasks.length > 0 &&
          currentSnap.validatedPlan?.mode === 'ai' &&
          currentSnap.validatedPlan.todayKey === ctx.todayKey
        ) {
          await controllerRef.current.runAiPlan({
            context: ctx,
            forceRefresh: false,
            executeGemini: async () => {
              throw new Error('unexpected_network_call_on_cache_hit');
            },
          });
          syncSnapshotState(controllerRef.current.getSnapshot());
          return;
        }
      }

      if (ctx.compressedRequest.tasks.length === 0) {
        controllerRef.current.setDeterministicPlan(ctx);
        syncSnapshotState(controllerRef.current.getSnapshot());
        return;
      }

      plannerInFlightRef.current = true;
      plannerAbortRef.current?.abort();
      const controller = new AbortController();
      plannerAbortRef.current = controller;
      setPlannerLoading(true);

      let latestUsageSnapshot: AiUsageSnapshot | undefined;
      try {
        await controllerRef.current.runAiPlan({
          context: ctx,
          forceRefresh: effectiveForceRefresh,
          executeGemini: async (compressedRequest) => {
            const payload = preferredPlannerModel
              ? { ...compressedRequest, modelOverride: preferredPlannerModel }
              : compressedRequest;
            const res = await requestAiDayPlan(payload, controller.signal);
            latestUsageSnapshot = res.usageSnapshot;
            return {
              rawPlan: res.rawPlan,
              model: res.model,
              generatedAtIso: res.generatedAtIso,
              usage: res.usage,
            };
          },
        });
        if (controller.signal.aborted) return;
        syncSnapshotState(controllerRef.current.getSnapshot());

        // Reflect usage count locally without an extra /api/ai/status Firestore read
        const latestPlan = controllerRef.current.getSnapshot().validatedPlan;
        const usageTokens = latestPlan?.usage;
        setAiStatus((prev) => {
          if (!prev) return prev;
          if (latestUsageSnapshot) {
            return {
              ...prev,
              usage: latestUsageSnapshot,
            };
          }
          const prevNotice =
            prev.usage.todayNoticeCount ??
            Math.max(0, prev.usage.todayTotalCount - prev.usage.todayPlanCount);
          return {
            ...prev,
            usage: {
              ...prev.usage,
              todayPlanCount: prev.usage.todayPlanCount + 1,
              todayNoticeCount: prevNotice,
              todayTotalCount: prev.usage.todayTotalCount + 1,
              monthTotalCount: prev.usage.monthTotalCount + 1,
              totalInputTokens:
                prev.usage.totalInputTokens + (usageTokens?.inputTokens ?? 0),
              totalOutputTokens:
                prev.usage.totalOutputTokens + (usageTokens?.outputTokens ?? 0),
              totalThoughtTokens:
                prev.usage.totalThoughtTokens + (usageTokens?.thoughtTokens ?? 0),
              lastModel: latestPlan?.model ?? prev.usage.lastModel,
              lastUsedAtIso: latestPlan?.generatedAtIso ?? prev.usage.lastUsedAtIso,
            },
          };
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        controllerRef.current.setDeterministicPlan(ctx);
        syncSnapshotState(controllerRef.current.getSnapshot());
        if (err instanceof AiClientError) {
          setPlannerError(err.message);
          setPlannerErrorCode(err.code);
          setPlannerErrorDetail(err.errorDetail ?? null);
          if (err.code === 'personal_key_required') {
            setHasPersonalKey(false);
            setAiStatus((prev) =>
              prev ? { ...prev, hasPersonalKey: false } : prev,
            );
          }
        } else {
          setPlannerError(
            err instanceof Error
              ? err.message
              : 'AI 조언을 생성하지 못해 기본 우선순위 계획을 먼저 표시했습니다.',
          );
          setPlannerErrorCode('unknown_error');
          setPlannerErrorDetail(null);
        }
      } finally {
        plannerInFlightRef.current = false;
        if (plannerAbortRef.current === controller) {
          plannerAbortRef.current = null;
          setPlannerLoading(false);
        }
      }
    },
    [
      uid,
      isActive,
      hasPersonalKey,
      aiEnabled,
      preferredPlannerModel,
      aiStatusLoaded,
      refreshAiStatus,
      buildContext,
      syncSnapshotState,
    ],
  );

  const cancelAiPlanner = useCallback(() => {
    plannerAbortRef.current?.abort();
    plannerAbortRef.current = null;
    plannerInFlightRef.current = false;
    setPlannerLoading(false);
  }, []);

  const closeAiPlanner = useCallback(() => {
    controllerRef.current.setPlannerVisible(false);
    setPlannerError(null);
    setPlannerErrorCode(null);
    setPlannerErrorDetail(null);
    syncSnapshotState(controllerRef.current.getSnapshot());
  }, [syncSnapshotState]);

  const applyQuickFilter = useCallback(
    (nextFilter: PlanAdjustmentFilter, inputs: PlannerContextInputs) => {
      const ctx = buildContext(inputs, nextFilter);
      controllerRef.current.applyQuickFilter(nextFilter, ctx);
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [buildContext, syncSnapshotState],
  );

  const movePlanItem = useCallback(
    (
      taskId: string,
      direction: 'up' | 'down',
      availableIntervals: MinuteInterval[],
    ) => {
      controllerRef.current.moveItemOrder(taskId, direction, availableIntervals);
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [syncSnapshotState],
  );

  const excludePlanItem = useCallback(
    (taskId: string, availableIntervals: MinuteInterval[]) => {
      controllerRef.current.excludeItem(taskId, availableIntervals);
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [syncSnapshotState],
  );

  const reassignPlanSlot = useCallback(
    (
      taskId: string,
      intervalIndex: number,
      availableIntervals: MinuteInterval[],
    ) => {
      controllerRef.current.reassignItemSlot(
        taskId,
        intervalIndex,
        availableIntervals,
      );
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [syncSnapshotState],
  );

  const resetLocalAdjustments = useCallback(
    (inputs: PlannerContextInputs) => {
      const ctx = buildContext(inputs, {});
      controllerRef.current.resetLocalAdjustments(ctx);
      syncSnapshotState(controllerRef.current.getSnapshot());
    },
    [buildContext, syncSnapshotState],
  );

  const runAiBriefing = useCallback(
    async (payload: AiBriefingRequest) => {
      if (!aiEnabled || briefingInFlightRef.current) return;
      briefingInFlightRef.current = true;
      aiBriefingAbortRef.current?.abort();
      const controller = new AbortController();
      aiBriefingAbortRef.current = controller;

      setAiBriefingError(null);
      setAiBriefingLoading(true);

      try {
        const res = await requestAiTodayBriefing(payload, controller.signal);
        if (controller.signal.aborted) return;
        const { normalizeAiBriefingResult } = await import(
          '../../lib/aiImportValidator'
        );
        const validIds = new Set(payload.tasks.map((t) => t.id));
        const normalized: AiBriefingResponse = {
          model: res.model,
          generatedAtIso: res.generatedAtIso,
          briefing: normalizeAiBriefingResult(res.briefing, validIds),
        };
        controllerRef.current.setAiBriefingData(normalized);
        syncSnapshotState(controllerRef.current.getSnapshot());
      } catch (err) {
        if (controller.signal.aborted) return;
        setAiBriefingError(
          err instanceof AiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'AI 브리핑 요청에 실패했습니다.',
        );
      } finally {
        briefingInFlightRef.current = false;
        if (aiBriefingAbortRef.current === controller) {
          aiBriefingAbortRef.current = null;
          setAiBriefingLoading(false);
        }
      }
    },
    [aiEnabled, syncSnapshotState],
  );

  const cancelAiBriefing = useCallback(() => {
    aiBriefingAbortRef.current?.abort();
    aiBriefingAbortRef.current = null;
    briefingInFlightRef.current = false;
    setAiBriefingLoading(false);
  }, []);

  const closeAiBriefing = useCallback(() => {
    setAiBriefingError(null);
    controllerRef.current.setAiBriefingData(null);
    syncSnapshotState(controllerRef.current.getSnapshot());
  }, [syncSnapshotState]);

  const value = useMemo<AiWorkspaceContextValue>(
    () => ({
      aiStatus,
      aiStatusLoaded,
      aiStatusLoading,
      aiStatusError,
      aiEnabled,
      hasPersonalKey,
      refreshAiStatus,
      patchAiStatus,
      recordNoticeAnalysisSuccess,
      setLocalAiEnabled,
      plannerVisible: sessionState.plannerVisible,
      plannerLoading,
      plannerError,
      plannerErrorCode,
      plannerErrorDetail,
      activePlannerModel,
      plannerPlan: sessionState.validatedPlan,
      plannerFilter: sessionState.plannerFilter,
      generatedDataFingerprint: sessionState.generatedDataFingerprint,
      aiBriefingLoading,
      aiBriefingError,
      aiBriefingData: sessionState.aiBriefingData,
      ensureTodayKeySynced,
      runAiPlanner,
      runDeterministicPlan,
      cancelAiPlanner,
      closeAiPlanner,
      applyQuickFilter,
      movePlanItem,
      excludePlanItem,
      reassignPlanSlot,
      resetLocalAdjustments,
      runAiBriefing,
      cancelAiBriefing,
      closeAiBriefing,
    }),
    [
      aiStatus,
      aiStatusLoaded,
      aiStatusLoading,
      aiStatusError,
      aiEnabled,
      hasPersonalKey,
      refreshAiStatus,
      patchAiStatus,
      recordNoticeAnalysisSuccess,
      setLocalAiEnabled,
      sessionState,
      plannerLoading,
      plannerError,
      plannerErrorCode,
      plannerErrorDetail,
      activePlannerModel,
      aiBriefingLoading,
      aiBriefingError,
      ensureTodayKeySynced,
      runAiPlanner,
      runDeterministicPlan,
      cancelAiPlanner,
      closeAiPlanner,
      applyQuickFilter,
      movePlanItem,
      excludePlanItem,
      reassignPlanSlot,
      resetLocalAdjustments,
      runAiBriefing,
      cancelAiBriefing,
      closeAiBriefing,
    ],
  );

  return (
    <AiWorkspaceContext.Provider value={value}>
      {children}
    </AiWorkspaceContext.Provider>
  );
}

export function useOptionalAiWorkspace(): AiWorkspaceContextValue | null {
  return useContext(AiWorkspaceContext);
}

export function useAiWorkspace(): AiWorkspaceContextValue {
  const ctx = useContext(AiWorkspaceContext);
  if (!ctx) {
    throw new Error('useAiWorkspace는 AiWorkspaceProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
