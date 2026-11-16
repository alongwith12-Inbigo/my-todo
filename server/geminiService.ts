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
  type AiTokenUsage,
  type GeminiApiKeyType,
  type GeminiDiagnosticErrorCategory,
} from '../src/lib/aiTypes.ts';
import {
  detectGeminiApiKeyType,
  normalizeGeminiApiKeyInput,
} from '../src/lib/byokKeyFormat.ts';
import {
  getGeminiModelName,
  mapGeminiError,
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
  // GoogleGenAI with { apiKey } injects x-goog-api-key (never Authorization: Bearer),
  // which is required by Google for both AIza... standard keys and AQ.... authorization keys.
  return new GoogleGenAI({
    apiKey: cleanKey,
    ...(apiVersionOverride ? { apiVersion: apiVersionOverride } : {}),
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

async function runWithTimeoutAndAbort<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Request timed out'));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    fn()
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
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: {
      diagnosticCategory?: GeminiDiagnosticErrorCategory;
      upstreamHttpStatus?: number;
      upstreamApiStatus?: string;
      upstreamErrorMessage?: string;
    },
  ) {
    super(message);
    this.name = 'GeminiServiceError';
    this.status = status;
    this.code = code;
    this.diagnosticCategory = extra?.diagnosticCategory;
    this.upstreamHttpStatus = extra?.upstreamHttpStatus;
    this.upstreamApiStatus = extra?.upstreamApiStatus;
    this.upstreamErrorMessage = extra?.upstreamErrorMessage;
  }
}

function toServiceError(mapped: MappedGeminiError): GeminiServiceError {
  return new GeminiServiceError(mapped.status, mapped.code, mapped.message, {
    diagnosticCategory: mapped.diagnosticCategory,
    upstreamHttpStatus: mapped.upstreamHttpStatus,
    upstreamApiStatus: mapped.upstreamApiStatus,
    upstreamErrorMessage: mapped.upstreamErrorMessage,
  });
}

/**
 * thinkingConfig.thinkingLevel is only supported on Gemini 3 and Gemini 4 models.
 * Passing thinkingLevel to Gemini 2.5 models causes HTTP 400 INVALID_ARGUMENT,
 * and passing ThinkingLevel.MINIMAL to gemini-4-* models also causes a 400 error.
 */
export function buildThinkingConfigForModel(
  modelName: string,
  mode: 'probe' | 'low_reasoning',
): { thinkingLevel: ThinkingLevel } | undefined {
  const short = modelName.replace(/^models\//, '').trim().toLowerCase();
  if (short.startsWith('gemini-4-')) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  if (
    short.startsWith('gemini-3.1-flash-lite') ||
    short.startsWith('gemini-3.5-flash-lite')
  ) {
    return {
      thinkingLevel:
        mode === 'probe' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
    };
  }
  if (short.startsWith('gemini-3')) {
    return { thinkingLevel: ThinkingLevel.LOW };
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
  apiKeyAuthOk: boolean;
  modelAccessible: boolean;
  generateContentOk: boolean;
  usage: AiTokenUsage;
  keyType: GeminiApiKeyType;
  diagnosticCategory?: GeminiDiagnosticErrorCategory;
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  requestApiVersion: string;
  requestEndpoint: string;
  modelListCached: boolean;
  availableGenerateModels: string[];
  recommendedModel: string | null;
  errorCode?: string;
  message?: string;
  warning?: string;
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
): Promise<{ keyType: GeminiApiKeyType; availableGenerateModels: string[] }> {
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
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
    throw toServiceError(mapGeminiError(err, configuredModel));
  }
}

export async function testGeminiPersonalKey(
  apiKey: string,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
): Promise<GeminiPersonalKeyTestResult> {
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
    );
  }
  const keyType = detectGeminiApiKeyType(cleanKey);
  const configuredModel = getGeminiModelName();
  const apiVersion = getEffectiveGeminiApiVersion();
  const requestEndpoint = buildGenerateEndpointPath(configuredModel);
  const ai = clientOverride ?? createGeminiClient(cleanKey);

  // 1. Check API key authentication & list generateContent-capable models (cached per key hash for 10m)
  let inspection: ListedModelInspection;
  let modelListCached = false;
  try {
    const listed = await getCachedOrFetchModelList({
      ai,
      apiKey: cleanKey,
      apiVersion,
      configuredModel,
      timeoutMs: 6000,
      signal,
    });
    inspection = listed.inspection;
    modelListCached = listed.cached;
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, configuredModel);
    throw toServiceError(mapped);
  }

  // Note: If configured model is explicitly listed WITHOUT generateContent support,
  // report modelAccessible=false and generateContentOk=false without making extra generateContent calls.
  if (
    inspection.configuredModelInList &&
    !inspection.configuredModelSupportsGenerate
  ) {
    return {
      ok: false,
      model: configuredModel,
      configuredModel,
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
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: inspection.recommendedFallbackModel,
      message: `API 키 인증은 정상이나 설정된 모델(${configuredModel})이 generateContent 생성 기능을 지원하지 않습니다.`,
      warning: inspection.recommendedFallbackModel
        ? `계정 목록에서 확인된 활성 모델(${inspection.recommendedFallbackModel})로 Vercel GEMINI_MODEL 변경을 검토해 주세요.`
        : undefined,
    };
  }

  // 2. Run strictly ONE minimal generateContent probe against the configured model (no speculative 2nd AI call)
  try {
    const thinkingConfig = buildThinkingConfigForModel(configuredModel, 'probe');
    const config: Record<string, unknown> = {
      maxOutputTokens: 16,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    };
    const response = await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model: configuredModel,
          contents: 'Reply with OK.',
          config,
        }),
      8000,
      signal,
    );
    return {
      ok: true,
      model: configuredModel,
      configuredModel,
      apiKeyAuthOk: true,
      modelAccessible: true,
      generateContentOk: true,
      usage: extractUsageMetadata(response),
      keyType,
      requestApiVersion: apiVersion,
      requestEndpoint,
      modelListCached,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: null,
      message: `API 키 인증 및 모델(${configuredModel}) generateContent 호출이 정상 확인되었습니다.`,
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, configuredModel);

    // Key-level auth rejection even during generateContent -> treat as auth error
    if (
      mapped.diagnosticCategory === 'auth_failed' ||
      mapped.diagnosticCategory === 'auth_header_error'
    ) {
      throw toServiceError(mapped);
    }

    const modelAccessible =
      mapped.diagnosticCategory === 'model_not_supported' ||
      mapped.diagnosticCategory === 'model_generate_unsupported' ||
      mapped.diagnosticCategory === 'model_permission_denied'
        ? false
        : inspection.configuredModelSupportsGenerate;

    return {
      ok: false,
      model: configuredModel,
      configuredModel,
      apiKeyAuthOk: true,
      modelAccessible,
      generateContentOk: false,
      usage: ZERO_USAGE,
      keyType,
      diagnosticCategory: mapped.diagnosticCategory,
      upstreamHttpStatus: mapped.upstreamHttpStatus,
      upstreamApiStatus: mapped.upstreamApiStatus,
      upstreamErrorMessage: mapped.upstreamErrorMessage,
      requestApiVersion: apiVersion,
      requestEndpoint,
      modelListCached,
      errorCode: mapped.code,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: inspection.recommendedFallbackModel,
      message: mapped.message,
      warning:
        mapped.diagnosticCategory === 'model_not_supported' &&
        inspection.recommendedFallbackModel
          ? `models.list에 포함되어 있더라도 실제 생성 요청이 404를 반환했습니다. 계정에서 조회된 다른 모델(${inspection.recommendedFallbackModel})로 GEMINI_MODEL을 변경하면 불필요한 재시도 없이 바로 호출할 수 있습니다.`
          : undefined,
    };
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
  signal?: AbortSignal;
}): Promise<{
  model: string;
  response: {
    text?: string;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}> {
  const apiVersion = getEffectiveGeminiApiVersion();
  const keyHash = hashKeyForCache(params.apiKey || 'override');
  const resolvedCacheKey = `${keyHash}:${apiVersion}:${params.configuredModel}`;

  const buildConfigFor = (targetModel: string): Record<string, unknown> => {
    const thinkingConfig = buildThinkingConfigForModel(
      targetModel,
      'low_reasoning',
    );
    return {
      ...params.baseConfig,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    };
  };

  // Reuse cached working fallback model when configuredModel previously returned 404 within TTL
  const cachedResolved = resolvedModelCache.get(resolvedCacheKey);
  if (cachedResolved && cachedResolved.expiresAt > Date.now()) {
    const targetClient =
      !params.hasClientOverride &&
      cachedResolved.resolvedApiVersion !== apiVersion
        ? createGeminiClient(params.apiKey, cachedResolved.resolvedApiVersion)
        : params.ai;
    try {
      const response = await runWithTimeoutAndAbort(
        () =>
          targetClient.models.generateContent({
            model: cachedResolved.resolvedModel,
            contents: params.contents,
            config: buildConfigFor(cachedResolved.resolvedModel),
          }),
        params.timeoutMs,
        params.signal,
      );
      return { model: cachedResolved.resolvedModel, response };
    } catch (err) {
      resolvedModelCache.delete(resolvedCacheKey);
      if (err instanceof GeminiServiceError) throw err;
      throw toServiceError(mapGeminiError(err, cachedResolved.resolvedModel));
    }
  }

  try {
    const response = await runWithTimeoutAndAbort(
      () =>
        params.ai.models.generateContent({
          model: params.configuredModel,
          contents: params.contents,
          config: buildConfigFor(params.configuredModel),
        }),
      params.timeoutMs,
      params.signal,
    );
    return { model: params.configuredModel, response };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, params.configuredModel);

    // Only attempt at most ONE retry when the model itself is missing or unsupported.
    // Never mask permission, quota, invalid request format, auth, or timeout errors.
    if (
      mapped.code !== 'model_not_found' &&
      mapped.code !== 'model_generate_unsupported'
    ) {
      throw toServiceError(mapped);
    }

    // Special case: Google explicitly reported API version mismatch on this exact model name -> max 1 retry on v1beta
    const lowerUpstream = (mapped.upstreamErrorMessage ?? '').toLowerCase();
    if (
      !params.hasClientOverride &&
      apiVersion !== 'v1beta' &&
      lowerUpstream.includes('not found for api version')
    ) {
      try {
        const betaClient = createGeminiClient(params.apiKey, 'v1beta');
        const betaResponse = await runWithTimeoutAndAbort(
          () =>
            betaClient.models.generateContent({
              model: params.configuredModel,
              contents: params.contents,
              config: buildConfigFor(params.configuredModel),
            }),
          params.timeoutMs,
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
        throw toServiceError(mapGeminiError(betaErr, params.configuredModel));
      }
    }

    let inspection: ListedModelInspection;
    try {
      const listed = await getCachedOrFetchModelList({
        ai: params.ai,
        apiKey: params.apiKey,
        apiVersion,
        configuredModel: params.configuredModel,
        timeoutMs: Math.min(5000, params.timeoutMs),
        signal: params.signal,
      });
      inspection = listed.inspection;
    } catch {
      throw toServiceError(mapped);
    }

    const fallbackModel = inspection.recommendedFallbackModel;
    if (!fallbackModel) {
      throw toServiceError(mapped);
    }

    try {
      const fallbackResponse = await runWithTimeoutAndAbort(
        () =>
          params.ai.models.generateContent({
            model: fallbackModel,
            contents: params.contents,
            config: buildConfigFor(fallbackModel),
          }),
        params.timeoutMs,
        params.signal,
      );
      setBoundedCacheEntry(resolvedModelCache, resolvedCacheKey, {
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
        resolvedModel: fallbackModel,
        resolvedApiVersion: apiVersion,
      });
      return { model: fallbackModel, response: fallbackResponse };
    } catch (fallbackErr) {
      if (fallbackErr instanceof GeminiServiceError) throw fallbackErr;
      throw toServiceError(mapGeminiError(fallbackErr, fallbackModel));
    }
  }
}

export async function analyzeNoticeWithGemini(
  apiKey: string,
  input: AiAnalyzeNoticeRequest,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
): Promise<AiAnalyzeNoticeResponse> {
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
    `3. 연도가 생략된 월/일(예: '11월 20일', '1월 10일')은 기준 날짜(${todayKey}) 기준으로 오늘이거나 미래면 올해, 이미 지났으면 다음 해의 YYYY-MM-DD로 해석하세요. 연도 생략 자체는 dateUncertain=true 사유로 삼지 마세요.`,
    `4. '2시', '3교시'처럼 오전/오후 또는 구체 시각이 불명확하거나 날짜가 전혀 없는 경우에만 dateUncertain=true 및 uncertaintyReason을 짧게 작성하세요.`,
    `5. dateEvidence에는 날짜/시각을 해석한 원문 표현을 그대로 적고, rationale에는 업무/일정으로 판단한 짧은 근거(1문장)를 적으세요.`,
    `6. 기존 목록과 의미가 겹치는 항목이 보이면(예: '디지털 수업사례 제출' vs '수업사례 보고서 제출') semanticDuplicateId에 해당 기존 id를, semanticDuplicateReason에 짧은 사유를 적으세요. 없으면 null로 두세요.`,
    `7. 원문 내 [성명], [연락처], [이메일], [고유식별번호 제외됨] 같은 마스킹 토큰은 그대로 존중하고 복원하려 하지 마세요.`,
    ``,
    existingList ? `[현재 등록된 기존 업무/일정 참고 목록]\n${existingList}\n` : '',
    `[분석할 학교 쪽지/안내문]\n${input.text}`,
  ]
    .filter(Boolean)
    .join('\n');

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      responseMimeType: 'application/json',
      responseSchema: NOTICE_RESPONSE_SCHEMA,
    },
    timeoutMs: AI_LIMITS.REQUEST_TIMEOUT_MS,
    signal,
  });

  const text = response.text;
  if (!text) {
    throw new GeminiServiceError(
      502,
      'ai_empty_response',
      'AI 모델이 빈 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }

  const parsed = JSON.parse(text) as AiRawNoticeOutput;
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
): Promise<AiBriefingResponse> {
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

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      responseMimeType: 'application/json',
      responseSchema: BRIEFING_RESPONSE_SCHEMA,
    },
    timeoutMs: AI_LIMITS.REQUEST_TIMEOUT_MS,
    signal,
  });

  const text = response.text;
  if (!text) {
    throw new GeminiServiceError(
      502,
      'ai_empty_response',
      'AI 모델이 빈 브리핑 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }

  const parsed = JSON.parse(text) as AiBriefingResult;
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
): Promise<AiPlannerResponse> {
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

  const { model, response } = await generateContentWithModelResolution({
    ai,
    apiKey: normalizeGeminiApiKeyInput(apiKey),
    hasClientOverride: Boolean(clientOverride),
    configuredModel,
    contents: prompt,
    baseConfig: {
      maxOutputTokens: 1400,
      responseMimeType: 'application/json',
      responseSchema: PLANNER_RESPONSE_SCHEMA,
    },
    timeoutMs: AI_LIMITS.REQUEST_TIMEOUT_MS,
    signal,
  });

  const text = response.text;
  if (!text) {
    throw new GeminiServiceError(
      502,
      'ai_empty_response',
      'AI 모델이 빈 업무 계획 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }

  const parsed = JSON.parse(text) as AiPlannerRawResult;
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
