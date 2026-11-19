import {
  clearPersistedAiState,
  loadPersistedAiState,
  purgeOtherUidAiStates,
  savePersistedAiState,
  type PersistedRawAiPlan,
} from './aiPlanStorage.ts';
import {
  buildDeterministicDayPlan,
  excludePlanItemFromToday,
  mergeDeterministicPlanWithAiAdvice,
  movePlanItemOrder,
  reassignPlanItemSlot,
  type PlanAdjustmentFilter,
  type PlannerContextResult,
  type ValidatedDayPlan,
} from './aiPlanner.ts';
import type {
  AiBriefingResponse,
  AiPlannerRawResult,
  AiPlannerRequest,
  AiTokenUsage,
} from './aiTypes.ts';
import type { MinuteInterval } from './timetable.ts';

export interface AiPlannerSessionSnapshot {
  uid: string | null;
  todayKey: string;
  plannerVisible: boolean;
  plannerFilter: PlanAdjustmentFilter;
  generatedFingerprint: string | null;
  generatedDataFingerprint: string | null;
  validatedPlan: ValidatedDayPlan | null;
  rawAiPlan: PersistedRawAiPlan | null;
  aiBriefingData: AiBriefingResponse | null;
}

export interface RunAiPlannerOutcome {
  executedAiCall: boolean;
  reason:
    | 'in_flight'
    | 'no_tasks'
    | 'fingerprint_cache_hit'
    | 'existing_today_plan_reused'
    | 'generated'
    | 'aborted'
    | 'error';
  plan: ValidatedDayPlan | null;
}

export interface GeminiPlannerExecutorResult {
  rawPlan: AiPlannerRawResult;
  model: string;
  generatedAtIso: string;
  usage?: AiTokenUsage;
}

/**
 * Stateful, framework-agnostic session coordinator for AI planner & briefing reuse.
 * Guarantees synchronous in-flight deduplication, UID-scoped persistence across
 * tab navigation and page reloads, zero-AI local edits, and strict account isolation.
 */
export class AiPlannerSessionController {
  private storage?: Storage | null;
  private cacheByFingerprint = new Map<string, ValidatedDayPlan>();
  private inFlight = false;
  private snapshot: AiPlannerSessionSnapshot = {
    uid: null,
    todayKey: '',
    plannerVisible: false,
    plannerFilter: {},
    generatedFingerprint: null,
    generatedDataFingerprint: null,
    validatedPlan: null,
    rawAiPlan: null,
    aiBriefingData: null,
  };

  constructor(storage?: Storage | null) {
    this.storage = storage;
  }

