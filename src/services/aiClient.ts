import { auth } from '../lib/firebase';
import type {
  AiAnalyzeNoticeRequest,
  AiAnalyzeNoticeResponse,
  AiBriefingRequest,
  AiBriefingResponse,
  AiStatusResponse,
} from '../lib/aiTypes';

export class AiClientError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AiClientError';
    this.status = status;
    this.code = code;
  }
}

async function getActiveIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new AiClientError(
      401,
      'unauthenticated',
      'Google 로그인이 필요합니다. 로그인 상태를 확인해 주세요.',
    );
  }
  return await user.getIdToken();
}

async function fetchAiJson<T>(
  url: string,
  options: {
    method: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  const token = await getActiveIdToken();

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method,
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AiClientError(499, 'ai_aborted', 'AI 요청이 취소되었습니다.');
    }
    throw new AiClientError(
      0,
      'network_error',
      'AI 서버와 통신할 수 없습니다. 네트워크 상태를 확인하거나 기본 분석을 이용해 주세요.',
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
        ? (payload as { error?: unknown; message?: unknown })
        : {};
    const code =
      typeof errObj.error === 'string' ? errObj.error : `http_${res.status}`;
    const message =
      typeof errObj.message === 'string'
        ? errObj.message
        : `AI 요청이 실패했습니다 (HTTP ${res.status}). 기본 분석을 이용해 주세요.`;
    throw new AiClientError(res.status, code, message);
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
