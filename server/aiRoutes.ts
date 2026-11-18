import { Router, type Request, type Response } from 'express';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
  type AiErrorCategory,
  type AiPlannerRequest,
  type AiPlannerResponse,
  type AiStatusResponse,
  type AiTokenUsage,
  type GeminiApiKeyType,
  type GeminiDiagnosticErrorCategory,
} from '../src/lib/aiTypes.ts';
import { detectGeminiApiKeyType } from '../src/lib/byokKeyFormat.ts';
import {
  generateSafeRequestId,
  getAiStatusBasePayload,
  getGeminiModelName,
  logAiServerDiagnostic,
  resolveSafeRequestId,
  validateCandidateModelName,
} from './aiConfig.ts';
import {
  acquireUidInFlightLock,
  applyUsageIncrement,
  buildByokClearCookieHeader,
  buildByokSetCookieHeader,
  ByokVaultError,
  checkDailyQuotaForKind,
  deletePersonalApiKeyForUid,
  getPersistenceMode,
  isVercelServerlessRuntime,
  loadUserAiState,
  normalizeGeminiApiKeyInput,
  releaseUidInFlightLock,
  resolvePersonalApiKeyForUid,
  savePersonalApiKeyForUid,
  saveUserAiState,
  toUsageSnapshot,
  validateGeminiApiKeyFormat,
} from './byokVault.ts';
import {
  extractBearerToken,
  ServerAuthError,
  verifyFirebaseUserAndAccess,
  type VerifiedFirebaseUser,
} from './firebaseServerAuth.ts';
import {
  GeminiServiceError,
  analyzeNoticeWithGemini,
  generateBriefingWithGemini,
  generateDayPlanWithGemini,
  getEffectiveGeminiApiVersion,
  testGeminiPersonalKey,
  verifyGeminiKeyAuthOnly,
  type GeminiPersonalKeyTestResult,
} from './geminiService.ts';
import { SlidingWindowRateLimiter } from './rateLimiter.ts';

export interface AiRouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string | string[]>;
}

export interface AiRouteDeps {
  verifyAuth?: (
    authorizationHeader: string | string[] | undefined,
  ) => Promise<VerifiedFirebaseUser>;
  rateLimiter?: SlidingWindowRateLimiter;
  /**
   * Optional test hook overriding personal key check (used by unit tests).
   * Production never sets this and ALWAYS requires caller's own BYOK key.
   */
  isConfigured?: () => boolean;
  resolveApiKey?: (params: {
    uid: string;
    cookieHeader?: string | string[];
    idToken?: string;
  }) => Promise<{ apiKey: string; keyType?: GeminiApiKeyType } | null>;
  analyzeNotice?: (
    input: AiAnalyzeNoticeRequest,
    signal?: AbortSignal,
    apiKey?: string,
    requestId?: string,
  ) => Promise<AiAnalyzeNoticeResponse>;
  generateBriefing?: (
    input: AiBriefingRequest,
    signal?: AbortSignal,
    apiKey?: string,
    requestId?: string,
  ) => Promise<AiBriefingResponse>;
  generateDayPlan?: (
    input: AiPlannerRequest,
    signal?: AbortSignal,
    apiKey?: string,
    requestId?: string,
  ) => Promise<AiPlannerResponse>;
  verifyKeyAuthOnly?: (
    apiKey: string,
    signal?: AbortSignal,
    requestId?: string,
  ) => Promise<{ keyType: GeminiApiKeyType; availableGenerateModels: string[] }>;
  testApiKey?: (
    apiKey: string,
    signal?: AbortSignal,
    requestId?: string,
    options?: { candidateModel?: string },
  ) => Promise<
    Partial<GeminiPersonalKeyTestResult> & {
      model: string;
      usage: AiTokenUsage;
    }
  >;
}

const defaultRateLimiter = new SlidingWindowRateLimiter(
  AI_LIMITS.RATE_LIMIT_MAX_REQUESTS,
  AI_LIMITS.RATE_LIMIT_WINDOW_MS,
);

function resolveDeps(deps: AiRouteDeps = {}) {
  return {
    verifyAuth: deps.verifyAuth ?? verifyFirebaseUserAndAccess,
    rateLimiter: deps.rateLimiter ?? defaultRateLimiter,
    isConfiguredOverride: deps.isConfigured,
    resolveApiKey: deps.resolveApiKey ?? resolvePersonalApiKeyForUid,
    analyzeNotice:
      deps.analyzeNotice ??
      ((
        input: AiAnalyzeNoticeRequest,
        signal?: AbortSignal,
        apiKey?: string,
        requestId?: string,
      ) => analyzeNoticeWithGemini(apiKey ?? '', input, signal, undefined, requestId)),
    generateBriefing:
      deps.generateBriefing ??
      ((
        input: AiBriefingRequest,
        signal?: AbortSignal,
        apiKey?: string,
        requestId?: string,
      ) =>
        generateBriefingWithGemini(apiKey ?? '', input, signal, undefined, requestId)),
    generateDayPlan:
      deps.generateDayPlan ??
      ((
        input: AiPlannerRequest,
        signal?: AbortSignal,
        apiKey?: string,
        requestId?: string,
      ) =>
        generateDayPlanWithGemini(apiKey ?? '', input, signal, undefined, requestId)),
    verifyKeyAuthOnly:
      deps.verifyKeyAuthOnly ??
      ((apiKey: string, signal?: AbortSignal, requestId?: string) =>
        verifyGeminiKeyAuthOnly(apiKey, signal, undefined, requestId)),
    testApiKey:
      deps.testApiKey ??
      ((
        apiKey: string,
        signal?: AbortSignal,
        requestId?: string,
        options?: { candidateModel?: string },
      ) => testGeminiPersonalKey(apiKey, signal, undefined, requestId, options)),
  };
}

