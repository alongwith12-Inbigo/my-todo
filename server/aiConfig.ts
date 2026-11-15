import { AI_LIMITS } from '../src/lib/aiTypes.ts';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

const DEPRECATED_MODELS = ['gemini-1.5', 'gemini-2.0', 'gemini-pro'];

export function getGeminiModelName(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  if (
    configured &&
    !DEPRECATED_MODELS.some((prefix) => configured.toLowerCase().startsWith(prefix))
  ) {
    return configured;
  }
  return DEFAULT_GEMINI_MODEL;
}

export function getAiStatusBasePayload() {
  return {
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
        'AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
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
        '등록한 개인 Gemini API 키의 일일 또는 분당 호출 한도에 도달했습니다. Google AI Studio 무료 할당량은 태평양 표준시 자정(한국시간 오후 4~5시경)에 초기화됩니다.',
    };
  }

  if (
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return {
      status: 403,
      code: 'invalid_api_key',
      message:
        '등록된 개인 Gemini API 키가 유효하지 않거나 권한이 없습니다. 설정에서 API 키를 확인·다시 등록해 주세요.',
    };
  }

  if (lower.includes('404') || lower.includes('not found') || lower.includes('model')) {
    return {
      status: 502,
      code: 'model_not_found',
      message:
        '요청한 Gemini 모델을 개인 API 키에서 사용할 수 없습니다. 키 권한과 Google AI Studio 프로젝트 상태를 확인해 주세요.',
    };
  }

  return {
    status: 502,
    code: 'ai_upstream_error',
    message:
      'AI 응답을 처리하는 중 일시적인 오류가 발생했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
  };
}
