import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_LIMITS,
  type AiPersistenceMode,
  type AiTokenUsage,
  type AiUsageSnapshot,
  type GeminiApiKeyType,
} from '../src/lib/aiTypes.ts';
import { getKstDateParts } from '../src/lib/dateKst.ts';

import {
  detectGeminiApiKeyType,
  normalizeGeminiApiKeyInput,
  validateGeminiApiKeyFormat,
} from '../src/lib/byokKeyFormat.ts';

export {
  detectGeminiApiKeyType,
  normalizeGeminiApiKeyInput,
  validateGeminiApiKeyFormat,
};

export const BYOK_COOKIE_NAME = 'sp_byok_key';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Random process secret used ONLY when BYOK_ENCRYPTION_SECRET is unset (session_memory_only mode).
const EPHEMERAL_PROCESS_KEY = crypto.randomBytes(32);

export const REDACTED_VAULT_KEY_HINT = 'hidden...key';

interface StoredMemoryKey {
  apiKey: string;
  keyType: GeminiApiKeyType;
  updatedAtIso: string;
}

export interface StoredAiUserState {
  existsInFirestore: boolean;
  aiEnabled: boolean;
  dailyPlanLimit: number;
  dailyTotalLimit: number;
  todayDateKey: string;
  todayPlanCount: number;
  todayTotalCount: number;
  monthKey: string;
  monthTotalCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThoughtTokens: number;
  lastModel: string | null;
  lastUsedAtIso: string | null;
}

interface FirebaseProjectMeta {
  projectId: string;
  firestoreDatabaseId: string;
}

const memoryKeyVault = new Map<string, StoredMemoryKey>();
const memoryStateStore = new Map<string, StoredAiUserState>();
const inFlightUidLocks = new Map<string, number>();

let cachedFirebaseMeta: FirebaseProjectMeta | null = null;

export class ByokVaultError extends Error {
  statusCode: number;
  code:
    | 'encryption_secret_missing'
    | 'vault_persistence_failed'
    | 'firebase_config_missing';

  constructor(
    statusCode: number,
    code:
      | 'encryption_secret_missing'
      | 'vault_persistence_failed'
      | 'firebase_config_missing',
    message: string,
  ) {
    super(message);
    this.name = 'ByokVaultError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isVercelServerlessRuntime(): boolean {
  return process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
}

function getFirebaseMeta(): FirebaseProjectMeta {
  if (cachedFirebaseMeta) return cachedFirebaseMeta;

  const envProjectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const envDbId =
    process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim() ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID?.trim();
  if (envProjectId && envDbId) {
    cachedFirebaseMeta = {
      projectId: envProjectId,
      firestoreDatabaseId: envDbId,
    };
    return cachedFirebaseMeta;
  }

  const candidatePaths = [
    new URL('../firebase-applet-config.json', import.meta.url),
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
  ];

  for (const candidate of candidatePaths) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(candidate, 'utf8'),
      ) as Partial<FirebaseProjectMeta>;
      if (raw.projectId && raw.firestoreDatabaseId) {
        cachedFirebaseMeta = {
          projectId: raw.projectId,
          firestoreDatabaseId: raw.firestoreDatabaseId,
        };
        return cachedFirebaseMeta;
      }
    } catch {
      // Try next candidate
    }
  }

  throw new ByokVaultError(
    500,
    'firebase_config_missing',
    '서버에서 Firebase 프로젝트 설정(firebase-applet-config.json 또는 FIREBASE_PROJECT_ID / FIREBASE_FIRESTORE_DATABASE_ID)을 찾지 못했습니다.',
  );
}

export function getPersistenceMode(): AiPersistenceMode {
  const configured = process.env.BYOK_ENCRYPTION_SECRET?.trim() ?? '';
  if (
    configured.length >= 16 &&
    configured !== 'CHANGE_TO_A_LONG_RANDOM_SERVER_SECRET'
  ) {
    return 'encrypted_vault';
  }
  return 'session_memory_only';
}