function parseRequestObjectBody(
  body: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; result: AiRouteResult } {
  if (body === undefined || body === null || body === '') {
    return { ok: true, data: {} };
  }
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, data: parsed as Record<string, unknown> };
      }
    } catch {
      return {
        ok: false,
        result: {
          status: 400,
          body: {
            error: 'invalid_request_body',
            category: 'request_format' satisfies AiErrorCategory,
            message: '요청 본문(JSON) 형식이 올바르지 않습니다.',
          },
        },
      };
    }
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return { ok: true, data: body as Record<string, unknown> };
  }
  return {
    ok: false,
    result: {
      status: 400,
      body: {
        error: 'invalid_request_body',
        category: 'request_format' satisfies AiErrorCategory,
        message: '요청 본문은 JSON 객체여야 합니다.',
      },
    },
  };
}

function handleRouteError(
  err: unknown,
  route?: string,
  requestId?: string,
): AiRouteResult {
  const reqId = requestId ?? generateSafeRequestId();
  if (err instanceof ServerAuthError) {
    if (err.statusCode >= 500) {
      logAiServerDiagnostic('warn', 'ai_route_auth_error', {
        requestId: reqId,
        route,
        status: err.statusCode,
        errorCode: err.code,
      });
    }
    return {
      status: err.statusCode,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
      body: {
        error: err.code,
        category: 'auth' satisfies AiErrorCategory,
        requestId: reqId,
        message: err.message,
      },
    };
  }
  if (err instanceof ByokVaultError) {
    logAiServerDiagnostic('warn', 'ai_route_vault_error', {
      requestId: reqId,
      route,
      status: err.statusCode,
      errorCode: err.code,
    });
    return {
      status: err.statusCode,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
      body: {
        error: err.code,
        category: 'encryption_config' satisfies AiErrorCategory,
        requestId: reqId,
        message: err.message,
      },
    };
  }
  if (err instanceof GeminiServiceError) {
    const resolvedReqId = err.requestId ?? reqId;
    logAiServerDiagnostic('warn', 'ai_route_gemini_error', {
      requestId: resolvedReqId,
      route,
      status: err.status,
      errorCode: err.code,
      diagnosticCategory: err.diagnosticCategory,
      upstreamHttpStatus: err.upstreamHttpStatus,
      upstreamApiStatus: err.upstreamApiStatus,
      upstreamErrorMessage: err.upstreamErrorMessage,
      requestApiVersion: err.requestApiVersion,
      requestEndpoint: err.requestEndpoint,
    });
    return {
      status: err.status,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': resolvedReqId },
      body: {
        error: err.code,
        category: 'gemini_api' satisfies AiErrorCategory,
        requestId: resolvedReqId,
        ...(err.diagnosticCategory
          ? { diagnosticCategory: err.diagnosticCategory }
          : {}),
        ...(typeof err.upstreamHttpStatus === 'number'
          ? { upstreamHttpStatus: err.upstreamHttpStatus }
          : {}),
        ...(err.upstreamApiStatus ? { upstreamApiStatus: err.upstreamApiStatus } : {}),
        ...(err.requestApiVersion ? { requestApiVersion: err.requestApiVersion } : {}),
        ...(err.requestEndpoint ? { requestEndpoint: err.requestEndpoint } : {}),
        ...(err.availableGenerateModels?.length
          ? { availableGenerateModels: err.availableGenerateModels }
          : {}),
        ...(err.recommendedModel !== undefined
          ? { recommendedModel: err.recommendedModel }
          : {}),
        message: err.message,
      },
    };
  }
  logAiServerDiagnostic('error', 'ai_route_internal_error', {
    requestId: reqId,
    route,
    errorName: err instanceof Error ? err.name : typeof err,
    errorDetail: err instanceof Error ? err.message : String(err),
  });
  return {
    status: 500,
    headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
    body: {
      error: 'internal_error',
      category: 'server_internal' satisfies AiErrorCategory,
      requestId: reqId,
      message:
        'AI 서버 내부 처리 중 예기치 않은 오류가 발생했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
    },
  };
}

