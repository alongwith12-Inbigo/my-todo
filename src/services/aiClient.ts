import { auth } from '../lib/firebase';
import type {
  AiAnalyzeNoticeRequest,
  AiAnalyzeNoticeResponse,
  AiBriefingRequest,
  AiBriefingResponse,
  AiByokSaveRequest,
  AiByokSaveResponse,
  AiByokTestRequest,
  AiByokTestResponse,
  AiErrorCategory,
  AiPlannerErrorDetail,
  AiPlannerRequest,
  AiPlannerResponse,
  AiPreferencesUpdateRequest,
  AiStatusResponse,
  AiTimeoutSource,
  AiUsageSnapshot,
  GeminiDiagnosticErrorCategory,
} from '../lib/aiTypes';

export class AiClientError extends Error {
  status: number;
  code: string;
  category?: AiErrorCategory;
  detailCode?: string;
  diagnostic?: AiByokTestResponse;
  errorDetail?: AiPlannerErrorDetail;

  constructor(
    status: number,
    code: string,
    message: string,
    category?: AiErrorCategory,
    detailCode?: string,
    diagnostic?: AiByokTestResponse,
    errorDetail?: AiPlannerErrorDetail,
  ) {
    super(message);
    this.name = 'AiClientError';
    this.status = status;
    this.code = code;
    this.category = category;
    this.detailCode = detailCode;
    this.diagnostic = diagnostic;
    this.errorDetail = errorDetail;
  }
}

async function getActiveIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new AiClientError(
      401,
      'unauthenticated',
      'Google 로그인이 필요합니다. 로그인 상태를 확인해 주세요.',
      'auth',
    );
  }
  return await user.getIdToken();
}

async function fetchAiJson<T>(
  url: string,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  const token = await getActiveIdToken();

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method,
      credentials: 'same-origin',
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AiClientError(
        499,
        'ai_aborted',
        'AI 요청이 취소되었습니다.',
        'network',
      );
    }
    throw new AiClientError(
      0,
      'network_error',
      'AI 서버와 통신할 수 없습니다. 네트워크 상태를 확인하거나 기본 기능을 이용해 주세요.',
      'network',
    );
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const errObj =
      payload && typeof payload === 'object'
        ? (payload as {
            error?: unknown;
            errorCode?: unknown;
            detailCode?: unknown;
            category?: unknown;
            diagnosticCategory?: unknown;
            message?: unknown;
            model?: unknown;
            timeoutSource?: unknown;
            timeoutMs?: unknown;
            latencyMs?: unknown;
            firstChunkLatencyMs?: unknown;
            chunkCount?: unknown;
            streamed?: unknown;
            requestId?: unknown;
            requestApiVersion?: unknown;
            requestEndpoint?: unknown;
            upstreamHttpStatus?: unknown;
            upstreamApiStatus?: unknown;
            upstreamErrorMessage?: unknown;
            availableGenerateModels?: unknown;
            recommendedModel?: unknown;
          })
        : {};
    const code =
      typeof errObj.error === 'string'
        ? errObj.error
        : typeof errObj.errorCode === 'string'
          ? errObj.errorCode
          : payload === null
            ? `non_json_http_${res.status}`
            : `http_${res.status}`;
    const detailCode =
      typeof errObj.detailCode === 'string' ? errObj.detailCode : undefined;
    const category =
      typeof errObj.category === 'string'
        ? (errObj.category as AiErrorCategory)
        : res.status === 401 || res.status === 403
          ? 'auth'
          : res.status >= 500 && payload === null
            ? 'server_internal'
            : undefined;
    const message =
      typeof errObj.message === 'string'
        ? errObj.message
        : payload === null
          ? `서버가 JSON 응답을 반환하지 못했습니다 (HTTP ${res.status}). Vercel API 함수 로그 또는 배포 상태를 확인해 주세요.`
          : `AI 요청이 실패했습니다 (HTTP ${res.status}). 기본 기능을 이용해 주세요.`;
    const diagnostic =
      payload &&
      typeof payload === 'object' &&
      'configuredModel' in payload &&
      'apiKeyAuthOk' in payload
        ? (payload as AiByokTestResponse)
        : undefined;
    const availableGenerateModels = Array.isArray(errObj.availableGenerateModels)
      ? errObj.availableGenerateModels.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : undefined;
    const hasDiagnosticFields =
      typeof errObj.diagnosticCategory === 'string' ||
      typeof errObj.model === 'string' ||
      typeof errObj.timeoutSource === 'string' ||
      typeof errObj.timeoutMs === 'number' ||
      typeof errObj.latencyMs === 'number' ||
      typeof errObj.chunkCount === 'number' ||
      typeof errObj.streamed === 'boolean' ||
      typeof errObj.requestId === 'string' ||
      typeof errObj.requestApiVersion === 'string' ||
      typeof errObj.requestEndpoint === 'string' ||
      typeof errObj.upstreamHttpStatus === 'number' ||
      typeof errObj.upstreamApiStatus === 'string' ||
      typeof errObj.upstreamErrorMessage === 'string';
    const errorDetail: AiPlannerErrorDetail | undefined = hasDiagnosticFields
      ? {
          errorCode: code,
          ...(typeof errObj.diagnosticCategory === 'string'
            ? {
                diagnosticCategory:
                  errObj.diagnosticCategory as GeminiDiagnosticErrorCategory,
              }
            : {}),
          ...(typeof errObj.model === 'string' ? { model: errObj.model } : {}),
          ...(errObj.timeoutSource === 'local' || errObj.timeoutSource === 'upstream'
            ? { timeoutSource: errObj.timeoutSource as AiTimeoutSource }
            : {}),
          ...(typeof errObj.timeoutMs === 'number'
            ? { timeoutMs: errObj.timeoutMs }
            : {}),
          ...(typeof errObj.latencyMs === 'number'
            ? { latencyMs: errObj.latencyMs }
            : {}),
          ...(typeof errObj.firstChunkLatencyMs === 'number'
            ? { firstChunkLatencyMs: errObj.firstChunkLatencyMs }
            : {}),
          ...(typeof errObj.chunkCount === 'number'
            ? { chunkCount: errObj.chunkCount }
            : {}),
          ...(typeof errObj.streamed === 'boolean'
            ? { streamed: errObj.streamed }
            : {}),
          ...(typeof errObj.requestId === 'string'
            ? { requestId: errObj.requestId }
            : {}),
          ...(typeof errObj.requestApiVersion === 'string'
            ? { requestApiVersion: errObj.requestApiVersion }
            : {}),
          ...(typeof errObj.requestEndpoint === 'string'
            ? { requestEndpoint: errObj.requestEndpoint }
            : {}),
          ...(typeof errObj.upstreamHttpStatus === 'number'
            ? { upstreamHttpStatus: errObj.upstreamHttpStatus }
            : {}),
          ...(typeof errObj.upstreamApiStatus === 'string'
            ? { upstreamApiStatus: errObj.upstreamApiStatus }
            : {}),
          ...(typeof errObj.upstreamErrorMessage === 'string'
            ? { upstreamErrorMessage: errObj.upstreamErrorMessage }
            : {}),
          ...(availableGenerateModels && availableGenerateModels.length > 0
            ? { availableGenerateModels }
            : {}),
          ...(errObj.recommendedModel === null ||
          typeof errObj.recommendedModel === 'string'
            ? { recommendedModel: errObj.recommendedModel }
            : {}),
        }
      : undefined;
    throw new AiClientError(
      res.status,
      code,
      message,
      category,
      detailCode,
      diagnostic,
      errorDetail,
    );
  }

  return payload as T;
}

