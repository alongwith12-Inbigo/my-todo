import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
  type AiBriefingResult,
  type AiPlannerRawResult,
  type AiPlannerRequest,
  type AiPlannerResponse,
  type AiRawNoticeOutput,
  type AiTimeoutSource,
  type AiTokenUsage,
  type GeminiApiKeyType,
  type GeminiDiagnosticErrorCategory,
  type GeminiModelCompatibilitySummary,
} from '../src/lib/aiTypes.ts';
import {
  detectGeminiApiKeyType,
  normalizeGeminiApiKeyInput,
} from '../src/lib/byokKeyFormat.ts';
import {
  generateSafeRequestId,
  getGeminiModelName,
  getGeminiModelProfile,
  logAiServerDiagnostic,
  mapGeminiError,
  toCompatibilitySummary,
  type MappedGeminiError,
} from './aiConfig.ts';

const NOTICE_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ['task', 'event'] },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          dueDate: { type: Type.STRING, nullable: true },
          priority: {
            type: Type.STRING,
            enum: ['low', 'normal', 'high', 'urgent'],
          },
          eventStartDate: { type: Type.STRING, nullable: true },
          eventEndDate: { type: Type.STRING, nullable: true },
          allDay: { type: Type.BOOLEAN },
          startTime: { type: Type.STRING, nullable: true },
          endTime: { type: Type.STRING, nullable: true },
          location: { type: Type.STRING, nullable: true },
          dateEvidence: { type: Type.STRING, nullable: true },
          dateUncertain: { type: Type.BOOLEAN },
          uncertaintyReason: { type: Type.STRING, nullable: true },
          rationale: { type: Type.STRING, nullable: true },
          semanticDuplicateId: { type: Type.STRING, nullable: true },
          semanticDuplicateReason: { type: Type.STRING, nullable: true },
        },
        required: ['kind', 'title'],
      },
    },
    unparsedSummary: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['candidates'],
};

const BRIEFING_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    priorityFocus: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          reason: { type: Type.STRING },
          linkedTaskId: { type: Type.STRING, nullable: true },
        },
        required: ['title', 'reason'],
      },
    },
    imminentAlerts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
    conflictAlerts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
    missedChecks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: [
    'summary',
    'priorityFocus',
    'imminentAlerts',
    'conflictAlerts',
    'missedChecks',
  ],
};

const PLANNER_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    coreAdvice: { type: Type.STRING },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          order: { type: Type.INTEGER },
          recommendedStart: { type: Type.STRING, nullable: true },
          recommendedEnd: { type: Type.STRING, nullable: true },
          estimatedMinutes: { type: Type.INTEGER },
          reason: { type: Type.STRING },
          tier: { type: Type.STRING, enum: ['must', 'optional'] },
          strategy: { type: Type.STRING, nullable: true },
        },
        required: ['taskId', 'order', 'estimatedMinutes', 'reason'],
      },
    },
    attentionTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['taskId', 'reason'],
      },
    },
    deferredTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['taskId', 'reason'],
      },
    },
  },
  required: [
    'coreAdvice',
    'recommendations',
    'attentionTasks',
    'deferredTasks',
  ],
};

export function getEffectiveGeminiApiVersion(): string {
  const raw = process.env.GOOGLE_GENAI_API_VERSION?.trim();
  if (!raw) return 'v1';
  return raw === 'beta' ? 'v1beta' : raw;
}