async function resolveCallerKeyOrError(params: {
  uid: string;
  cookieHeader?: string | string[];
  idToken?: string;
  resolvedDeps: ReturnType<typeof resolveDeps>;
}): Promise<{ apiKey: string; keyType?: GeminiApiKeyType } | AiRouteResult> {
  if (params.resolvedDeps.isConfiguredOverride) {
    if (!params.resolvedDeps.isConfiguredOverride()) {
      return {
        status: 503,
        body: {
          error: 'ai_not_configured',
          category: 'encryption_config' satisfies AiErrorCategory,
          message:
            '개인 Gemini API 키가 등록되어 있지 않습니다. 설정에서 개인 API 키를 등록하거나 기본 기능을 이용해 주세요.',
        },
      };
    }
    return { apiKey: 'test-injected-key', keyType: 'generic' };
  }

  const found = await params.resolvedDeps.resolveApiKey({
    uid: params.uid,
    cookieHeader: params.cookieHeader,
    idToken: params.idToken,
  });
  if (!found) {
    if (isVercelServerlessRuntime() && getPersistenceMode() !== 'encrypted_vault') {
      return {
        status: 503,
        body: {
          error: 'encryption_secret_missing',
          category: 'encryption_config' satisfies AiErrorCategory,
          message:
            'Vercel 서버 환경변수 BYOK_ENCRYPTION_SECRET가 설정되지 않아 등록된 개인 API 키를 불러올 수 없습니다. Vercel 설정에서 환경변수를 추가해 주세요.',
        },
      };
    }
    return {
      status: 403,
      body: {
        error: 'personal_key_required',
        category: 'encryption_config' satisfies AiErrorCategory,
        message:
          '개인 Gemini API 키가 등록되어 있지 않습니다. [설정 > AI 스마트 업무비서]에서 본인의 Gemini API 키를 등록해 주세요.',
      },
    };
  }
  return found;
}

export async function handleAiStatusRequest(
  authorizationHeader: string | string[] | undefined,
  deps: AiRouteDeps = {},
  cookieHeader?: string | string[],
  requestId?: string,
): Promise<AiRouteResult> {
  const reqId = requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(authorizationHeader);
    const idToken = extractBearerToken(authorizationHeader) ?? undefined;

    const personalKey = resolved.isConfiguredOverride
      ? resolved.isConfiguredOverride()
        ? { apiKey: 'test', keyType: 'generic' as GeminiApiKeyType }
        : null
      : await resolved.resolveApiKey({
          uid: user.uid,
          cookieHeader,
          idToken,
        });

    const userState = await loadUserAiState(user.uid, idToken);
    const base = getAiStatusBasePayload();

    const persistenceMode = getPersistenceMode();
    const body: AiStatusResponse = {
      configured: Boolean(personalKey),
      hasPersonalKey: Boolean(personalKey),
      keyType: personalKey ? (personalKey.keyType ?? detectGeminiApiKeyType(personalKey.apiKey)) : null,
      persistenceMode,
      encryptionConfigured: persistenceMode === 'encrypted_vault',
      serverlessRuntime: isVercelServerlessRuntime(),
      model: base.model,
      aiEnabled: userState.aiEnabled,
      dailyPlanLimit: userState.dailyPlanLimit,
      dailyTotalLimit: userState.dailyTotalLimit,
      usage: toUsageSnapshot(userState),
      rateLimitMaxRequests: base.rateLimitMaxRequests,
      rateLimitWindowSeconds: base.rateLimitWindowSeconds,
      maxNoticeChars: base.maxNoticeChars,
    };

    return {
      status: 200,
      body,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
    };
  } catch (err) {
    return handleRouteError(err, 'status', reqId);
  }
}

export async function handleSaveByokKeyRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    body: unknown;
    isSecure?: boolean;
    signal?: AbortSignal;
    requestId?: string;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const reqId = params.requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;
    const parsedBody = parseRequestObjectBody(params.body);
    if (parsedBody.ok === false) {
      return parsedBody.result;
    }
    const rawBody = parsedBody.data;

    const validation = validateGeminiApiKeyFormat(rawBody.apiKey);
    if (!validation.valid || !validation.apiKey) {
      return {
        status: 400,
        headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
        body: {
          error: 'invalid_key_format',
          errorCode: 'invalid_key_format',
          detailCode: validation.reasonCode,
          category: 'input_format' satisfies AiErrorCategory,
          requestId: reqId,
          message: validation.message || 'API 키 형식이 올바르지 않습니다.',
        },
      };
    }

    let testUsage: AiTokenUsage | undefined;
    let testWarning: string | undefined;
    if (rawBody.testBeforeSave === true) {
      const testRes = await resolved.testApiKey(validation.apiKey, params.signal, reqId);
      testUsage = testRes.usage;
      testWarning = testRes.warning;
    } else if (rawBody.verifyAuthBeforeSave === true) {
      await resolved.verifyKeyAuthOnly(validation.apiKey, params.signal, reqId);
    }

    const saved = await savePersonalApiKeyForUid({
      uid: user.uid,
      apiKey: validation.apiKey,
      idToken,
    });

    // Ensure aiEnabled is initialized if user just registered their key
    const currentState = await loadUserAiState(user.uid, idToken);
    if (!currentState.aiEnabled) {
      await saveUserAiState(
        user.uid,
        { ...currentState, aiEnabled: true },
        idToken,
      );
    }

    const setCookie = buildByokSetCookieHeader(
      validation.apiKey,
      user.uid,
      Boolean(params.isSecure),
    );

    const keyType =
      validation.keyType ?? detectGeminiApiKeyType(validation.apiKey);

    return {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': setCookie,
        'X-Request-Id': reqId,
      },
      body: {
        ok: true,
        hasPersonalKey: true,
        keyType,
        persistenceMode: saved.persistenceMode,
        message:
          saved.persistenceMode === 'encrypted_vault'
            ? '개인 Gemini API 키를 암호화하여 안전하게 등록했습니다.'
            : '개인 Gemini API 키를 현재 서버 세션(암호화 쿠키·메모리)에 등록했습니다.',
        ...(testWarning ? { warning: testWarning } : {}),
        ...(testUsage ? { usage: testUsage } : {}),
      },
    };
  } catch (err) {
    return handleRouteError(err, 'byok-save', reqId);
  }
}