  getSnapshot(): AiPlannerSessionSnapshot {
    return this.snapshot;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  private persist(): void {
    if (!this.snapshot.uid || !this.snapshot.todayKey) return;
    savePersistedAiState(
      {
        uid: this.snapshot.uid,
        todayKey: this.snapshot.todayKey,
        plannerVisible: this.snapshot.plannerVisible,
        plannerFilter: this.snapshot.plannerFilter,
        generatedFingerprint: this.snapshot.generatedFingerprint,
        generatedDataFingerprint: this.snapshot.generatedDataFingerprint,
        validatedPlan: this.snapshot.validatedPlan,
        rawAiPlan: this.snapshot.rawAiPlan,
        aiBriefingData: this.snapshot.aiBriefingData,
      },
      this.storage,
    );
  }

  syncSession(uid: string | null, todayKey: string): AiPlannerSessionSnapshot {
    if (!uid) {
      this.resetForSignOut();
      return this.snapshot;
    }

    if (this.snapshot.uid === uid && this.snapshot.todayKey === todayKey) {
      return this.snapshot;
    }

    purgeOtherUidAiStates(uid, this.storage);
    this.cacheByFingerprint.clear();
    this.inFlight = false;

    const restored = loadPersistedAiState(uid, todayKey, this.storage);
    if (restored) {
      this.snapshot = {
        uid,
        todayKey,
        plannerVisible: restored.plannerVisible,
        plannerFilter: restored.plannerFilter,
        generatedFingerprint: restored.generatedFingerprint,
        generatedDataFingerprint: restored.generatedDataFingerprint,
        validatedPlan: restored.validatedPlan,
        rawAiPlan: restored.rawAiPlan,
        aiBriefingData: restored.aiBriefingData,
      };
      if (restored.generatedFingerprint && restored.validatedPlan) {
        this.cacheByFingerprint.set(
          restored.generatedFingerprint,
          restored.validatedPlan,
        );
      }
    } else {
      this.snapshot = {
        uid,
        todayKey,
        plannerVisible: false,
        plannerFilter: {},
        generatedFingerprint: null,
        generatedDataFingerprint: null,
        validatedPlan: null,
        rawAiPlan: null,
        aiBriefingData: null,
      };
    }

    return this.snapshot;
  }

  resetForSignOut(): void {
    const prevUid = this.snapshot.uid;
    if (prevUid) {
      clearPersistedAiState(prevUid, this.storage);
    }
    this.cacheByFingerprint.clear();
    this.inFlight = false;
    this.snapshot = {
      uid: null,
      todayKey: '',
      plannerVisible: false,
      plannerFilter: {},
      generatedFingerprint: null,
      generatedDataFingerprint: null,
      validatedPlan: null,
      rawAiPlan: null,
      aiBriefingData: null,
    };
  }

  setPlannerVisible(visible: boolean): AiPlannerSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      plannerVisible: visible,
    };
    this.persist();
    return this.snapshot;
  }

  setPlannerFilter(filter: PlanAdjustmentFilter): AiPlannerSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      plannerFilter: filter,
    };
    this.persist();
    return this.snapshot;
  }

  setDeterministicPlan(context: PlannerContextResult): ValidatedDayPlan {
    const plan = buildDeterministicDayPlan(context);
    this.snapshot = {
      ...this.snapshot,
      plannerVisible: true,
      validatedPlan: plan,
      rawAiPlan: null,
      generatedFingerprint: null,
      generatedDataFingerprint: null,
    };
    this.persist();
    return plan;
  }

  async runAiPlan(params: {
    context: PlannerContextResult;
    forceRefresh?: boolean;
    executeGemini: (
      request: AiPlannerRequest,
    ) => Promise<GeminiPlannerExecutorResult>;
  }): Promise<RunAiPlannerOutcome> {
    if (this.inFlight) {
      return {
        executedAiCall: false,
        reason: 'in_flight',
        plan: this.snapshot.validatedPlan,
      };
    }

    const { context, forceRefresh = false, executeGemini } = params;
    this.snapshot = {
      ...this.snapshot,
      plannerVisible: true,
    };

    if (context.compressedRequest.tasks.length === 0) {
      const plan = this.setDeterministicPlan(context);
      return {
        executedAiCall: false,
        reason: 'no_tasks',
        plan,
      };
    }

    if (!forceRefresh) {
      const exactCached = this.cacheByFingerprint.get(context.fingerprint);
      if (exactCached && exactCached.todayKey === context.todayKey) {
        const reused: ValidatedDayPlan = { ...exactCached, fromCache: true };
        this.snapshot = {
          ...this.snapshot,
          plannerVisible: true,
          validatedPlan: reused,
        };
        this.persist();
        return {
          executedAiCall: false,
          reason: 'fingerprint_cache_hit',
          plan: reused,
        };
      }

      if (
        this.snapshot.validatedPlan?.mode === 'ai' &&
        this.snapshot.validatedPlan.todayKey === context.todayKey
      ) {
        const reused: ValidatedDayPlan = {
          ...this.snapshot.validatedPlan,
          fromCache: true,
        };
        this.snapshot = {
          ...this.snapshot,
          plannerVisible: true,
          validatedPlan: reused,
        };
        this.persist();
        return {
          executedAiCall: false,
          reason: 'existing_today_plan_reused',
          plan: reused,
        };
      }
    }

    this.inFlight = true;
    try {
      const res = await executeGemini(context.compressedRequest);
      const rawAiPlan: PersistedRawAiPlan = {
        raw: res.rawPlan,
        model: res.model,
        generatedAtIso: res.generatedAtIso,
        usage: res.usage,
      };
      const validated = mergeDeterministicPlanWithAiAdvice(
        res.rawPlan,
        context,
        {
          model: res.model,
          generatedAtIso: res.generatedAtIso,
          usage: res.usage,
        },
      );
      this.cacheByFingerprint.set(context.fingerprint, validated);
      this.snapshot = {
        ...this.snapshot,
        plannerVisible: true,
        generatedFingerprint: context.fingerprint,
        generatedDataFingerprint: context.dataFingerprint,
        validatedPlan: validated,
        rawAiPlan,
      };
      this.persist();
      return {
        executedAiCall: true,
        reason: 'generated',
        plan: validated,
      };
    } finally {
      this.inFlight = false;
    }
  }

  applyQuickFilter(
    nextFilter: PlanAdjustmentFilter,
    context: PlannerContextResult,
  ): ValidatedDayPlan {
    let nextPlan: ValidatedDayPlan;
    if (
      this.snapshot.validatedPlan?.mode === 'ai' &&
      this.snapshot.rawAiPlan
    ) {
      nextPlan = mergeDeterministicPlanWithAiAdvice(
        this.snapshot.rawAiPlan.raw,
        context,
        {
          model: this.snapshot.rawAiPlan.model,
          generatedAtIso: this.snapshot.rawAiPlan.generatedAtIso,
          usage: this.snapshot.rawAiPlan.usage,
        },
      );
      if (this.snapshot.validatedPlan.fromCache) {
        nextPlan = { ...nextPlan, fromCache: true };
      }
    } else {
      nextPlan = buildDeterministicDayPlan(context);
    }

    this.snapshot = {
      ...this.snapshot,
      plannerFilter: nextFilter,
      validatedPlan: nextPlan,
    };
    this.persist();
    return nextPlan;
  }

  moveItemOrder(
    taskId: string,
    direction: 'up' | 'down',
    availableIntervals: MinuteInterval[],
  ): ValidatedDayPlan | null {
    if (!this.snapshot.validatedPlan) return null;
    const nextPlan = movePlanItemOrder(
      this.snapshot.validatedPlan,
      taskId,
      direction,
      availableIntervals,
    );
    this.snapshot = {
      ...this.snapshot,
      validatedPlan: nextPlan,
    };
    this.persist();
    return nextPlan;
  }

  excludeItem(
    taskId: string,
    availableIntervals: MinuteInterval[],
  ): ValidatedDayPlan | null {
    const nextExcluded = Array.from(
      new Set([...(this.snapshot.plannerFilter.excludedTaskIds ?? []), taskId]),
    );
    const nextFilter: PlanAdjustmentFilter = {
      ...this.snapshot.plannerFilter,
      excludedTaskIds: nextExcluded,
    };
    const nextPlan = this.snapshot.validatedPlan
      ? excludePlanItemFromToday(
          this.snapshot.validatedPlan,
          taskId,
          availableIntervals,
        )
      : null;

    this.snapshot = {
      ...this.snapshot,
      plannerFilter: nextFilter,
      validatedPlan: nextPlan,
    };
    this.persist();
    return nextPlan;
  }

  reassignItemSlot(
    taskId: string,
    intervalIndex: number,
    availableIntervals: MinuteInterval[],
  ): ValidatedDayPlan | null {
    if (!this.snapshot.validatedPlan) return null;
    const nextPlan = reassignPlanItemSlot(
      this.snapshot.validatedPlan,
      taskId,
      intervalIndex,
      availableIntervals,
    );
    this.snapshot = {
      ...this.snapshot,
      validatedPlan: nextPlan,
    };
    this.persist();
    return nextPlan;
  }

  resetLocalAdjustments(context: PlannerContextResult): ValidatedDayPlan {
    return this.applyQuickFilter({}, context);
  }

  setAiBriefingData(data: AiBriefingResponse | null): AiPlannerSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      aiBriefingData: data,
    };
    this.persist();
    return this.snapshot;
  }

  isPlanStale(currentDataFingerprint: string): boolean {
    return Boolean(
      this.snapshot.validatedPlan?.mode === 'ai' &&
        this.snapshot.generatedDataFingerprint &&
        this.snapshot.generatedDataFingerprint !== currentDataFingerprint,
    );
  }
}