export async function fetchAiServerStatus(
  signal?: AbortSignal,
): Promise<AiStatusResponse> {
  return await fetchAiJson<AiStatusResponse>('/api/ai/status', {
    method: 'GET',
    signal,
  });
}

export async function saveByokApiKey(
  input: AiByokSaveRequest,
  signal?: AbortSignal,
): Promise<AiByokSaveResponse> {
  return await fetchAiJson<AiByokSaveResponse>('/api/ai/byok', {
    method: 'POST',
    body: input,
    signal,
  });
}

export async function testByokApiKey(
  input: AiByokTestRequest = {},
  signal?: AbortSignal,
): Promise<AiByokTestResponse> {
  return await fetchAiJson<AiByokTestResponse>('/api/ai/byok/test', {
    method: 'POST',
    body: input,
    signal,
  });
}

export async function deleteByokApiKey(
  signal?: AbortSignal,
): Promise<{ ok: boolean; hasPersonalKey: boolean; message: string }> {
  return await fetchAiJson<{ ok: boolean; hasPersonalKey: boolean; message: string }>(
    '/api/ai/byok',
    {
      method: 'DELETE',
      signal,
    },
  );
}

export async function updateAiServerPreferences(
  input: AiPreferencesUpdateRequest,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  aiEnabled: boolean;
  dailyPlanLimit: number;
  dailyTotalLimit: number;
  usage: AiUsageSnapshot;
}> {
  return await fetchAiJson('/api/ai/preferences', {
    method: 'POST',
    body: input,
    signal,
  });
}

export async function requestAiNoticeAnalysis(
  input: AiAnalyzeNoticeRequest,
  signal?: AbortSignal,
): Promise<AiAnalyzeNoticeResponse> {
  return await fetchAiJson<AiAnalyzeNoticeResponse>('/api/ai/analyze-notice', {
    method: 'POST',
    body: input,
    signal,
  });
}

export async function requestAiTodayBriefing(
  input: AiBriefingRequest,
  signal?: AbortSignal,
): Promise<AiBriefingResponse> {
  return await fetchAiJson<AiBriefingResponse>('/api/ai/briefing', {
    method: 'POST',
    body: input,
    signal,
  });
}

export async function requestAiDayPlan(
  input: AiPlannerRequest,
  signal?: AbortSignal,
): Promise<AiPlannerResponse> {
  return await fetchAiJson<AiPlannerResponse>('/api/ai/planner', {
    method: 'POST',
    body: input,
    signal,
  });
}