export async function handleTestByokKeyRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    cookieHeader?: string | string[];
    body?: unknown;
    signal?: AbortSignal;
    requestId?: string;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const reqId = params.requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;
    const parsedBody = parseRequestObjectBody(params.body);
    if (parsedBody.ok === false) {
      return parsedBody.result;
    }
    const rawBody = parsedBody.data;

    let targetKey: string | null = null;
    let resolvedKeyType: GeminiApiKeyType | undefined;

    if (
      typeof rawBody.apiKey === 'string' &&
      normalizeGeminiApiKeyInput(rawBody.apiKey).length > 0
    ) {
      const validation = validateGeminiApiKeyFormat(rawBody.apiKey);
      if (!validation.valid || !validation.apiKey) {
        return {
          status: 400,
          headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
          body: {
            ok: false,
            error: 'invalid_key_format',
            errorCode: 'invalid_key_format',
            detailCode: validation.reasonCode,
            category: 'input_format' satisfies AiErrorCategory,
            requestId: reqId,
            message: validation.message || 'API 키 형식이 올바르지 않습니다.',
          },
        };
      }
      targetKey = validation.apiKey;
      resolvedKeyType = validation.keyType ?? detectGeminiApiKeyType(validation.apiKey);
    } else {
      const stored = await resolved.resolveApiKey({
        uid: user.uid,
        cookieHeader: params.cookieHeader,
        idToken,
      });
      if (!stored) {
        if (isVercelServerlessRuntime() && getPersistenceMode() !== 'encrypted_vault') {
          return {
            status: 503,
            headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
            body: {
              ok: false,
              error: 'encryption_secret_missing',
              errorCode: 'encryption_secret_missing',
              category: 'encryption_config' satisfies AiErrorCategory,
              requestId: reqId,
              message:
                'Vercel 서버 환경변수 BYOK_ENCRYPTION_SECRET가 설정되지 않아 저장된 개인 API 키를 복호화할 수 없습니다.',
            },
          };
        }
        return {
          status: 403,
          headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
          body: {
            ok: false,
            error: 'personal_key_required',
            errorCode: 'personal_key_required',
            category: 'encryption_config' satisfies AiErrorCategory,
            requestId: reqId,
            message: '테스트할 개인 API 키가 등록되어 있지 않습니다.',
          },
        };
      }
      targetKey = stored.apiKey;
      resolvedKeyType = stored.keyType ?? detectGeminiApiKeyType(stored.apiKey);
    }

    let candidateModel: string | undefined;
    if (
      rawBody.candidateModel !== undefined &&
      rawBody.candidateModel !== null &&
      String(rawBody.candidateModel).trim().length > 0
    ) {
      const modelCheck = validateCandidateModelName(rawBody.candidateModel);
      if (!modelCheck.ok) {
        return {
          status: 400,
          headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
          body: {
            ok: false,
            error: 'invalid_model_name',
            errorCode: 'invalid_model_name',
            category: 'input_format' satisfies AiErrorCategory,
            requestId: reqId,
            message: modelCheck.message,
          },
        };
      }
      candidateModel = modelCheck.model;
    }

    const startMs = Date.now();
    const res = await resolved.testApiKey(
      targetKey,
      params.signal,
      reqId,
      candidateModel ? { candidateModel } : undefined,
    );
    const latencyMs =
      typeof res.latencyMs === 'number' && res.latencyMs > 0
        ? res.latencyMs
        : Math.max(1, Date.now() - startMs);
    const keyType = res.keyType ?? resolvedKeyType ?? detectGeminiApiKeyType(targetKey);
    const configuredModel = res.configuredModel ?? getGeminiModelName();
    const apiKeyAuthOk = res.apiKeyAuthOk ?? true;
    const generateContentOk = res.generateContentOk ?? (res.ok ?? true);
    const modelAccessible = res.modelAccessible ?? generateContentOk;
    const overallOk = Boolean(res.ok ?? (apiKeyAuthOk && generateContentOk));

    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
      body: {
        ok: overallOk,
        requestId: reqId,
        model: res.model,
        configuredModel,
        ...(typeof res.isCandidateTest === 'boolean'
          ? { isCandidateTest: res.isCandidateTest }
          : candidateModel
            ? { isCandidateTest: candidateModel !== configuredModel }
            : {}),
        apiKeyAuthOk,
        modelAccessible,
        generateContentOk,
        ...(typeof res.httpStatus === 'number'
          ? { httpStatus: res.httpStatus }
          : overallOk
            ? { httpStatus: 200 }
            : {}),
        ...(res.finishReason ? { finishReason: res.finishReason } : {}),
        latencyMs,
        ...(typeof res.timeoutMs === 'number' ? { timeoutMs: res.timeoutMs } : {}),
        ...(res.timeoutSource ? { timeoutSource: res.timeoutSource } : {}),
        keyType,
        message:
          res.message ||
          (overallOk
            ? `개인 API 키 인증 및 모델(${res.model}) 호출 확인 완료 (${latencyMs}ms)`
            : `API 키 인증은 정상이나 모델(${res.model}) generateContent 호출에 실패했습니다.`),
        ...(res.errorCode ? { errorCode: res.errorCode } : {}),
        ...(res.diagnosticCategory ? { diagnosticCategory: res.diagnosticCategory } : {}),
        ...(typeof res.upstreamHttpStatus === 'number'
          ? { upstreamHttpStatus: res.upstreamHttpStatus }
          : {}),
        ...(res.upstreamApiStatus ? { upstreamApiStatus: res.upstreamApiStatus } : {}),
        ...(res.upstreamErrorMessage
          ? { upstreamErrorMessage: res.upstreamErrorMessage }
          : {}),
        ...(res.requestApiVersion ? { requestApiVersion: res.requestApiVersion } : {}),
        ...(res.requestEndpoint ? { requestEndpoint: res.requestEndpoint } : {}),
        ...(typeof res.modelListCached === 'boolean'
          ? { modelListCached: res.modelListCached }
          : {}),
        ...(typeof res.targetModelInList === 'boolean'
          ? { targetModelInList: res.targetModelInList }
          : {}),
        ...(typeof res.targetModelSupportsGenerate === 'boolean'
          ? { targetModelSupportsGenerate: res.targetModelSupportsGenerate }
          : {}),
        ...(res.availableGenerateModels
          ? { availableGenerateModels: res.availableGenerateModels }
          : {}),
        ...(res.recommendedModel !== undefined
          ? { recommendedModel: res.recommendedModel }
          : {}),
        ...(res.compatibility ? { compatibility: res.compatibility } : {}),
        ...(res.warning ? { warning: res.warning } : {}),
        usage: res.usage,
      },
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) {
      const resolvedReqId = err.requestId ?? reqId;
      const configuredModel = getGeminiModelName();
      const requestApiVersion = err.requestApiVersion ?? getEffectiveGeminiApiVersion();
      const requestEndpoint =
        err.requestEndpoint ??
        `models/${configuredModel.replace(/^models\//, '')}:generateContent`;
      const isAuthFailure =
        err.diagnosticCategory === 'auth_failed' ||
        err.diagnosticCategory === 'auth_header_error' ||
        err.code === 'invalid_api_key' ||
        err.code === 'api_key_permission_denied' ||
        err.code === 'gemini_auth_header_error';
      return {
        status: err.status,
        headers: { 'Cache-Control': 'no-store', 'X-Request-Id': resolvedReqId },
        body: {
          ok: false,
          requestId: resolvedReqId,
          model: configuredModel,
          configuredModel,
          apiKeyAuthOk: !isAuthFailure,
          modelAccessible: false,
          generateContentOk: false,
          ...(typeof err.upstreamHttpStatus === 'number'
            ? { httpStatus: err.upstreamHttpStatus }
            : {}),
          latencyMs: 0,
          ...(err.timeoutSource ? { timeoutSource: err.timeoutSource } : {}),
          error: err.code,
          errorCode: err.code,
          category: 'gemini_api' satisfies AiErrorCategory,
          requestApiVersion,
          requestEndpoint,
          ...(err.diagnosticCategory
            ? { diagnosticCategory: err.diagnosticCategory satisfies GeminiDiagnosticErrorCategory }
            : {}),
          ...(typeof err.upstreamHttpStatus === 'number'
            ? { upstreamHttpStatus: err.upstreamHttpStatus }
            : {}),
          ...(err.upstreamApiStatus ? { upstreamApiStatus: err.upstreamApiStatus } : {}),
          ...(err.upstreamErrorMessage
            ? { upstreamErrorMessage: err.upstreamErrorMessage }
            : {}),
          message: err.message,
        },
      };
    }
    return handleRouteError(err, 'byok-test', reqId);
  }
}