export function createGeminiClient(
  apiKey: string,
  apiVersionOverride?: string,
): GoogleGenAI {
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
    );
  }
  const effectiveApiVersion = apiVersionOverride ?? getEffectiveGeminiApiVersion();
  // GoogleGenAI with { apiKey } injects x-goog-api-key (never Authorization: Bearer),
  // which is required by Google for both AIza... standard keys and AQ.... authorization keys.
  return new GoogleGenAI({
    apiKey: cleanKey,
    apiVersion: effectiveApiVersion,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractUsageMetadata(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}): AiTokenUsage {
  const m = response.usageMetadata;
  const inputTokens = typeof m?.promptTokenCount === 'number' ? m.promptTokenCount : 0;
  const outputTokens =
    typeof m?.candidatesTokenCount === 'number' ? m.candidatesTokenCount : 0;
  const thoughtTokens =
    typeof m?.thoughtsTokenCount === 'number' ? m.thoughtsTokenCount : 0;
  const totalTokens =
    typeof m?.totalTokenCount === 'number'
      ? m.totalTokenCount
      : inputTokens + outputTokens + thoughtTokens;
  return { inputTokens, outputTokens, thoughtTokens, totalTokens };
}

function createLocalTimeoutError(): Error {
  return Object.assign(new Error('Request timed out'), {
    name: 'LocalTimeoutError',
  });
}

function createLocalAbortError(): Error {
  return Object.assign(new Error('Request aborted'), {
    name: 'LocalAbortError',
  });
}

async function runWithTimeoutAndAbort<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw createLocalAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const internalController = new AbortController();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      internalController.abort();
      reject(createLocalTimeoutError());
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      internalController.abort();
      reject(createLocalAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    fn(internalController.signal)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

export class GeminiServiceError extends Error {
  status: number;
  code: string;
  diagnosticCategory?: GeminiDiagnosticErrorCategory;
  timeoutSource?: AiTimeoutSource;
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  requestId?: string;
  requestApiVersion?: string;
  requestEndpoint?: string;
  availableGenerateModels?: string[];
  recommendedModel?: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: {
      diagnosticCategory?: GeminiDiagnosticErrorCategory;
      timeoutSource?: AiTimeoutSource;
      upstreamHttpStatus?: number;
      upstreamApiStatus?: string;
      upstreamErrorMessage?: string;
      requestId?: string;
      requestApiVersion?: string;
      requestEndpoint?: string;
      availableGenerateModels?: string[];
      recommendedModel?: string | null;
    },
  ) {
    super(message);
    this.name = 'GeminiServiceError';
    this.status = status;
    this.code = code;
    this.diagnosticCategory = extra?.diagnosticCategory;
    this.timeoutSource = extra?.timeoutSource;
    this.upstreamHttpStatus = extra?.upstreamHttpStatus;
    this.upstreamApiStatus = extra?.upstreamApiStatus;
    this.upstreamErrorMessage = extra?.upstreamErrorMessage;
    this.requestId = extra?.requestId;
    this.requestApiVersion = extra?.requestApiVersion;
    this.requestEndpoint = extra?.requestEndpoint;
    this.availableGenerateModels = extra?.availableGenerateModels;
    this.recommendedModel = extra?.recommendedModel;
  }
}

function toServiceError(
  mapped: MappedGeminiError,
  extra?: {
    requestId?: string;
    requestApiVersion?: string;
    requestEndpoint?: string;
    availableGenerateModels?: string[];
    recommendedModel?: string | null;
  },
): GeminiServiceError {
  return new GeminiServiceError(mapped.status, mapped.code, mapped.message, {
    diagnosticCategory: mapped.diagnosticCategory,
    timeoutSource: mapped.timeoutSource,
    upstreamHttpStatus: mapped.upstreamHttpStatus,
    upstreamApiStatus: mapped.upstreamApiStatus,
    upstreamErrorMessage: mapped.upstreamErrorMessage,
    requestId: extra?.requestId,
    requestApiVersion: extra?.requestApiVersion,
    requestEndpoint: extra?.requestEndpoint,
    availableGenerateModels: extra?.availableGenerateModels,
    recommendedModel: extra?.recommendedModel,
  });
}

/**
 * Thinking parameter rules separated per model family via getGeminiModelProfile().
 * Gemini 4 / Gemini 3 models use thinkingLevel (thinkingBudget fails with 400);
 * Gemini 2.5 models use bounded thinkingBudget.
 */
export function buildThinkingConfigForModel(
  modelName: string,
  mode: 'probe' | 'minimal_extract' | 'low_reasoning',
): { thinkingLevel: ThinkingLevel } | { thinkingBudget: number } | undefined {
  const profile = getGeminiModelProfile(modelName);
  const setting =
    mode === 'probe'
      ? profile.probe
      : mode === 'minimal_extract'
        ? profile.operations.analyze_notice
        : profile.operations.planner;

  if (setting.thinkingLevel === 'MINIMAL') {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }
  if (setting.thinkingLevel === 'LOW') {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  if (typeof setting.thinkingBudget === 'number') {
    return { thinkingBudget: setting.thinkingBudget };
  }
  return undefined;
}

export interface GeminiTestClientLike {
  models: {
    list: (params?: { config?: { pageSize?: number } }) => Promise<{
      page?: Array<{ name?: string; supportedActions?: string[] }>;
    }>;
    generateContent: (params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }) => Promise<{
      text?: string;
      candidates?: Array<{ finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
    }>;
  };
}

export interface GeminiPersonalKeyTestResult {
  ok: boolean;
  model: string;
  configuredModel: string;
  isCandidateTest?: boolean;
  apiKeyAuthOk: boolean;
  modelAccessible: boolean;
  generateContentOk: boolean;
  httpStatus?: number;
  finishReason?: string;
  latencyMs?: number;
  timeoutMs?: number;
  timeoutSource?: AiTimeoutSource;
  usage: AiTokenUsage;
  keyType: GeminiApiKeyType;
  diagnosticCategory?: GeminiDiagnosticErrorCategory;
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  requestApiVersion: string;
  requestEndpoint: string;
  modelListCached: boolean;
  targetModelInList?: boolean;
  targetModelSupportsGenerate?: boolean;
  availableGenerateModels: string[];
  recommendedModel: string | null;
  compatibility?: GeminiModelCompatibilitySummary;
  errorCode?: string;
  message?: string;
  warning?: string;
}

export function getKeyTestProbeTimeoutMs(isCandidateTest: boolean): number {
  return isCandidateTest
    ? AI_LIMITS.CANDIDATE_TEST_TIMEOUT_MS
    : AI_LIMITS.KEY_TEST_TIMEOUT_MS;
}

const ZERO_USAGE: AiTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

interface CachedModelListEntry {
  expiresAt: number;
  models: Array<{ name?: string; supportedActions?: string[] }>;
}

interface CachedResolvedModelEntry {
  expiresAt: number;
  resolvedModel: string;
  resolvedApiVersion: string;
  omitThinkingConfig?: boolean;
}

const modelListCache = new Map<string, CachedModelListEntry>();
const resolvedModelCache = new Map<string, CachedResolvedModelEntry>();

export function clearGeminiModelCacheForTesting(): void {
  modelListCache.clear();
  resolvedModelCache.clear();
}

function hashKeyForCache(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function setBoundedCacheEntry<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

const EXCLUDED_MODEL_SUBSTRINGS = [
  'embedding',
  '-image',
  '-tts',
  '-live',
  '-transcribe',
  'imagen',
  'veo',
  'lyria',
  'robotics',
  'computer-use',
  'deep-research',
  'customtools',
  'aqa',
  'gemini-1.5',
  'gemini-2.0',
];

const PREFERRED_TEXT_MODEL_ORDER = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
];

function rankGeminiTextModel(name: string): number {
  const lower = name.toLowerCase();
  const explicitIdx = PREFERRED_TEXT_MODEL_ORDER.indexOf(lower);
  if (explicitIdx >= 0) return explicitIdx;
  if (lower.startsWith('gemini-4-') && !lower.includes('carbon')) return 20;
  if (lower.startsWith('gemini-4-')) return 25;
  if (lower.startsWith('gemini-3') && lower.includes('flash')) return 30;
  if (lower.startsWith('gemini-3')) return 35;
  if (lower.startsWith('gemini-2.5-') && lower.includes('flash')) return 60;
  if (lower.startsWith('gemini-2.5-')) return 70;
  return 90;
}

export interface ListedModelInspection {
  configuredModelInList: boolean;
  configuredModelSupportsGenerate: boolean;
  availableGenerateModels: string[];
  recommendedFallbackModel: string | null;
}

export function inspectListedGeminiModels(
  listedModels: Array<{ name?: string; supportedActions?: string[] }> | undefined,
  configuredModel: string,
): ListedModelInspection {
  const configuredShort = configuredModel.replace(/^models\//, '').trim();
  let configuredModelInList = false;
  let configuredModelSupportsGenerate = false;
  const generateCapable: string[] = [];

  if (Array.isArray(listedModels)) {
    for (const item of listedModels) {
      const rawName = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!rawName) continue;
      const shortName = rawName.replace(/^models\//, '');
      const supportsGenerate =
        Array.isArray(item.supportedActions) &&
        item.supportedActions.includes('generateContent');

      if (shortName === configuredShort) {
        configuredModelInList = true;
        configuredModelSupportsGenerate = supportsGenerate;
      }

      const lower = shortName.toLowerCase();
      if (!lower.includes('gemini')) continue;
      if (EXCLUDED_MODEL_SUBSTRINGS.some((part) => lower.includes(part))) {
        continue;
      }
      if (!supportsGenerate) continue;
      if (!generateCapable.includes(shortName)) {
        generateCapable.push(shortName);
      }
    }
  }

  generateCapable.sort((a, b) => {
    const ra = rankGeminiTextModel(a);
    const rb = rankGeminiTextModel(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  // When a 2.5 model fails, prefer an active Gemini 3/4 candidate ahead of another 2.5 alias
  const isConfiguredLegacy25 = configuredShort.toLowerCase().startsWith('gemini-2.5');
  const recommendedFallbackModel =
    (isConfiguredLegacy25
      ? generateCapable.find(
          (name) =>
            name !== configuredShort &&
            !name.toLowerCase().startsWith('gemini-2.5'),
        )
      : undefined) ??
    generateCapable.find((name) => name !== configuredShort) ??
    null;

  return {
    configuredModelInList,
    configuredModelSupportsGenerate,
    availableGenerateModels: generateCapable.slice(0, 8),
    recommendedFallbackModel,
  };
}

async function getCachedOrFetchModelList(params: {
  ai: GeminiTestClientLike;
  apiKey: string;
  apiVersion: string;
  configuredModel: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ inspection: ListedModelInspection; cached: boolean }> {
  const keyHash = params.apiKey ? hashKeyForCache(params.apiKey) : 'override';
  const cacheKey = `${keyHash}:${params.apiVersion}`;
  const now = Date.now();
  const hit = modelListCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return {
      inspection: inspectListedGeminiModels(hit.models, params.configuredModel),
      cached: true,
    };
  }

  const pager = await runWithTimeoutAndAbort(
    () => params.ai.models.list({ config: { pageSize: 100 } }),
    params.timeoutMs,
    params.signal,
  );
  const rawModels = Array.isArray(pager?.page) ? pager.page : [];
  setBoundedCacheEntry(modelListCache, cacheKey, {
    expiresAt: now + MODEL_CACHE_TTL_MS,
    models: rawModels,
  });
  return {
    inspection: inspectListedGeminiModels(rawModels, params.configuredModel),
    cached: false,
  };
}

function buildGenerateEndpointPath(modelName: string): string {
  const short = modelName.replace(/^models\//, '').trim();
  return `models/${short}:generateContent`;
}

/**
 * Verifies only API key authentication (via 0-token models.list) before saving.
 * Does NOT execute generateContent so saving a key consumes zero generation tokens.
 */
export async function verifyGeminiKeyAuthOnly(
  apiKey: string,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
  requestId?: string,
): Promise<{ keyType: GeminiApiKeyType; availableGenerateModels: string[] }> {
  const reqId = requestId ?? generateSafeRequestId();
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
      { requestId: reqId },
    );
  }
  const keyType = detectGeminiApiKeyType(cleanKey);
  const configuredModel = getGeminiModelName();
  const apiVersion = getEffectiveGeminiApiVersion();
  const ai = clientOverride ?? createGeminiClient(cleanKey);

  try {
    const { inspection } = await getCachedOrFetchModelList({
      ai,
      apiKey: cleanKey,
      apiVersion,
      configuredModel,
      timeoutMs: 7000,
      signal,
    });
    return {
      keyType,
      availableGenerateModels: inspection.availableGenerateModels,
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, configuredModel);
    logAiServerDiagnostic('warn', 'gemini_verify_auth_failed', {
      requestId: reqId,
      model: configuredModel,
      apiVersion,
      errorCode: mapped.code,
      diagnosticCategory: mapped.diagnosticCategory,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
    });
    throw toServiceError(mapped, {
      requestId: reqId,
      requestApiVersion: apiVersion,
    });
  }
}

export async function testGeminiPersonalKey(
  apiKey: string,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
  requestId?: string,
  options?: { candidateModel?: string },
): Promise<GeminiPersonalKeyTestResult> {
  const reqId = requestId ?? generateSafeRequestId();
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
      { requestId: reqId },
    );
  }
  const keyType = detectGeminiApiKeyType(cleanKey);
  const configuredModel = getGeminiModelName();
  const targetModel = options?.candidateModel
    ? options.candidateModel.replace(/^models\//, '').trim()
    : configuredModel;
  const isCandidateTest = targetModel !== configuredModel;
  const targetProfile = getGeminiModelProfile(targetModel);
  const compatibility = toCompatibilitySummary(targetProfile);
  const apiVersion = getEffectiveGeminiApiVersion();
  const requestEndpoint = buildGenerateEndpointPath(targetModel);
  const ai = clientOverride ?? createGeminiClient(cleanKey);

  // 1. Check API key authentication & list generateContent-capable models (cached per key hash for 10m)
  let inspection: ListedModelInspection;
  let modelListCached = false;
  try {
    const listed = await getCachedOrFetchModelList({
      ai,
      apiKey: cleanKey,
      apiVersion,
      configuredModel: targetModel,
      timeoutMs: 6000,
      signal,
    });
    inspection = listed.inspection;
    modelListCached = listed.cached;
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, targetModel);
    logAiServerDiagnostic('warn', 'gemini_key_test_list_failed', {
      requestId: reqId,
      model: targetModel,
      configuredModel,
      isCandidateTest,
      apiVersion,
      errorCode: mapped.code,
      diagnosticCategory: mapped.diagnosticCategory,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
    });
    throw toServiceError(mapped, {
      requestId: reqId,
      requestApiVersion: apiVersion,
      requestEndpoint,
    });
  }

  // Note: If target model is explicitly listed WITHOUT generateContent support,
  // report modelAccessible=false and generateContentOk=false without making extra generateContent calls.
  if (
    inspection.configuredModelInList &&
    !inspection.configuredModelSupportsGenerate
  ) {
    return {
      ok: false,
      model: targetModel,
      configuredModel,
      isCandidateTest,
      apiKeyAuthOk: true,
      modelAccessible: false,
      generateContentOk: false,
      usage: ZERO_USAGE,
      keyType,
      diagnosticCategory: 'model_generate_unsupported',
      errorCode: 'model_generate_unsupported',
      requestApiVersion: apiVersion,
      requestEndpoint,
      modelListCached,
      targetModelInList: true,
      targetModelSupportsGenerate: false,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: inspection.recommendedFallbackModel,
      compatibility,
      message: `API 키 인증은 정상이나 대상 모델(${targetModel})이 generateContent 생성 기능을 지원하지 않습니다.`,
      warning: inspection.recommendedFallbackModel
        ? `계정 목록에서 확인된 활성 모델(${inspection.recommendedFallbackModel})로 1회 연결 검증을 진행해 보세요.`
        : undefined,
    };
  }

  // 2. Run strictly ONE minimal generateContent probe against the target model
  //    (no JSON schema, short non-PII prompt, minimal output tokens, zero retries, zero fallback)
  const probeTimeoutMs = getKeyTestProbeTimeoutMs(isCandidateTest);
  const startedAt = Date.now();
  try {
    const thinkingConfig = buildThinkingConfigForModel(targetModel, 'probe');
    const response = await runWithTimeoutAndAbort(
      (attemptSignal) =>
        ai.models.generateContent({
          model: targetModel,
          contents: 'Reply with OK only.',
          config: {
            maxOutputTokens: targetProfile.probe.maxOutputTokens,
            ...(thinkingConfig ? { thinkingConfig } : {}),
            abortSignal: attemptSignal,
          },
        }),
      probeTimeoutMs,
      signal,
    );
    const probeLatencyMs = Math.max(1, Date.now() - startedAt);
    const finishReason = response.candidates?.[0]?.finishReason;
    const usage = extractUsageMetadata(response);
    const text = response.text?.trim() ?? '';
    const isEmptyProbeFailure =
      (!text && finishReason === 'MAX_TOKENS') ||
      (typeof response.text === 'string' && !text) ||
      (!text && usage.outputTokens === 0);
    if (isEmptyProbeFailure) {
      const truncated = finishReason === 'MAX_TOKENS';
      return {
        ok: false,
        model: targetModel,
        configuredModel,
        isCandidateTest,
        apiKeyAuthOk: true,
        modelAccessible: true,
        generateContentOk: false,
        httpStatus: 200,
        finishReason: finishReason ?? 'UNKNOWN',
        latencyMs: probeLatencyMs,
        timeoutMs: probeTimeoutMs,
        usage,
        keyType,
        diagnosticCategory: 'server_error',
        errorCode: truncated ? 'ai_response_truncated' : 'ai_empty_response',
        requestApiVersion: apiVersion,
        requestEndpoint,
        modelListCached,
        targetModelInList: inspection.configuredModelInList,
        targetModelSupportsGenerate: inspection.configuredModelSupportsGenerate,
        availableGenerateModels: inspection.availableGenerateModels,
        recommendedModel: isCandidateTest
          ? inspection.recommendedFallbackModel
          : null,
        compatibility,
        message: truncated
          ? `대상 모델(${targetModel}) 응답이 최소 출력 한도(${targetProfile.probe.maxOutputTokens})에서 잘려 빈 텍스트를 반환했습니다.`
          : `대상 모델(${targetModel})이 빈 응답을 반환했습니다.`,
      };
    }

    return {
      ok: true,
      model: targetModel,
      configuredModel,
      isCandidateTest,
      apiKeyAuthOk: true,
      modelAccessible: true,
      generateContentOk: true,
      httpStatus: 200,
      finishReason: finishReason ?? 'STOP',
      latencyMs: probeLatencyMs,
      timeoutMs: probeTimeoutMs,
      usage,
      keyType,
      requestApiVersion: apiVersion,
      requestEndpoint,
      modelListCached,
      targetModelInList: inspection.configuredModelInList,
      targetModelSupportsGenerate: inspection.configuredModelSupportsGenerate,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: null,
      compatibility,
      message: isCandidateTest
        ? `후보 모델(${targetModel}) 1회 generateContent 검증에 성공했습니다. (현재 서버 GEMINI_MODEL=${configuredModel} 설정은 아직 변경되지 않았습니다.)`
        : `API 키 인증 및 모델(${targetModel}) generateContent 호출이 정상 확인되었습니다.`,
      warning: isCandidateTest
        ? `이 검증으로 ${targetModel} 호출과 호환 설정(${compatibility.noticeThinkingSummary}, JSON 스키마 지원)을 확인했습니다. 전환하려면 Vercel 환경변수 GEMINI_MODEL 값을 ${targetModel}로 변경한 뒤 재배포(Redeploy)해 주세요.`
        : undefined,
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const probeLatencyMs = Math.max(1, Date.now() - startedAt);
    const mapped = mapGeminiError(err, targetModel);

    logAiServerDiagnostic('warn', 'gemini_key_test_probe_failed', {
      requestId: reqId,
      model: targetModel,
      configuredModel,
      isCandidateTest,
      apiVersion,
      requestEndpoint,
      errorCode: mapped.code,
      diagnosticCategory: mapped.diagnosticCategory,
      timeoutSource: mapped.timeoutSource,
      timeoutMs: probeTimeoutMs,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
      targetModelInList: inspection.configuredModelInList,
      targetModelSupportsGenerate: inspection.configuredModelSupportsGenerate,
      modelListCached,
      latencyMs: probeLatencyMs,
    });

    // Key-level auth rejection even during generateContent -> treat as auth error
    if (
      mapped.diagnosticCategory === 'auth_failed' ||
      mapped.diagnosticCategory === 'auth_header_error'
    ) {
      throw toServiceError(mapped, {
        requestId: reqId,
        requestApiVersion: apiVersion,
        requestEndpoint,
      });
    }

    const modelAccessible =
      mapped.diagnosticCategory === 'model_not_supported' ||
      mapped.diagnosticCategory === 'model_generate_unsupported' ||
      mapped.diagnosticCategory === 'model_permission_denied'
        ? false
        : inspection.configuredModelSupportsGenerate;

    const timeoutWarning =
      mapped.diagnosticCategory === 'timeout'
        ? mapped.timeoutSource === 'local'
          ? `호출 시간(${probeLatencyMs}ms)이 앱 로컬 제한 시간(${probeTimeoutMs}ms)에 도달해 중단되었습니다. Google API 오류 응답이 아니며 재시도나 대체 모델 호출 없이 중단되었습니다.`
          : `Google API가 시간 초과를 반환했습니다(앱 로컬 타임아웃 아님 · 호출 시간 ${probeLatencyMs}ms / 제한 ${probeTimeoutMs}ms).`
        : undefined;

    return {
      ok: false,
      model: targetModel,
      configuredModel,
      isCandidateTest,
      apiKeyAuthOk: true,
      modelAccessible,
      generateContentOk: false,
      httpStatus: mapped.upstreamHttpStatus,
      latencyMs: probeLatencyMs,
      timeoutMs: probeTimeoutMs,
      ...(mapped.timeoutSource ? { timeoutSource: mapped.timeoutSource } : {}),
      usage: ZERO_USAGE,
      keyType,
      diagnosticCategory: mapped.diagnosticCategory,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
      requestApiVersion: apiVersion,
      requestEndpoint,
      modelListCached,
      targetModelInList: inspection.configuredModelInList,
      targetModelSupportsGenerate: inspection.configuredModelSupportsGenerate,
      errorCode: mapped.code,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: inspection.recommendedFallbackModel,
      compatibility,
      message: mapped.message,
      warning:
        timeoutWarning ??
        (!isCandidateTest &&
        mapped.diagnosticCategory === 'model_not_supported' &&
        inspection.recommendedFallbackModel
          ? `models.list에 포함되어 있더라도 실제 생성 요청이 404를 반환했습니다. 아래에서 권장 모델(${inspection.recommendedFallbackModel})을 1회 직접 검증한 뒤, 성공 시 Vercel GEMINI_MODEL을 변경해 주세요.`
          : undefined),
    };
  }
}

function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function parseGeminiJsonResponse<T extends object>(params: {
  response: {
    text?: string;
    candidates?: Array<{ finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  model: string;
  operation: 'analyze_notice' | 'briefing' | 'planner';
  requestId?: string;
  emptyMessage: string;
}): T {
  const finishReason = params.response.candidates?.[0]?.finishReason;
  const rawText = params.response.text;
  const usage = extractUsageMetadata(params.response);

  if (!rawText || !rawText.trim()) {
    if (finishReason === 'MAX_TOKENS') {
      logAiServerDiagnostic('warn', 'gemini_response_truncated_empty', {
        requestId: params.requestId,
        operation: params.operation,
        model: params.model,
        finishReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtTokens: usage.thoughtTokens,
      });
      throw new GeminiServiceError(
        502,
        'ai_response_truncated',
        'AI 응답 생성 길이가 초과되어 결과를 완성하지 못했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
        {
          diagnosticCategory: 'server_error',
          requestId: params.requestId,
        },
      );
    }
    logAiServerDiagnostic('warn', 'gemini_empty_response', {
      requestId: params.requestId,
      operation: params.operation,
      model: params.model,
      finishReason: finishReason ?? 'UNKNOWN',
    });
    throw new GeminiServiceError(502, 'ai_empty_response', params.emptyMessage, {
      diagnosticCategory: 'server_error',
      requestId: params.requestId,
    });
  }

  const candidateJson = stripJsonCodeFence(rawText);
  try {
    const parsed = JSON.parse(candidateJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root is not an object');
    }
    return parsed as T;
  } catch {
    const isTruncated = finishReason === 'MAX_TOKENS';
    logAiServerDiagnostic(
      'warn',
      isTruncated ? 'gemini_response_truncated_json' : 'gemini_invalid_json',
      {
        requestId: params.requestId,
        operation: params.operation,
        model: params.model,
        finishReason: finishReason ?? 'UNKNOWN',
        responseChars: rawText.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtTokens: usage.thoughtTokens,
      },
    );
    if (isTruncated) {
      throw new GeminiServiceError(
        502,
        'ai_response_truncated',
        'AI 응답이 길이 제한으로 중간에 잘려 결과를 처리하지 못했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
        {
          diagnosticCategory: 'server_error',
          requestId: params.requestId,
        },
      );
    }
    throw new GeminiServiceError(
      502,
      'ai_invalid_json',
      'AI 모델이 올바른 JSON 형식의 응답을 반환하지 못했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
      {
        diagnosticCategory: 'server_error',
        requestId: params.requestId,
      },
    );
  }
}

async function generateContentWithModelResolution(params: {
  ai: GeminiTestClientLike;
  apiKey: string;
  hasClientOverride: boolean;
  configuredModel: string;
  contents: string;
  baseConfig: Record<string, unknown>;
  timeoutMs: number;
  thinkingMode?: 'minimal_extract' | 'low_reasoning';
  operation?: 'analyze_notice' | 'briefing' | 'planner';
  requestId?: string;
  signal?: AbortSignal;
}): Promise<{
  model: string;
  response: {
    text?: string;
    candidates?: Array<{ finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}> {
  const apiVersion = getEffectiveGeminiApiVersion();
  const requestEndpoint = buildGenerateEndpointPath(params.configuredModel);
  const requestId = params.requestId ?? generateSafeRequestId();
  const keyHash = hashKeyForCache(params.apiKey || 'override');
  const resolvedCacheKey = `${keyHash}:${apiVersion}:${params.configuredModel}`;
  const thinkingMode = params.thinkingMode ?? 'low_reasoning';
  const deadline = Date.now() + params.timeoutMs;

  const buildConfigFor = (
    targetModel: string,
    omitThinkingConfig = false,
    attemptSignal?: AbortSignal,
  ): Record<string, unknown> => {
    const thinkingConfig = omitThinkingConfig
      ? undefined
      : buildThinkingConfigForModel(targetModel, thinkingMode);
    return {
      ...params.baseConfig,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(attemptSignal ? { abortSignal: attemptSignal } : {}),
    };
  };

  // Reuse cached API version / thinkingConfig compatibility ONLY for the configured model (never switch models silently)
  const cachedResolved = resolvedModelCache.get(resolvedCacheKey);
  if (
    cachedResolved &&
    cachedResolved.expiresAt > Date.now() &&
    cachedResolved.resolvedModel === params.configuredModel
  ) {
    const targetClient =
      !params.hasClientOverride &&
      cachedResolved.resolvedApiVersion !== apiVersion
        ? createGeminiClient(params.apiKey, cachedResolved.resolvedApiVersion)
        : params.ai;
    const cachedStartedAt = Date.now();
    try {
      const response = await runWithTimeoutAndAbort(
        (attemptSignal) =>
          targetClient.models.generateContent({
            model: params.configuredModel,
            contents: params.contents,
            config: buildConfigFor(
              params.configuredModel,
              Boolean(cachedResolved.omitThinkingConfig),
              attemptSignal,
            ),
          }),
        params.timeoutMs,
        params.signal,
      );
      return { model: params.configuredModel, response };
    } catch (err) {
      resolvedModelCache.delete(resolvedCacheKey);
      if (err instanceof GeminiServiceError) throw err;
      const mappedCached = mapGeminiError(err, params.configuredModel);
      logAiServerDiagnostic('warn', 'gemini_cached_compat_attempt_failed', {
        requestId,
        operation: params.operation ?? 'unknown',
        model: params.configuredModel,
        apiVersion: cachedResolved.resolvedApiVersion,
        requestEndpoint,
        errorCode: mappedCached.code,
        diagnosticCategory: mappedCached.diagnosticCategory,
        upstreamHttpStatus: mappedCached.upstreamHttpStatus,
        upstreamApiStatus: mappedCached.upstreamApiStatus,
        upstreamErrorMessage: mappedCached.upstreamErrorMessage,
        latencyMs: Date.now() - cachedStartedAt,
      });
      throw toServiceError(mappedCached, {
        requestId,
        requestApiVersion: cachedResolved.resolvedApiVersion,
        requestEndpoint,
      });
    }
  }

  const startedAt = Date.now();
  try {
    const response = await runWithTimeoutAndAbort(
      (attemptSignal) =>
        params.ai.models.generateContent({
          model: params.configuredModel,
          contents: params.contents,
          config: buildConfigFor(params.configuredModel, false, attemptSignal),
        }),
      params.timeoutMs,
      params.signal,
    );
    return { model: params.configuredModel, response };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, params.configuredModel);
    const lowerUpstream = (mapped.upstreamErrorMessage ?? '').toLowerCase();

    logAiServerDiagnostic('warn', 'gemini_generate_attempt_failed', {
      requestId,
      operation: params.operation ?? 'unknown',
      model: params.configuredModel,
      apiVersion,
      requestEndpoint,
      errorCode: mapped.code,
      diagnosticCategory: mapped.diagnosticCategory,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
      latencyMs: Date.now() - startedAt,
    });

    // If v1 rejected thinkingConfig (e.g. "Unknown name 'thinkingConfig'"), switch to v1beta ONCE
    // (or omit thinkingConfig) on the SAME configured model using the remaining timeout budget.
    if (
      mapped.code === 'invalid_request_format' &&
      lowerUpstream.includes('thinking')
    ) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1000) {
        throw toServiceError(mapped, {
          requestId,
          requestApiVersion: apiVersion,
          requestEndpoint,
        });
      }

      if (!params.hasClientOverride && apiVersion !== 'v1beta') {
        const betaStartedAt = Date.now();
        try {
          const betaClient = createGeminiClient(params.apiKey, 'v1beta');
          const betaResponse = await runWithTimeoutAndAbort(
            (attemptSignal) =>
              betaClient.models.generateContent({
                model: params.configuredModel,
                contents: params.contents,
                config: buildConfigFor(
                  params.configuredModel,
                  false,
                  attemptSignal,
                ),
              }),
            remainingMs,
            params.signal,
          );
          setBoundedCacheEntry(resolvedModelCache, resolvedCacheKey, {
            expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
            resolvedModel: params.configuredModel,
            resolvedApiVersion: 'v1beta',
          });
          return { model: params.configuredModel, response: betaResponse };
        } catch (betaErr) {
          if (betaErr instanceof GeminiServiceError) throw betaErr;
          const betaMapped = mapGeminiError(betaErr, params.configuredModel);
          logAiServerDiagnostic('warn', 'gemini_thinking_compat_retry_failed', {
            requestId,
            operation: params.operation ?? 'unknown',
            model: params.configuredModel,
            fromApiVersion: apiVersion,
            toApiVersion: 'v1beta',
            errorCode: betaMapped.code,
            upstreamHttpStatus: betaMapped.upstreamHttpStatus,
            upstreamApiStatus: betaMapped.upstreamApiStatus,
            upstreamErrorMessage: betaMapped.upstreamErrorMessage,
            latencyMs: Date.now() - betaStartedAt,
          });
          throw toServiceError(betaMapped, {
            requestId,
            requestApiVersion: 'v1beta',
            requestEndpoint,
          });
        }
      }

      const plainStartedAt = Date.now();
      try {
        const plainResponse = await runWithTimeoutAndAbort(
          (attemptSignal) =>
            params.ai.models.generateContent({
              model: params.configuredModel,
              contents: params.contents,
              config: buildConfigFor(params.configuredModel, true, attemptSignal),
            }),
          remainingMs,
          params.signal,
        );
        setBoundedCacheEntry(resolvedModelCache, resolvedCacheKey, {
          expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
          resolvedModel: params.configuredModel,
          resolvedApiVersion: apiVersion,
          omitThinkingConfig: true,
        });
        return { model: params.configuredModel, response: plainResponse };
      } catch (plainErr) {
        if (plainErr instanceof GeminiServiceError) throw plainErr;
        const plainMapped = mapGeminiError(plainErr, params.configuredModel);
        logAiServerDiagnostic('warn', 'gemini_thinking_compat_retry_failed', {
          requestId,
          operation: params.operation ?? 'unknown',
          model: params.configuredModel,
          apiVersion,
          omitThinkingConfig: true,
          errorCode: plainMapped.code,
          upstreamHttpStatus: plainMapped.upstreamHttpStatus,
          upstreamApiStatus: plainMapped.upstreamApiStatus,
          upstreamErrorMessage: plainMapped.upstreamErrorMessage,
          latencyMs: Date.now() - plainStartedAt,
        });
        throw toServiceError(plainMapped, {
          requestId,
          requestApiVersion: apiVersion,
          requestEndpoint,
        });
      }
    }

    // Never auto-switch models or blindly retry on 404/model errors.
    if (
      mapped.code !== 'model_not_found' &&
      mapped.code !== 'model_generate_unsupported'
    ) {
      throw toServiceError(mapped, {
        requestId,
        requestApiVersion: apiVersion,
        requestEndpoint,
      });
    }

    // Narrow non-speculative check: ONLY when Google explicitly states the exact configured model
    // is not found for the current API version (e.g. v1), try v1beta ONCE for the SAME model.
    if (
      mapped.code === 'model_not_found' &&
      !params.hasClientOverride &&
      apiVersion !== 'v1beta' &&
      lowerUpstream.includes('not found for api version')
    ) {
      const remainingMs = deadline - Date.now();
      if (remainingMs >= 1000) {
        const betaStartedAt = Date.now();
        try {
          const betaClient = createGeminiClient(params.apiKey, 'v1beta');
          const betaResponse = await runWithTimeoutAndAbort(
            (attemptSignal) =>
              betaClient.models.generateContent({
                model: params.configuredModel,
                contents: params.contents,
                config: buildConfigFor(
                  params.configuredModel,
                  false,
                  attemptSignal,
                ),
              }),
            remainingMs,
            params.signal,
          );
          setBoundedCacheEntry(resolvedModelCache, resolvedCacheKey, {
            expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
            resolvedModel: params.configuredModel,
            resolvedApiVersion: 'v1beta',
          });
          return { model: params.configuredModel, response: betaResponse };
        } catch (betaErr) {
          if (betaErr instanceof GeminiServiceError) throw betaErr;
          const betaMapped = mapGeminiError(betaErr, params.configuredModel);
          logAiServerDiagnostic('warn', 'gemini_api_version_retry_failed', {
            requestId,
            operation: params.operation ?? 'unknown',
            model: params.configuredModel,
            fromApiVersion: apiVersion,
            toApiVersion: 'v1beta',
            priorErrorCode: mapped.code,
            errorCode: betaMapped.code,
            upstreamHttpStatus: betaMapped.upstreamHttpStatus,
            upstreamApiStatus: betaMapped.upstreamApiStatus,
            upstreamErrorMessage: betaMapped.upstreamErrorMessage,
            latencyMs: Date.now() - betaStartedAt,
          });
          // Never mask the prior 404 model error behind a 504 timeout if the version probe itself timed out.
          if (betaMapped.code !== 'ai_timeout' && betaMapped.code !== 'ai_aborted') {
            throw toServiceError(betaMapped, {
              requestId,
              requestApiVersion: 'v1beta',
              requestEndpoint,
            });
          }
        }
      }
    }

    // Use existing 0-token cached models.list diagnostic to report which models this key can access
    // (strictly 0 extra generateContent calls — never switch models behind the scenes).
    let inspection: ListedModelInspection | null = null;
    let modelListCached = false;
    try {
      const listTimeoutMs = Math.min(3500, Math.max(1500, deadline - Date.now()));
      const listed = await getCachedOrFetchModelList({
        ai: params.ai,
        apiKey: params.apiKey,
        apiVersion,
        configuredModel: params.configuredModel,
        timeoutMs: listTimeoutMs,
        signal: params.signal,
      });
      inspection = listed.inspection;
      modelListCached = listed.cached;
    } catch {
      inspection = null;
    }

    logAiServerDiagnostic('warn', 'gemini_model_not_found_diagnostics', {
      requestId,
      operation: params.operation ?? 'unknown',
      model: params.configuredModel,
      apiVersion,
      requestEndpoint,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
      configuredModelInList: inspection?.configuredModelInList ?? null,
      configuredModelSupportsGenerate:
        inspection?.configuredModelSupportsGenerate ?? null,
      modelListCached,
      availableGenerateModels: inspection?.availableGenerateModels ?? [],
      recommendedModel: inspection?.recommendedFallbackModel ?? null,
    });

    const availableList = inspection?.availableGenerateModels ?? [];
    const recommended = inspection?.recommendedFallbackModel ?? null;
    const modelHint =
      availableList.length > 0
        ? ` (계정에서 조회된 모델: ${availableList.slice(0, 4).join(', ')}${
            recommended ? ` · 권장: ${recommended}` : ''
          })`
        : '';

    throw new GeminiServiceError(
      mapped.status,
      mapped.code,
      `${mapped.message}${modelHint}`,
      {
        diagnosticCategory: mapped.diagnosticCategory,
        upstreamHttpStatus: mapped.upstreamHttpStatus,
        upstreamApiStatus: mapped.upstreamApiStatus,
        upstreamErrorMessage: mapped.upstreamErrorMessage,
        requestId,
        requestApiVersion: apiVersion,
        requestEndpoint,
        availableGenerateModels: availableList,
        recommendedModel: recommended,
      },
    );
  }
}

export async function analyzeNoticeWithGemini(
  apiKey: string,
  input: AiAnalyzeNoticeRequest,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
  requestId?: string,
): Promise<AiAnalyzeNoticeResponse> {
  const reqId = requestId ?? generateSafeRequestId();
  const configuredModel = getGeminiModelName();
  const ai = clientOverride ?? createGeminiClient(apiKey);
  const todayKey = input.todayKey || new Date().toISOString().slice(0, 10);

  const existingList = (input.existingItems ?? [])
    .slice(0, AI_LIMITS.MAX_EXISTING_CONTEXT_ITEMS)
    .map((item) => `- [${item.kind}:${item.id}] ${item.title} (${item.dateKey ?? '날짜없음'})`)
    .join('\n');

  const prompt = [
    `당신은 한국 고등학교 교사의 개인 업무·일정 비서입니다.`,
    `기준 날짜(Asia/Seoul): ${todayKey}`,
    ``,
    `[규칙]`,
    `1. 원문에 없는 사실, 날짜, 시각, 장소를 추측하거나 지어내지 마세요.`,
    `2. 제출·회신·작성·취합·확인·입력 등 행위가 중심이면 kind='task', 회의·연수·상담·행사·출장·수업공개 등 일정 참여가 중심이면 kind='event'로 분류하세요.`,
    `3. 같은 행사나 업무의 부연 설명 줄은 하나의 후보로 묶고 중복 생성하지 마세요.`,
    `4. 연도가 생략된 월/일(예: '11월 20일', '1월 10일')은 기준 날짜(${todayKey}) 기준으로 오늘이거나 미래면 올해, 이미 지났으면 다음 해의 YYYY-MM-DD로 해석하세요. 연도 생략 자체는 dateUncertain=true 사유로 삼지 마세요.`,
    `5. '2시', '3교시'처럼 오전/오후 또는 구체 시각이 불명확하거나 날짜가 전혀 없는 경우에만 dateUncertain=true 및 uncertaintyReason을 짧게 적으세요.`,
    `6. 간결성: title은 30자 이내, description은 원문에 꼭 필요한 보충 세부사항이 있을 때만 60자 이내(없으면 ""), dateEvidence는 20자 이내 원문 표현, rationale은 25자 이내 한 구절로 짧게 적고, unparsedSummary는 추출 못 한 핵심 문장만 최대 5개(단순 인사말·구분선 제외)로 줄이세요.`,
    `7. 기존 목록과 의미가 겹치는 항목이 보이면 semanticDuplicateId에 기존 id를, semanticDuplicateReason에 짧은 사유(25자 이내)를 적고 없으면 null로 두세요.`,
    `8. 원문 내 [성명], [연락처], [이메일], [고유식별번호 제외됨] 같은 마스킹 토큰은 그대로 존중하고 복원하지 마세요.`,
    ``,
    existingList ? `[기존 업무/일정 목록]\n${existingList}\n` : '',
    `[분석할 학교 쪽지/안내문]\n${input.text}`,
  ]
    .filter(Boolean)
    .join('\n');

  const noticeOpSettings =
    getGeminiModelProfile(configuredModel).operations.analyze_notice;

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      maxOutputTokens: noticeOpSettings.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: NOTICE_RESPONSE_SCHEMA,
    },
    timeoutMs: noticeOpSettings.timeoutMs,
    thinkingMode: 'minimal_extract',
    operation: 'analyze_notice',
    requestId: reqId,
    signal,
  });

  const parsed = parseGeminiJsonResponse<AiRawNoticeOutput>({
    response,
    model,
    operation: 'analyze_notice',
    requestId: reqId,
    emptyMessage: 'AI 모델이 빈 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
  });

  return {
    model,
    rawOutput: {
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      unparsedSummary: Array.isArray(parsed.unparsedSummary)
        ? parsed.unparsedSummary
        : [],
    },
    usage: extractUsageMetadata(response),
  };
}

export async function generateBriefingWithGemini(
  apiKey: string,
  input: AiBriefingRequest,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
  requestId?: string,
): Promise<AiBriefingResponse> {
  const reqId = requestId ?? generateSafeRequestId();
  const configuredModel = getGeminiModelName();
  const ai = clientOverride ?? createGeminiClient(apiKey);

  const tasksText =
    input.tasks.length > 0
      ? input.tasks
          .map(
            (t) =>
              `- [id:${t.id}] (${t.bucket}/${t.priority}/${t.status}) ${t.title} | 마감:${t.dueDateKey ?? '없음'} | 재확인:${t.remindDateKey ?? '없음'}`,
          )
          .join('\n')
      : '(등록된 미완료 업무 없음)';

  const eventsText =
    input.events.length > 0
      ? input.events
          .map(
            (e) =>
              `- [id:${e.id}] ${e.dateKey} ${e.timeRange} ${e.title}${e.location ? ` @${e.location}` : ''}`,
          )
          .join('\n')
      : '(다가오는 일정 없음)';

  const prompt = [
    `당신은 한국 고등학교 교사의 오늘의 브리핑 도우미입니다.`,
    `기준 날짜(Asia/Seoul): ${input.todayKey} (마감 임박 기준: ${input.imminentDays}일 이내)`,
    ``,
    `[규칙]`,
    `1. 제공된 목록에 있는 항목만 참고하여 짧고 실무적인 한국어로 요약하세요. 없는 업무나 일정을 만들어내지 마세요.`,
    `2. summary: 오늘 하루 핵심 흐름을 1~2문장으로 요약`,
    `3. priorityFocus: 오늘 먼저 챙길 업무 1~4건 제안 (linkedTaskId는 목록에 있는 id만 사용)`,
    `4. imminentAlerts: 기한 초과 또는 임박 마감 주의 항목`,
    `5. conflictAlerts: 같은 날 일정과 업무 마감이 겹치거나 일정 시간이 몰려 주의가 필요한 부분`,
    `6. missedChecks: 날짜 미지정, 재확인 미설정 등 놓치기 쉬운 확인 포인트`,
    ``,
    `[미완료 업무 요약]\n${tasksText}`,
    ``,
    `[오늘 및 다가오는 일정 요약]\n${eventsText}`,
  ].join('\n');

  const briefingOpSettings =
    getGeminiModelProfile(configuredModel).operations.briefing;

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      maxOutputTokens: briefingOpSettings.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: BRIEFING_RESPONSE_SCHEMA,
    },
    timeoutMs: briefingOpSettings.timeoutMs,
    thinkingMode: 'low_reasoning',
    operation: 'briefing',
    requestId: reqId,
    signal,
  });

  const parsed = parseGeminiJsonResponse<AiBriefingResult>({
    response,
    model,
    operation: 'briefing',
    requestId: reqId,
    emptyMessage: 'AI 모델이 빈 브리핑 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
  });

  return {
    model,
    generatedAtIso: new Date().toISOString(),
    briefing: parsed,
    usage: extractUsageMetadata(response),
  };
}

