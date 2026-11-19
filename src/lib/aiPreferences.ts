const AI_ENABLED_STORAGE_PREFIX = 'school_partner_ai_enabled_v1_';
const AI_PREF_CHANGED_EVENT = 'school-partner:ai-pref-changed';

export function getStoredAiEnabled(uid: string | undefined | null): boolean {
  if (!uid || typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(`${AI_ENABLED_STORAGE_PREFIX}${uid}`);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

export function setStoredAiEnabled(
  uid: string | undefined | null,
  enabled: boolean,
): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${AI_ENABLED_STORAGE_PREFIX}${uid}`,
      enabled ? 'true' : 'false',
    );
    window.dispatchEvent(
      new CustomEvent(AI_PREF_CHANGED_EVENT, { detail: { uid, enabled } }),
    );
  } catch {
    // Ignore storage quota/private-mode errors
  }
}

export function subscribeAiEnabledChange(
  uid: string | undefined | null,
  callback: (enabled: boolean) => void,
): () => void {
  if (!uid || typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ uid?: string; enabled?: boolean }>)
      .detail;
    if (detail?.uid === uid && typeof detail.enabled === 'boolean') {
      callback(detail.enabled);
    }
  };
  window.addEventListener(AI_PREF_CHANGED_EVENT, handler);
  return () => {
    window.removeEventListener(AI_PREF_CHANGED_EVENT, handler);
  };
}

const PLANNER_MODEL_STORAGE_PREFIX = 'school_partner_ai_planner_model_v1_';
const PLANNER_MODEL_CHANGED_EVENT = 'school-partner:planner-model-changed';

export function getStoredPreferredPlannerModel(
  uid: string | undefined | null,
): string | null {
  if (!uid || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${PLANNER_MODEL_STORAGE_PREFIX}${uid}`);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function setStoredPreferredPlannerModel(
  uid: string | undefined | null,
  model: string | null,
): void {
  if (!uid || typeof window === 'undefined') return;
  const clean = model?.replace(/^models\//, '').trim() || null;
  try {
    if (clean) {
      window.localStorage.setItem(`${PLANNER_MODEL_STORAGE_PREFIX}${uid}`, clean);
    } else {
      window.localStorage.removeItem(`${PLANNER_MODEL_STORAGE_PREFIX}${uid}`);
    }
    window.dispatchEvent(
      new CustomEvent(PLANNER_MODEL_CHANGED_EVENT, {
        detail: { uid, model: clean },
      }),
    );
  } catch {
    // Ignore storage quota/private-mode errors
  }
}

export function subscribePreferredPlannerModelChange(
  uid: string | undefined | null,
  callback: (model: string | null) => void,
): () => void {
  if (!uid || typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (
      event as CustomEvent<{ uid?: string; model?: string | null }>
    ).detail;
    if (detail?.uid === uid && 'model' in (detail ?? {})) {
      callback(detail.model ?? null);
    }
  };
  window.addEventListener(PLANNER_MODEL_CHANGED_EVENT, handler);
  return () => {
    window.removeEventListener(PLANNER_MODEL_CHANGED_EVENT, handler);
  };
}