function getCipherKey(): Buffer {
  const configured = process.env.BYOK_ENCRYPTION_SECRET?.trim() ?? '';
  if (
    configured.length >= 16 &&
    configured !== 'CHANGE_TO_A_LONG_RANDOM_SERVER_SECRET'
  ) {
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
  }
  return EPHEMERAL_PROCESS_KEY;
}

export function maskGeminiApiKey(_apiKey: string): string {
  return REDACTED_VAULT_KEY_HINT;
}

export function encryptApiKeyForUid(
  apiKey: string,
  uid: string,
): { iv: string; authTag: string; ciphertext: string; keyHint: string } {
  const key = getCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`byok:v1:${uid}`, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(apiKey, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64url'),
    authTag: authTag.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
    keyHint: REDACTED_VAULT_KEY_HINT,
  };
}

export function decryptApiKeyForUid(
  envelope: { iv: string; authTag: string; ciphertext: string },
  uid: string,
): string | null {
  try {
    const key = getCipherKey();
    const iv = Buffer.from(envelope.iv, 'base64url');
    const authTag = Buffer.from(envelope.authTag, 'base64url');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`byok:v1:${uid}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

export function parseCookies(
  cookieHeader: string | string[] | undefined,
): Record<string, string> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!raw || typeof raw !== 'string') return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) {
      out[name] = decodeURIComponent(val);
    }
  }
  return out;
}

export function sealByokCookieValue(apiKey: string, uid: string): string {
  const enc = encryptApiKeyForUid(apiKey, uid);
  return `v1.${enc.iv}.${enc.authTag}.${enc.ciphertext}`;
}

export function unsealByokCookieValue(
  cookieValue: string | undefined,
  uid: string,
): string | null {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  return decryptApiKeyForUid(
    { iv: parts[1], authTag: parts[2], ciphertext: parts[3] },
    uid,
  );
}

export function buildByokSetCookieHeader(
  apiKey: string,
  uid: string,
  isSecure: boolean,
): string {
  const value = encodeURIComponent(sealByokCookieValue(apiKey, uid));
  const attrs = [
    `${BYOK_COOKIE_NAME}=${value}`,
    'Path=/api/ai',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (isSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildByokClearCookieHeader(isSecure: boolean): string {
  const attrs = [
    `${BYOK_COOKIE_NAME}=`,
    'Path=/api/ai',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure) attrs.push('Secure');
  return attrs.join('; ');
}

function defaultUserAiState(now = new Date()): StoredAiUserState {
  const { dateKey } = getKstDateParts(now);
  return {
    existsInFirestore: false,
    aiEnabled: true,
    dailyPlanLimit: AI_LIMITS.DEFAULT_DAILY_PLAN_LIMIT,
    dailyTotalLimit: AI_LIMITS.DEFAULT_DAILY_TOTAL_LIMIT,
    todayDateKey: dateKey,
    todayPlanCount: 0,
    todayTotalCount: 0,
    monthKey: dateKey.slice(0, 7),
    monthTotalCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThoughtTokens: 0,
    lastModel: null,
    lastUsedAtIso: null,
  };
}

function rollStateDatesIfNeeded(
  state: StoredAiUserState,
  now = new Date(),
): StoredAiUserState {
  const { dateKey } = getKstDateParts(now);
  const monthKey = dateKey.slice(0, 7);
  return {
    ...state,
    todayDateKey: dateKey,
    todayPlanCount: state.todayDateKey === dateKey ? state.todayPlanCount : 0,
    todayTotalCount: state.todayDateKey === dateKey ? state.todayTotalCount : 0,
    monthKey,
    monthTotalCount: state.monthKey === monthKey ? state.monthTotalCount : 0,
  };
}

export function toUsageSnapshot(state: StoredAiUserState): AiUsageSnapshot {
  return {
    todayDateKey: state.todayDateKey,
    todayPlanCount: state.todayPlanCount,
    todayTotalCount: state.todayTotalCount,
    monthKey: state.monthKey,
    monthTotalCount: state.monthTotalCount,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    totalThoughtTokens: state.totalThoughtTokens,
    lastModel: state.lastModel,
    lastUsedAtIso: state.lastUsedAtIso,
  };
}

type FirestoreFieldValue =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null };

function decodeFsInt(val: unknown, fallback = 0): number {
  if (
    val &&
    typeof val === 'object' &&
    'integerValue' in val &&
    typeof (val as { integerValue?: unknown }).integerValue === 'string'
  ) {
    const parsed = Number((val as { integerValue: string }).integerValue);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function decodeFsBool(val: unknown, fallback: boolean): boolean {
  if (
    val &&
    typeof val === 'object' &&
    'booleanValue' in val &&
    typeof (val as { booleanValue?: unknown }).booleanValue === 'boolean'
  ) {
    return (val as { booleanValue: boolean }).booleanValue;
  }
  return fallback;
}

function decodeFsString(val: unknown): string | null {
  if (
    val &&
    typeof val === 'object' &&
    'stringValue' in val &&
    typeof (val as { stringValue?: unknown }).stringValue === 'string'
  ) {
    return (val as { stringValue: string }).stringValue;
  }
  return null;
}

async function fetchFirestoreDoc(
  uid: string,
  docName: 'state' | 'vault',
  idToken: string,
): Promise<Record<string, unknown> | null> {
  if (!idToken || idToken === 'test-token') return null;
  try {
    const { projectId, firestoreDatabaseId } = getFirebaseMeta();
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId,
    )}/databases/${encodeURIComponent(
      firestoreDatabaseId,
    )}/documents/users/${encodeURIComponent(uid)}/aiConfig/${docName}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    return json.fields ?? null;
  } catch {
    return null;
  }
}

async function commitFirestoreDoc(params: {
  uid: string;
  docName: 'state' | 'vault';
  idToken: string;
  fields: Record<string, FirestoreFieldValue>;
  isCreate: boolean;
}): Promise<boolean> {
  if (!params.idToken || params.idToken === 'test-token') return false;
  try {
    const { projectId, firestoreDatabaseId } = getFirebaseMeta();
    const docPath = `projects/${projectId}/databases/${firestoreDatabaseId}/documents/users/${params.uid}/aiConfig/${params.docName}`;
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId,
    )}/databases/${encodeURIComponent(
      firestoreDatabaseId,
    )}/documents:commit`;

    const fieldTransforms = [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' as const },
      ...(params.isCreate
        ? [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' as const }]
        : []),
    ];

    const write = params.isCreate
      ? {
          update: {
            name: docPath,
            fields: params.fields,
          },
          updateTransforms: fieldTransforms,
          currentDocument: { exists: false },
        }
      : {
          update: {
            name: docPath,
            fields: params.fields,
          },
          updateTransforms: fieldTransforms,
          updateMask: {
            fieldPaths: Object.keys(params.fields),
          },
        };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes: [write] }),
    });

    return res.ok;
  } catch {
    return false;
  }
}

