import type { PlanAdjustmentFilter, ValidatedDayPlan } from './aiPlanner.ts';
import type {
  AiBriefingResponse,
  AiPlannerRawResult,
  AiTokenUsage,
} from './aiTypes.ts';

const STORAGE_PREFIX = 'sp_ai_plan_state_v1_';

export interface PersistedRawAiPlan {
  raw: AiPlannerRawResult;
  model: string;
  generatedAtIso: string;
  usage?: AiTokenUsage;
}

export interface PersistedAiWorkspaceState {
  version: 1;
  uid: string;
  todayKey: string;
  plannerVisible: boolean;
  plannerFilter: PlanAdjustmentFilter;
  generatedFingerprint: string | null;
  generatedDataFingerprint: string | null;
  validatedPlan: ValidatedDayPlan | null;
  rawAiPlan: PersistedRawAiPlan | null;
  aiBriefingData: AiBriefingResponse | null;
  savedAtIso: string;
}

export function getAiPlanStorageKey(uid: string): string {
  return `${STORAGE_PREFIX}${uid}`;
}

function getBrowserStorage(override?: Storage | null): Storage | null {
  if (override !== undefined) return override;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPersistedAiState(
  uid: string | null | undefined,
  todayKey: string,
  storageOverride?: Storage | null,
): PersistedAiWorkspaceState | null {
  if (!uid || !todayKey) return null;
  const storage = getBrowserStorage(storageOverride);
  if (!storage) return null;

  const key = getAiPlanStorageKey(uid);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAiWorkspaceState>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.uid !== uid ||
      parsed.todayKey !== todayKey
    ) {
      storage.removeItem(key);
      return null;
    }

    const validatedPlan =
      parsed.validatedPlan &&
      typeof parsed.validatedPlan === 'object' &&
      parsed.validatedPlan.todayKey === todayKey
        ? { ...parsed.validatedPlan, fromCache: true }
        : null;

    return {
      version: 1,
      uid,
      todayKey,
      plannerVisible: Boolean(parsed.plannerVisible),
      plannerFilter:
        parsed.plannerFilter && typeof parsed.plannerFilter === 'object'
          ? parsed.plannerFilter
          : {},
      generatedFingerprint:
        typeof parsed.generatedFingerprint === 'string'
          ? parsed.generatedFingerprint
          : null,
      generatedDataFingerprint:
        typeof parsed.generatedDataFingerprint === 'string'
          ? parsed.generatedDataFingerprint
          : null,
      validatedPlan,
      rawAiPlan:
        parsed.rawAiPlan && typeof parsed.rawAiPlan === 'object'
          ? parsed.rawAiPlan
          : null,
      aiBriefingData:
        parsed.aiBriefingData && typeof parsed.aiBriefingData === 'object'
          ? parsed.aiBriefingData
          : null,
      savedAtIso:
        typeof parsed.savedAtIso === 'string'
          ? parsed.savedAtIso
          : new Date().toISOString(),
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // ignore storage cleanup errors
    }
    return null;
  }
}

export function savePersistedAiState(
  state: Omit<PersistedAiWorkspaceState, 'version' | 'savedAtIso'>,
  storageOverride?: Storage | null,
): void {
  if (!state.uid || !state.todayKey) return;
  const storage = getBrowserStorage(storageOverride);
  if (!storage) return;

  const payload: PersistedAiWorkspaceState = {
    ...state,
    version: 1,
    savedAtIso: new Date().toISOString(),
  };

  try {
    storage.setItem(getAiPlanStorageKey(state.uid), JSON.stringify(payload));
  } catch {
    // ignore quota/private-browsing errors cleanly
  }
}

export function clearPersistedAiState(
  uid: string | null | undefined,
  storageOverride?: Storage | null,
): void {
  if (!uid) return;
  const storage = getBrowserStorage(storageOverride);
  if (!storage) return;
  try {
    storage.removeItem(getAiPlanStorageKey(uid));
  } catch {
    // ignore storage errors
  }
}

export function purgeOtherUidAiStates(
  activeUid: string | null | undefined,
  storageOverride?: Storage | null,
): void {
  const storage = getBrowserStorage(storageOverride);
  if (!storage) return;

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const entryUid = key.slice(STORAGE_PREFIX.length);
      if (!activeUid || entryUid !== activeUid) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}
