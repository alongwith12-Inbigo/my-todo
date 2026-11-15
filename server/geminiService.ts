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

export function createGeminiClient(apiKey: string): GoogleGenAI {
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

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: {
      diagnosticCategory?: GeminiDiagnosticErrorCategory;
      upstreamHttpStatus?: number;
      upstreamApiStatus?: string;
    },
  ) {
    super(message);
    this.name = 'GeminiServiceError';
    this.status = status;
    this.code = code;
    this.diagnosticCategory = extra?.diagnosticCategory;
    this.upstreamHttpStatus = extra?.upstreamHttpStatus;
    this.upstreamApiStatus = extra?.upstreamApiStatus;
  }
}

function toServiceError(mapped: MappedGeminiError): GeminiServiceError {
  return new GeminiServiceError(mapped.status, mapped.code, mapped.message, {
    diagnosticCategory: mapped.diagnosticCategory,
    upstreamHttpStatus: mapped.upstreamHttpStatus,
    upstreamApiStatus: mapped.upstreamApiStatus,
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
  if (short.startsWith('gemini-3.1-flash-lite')) {
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
  'aqa',
  'gemini-1.5',
  'gemini-2.0',
];

const PREFERRED_TEXT_MODEL_ORDER = [
  'gemini-4-hydrogen',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
];

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
    const ia = PREFERRED_TEXT_MODEL_ORDER.indexOf(a);
    const ib = PREFERRED_TEXT_MODEL_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });

  const recommendedFallbackModel =
    generateCapable.find((name) => name !== configuredShort) ?? null;

  return {
    configuredModelInList,
    configuredModelSupportsGenerate,
    availableGenerateModels: generateCapable.slice(0, 8),
    recommendedFallbackModel,
  };
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
  const ai = clientOverride ?? createGeminiClient(cleanKey);

  try {
    const pager = await runWithTimeoutAndAbort(
      () => ai.models.list({ config: { pageSize: 50 } }),
      7000,
      signal,
    );
    const inspection = inspectListedGeminiModels(pager?.page, configuredModel);
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
  const ai = clientOverride ?? createGeminiClient(cleanKey);
  const deadlineMs = Date.now() + 9000;
  const remainingMs = () => Math.max(1500, deadlineMs - Date.now());

  // 1. Check API key authentication & list generateContent-capable models
  let inspection: ListedModelInspection;
  try {
    const pager = await runWithTimeoutAndAbort(
      () => ai.models.list({ config: { pageSize: 50 } }),
      remainingMs(),
      signal,
    );
    inspection = inspectListedGeminiModels(pager?.page, configuredModel);
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err, configuredModel);
    throw toServiceError(mapped);
  }

  // Note: If configured model is explicitly listed WITHOUT generateContent support,
  // report modelAccessible=false and generateContentOk=false clearly (do not falsely pass on models.list).
  if (
    inspection.configuredModelInList &&
    !inspection.configuredModelSupportsGenerate
  ) {
    const verifiedAlt = await probeFallbackModelIfPresent(
      ai,
      inspection.recommendedFallbackModel,
      remainingMs(),
      signal,
    );
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
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: verifiedAlt,
      message: `API 키 인증은 정상이나 설정된 모델(${configuredModel})이 generateContent 생성 기능을 지원하지 않습니다.`,
      warning: verifiedAlt
        ? `대체 사용 가능한 모델(${verifiedAlt})은 generateContent 호출이 가능했습니다. Vercel GEMINI_MODEL 변경을 권장합니다.`
        : undefined,
    };
  }

  // 2. Run actual minimal generateContent probe against the configured model
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
      remainingMs(),
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

    let verifiedFallback: string | null = null;
    if (
      (mapped.diagnosticCategory === 'model_not_supported' ||
        mapped.diagnosticCategory === 'model_generate_unsupported') &&
      inspection.recommendedFallbackModel
    ) {
      verifiedFallback = await probeFallbackModelIfPresent(
        ai,
        inspection.recommendedFallbackModel,
        remainingMs(),
        signal,
      );
    }

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
      errorCode: mapped.code,
      availableGenerateModels: inspection.availableGenerateModels,
      recommendedModel: verifiedFallback ?? inspection.recommendedFallbackModel,
      message: mapped.message,
      warning: verifiedFallback
        ? `API 키 인증은 정상입니다. 현재 설정 모델(${configuredModel})은 실패했으나, 계정 내 다른 모델(${verifiedFallback})은 실제 generateContent 호출이 가능했습니다. Vercel GEMINI_MODEL=${verifiedFallback} 설정 또는 재실행을 권장합니다.`
        : undefined,
    };
  }
}

async function probeFallbackModelIfPresent(
  ai: GeminiTestClientLike,
  fallbackModel: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!fallbackModel || timeoutMs < 1500) return null;
  try {
    const thinkingConfig = buildThinkingConfigForModel(fallbackModel, 'probe');
    await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model: fallbackModel,
          contents: 'Reply with OK.',
          config: {
            maxOutputTokens: 16,
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
      timeoutMs,
      signal,
    );
    return fallbackModel;
  } catch {
    return null;
  }
}

async function generateContentWithModelResolution(params: {
  ai: GeminiTestClientLike;
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

    // Only attempt account model-list fallback when the specific model ID is missing or unsupported.
    // Never mask permission, quota, invalid request format, auth, or timeout errors.
    if (
      mapped.code !== 'model_not_found' &&
      mapped.code !== 'model_generate_unsupported'
    ) {
      throw toServiceError(mapped);
    }

    let inspection: ListedModelInspection;
    try {
      const pager = await runWithTimeoutAndAbort(
        () => params.ai.models.list({ config: { pageSize: 50 } }),
        Math.min(5000, params.timeoutMs),
        params.signal,
      );
      inspection = inspectListedGeminiModels(
        pager?.page,
        params.configuredModel,
      );
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
    `당신은 한국 교사의 '오늘의 업무 실행 플래너'입니다.`,
    `규칙:`,
    `1. 제공된 tasks의 id만 사용하세요(최대 5건 추천). 없는 id/업무 금지.`,
    `2. recommendedStart/End(HH:MM)는 반드시 slots 구간 내부에만 겹치지 않게 배치하세요. slots가 비어 있으면 null로 두세요.`,
    `3. estimatedMinutes는 task.m 값이 있으면 그대로 사용하고, null일 때만 15~90 사이 합리적 정수(5단위)로 추정하세요.`,
    `4. 마감(ov/dd), 중요도(p: u>h>n>l), 남은 시간, 집중 블록/짧은 공강 적합성을 판단해 우선순위를 정하고 큰 업무는 분할 제안하세요.`,
    `5. reason은 1문장(35자 내외), coreAdvice는 1~2문장(90자 내외)으로 간결히 작성하세요.`,
    `입력JSON:${JSON.stringify(compactInput)}`,
  ].join('\n');

  const { model, response } = await generateContentWithModelResolution({
    ai,
    configuredModel,
    contents: prompt,
    baseConfig: {
      maxOutputTokens: 1200,
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
