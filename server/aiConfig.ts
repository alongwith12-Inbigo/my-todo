import { AI_LIMITS } from '../src/lib/aiTypes.ts';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

export function getGeminiApiKey(): string | null {
  const raw = process.env.GEMINI_API_KEY?.trim();
  if (!raw || raw === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return raw;
}

export function isGeminiConfigured(): boolean {
  return getGeminiApiKey() !== null;
}

export function getGeminiModelName(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured || DEFAULT_GEMINI_MODEL;
}

export function getAiStatusPayload() {
  return {
    configured: isGeminiConfigured(),
    model: getGeminiModelName(),
    rateLimitMaxRequests: AI_LIMITS.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowSeconds: Math.round(AI_LIMITS.RATE_LIMIT_WINDOW_MS / 1000),
    maxNoticeChars: AI_LIMITS.MAX_NOTICE_CHARS,
  };
}

export function mapGeminiError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const lower = rawMessage.toLowerCase();

  if (lower.includes('aborted') || lower.includes('abort')) {
    return {
      status: 499,
      code: 'ai_aborted',
      message: 'AI 분석 요청이 취소되었습니다.',
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return {
      status: 504,
      code: 'ai_timeout',
      message:
        'AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도하거나 기본 분석을 이용해 주세요.',
    };
  }

  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      status: 429,
      code: 'ai_quota_exceeded',
      message:
        'Gemini API 호출 한도에 도달했습니다. 잠시 후 다시 시도하거나 기본 분석을 이용해 주세요.',
    };
  }

  if (
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      status: 503,
      code: 'ai_unavailable',
      message:
        '서버의 AI API 연결 설정을 확인할 수 없습니다. 관리자에게 문의하거나 기본 분석을 이용해 주세요.',
    };
  }

  return {
    status: 502,
    code: 'ai_upstream_error',
    message:
      'AI 분석 중 일시적인 오류가 발생했습니다. 잠시 후 다시 시도하거나 기본 분석으로 전환해 주세요.',
  };
}