async function deleteFirestoreVaultDoc(
  uid: string,
  idToken: string,
): Promise<void> {
  if (!idToken || idToken === 'test-token') return;
  try {
    const { projectId, firestoreDatabaseId } = getFirebaseMeta();
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId,
    )}/databases/${encodeURIComponent(
      firestoreDatabaseId,
    )}/documents/users/${encodeURIComponent(uid)}/aiConfig/vault`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch {
    // Ignore cleanup errors
  }
}

export async function loadUserAiState(
  uid: string,
  idToken?: string,
  now = new Date(),
): Promise<StoredAiUserState> {
  const fields = idToken ? await fetchFirestoreDoc(uid, 'state', idToken) : null;
  if (fields) {
    const loaded: StoredAiUserState = {
      existsInFirestore: true,
      aiEnabled: decodeFsBool(fields.aiEnabled, true),
      dailyPlanLimit: Math.max(
        1,
        Math.min(
          AI_LIMITS.MAX_DAILY_PLAN_LIMIT,
          decodeFsInt(fields.dailyPlanLimit, AI_LIMITS.DEFAULT_DAILY_PLAN_LIMIT),
        ),
      ),
      dailyTotalLimit: Math.max(
        1,
        Math.min(
          AI_LIMITS.MAX_DAILY_TOTAL_LIMIT,
          decodeFsInt(fields.dailyTotalLimit, AI_LIMITS.DEFAULT_DAILY_TOTAL_LIMIT),
        ),
      ),
      todayDateKey: decodeFsString(fields.todayDateKey) || getKstDateParts(now).dateKey,
      todayPlanCount: decodeFsInt(fields.todayPlanCount, 0),
      todayTotalCount: decodeFsInt(fields.todayTotalCount, 0),
      monthKey: decodeFsString(fields.monthKey) || getKstDateParts(now).dateKey.slice(0, 7),
      monthTotalCount: decodeFsInt(fields.monthTotalCount, 0),
      totalInputTokens: decodeFsInt(fields.totalInputTokens, 0),
      totalOutputTokens: decodeFsInt(fields.totalOutputTokens, 0),
      totalThoughtTokens: decodeFsInt(fields.totalThoughtTokens, 0),
      lastModel: decodeFsString(fields.lastModel),
      lastUsedAtIso: decodeFsString(fields.lastUsedAtIso),
    };
    const rolled = rollStateDatesIfNeeded(loaded, now);
    memoryStateStore.set(uid, rolled);
    return rolled;
  }

  const mem = memoryStateStore.get(uid);
  if (mem) {
    const rolled = rollStateDatesIfNeeded(mem, now);
    memoryStateStore.set(uid, rolled);
    return rolled;
  }

  const initial = defaultUserAiState(now);
  memoryStateStore.set(uid, initial);
  return initial;
}

export async function saveUserAiState(
  uid: string,
  state: StoredAiUserState,
  idToken?: string,
): Promise<StoredAiUserState> {
  memoryStateStore.set(uid, state);
  if (!idToken) return state;

  const fields: Record<string, FirestoreFieldValue> = {
    aiEnabled: { booleanValue: state.aiEnabled },
    dailyPlanLimit: { integerValue: String(state.dailyPlanLimit) },
    dailyTotalLimit: { integerValue: String(state.dailyTotalLimit) },
    todayDateKey: { stringValue: state.todayDateKey },
    todayPlanCount: { integerValue: String(state.todayPlanCount) },
    todayTotalCount: { integerValue: String(state.todayTotalCount) },
    monthKey: { stringValue: state.monthKey },
    monthTotalCount: { integerValue: String(state.monthTotalCount) },
    totalInputTokens: { integerValue: String(state.totalInputTokens) },
    totalOutputTokens: { integerValue: String(state.totalOutputTokens) },
    totalThoughtTokens: { integerValue: String(state.totalThoughtTokens) },
    lastModel: state.lastModel
      ? { stringValue: state.lastModel.slice(0, 64) }
      : { nullValue: null },
    lastUsedAtIso: state.lastUsedAtIso
      ? { stringValue: state.lastUsedAtIso.slice(0, 40) }
      : { nullValue: null },
    schemaVersion: { integerValue: '1' },
  };

  let ok = await commitFirestoreDoc({
    uid,
    docName: 'state',
    idToken,
    fields,
    isCreate: !state.existsInFirestore,
  });

  if (!ok && state.existsInFirestore) {
    ok = await commitFirestoreDoc({
      uid,
      docName: 'state',
      idToken,
      fields,
      isCreate: true,
    });
  }

  if (ok) {
    const persisted = { ...state, existsInFirestore: true };
    memoryStateStore.set(uid, persisted);
    return persisted;
  }

  return state;
}

export async function savePersonalApiKeyForUid(params: {
  uid: string;
  apiKey: string;
  idToken?: string;
}): Promise<{ keyType: GeminiApiKeyType; persistenceMode: AiPersistenceMode }> {
  const persistenceMode = getPersistenceMode();

  if (isVercelServerlessRuntime() && persistenceMode !== 'encrypted_vault') {
    throw new ByokVaultError(
      503,
      'encryption_secret_missing',
      'Vercel 서버 환경변수 BYOK_ENCRYPTION_SECRET가 설정되지 않았습니다. 서버리스 함수 간 키 복호화 및 Firestore 암호화 저장을 위해 32자 이상의 BYOK_ENCRYPTION_SECRET를 Vercel 환경변수에 추가하고 재배포해 주세요.',
    );
  }

  const enc = encryptApiKeyForUid(params.apiKey, params.uid);
  const keyType = detectGeminiApiKeyType(params.apiKey);

  if (
    persistenceMode === 'encrypted_vault' &&
    params.idToken &&
    params.idToken !== 'test-token'
  ) {
    const existingVault = await fetchFirestoreDoc(
      params.uid,
      'vault',
      params.idToken,
    );
    const fields: Record<string, FirestoreFieldValue> = {
      cipherVersion: { integerValue: '1' },
      iv: { stringValue: enc.iv },
      authTag: { stringValue: enc.authTag },
      ciphertext: { stringValue: enc.ciphertext },
      keyHint: { stringValue: enc.keyHint },
      schemaVersion: { integerValue: '1' },
    };

    let savedToVault = await commitFirestoreDoc({
      uid: params.uid,
      docName: 'vault',
      idToken: params.idToken,
      fields,
      isCreate: !existingVault,
    });

    if (!savedToVault && !existingVault) {
      savedToVault = await commitFirestoreDoc({
        uid: params.uid,
        docName: 'vault',
        idToken: params.idToken,
        fields,
        isCreate: false,
      });
    }

    if (!savedToVault) {
      throw new ByokVaultError(
        502,
        'vault_persistence_failed',
        '암호화된 개인 API 키를 Firestore 보관소(aiConfig/vault)에 저장하지 못했습니다. 계정 승인 상태와 Firestore 보안 규칙 배포 여부를 확인해 주세요.',
      );
    }
  }

  const nowIso = new Date().toISOString();
  memoryKeyVault.set(params.uid, {
    apiKey: params.apiKey,
    keyType,
    updatedAtIso: nowIso,
  });

  return { keyType, persistenceMode };
}

export async function deletePersonalApiKeyForUid(params: {
  uid: string;
  idToken?: string;
}): Promise<void> {
  memoryKeyVault.delete(params.uid);
  if (params.idToken) {
    await deleteFirestoreVaultDoc(params.uid, params.idToken);
  }
}

export async function resolvePersonalApiKeyForUid(params: {
  uid: string;
  cookieHeader?: string | string[];
  idToken?: string;
}): Promise<{ apiKey: string; keyType: GeminiApiKeyType } | null> {
  // 1. Check HttpOnly AES-256-GCM encrypted cookie bound to uid (0 Firestore reads)
  const cookies = parseCookies(params.cookieHeader);
  const fromCookie = unsealByokCookieValue(cookies[BYOK_COOKIE_NAME], params.uid);
  if (fromCookie) {
    const keyType = detectGeminiApiKeyType(fromCookie);
    if (!memoryKeyVault.has(params.uid)) {
      memoryKeyVault.set(params.uid, {
        apiKey: fromCookie,
        keyType,
        updatedAtIso: new Date().toISOString(),
      });
    }
    return { apiKey: fromCookie, keyType };
  }

  // 2. Check process memory vault (0 Firestore reads)
  const fromMemory = memoryKeyVault.get(params.uid);
  if (fromMemory) {
    return { apiKey: fromMemory.apiKey, keyType: fromMemory.keyType };
  }

  // 3. Check persistent AES-256-GCM encrypted Firestore vault if server master secret is set
  if (getPersistenceMode() === 'encrypted_vault' && params.idToken) {
    const fields = await fetchFirestoreDoc(params.uid, 'vault', params.idToken);
    if (fields) {
      const iv = decodeFsString(fields.iv);
      const authTag = decodeFsString(fields.authTag);
      const ciphertext = decodeFsString(fields.ciphertext);
      if (iv && authTag && ciphertext) {
        const decrypted = decryptApiKeyForUid(
          { iv, authTag, ciphertext },
          params.uid,
        );
        if (decrypted) {
          const keyType = detectGeminiApiKeyType(decrypted);
          memoryKeyVault.set(params.uid, {
            apiKey: decrypted,
            keyType,
            updatedAtIso: new Date().toISOString(),
          });
          return { apiKey: decrypted, keyType };
        }
      }
    }
  }

  return null;
}

export function acquireUidInFlightLock(uid: string): boolean {
  const existing = inFlightUidLocks.get(uid);
  const now = Date.now();
  if (existing && now - existing < AI_LIMITS.REQUEST_TIMEOUT_MS + 2000) {
    return false;
  }
  inFlightUidLocks.set(uid, now);
  return true;
}

export function releaseUidInFlightLock(uid: string): void {
  inFlightUidLocks.delete(uid);
}

export function checkDailyQuotaForKind(
  state: StoredAiUserState,
  kind: 'planner' | 'briefing' | 'notice',
): { allowed: boolean; reason?: string; code?: string } {
  if (!state.aiEnabled) {
    return {
      allowed: false,
      code: 'ai_disabled_by_user',
      reason: '설정에서 AI 스마트 업무비서 사용이 꺼져 있습니다. 설정에서 켠 후 다시 시도해 주세요.',
    };
  }
  if (state.todayTotalCount >= state.dailyTotalLimit) {
    return {
      allowed: false,
      code: 'daily_total_quota_exceeded',
      reason: `오늘 개인 AI 전체 호출 한도(${state.dailyTotalLimit}회)에 도달했습니다. 한국시간 자정 이후 다시 사용하거나 설정에서 개인 일일 한도를 조정해 주세요.`,
    };
  }
  if (kind === 'planner' && state.todayPlanCount >= state.dailyPlanLimit) {
    return {
      allowed: false,
      code: 'daily_plan_quota_exceeded',
      reason: `오늘 AI 업무 계획 생성 한도(${state.dailyPlanLimit}회)에 도달했습니다. 기존 계획을 화면에서 조정하거나 설정에서 개인 한도를 확인해 주세요.`,
    };
  }
  return { allowed: true };
}

export function applyUsageIncrement(
  state: StoredAiUserState,
  kind: 'planner' | 'briefing' | 'notice',
  model: string,
  usage?: AiTokenUsage,
  now = new Date(),
): StoredAiUserState {
  const rolled = rollStateDatesIfNeeded(state, now);
  return {
    ...rolled,
    todayPlanCount:
      kind === 'planner' ? rolled.todayPlanCount + 1 : rolled.todayPlanCount,
    todayTotalCount: rolled.todayTotalCount + 1,
    monthTotalCount: rolled.monthTotalCount + 1,
    totalInputTokens: rolled.totalInputTokens + (usage?.inputTokens ?? 0),
    totalOutputTokens: rolled.totalOutputTokens + (usage?.outputTokens ?? 0),
    totalThoughtTokens: rolled.totalThoughtTokens + (usage?.thoughtTokens ?? 0),
    lastModel: model,
    lastUsedAtIso: now.toISOString(),
  };
}
