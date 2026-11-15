import { Router, type Request, type Response } from 'express';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
  type AiPlannerRequest,
  type AiPlannerResponse,
  type AiStatusResponse,
  type AiTokenUsage,
} from '../src/lib/aiTypes.ts';
import { getAiStatusBasePayload, getGeminiModelName } from './aiConfig.ts';
import {
  acquireUidInFlightLock,
  applyUsageIncrement,
  buildByokClearCookieHeader,
  buildByokSetCookieHeader,
  checkDailyQuotaForKind,
  deletePersonalApiKeyForUid,
  getPersistenceMode,
  loadUserAiState,
  maskGeminiApiKey,
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
  testGeminiPersonalKey,
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
  }) => Promise<{ apiKey: string; keyHint: string } | null>;
  analyzeNotice?: (
    input: AiAnalyzeNoticeRequest,
    signal?: AbortSignal,
    apiKey?: string,
  ) => Promise<AiAnalyzeNoticeResponse>;
  generateBriefing?: (
    input: AiBriefingRequest,
    signal?: AbortSignal,
    apiKey?: string,
  ) => Promise<AiBriefingResponse>;
  generateDayPlan?: (
    input: AiPlannerRequest,
    signal?: AbortSignal,
    apiKey?: string,
  ) => Promise<AiPlannerResponse>;
  testApiKey?: (
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<{ model: string; usage: AiTokenUsage }>;
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
      ((input: AiAnalyzeNoticeRequest, signal?: AbortSignal, apiKey?: string) =>
        analyzeNoticeWithGemini(apiKey ?? '', input, signal)),
    generateBriefing:
      deps.generateBriefing ??
      ((input: AiBriefingRequest, signal?: AbortSignal, apiKey?: string) =>
        generateBriefingWithGemini(apiKey ?? '', input, signal)),
    generateDayPlan:
      deps.generateDayPlan ??
      ((input: AiPlannerRequest, signal?: AbortSignal, apiKey?: string) =>
        generateDayPlanWithGemini(apiKey ?? '', input, signal)),
    testApiKey: deps.testApiKey ?? testGeminiPersonalKey,
  };
}

function handleRouteError(err: unknown): AiRouteResult {
  if (err instanceof ServerAuthError) {
    return {
      status: err.statusCode,
      body: { error: err.code, message: err.message },
    };
  }
  if (err instanceof GeminiServiceError) {
    return {
      status: err.status,
      body: { error: err.code, message: err.message },
    };
  }
  return {
    status: 500,
    body: {
      error: 'internal_error',
      message:
        'AI 요청 처리 중 예기치 않은 오류가 발생했습니다. 기본 기능을 이용해 주세요.',
    },
  };
}