export async function handleDeleteByokKeyRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    isSecure?: boolean;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;
    await deletePersonalApiKeyForUid({ uid: user.uid, idToken });

    return {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': buildByokClearCookieHeader(Boolean(params.isSecure)),
      },
      body: {
        ok: true,
        hasPersonalKey: false,
        message: '등록된 개인 Gemini API 키를 삭제했습니다.',
      },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleUpdateAiPreferencesRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    body: unknown;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;
    const rawBody =
      params.body && typeof params.body === 'object'
        ? (params.body as Record<string, unknown>)
        : {};

    const current = await loadUserAiState(user.uid, idToken);
    const next = { ...current };

    if (typeof rawBody.aiEnabled === 'boolean') {
      next.aiEnabled = rawBody.aiEnabled;
    }
    if (typeof rawBody.dailyPlanLimit === 'number' && Number.isInteger(rawBody.dailyPlanLimit)) {
      next.dailyPlanLimit = Math.max(
        1,
        Math.min(AI_LIMITS.MAX_DAILY_PLAN_LIMIT, rawBody.dailyPlanLimit),
      );
    }
    if (typeof rawBody.dailyTotalLimit === 'number' && Number.isInteger(rawBody.dailyTotalLimit)) {
      next.dailyTotalLimit = Math.max(
        next.dailyPlanLimit,
        Math.min(AI_LIMITS.MAX_DAILY_TOTAL_LIMIT, rawBody.dailyTotalLimit),
      );
    }

    const saved = await saveUserAiState(user.uid, next, idToken);
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        ok: true,
        aiEnabled: saved.aiEnabled,
        dailyPlanLimit: saved.dailyPlanLimit,
        dailyTotalLimit: saved.dailyTotalLimit,
        usage: toUsageSnapshot(saved),
      },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleAnalyzeNoticeRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    cookieHeader?: string | string[];
    body: unknown;
    signal?: AbortSignal;
    requestId?: string;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const reqId = params.requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  let lockedUid: string | null = null;
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;

    const keyOrErr = await resolveCallerKeyOrError({
      uid: user.uid,
      cookieHeader: params.cookieHeader,
      idToken,
      resolvedDeps: resolved,
    });
    if ('status' in keyOrErr) {
      return {
        ...keyOrErr,
        headers: { ...(keyOrErr.headers ?? {}), 'X-Request-Id': reqId },
      };
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: {
          'Retry-After': String(rate.retryAfterSeconds),
          'X-Request-Id': reqId,
        },
        body: {
          error: 'rate_limit_exceeded',
          requestId: reqId,
          message: `잠시 후(${rate.retryAfterSeconds}초 뒤) 다시 시도해 주세요. AI 호출 한도를 초과했습니다.`,
        },
      };
    }

    const userState = await loadUserAiState(user.uid, idToken);
    if (!resolved.isConfiguredOverride) {
      const quota = checkDailyQuotaForKind(userState, 'notice');
      if (!quota.allowed) {
        return {
          status: 429,
          headers: { 'X-Request-Id': reqId },
          body: { error: quota.code, requestId: reqId, message: quota.reason },
        };
      }
    }

    const rawBody =
      params.body && typeof params.body === 'object'
        ? (params.body as Record<string, unknown>)
        : {};
    const text = typeof rawBody.text === 'string' ? rawBody.text.trim() : '';

    if (!text) {
      return {
        status: 400,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'empty_input',
          requestId: reqId,
          message: '분석할 텍스트를 입력해 주세요.',
        },
      };
    }

    if (text.length > AI_LIMITS.MAX_NOTICE_CHARS) {
      return {
        status: 400,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'input_too_long',
          requestId: reqId,
          message: `입력 텍스트가 너무 깁니다. ${AI_LIMITS.MAX_NOTICE_CHARS.toLocaleString()}자 이내로 줄여서 분석해 주세요.`,
        },
      };
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'concurrent_ai_request',
          requestId: reqId,
          message: '이전 AI 요청이 아직 처리 중입니다. 완료된 후 다시 시도해 주세요.',
        },
      };
    }
    lockedUid = user.uid;

    const todayKey =
      typeof rawBody.todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawBody.todayKey)
        ? rawBody.todayKey
        : undefined;

    const existingItems = Array.isArray(rawBody.existingItems)
      ? rawBody.existingItems
          .slice(0, AI_LIMITS.MAX_EXISTING_CONTEXT_ITEMS)
          .filter(
            (item): item is NonNullable<AiAnalyzeNoticeRequest['existingItems']>[number] =>
              Boolean(
                item &&
                  typeof item === 'object' &&
                  typeof (item as { id?: unknown }).id === 'string' &&
                  typeof (item as { title?: unknown }).title === 'string' &&
                  ((item as { kind?: unknown }).kind === 'task' ||
                    (item as { kind?: unknown }).kind === 'event'),
              ),
          )
      : [];

    const result = await resolved.analyzeNotice(
      { text, todayKey, existingItems },
      params.signal,
      keyOrErr.apiKey,
      reqId,
    );

    let usageSnapshot: AiStatusResponse['usage'] | undefined;
    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'notice',
        result.model,
        result.usage,
      );
      const savedState = await saveUserAiState(user.uid, updatedState, idToken);
      usageSnapshot = toUsageSnapshot(savedState);
    }

    return {
      status: 200,
      body: {
        ...result,
        ...(usageSnapshot ? { usageSnapshot } : {}),
      },
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
    };
  } catch (err) {
    return handleRouteError(err, 'analyze-notice', reqId);
  } finally {
    if (lockedUid) releaseUidInFlightLock(lockedUid);
  }
}

