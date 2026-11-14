import { Router, type Request, type Response } from 'express';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
} from '../src/lib/aiTypes.ts';
import { getAiStatusPayload, isGeminiConfigured } from './aiConfig.ts';
import {
  ServerAuthError,
  verifyFirebaseUserAndAccess,
  type VerifiedFirebaseUser,
} from './firebaseServerAuth.ts';
import {
  GeminiServiceError,
  analyzeNoticeWithGemini,
  generateBriefingWithGemini,
} from './geminiService.ts';
import { SlidingWindowRateLimiter } from './rateLimiter.ts';

export interface AiRouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface AiRouteDeps {
  verifyAuth?: (
    authorizationHeader: string | string[] | undefined,
  ) => Promise<VerifiedFirebaseUser>;
  rateLimiter?: SlidingWindowRateLimiter;
  isConfigured?: () => boolean;
  getStatusPayload?: typeof getAiStatusPayload;
  analyzeNotice?: (
    input: AiAnalyzeNoticeRequest,
    signal?: AbortSignal,
  ) => Promise<AiAnalyzeNoticeResponse>;
  generateBriefing?: (
    input: AiBriefingRequest,
    signal?: AbortSignal,
  ) => Promise<AiBriefingResponse>;
}

const defaultRateLimiter = new SlidingWindowRateLimiter(
  AI_LIMITS.RATE_LIMIT_MAX_REQUESTS,
  AI_LIMITS.RATE_LIMIT_WINDOW_MS,
);

function resolveDeps(deps: AiRouteDeps = {}) {
  return {
    verifyAuth: deps.verifyAuth ?? verifyFirebaseUserAndAccess,
    rateLimiter: deps.rateLimiter ?? defaultRateLimiter,
    isConfigured: deps.isConfigured ?? isGeminiConfigured,
    getStatusPayload: deps.getStatusPayload ?? getAiStatusPayload,
    analyzeNotice: deps.analyzeNotice ?? analyzeNoticeWithGemini,
    generateBriefing: deps.generateBriefing ?? generateBriefingWithGemini,
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
        'AI 요청 처리 중 예기치 않은 오류가 발생했습니다. 기본 분석 기능을 이용해 주세요.',
    },
  };
}

export async function handleAiStatusRequest(
  authorizationHeader: string | string[] | undefined,
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    await resolved.verifyAuth(authorizationHeader);
    return {
      status: 200,
      body: resolved.getStatusPayload(),
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleAnalyzeNoticeRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    body: unknown;
    signal?: AbortSignal;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);

    if (!resolved.isConfigured()) {
      return {
        status: 503,
        body: {
          error: 'ai_not_configured',
          message:
            '서버에 Gemini API 키가 설정되지 않았습니다. 대신 기본 분석을 이용해 주세요.',
        },
      };
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
    );

    return {
      status: 200,
      body: result,
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function handleAiBriefingRequest(
  params: {
    authorizationHeader: string | string[] | undefined;
    body: unknown;
    signal?: AbortSignal;
  },
  deps: AiRouteDeps = {},
): Promise<AiRouteResult> {
  const resolved = resolveDeps(deps);
  try {
    const user = await resolved.verifyAuth(params.authorizationHeader);

    if (!resolved.isConfigured()) {
      return {
        status: 503,
        body: {
          error: 'ai_not_configured',
          message:
            '서버에 Gemini API 키가 설정되지 않아 AI 브리핑을 사용할 수 없습니다.',
        },
      };
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
    );

    return {
      status: 200,
      body: result,
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch (err) {
    return handleRouteError(err);
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

export function createAiExpressRouter(deps: AiRouteDeps = {}) {
  const router = Router();

  router.get('/status', async (req, res) => {
    const result = await handleAiStatusRequest(req.headers.authorization, deps);
    sendRouteResult(res, result);
  });

  router.post('/analyze-notice', async (req, res) => {
    const controller = bindRequestAbortController(req);
    const result = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: req.headers.authorization,
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
  setHeader: (name: string, value: string) => void;
}

export async function dispatchVercelAiRoute(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
  expectedMethod: 'GET' | 'POST',
  runner: (signal?: AbortSignal) => Promise<AiRouteResult>,
) {
  if (req.method !== expectedMethod) {
    res.setHeader('Allow', expectedMethod);
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