export async function generateDayPlanWithGemini(
  apiKey: string,
  input: AiPlannerRequest,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
  requestId?: string,
): Promise<AiPlannerResponse> {
  const reqId = requestId ?? generateSafeRequestId();
  const configuredModel = getGeminiModelName();
  const ai = clientOverride ?? createGeminiClient(apiKey);

  const compactInput = {
    today: input.todayKey,
    now: input.currentTimeHhMm,
    counts: {
      total: input.totalIncompleteCount,
      overdue: input.overdueCount,
      dueToday: input.dueTodayCount,
    },
    timetableConfigured: input.timetableConfigured,
    availMin: input.remainingWorkableMinutes,
    slots: input.workableSlots,
    events: input.blockedEventsSummary,
    academic: input.academicAlertsSummary,
    tasks: input.tasks,
    ...(input.constraint ? { constraint: input.constraint } : {}),
  };

  const prompt = [
    `당신은 한국 교사의 '오늘의 업무 실행 전략 플래너'입니다.`,
    `규칙:`,
    `1. 제공된 tasks의 id만 사용(최대 5건). 입력에 없는 업무·일정·의존성·근무시간은 절대 만들어내지 마세요.`,
    `2. recommendedStart/End(HH:MM)는 반드시 slots 구간 내부에만 겹치지 않게 배치하세요. slots가 비어 있거나 시간이 부족하면 null로 두세요.`,
    `3. estimatedMinutes는 task.m 값이 있으면 그대로 사용하고, null일 때만 15~90 사이 합리적 정수(5단위)로 추정하세요.`,
    `4. 단순 마감순이 아니라 긴급·공문 마감, 오늘 일정 전 준비(ev:true), 짧은 공강 vs 연속 집중 블록 적합성을 고려해 순서를 정하세요.`,
    `5. tier는 'must'(오늘 반드시 할 업무)와 'optional'(시간이 남으면 할 업무)로 구분하고, 여력이 없으면 deferredTasks(다음 일정으로 미룰 업무)로 보내세요.`,
    `6. reason(우선순위/배치 이유 35자 내외), strategy(입력 사실에 근거한 구체적 실행·분할 방법 45자 내외), coreAdvice(전체 전략 1~2문장 95자 내외)를 간결히 작성하세요.`,
    `입력JSON:${JSON.stringify(compactInput)}`,
  ].join('\n');

  const plannerOpSettings =
    getGeminiModelProfile(configuredModel).operations.planner;

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      maxOutputTokens: plannerOpSettings.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: PLANNER_RESPONSE_SCHEMA,
    },
    timeoutMs: plannerOpSettings.timeoutMs,
    thinkingMode: 'low_reasoning',
    operation: 'planner',
    requestId: reqId,
    signal,
  });

  const parsed = parseGeminiJsonResponse<AiPlannerRawResult>({
    response,
    model,
    operation: 'planner',
    requestId: reqId,
    emptyMessage: 'AI 모델이 빈 업무 계획 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
  });

  return {
    model,
    generatedAtIso: new Date().toISOString(),
    rawPlan: {
      coreAdvice: typeof parsed.coreAdvice === 'string' ? parsed.coreAdvice : '',
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, AI_LIMITS.MAX_PLANNER_RECOMMENDATIONS)
        : [],
      attentionTasks: Array.isArray(parsed.attentionTasks)
        ? parsed.attentionTasks.slice(0, 6)
        : [],
      deferredTasks: Array.isArray(parsed.deferredTasks)
        ? parsed.deferredTasks.slice(0, 6)
        : [],
    },
    usage: extractUsageMetadata(response),
  };
}
