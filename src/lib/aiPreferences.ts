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