export async function handleAiBriefingRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    cookieHeader?: string | string[];
    body: unknown;
    signal?: AbortSignal;
    requestId?: string;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const reqId = params.requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  let lockedUid: string | null = null;
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;

    const keyOrErr = await resolveCallerKeyOrError({
      uid: user.uid,
      cookieHeader: params.cookieHeader,
      idToken,
      resolvedDeps: resolved,
    });
    if ('status' in keyOrErr) {
      return {
        ...keyOrErr,
        headers: { ...(keyOrErr.headers ?? {}), 'X-Request-Id': reqId },
      };
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: {
          'Retry-After': String(rate.retryAfterSeconds),
          'X-Request-Id': reqId,
        },
        body: {
          error: 'rate_limit_exceeded',
          requestId: reqId,
          message: `잠시 후(${rate.retryAfterSeconds}초 뒤) 다시 시도해 주세요. AI 호출 한도를 초과했습니다.`,
        },
      };
    }

    const userState = await loadUserAiState(user.uid, idToken);
    if (!resolved.isConfiguredOverride) {
      const quota = checkDailyQuotaForKind(userState, 'briefing');
      if (!quota.allowed) {
        return {
          status: 429,
          headers: { 'X-Request-Id': reqId },
          body: { error: quota.code, requestId: reqId, message: quota.reason },
        };
      }
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'concurrent_ai_request',
          requestId: reqId,
          message: '이전 AI 요청이 아직 처리 중입니다. 완료된 후 다시 시도해 주세요.',
        },
      };
    }
    lockedUid = user.uid;

    const rawBody =
      params.body && typeof params.body === 'object'
        ? (params.body as Record<string, unknown>)
        : {};

    const todayKey =
      typeof rawBody.todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawBody.todayKey)
        ? rawBody.todayKey
        : new Date().toISOString().slice(0, 10);

    const imminentDays =
      typeof rawBody.imminentDays === 'number' &&
      rawBody.imminentDays >= 1 &&
      rawBody.imminentDays <= 14
        ? rawBody.imminentDays
        : 3;

    const tasks = Array.isArray(rawBody.tasks)
      ? (rawBody.tasks as AiBriefingRequest['tasks']).slice(
          0,
          AI_LIMITS.MAX_BRIEFING_TASKS,
        )
      : [];
    const events = Array.isArray(rawBody.events)
      ? (rawBody.events as AiBriefingRequest['events']).slice(
          0,
          AI_LIMITS.MAX_BRIEFING_EVENTS,
        )
      : [];

    const result = await resolved.generateBriefing(
      { todayKey, imminentDays, tasks, events },
      params.signal,
      keyOrErr.apiKey,
      reqId,
    );

    let usageSnapshot: AiStatusResponse['usage'] | undefined;
    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'briefing',
        result.model,
        result.usage,
      );
      const savedState = await saveUserAiState(user.uid, updatedState, idToken);
      usageSnapshot = toUsageSnapshot(savedState);
    }

    return {
      status: 200,
      body: {
        ...result,
        ...(usageSnapshot ? { usageSnapshot } : {}),
      },
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
    };
  } catch (err) {
    return handleRouteError(err, 'briefing', reqId);
  } finally {
    if (lockedUid) releaseUidInFlightLock(lockedUid);
  }
}