async function resolveCallerKeyOrError(params: {
  uid: string;
  cookieHeader?: string | string[];
  idToken?: string;
  resolvedDeps: ReturnType<typeof resolveDeps>;
}): Promise<{ apiKey: string; keyHint: string } | AiRouteResult> {
  if (params.resolvedDeps.isConfiguredOverride) {
    if (!params.resolvedDeps.isConfiguredOverride()) {
      return {
        status: 503,
        body: {
          error: 'ai_not_configured',
          message:
            '개인 Gemini API 키가 등록되어 있지 않습니다. 설정에서 개인 API 키를 등록하거나 기본 기능을 이용해 주세요.',
        },
      };
    }
    return { apiKey: 'test-injected-key', keyHint: 'test...key' };
  }

  const found = await params.resolvedDeps.resolveApiKey({
    uid: params.uid,
    cookieHeader: params.cookieHeader,
    idToken: params.idToken,
  });
  if (!found) {
    return {
      status: 403,
      body: {
        error: 'personal_key_required',
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
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(authorizationHeader);
    const idToken = extractBearerToken(authorizationHeader) ?? undefined;

    const personalKey = resolved.isConfiguredOverride
      ? resolved.isConfiguredOverride()
        ? { apiKey: 'test', keyHint: 'test...key' }
        : null
      : await resolved.resolveApiKey({
          uid: user.uid,
          cookieHeader,
          idToken,
        });

    const userState = await loadUserAiState(user.uid, idToken);
    const base = getAiStatusBasePayload();

    const body: AiStatusResponse = {
      configured: Boolean(personalKey),
      hasPersonalKey: Boolean(personalKey),
      keyHint: personalKey?.keyHint ?? null,
      persistenceMode: getPersistenceMode(),
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
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleSaveByokKeyRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    body: unknown;
    isSecure?: boolean;
    signal?: AbortSignal;
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

    const validation = validateGeminiApiKeyFormat(rawBody.apiKey);
    if (!validation.valid || !validation.apiKey) {
      return {
        status: 400,
        body: {
          error: 'invalid_key_format',
          message: validation.message || 'API 키 형식이 올바르지 않습니다.',
        },
      };
    }

    let testUsage: AiTokenUsage | undefined;
    if (rawBody.testBeforeSave === true) {
      const testRes = await resolved.testApiKey(validation.apiKey, params.signal);
      testUsage = testRes.usage;
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

    return {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': setCookie,
      },
      body: {
        ok: true,
        hasPersonalKey: true,
        keyHint: saved.keyHint,
        persistenceMode: saved.persistenceMode,
        message:
          saved.persistenceMode === 'encrypted_vault'
            ? '개인 Gemini API 키를 암호화하여 안전하게 등록했습니다.'
            : '개인 Gemini API 키를 현재 서버 세션(암호화 쿠키·메모리)에 등록했습니다.',
        ...(testUsage ? { usage: testUsage } : {}),
      },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleTestByokKeyRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    cookieHeader?: string | string[];
    body?: unknown;
    signal?: AbortSignal;
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

    let targetKey: string | null = null;
    let keyHint: string | null = null;

    if (
      typeof rawBody.apiKey === 'string' &&
      normalizeGeminiApiKeyInput(rawBody.apiKey).length > 0
    ) {
      const validation = validateGeminiApiKeyFormat(rawBody.apiKey);
      if (!validation.valid || !validation.apiKey) {
        return {
          status: 400,
          body: {
            ok: false,
            errorCode: 'invalid_key_format',
            message: validation.message || 'API 키 형식이 올바르지 않습니다.',
          },
        };
      }
      targetKey = validation.apiKey;
      keyHint = maskGeminiApiKey(validation.apiKey);
    } else {
      const stored = await resolved.resolveApiKey({
        uid: user.uid,
        cookieHeader: params.cookieHeader,
        idToken,
      });
      if (!stored) {
        return {
          status: 403,
          body: {
            ok: false,
            errorCode: 'personal_key_required',
            message: '테스트할 개인 API 키가 등록되어 있지 않습니다.',
          },
        };
      }
      targetKey = stored.apiKey;
      keyHint = stored.keyHint;
    }

    const startMs = Date.now();
    const res = await resolved.testApiKey(targetKey, params.signal);
    const latencyMs = Math.max(1, Date.now() - startMs);

    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        ok: true,
        model: res.model,
        latencyMs,
        keyHint,
        message: `개인 API 키 연결 확인 완료 (${res.model}, ${latencyMs}ms)`,
        usage: res.usage,
      },
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) {
      return {
        status: err.status,
        headers: { 'Cache-Control': 'no-store' },
        body: {
          ok: false,
          model: getGeminiModelName(),
          latencyMs: 0,
          keyHint: null,
          errorCode: err.code,
          message: err.message,
        },
      };
    }
    return handleRouteError(err);
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
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
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
      return keyOrErr;
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
        body: {
          error: 'rate_limit_exceeded',
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
          body: { error: quota.code, message: quota.reason },
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
        body: {
          error: 'empty_input',
          message: '분석할 텍스트를 입력해 주세요.',
        },
      };
    }

    if (text.length > AI_LIMITS.MAX_NOTICE_CHARS) {
      return {
        status: 400,
        body: {
          error: 'input_too_long',
          message: `입력 텍스트가 너무 깁니다. ${AI_LIMITS.MAX_NOTICE_CHARS.toLocaleString()}자 이내로 줄여서 분석해 주세요.`,
        },
      };
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        body: {
          error: 'concurrent_ai_request',
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
    );

    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'notice',
        result.model,
        result.usage,
      );
      await saveUserAiState(user.uid, updatedState, idToken);
    }

    return {
      status: 200,
      body: result,
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
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
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
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
      return keyOrErr;
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
        body: {
          error: 'rate_limit_exceeded',
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
          body: { error: quota.code, message: quota.reason },
        };
      }
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        body: {
          error: 'concurrent_ai_request',
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
    );

    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'briefing',
        result.model,
        result.usage,
      );
      await saveUserAiState(user.uid, updatedState, idToken);
    }

    return {
      status: 200,
      body: result,
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
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
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
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
      return keyOrErr;
    }

    const rate = resolved.rateLimiter.consume(user.uid);
    if (!rate.allowed) {
      return {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
        body: {
          error: 'rate_limit_exceeded',
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
          body: { error: quota.code, message: quota.reason },
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
        body: {
          error: 'no_tasks_to_plan',
          message: '계획할 미완료 업무가 없습니다. 새 업무를 등록한 뒤 다시 시도해 주세요.',
        },
      };
    }

    if (!acquireUidInFlightLock(user.uid)) {
      return {
        status: 429,
        body: {
          error: 'concurrent_ai_request',
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
    );

    if (!resolved.isConfiguredOverride) {
      const updatedState = applyUsageIncrement(
        userState,
        'planner',
        result.model,
        result.usage,
      );
      await saveUserAiState(user.uid, updatedState, idToken);
    }

    return {
      status: 200,
      body: result,
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
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
    const result = await handleAiStatusRequest(
      req.headers.authorization,
      deps,
      req.headers.cookie,
    );
    sendRouteResult(res, result);
  });

  router.post('/byok', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const result = await handleSaveByokKeyRequest(
      {
        authorizationHeader: req.headers.authorization,
        body: req.body,
        isSecure: isSecureRequest(req.headers, req.secure),
        signal: controller.signal,
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
    const result = await handleTestByokKeyRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
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
    const result = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/briefing', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const result = await handleAiBriefingRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
      },
      deps,
    );
    sendRouteResult(res, result);
  });

  router.post('/planner', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const result = await handleAiPlannerRequest(
      {
        authorizationHeader: req.headers.authorization,
        cookieHeader: req.headers.cookie,
        body: req.body,
        signal: controller.signal,
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
  runner: (signal?: AbortSignal) => Promise<AiRouteResult>,
) {
  const allowed = Array.isArray(expectedMethod) ? expectedMethod : [expectedMethod];
  if (!req.method || !allowed.includes(req.method as 'GET' | 'POST' | 'DELETE')) {
    res.setHeader('Allow', allowed.join(', '));
    res.status(405).json({ error: 'method_not_allowed', message: '허용되지 않은 요청 방식입니다.' });
    return;
  }

  const controller = new AbortController();
  req.on?.('close', () => controller.abort());

  const result = await runner(controller.signal);
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
  }
  res.status(result.status).json(result.body);
}