export async function handleAiPlannerRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    cookieHeader?: string | string[];
    body: unknown;
    signal?: AbortSignal;
    requestId?: string;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const reqId = params.requestId ?? generateSafeRequestId();
  const resolved = resolveDeps(deps);
  let lockedUid: string | null = null;
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);
    const idToken = extractBearerToken(params.authorizationHeader) ?? undefined;

    const keyOrErr = await resolveCallerKeyOrError({
      uid: user.uid,
      cookieHeader: params.cookieHeader,
      idToken,
      resolvedDeps: resolved,
    });
    if ('status' in keyOrErr) {
      return {
        ...keyOrErr,
        headers: { ...(keyOrErr.headers ?? {}), 'X-Request-Id': reqId },
      };
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: {
          'Retry-After': String(rate.retryAfterSeconds),
          'X-Request-Id': reqId,
        },
        body: {
          error: 'rate_limit_exceeded',
          requestId: reqId,
          message: `잠시 후(${rate.retryAfterSeconds}초 뒤) 다시 시도해 주세요. 분당 호출 한도를 초과했습니다.`,
        },
      };
    }

    const userState = await loadUserAiState(user.uid, idToken);
    if (!resolved.isConfiguredOverride) {
      const quota = checkDailyQuotaForKind(userState, 'planner');
      if (!quota.allowed) {
        return {
          status: 429,
          headers: { 'X-Request-Id': reqId },
          body: { error: quota.code, requestId: reqId, message: quota.reason },
        };
      }
    }

    const rawBody =
      params.body && typeof params.body === 'object'
        ? (params.body as Record<string, unknown>)
        : {};

    const todayKey =
      typeof rawBody.todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawBody.todayKey)
        ? rawBody.todayKey
        : new Date().toISOString().slice(0, 10);

    const currentTimeHhMm =
      typeof rawBody.currentTimeHhMm === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(rawBody.currentTimeHhMm)
        ? rawBody.currentTimeHhMm
        : '08:30';

    const tasks = Array.isArray(rawBody.tasks)
      ? (rawBody.tasks as AiPlannerRequest['tasks']).slice(
          0,
          AI_LIMITS.MAX_PLANNER_TASKS,
        )
      : [];

    if (tasks.length === 0) {
      return {
        status: 400,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'no_tasks_to_plan',
          requestId: reqId,
          message: '계획할 미완료 업무가 없습니다. 새 업무를 등록한 뒤 다시 시도해 주세요.',
        },
      };
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        headers: { 'X-Request-Id': reqId },
        body: {
          error: 'concurrent_ai_request',
          requestId: reqId,
          message: '오늘의 업무 계획을 생성하는 중입니다. 잠시만 기다려 주세요.',
        },
      };
    }
    lockedUid = user.uid;

    const plannerPayload: AiPlannerRequest = {
      todayKey,
      currentTimeHhMm,
      totalIncompleteCount:
        typeof rawBody.totalIncompleteCount === 'number'
          ? rawBody.totalIncompleteCount
          : tasks.length,
      overdueCount:
        typeof rawBody.overdueCount === 'number' ? rawBody.overdueCount : 0,
      dueTodayCount:
        typeof rawBody.dueTodayCount === 'number' ? rawBody.dueTodayCount : 0,
      timetableConfigured: Boolean(rawBody.timetableConfigured),
      remainingWorkableMinutes:
        typeof rawBody.remainingWorkableMinutes === 'number'
          ? rawBody.remainingWorkableMinutes
          : 0,
      workableSlots: Array.isArray(rawBody.workableSlots)
        ? (rawBody.workableSlots as AiPlannerRequest['workableSlots']).slice(
            0,
            AI_LIMITS.MAX_PLANNER_SLOTS,
          )
        : [],
      blockedEventsSummary: Array.isArray(rawBody.blockedEventsSummary)
        ? (rawBody.blockedEventsSummary as string[]).slice(0, 6)
        : [],
      academicAlertsSummary: Array.isArray(rawBody.academicAlertsSummary)
        ? (rawBody.academicAlertsSummary as string[]).slice(0, 4)
        : [],
      tasks,
      ...(typeof rawBody.constraint === 'string' && rawBody.constraint.trim()
        ? {
            constraint: rawBody.constraint
              .trim()
              .slice(0, AI_LIMITS.MAX_ADJUST_CONSTRAINT_CHARS),
          }
        : {}),
    };

    const result = await resolved.generateDayPlan(
      plannerPayload,
      params.signal,
      keyOrErr.apiKey,
      reqId,
    );

    let usageSnapshot: AiStatusResponse['usage'] | undefined;
    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'planner',
        result.model,
        result.usage,
      );
      const savedState = await saveUserAiState(user.uid, updatedState, idToken);
      usageSnapshot = toUsageSnapshot(savedState);
    }

    return {
      status: 200,
      body: {
        ...result,
        ...(usageSnapshot ? { usageSnapshot } : {}),
      },
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': reqId },
    };
  } catch (err) {
    return handleRouteError(err, 'planner', reqId);
  } finally {
    if (lockedUid) releaseUidInFlightLock(lockedUid);
  }
}

function sendRouteResult(res: Response, result: AiRouteResult) {
  if (res.writableEnded) return;
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
  }
  res.status(result.status).json(result.body);
}

function bindRequestAbortController(req: Request): AbortController {
  const controller = new AbortController();
  req.on('close', () => {
    if (!req.complete) {
      controller.abort();
    }
  });
  return controller;
}

function isSecureRequest(headers: Record<string, string | string[] | undefined>, expressSecure?: boolean): boolean {
  if (expressSecure) return true;
  const proto = headers['x-forwarded-proto'];
  const val = Array.isArray(proto) ? proto[0] : proto;
  return typeof val === 'string' && val.toLowerCase().includes('https');
}

export function createAiExpressRouter(deps: AiRouteDeps = {}) {
  const router = Router();

  router.get('/status', async (req, res) => {
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleAiStatusRequest(
      req.headers.authorization,
      deps,
      req.headers.cookie,
      requestId,
    );
    sendRouteResult(res, result);
  });

  router.post('/byok', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleSaveByokKeyRequest(
      {
        authorizationHeader: req.headers.authorization,
        body: req.body,
        isSecure: isSecureRequest(req.headers, req.secure),
        signal: controller.signal,
        requestId,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.delete('/byok', async (req, res) => {
    const result = await handleDeleteByokKeyRequest(
      {
        authorizationHeader: req.headers.authorization,
        isSecure: isSecureRequest(req.headers, req.secure),
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/byok/test', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleTestByokKeyRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
        requestId,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/preferences', async (req, res) => {
    const result = await handleUpdateAiPreferencesRequest(
      {
        authorizationHeader: req.headers.authorization,
        body: req.body,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/analyze-notice', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
        requestId,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/briefing', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleAiBriefingRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
        requestId,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/planner', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const requestId = resolveSafeRequestId(req.headers);
    const result = await handleAiPlannerRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
        requestId,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  return router;
}

export interface VercelLikeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  complete?: boolean;
  on?: (event: string, listener: () => void) => void;
}

export interface VercelLikeResponse {
  status: (code: number) => VercelLikeResponse;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string | string[]) => void;
}

export async function dispatchVercelAiRoute(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
  expectedMethod: 'GET' | 'POST' | 'DELETE' | Array<'GET' | 'POST' | 'DELETE'>,
  runner: (signal?: AbortSignal, requestId?: string) => Promise<AiRouteResult>,
) {
  const requestId = resolveSafeRequestId(req.headers);
  const allowed = Array.isArray(expectedMethod) ? expectedMethod : [expectedMethod];
  if (!req.method || !allowed.includes(req.method as 'GET' | 'POST' | 'DELETE')) {
    res.setHeader('Allow', allowed.join(', '));
    res.setHeader('X-Request-Id', requestId);
    res.status(405).json({
      error: 'method_not_allowed',
      category: 'request_format' satisfies AiErrorCategory,
      requestId,
      message: '허용되지 않은 요청 방식입니다.',
    });
    return;
  }

  const controller = new AbortController();
  req.on?.('close', () => {
    if (!req.complete) {
      controller.abort();
    }
  });

  try {
    const result = await runner(controller.signal, requestId);
    res.setHeader('X-Request-Id', requestId);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        res.setHeader(k, v);
      }
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    const fallback = handleRouteError(err, 'vercel-dispatch', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);
    res.status(fallback.status).json(fallback.body);
  }
}
