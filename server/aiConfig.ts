import {
  AI_LIMITS,
  type GeminiDiagnosticErrorCategory,
} from '../src/lib/aiTypes.ts';

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

export interface MappedGeminiError {
  status: number;
  code: string;
  diagnosticCategory: GeminiDiagnosticErrorCategory;
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  message: string;
}

interface ParsedUpstreamErrorInfo {
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  reasons: string[];
  textLower: string;
}

export function sanitizeUpstreamErrorMessage(raw: string): string | undefined {
  const cleaned = raw
    .replace(/\bAIza[0-9A-Za-z_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bAQ\.[0-9A-Za-z._-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[0-9A-Za-z._-]+\b/gi, 'Bearer [REDACTED]')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

function parseUpstreamGeminiError(error: unknown): ParsedUpstreamErrorInfo {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let upstreamHttpStatus =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;

  let upstreamApiStatus: string | undefined;
  let apiMessage = rawMessage;
  const reasons: string[] = [];

  const trimmed = rawMessage.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
        error?: {
          code?: unknown;
          status?: unknown;
          message?: unknown;
          details?: Array<{ reason?: unknown }>;
        };
      };
      if (parsed?.error) {
        if (
          upstreamHttpStatus === undefined &&
          typeof parsed.error.code === 'number'
        ) {
          upstreamHttpStatus = parsed.error.code;
        }
        if (typeof parsed.error.status === 'string') {
          upstreamApiStatus = parsed.error.status;
        }
        if (typeof parsed.error.message === 'string') {
          apiMessage = parsed.error.message;
        }
        if (Array.isArray(parsed.error.details)) {
          for (const d of parsed.error.details) {
            if (d && typeof d.reason === 'string') {
              reasons.push(d.reason);
            }
          }
        }
      }
    } catch {
      // Non-JSON error message; fall back to plain text inspection
    }
  }

  return {
    upstreamHttpStatus,
    upstreamApiStatus,
    upstreamErrorMessage: sanitizeUpstreamErrorMessage(apiMessage),
    reasons,
    textLower: `${rawMessage} ${apiMessage} ${reasons.join(' ')} ${upstreamApiStatus ?? ''}`.toLowerCase(),
  };
}

export function mapGeminiError(
  error: unknown,
  requestedModel?: string,
): MappedGeminiError {
  const modelName = requestedModel || getGeminiModelName();
  const parsed = parseUpstreamGeminiError(error);
  const lower = parsed.textLower;
  const httpStatus = parsed.upstreamHttpStatus;
  const apiStatus = parsed.upstreamApiStatus?.toUpperCase();

  if (lower.includes('aborted') || lower.includes('abort')) {
    return {
      status: 499,
      code: 'ai_aborted',
      diagnosticCategory: 'aborted',
      upstreamHttpStatus: httpStatus,
      upstreamApiStatus: apiStatus,
      message: 'AI 분석 요청이 취소되었습니다.',
    };
  }

  if (
    httpStatus === 504 ||
    apiStatus === 'DEADLINE_EXCEEDED' ||
    lower.includes('deadline_exceeded') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return {
      status: 504,
      code: 'ai_timeout',
      diagnosticCategory: 'timeout',
      upstreamHttpStatus: httpStatus,
      upstreamApiStatus: apiStatus,
      message:
        'AI 서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
    };
  }

  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return {
      status: 502,
      code: 'upstream_network_error',
      diagnosticCategory: 'network',
      upstreamHttpStatus: httpStatus,
      upstreamApiStatus: apiStatus,
      message:
        '서버에서 Google Gemini API 서버로의 네트워크 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  if (
    lower.includes('access_token_type_unsupported') ||
    lower.includes('multiple authentication credentials') ||
    lower.includes('bearer token')
  ) {
    return {
      status: 401,
      code: 'gemini_auth_header_error',
      diagnosticCategory: 'auth_header_error',
      upstreamHttpStatus: httpStatus ?? 401,
      upstreamApiStatus: apiStatus,
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message:
        'Gemini API 인증 헤더 방식이 호환되지 않습니다. AQ. 인증 키와 AIza 키 모두 Bearer 토큰이 아닌 x-goog-api-key 헤더로 전송되어야 합니다.',
    };
  }

  if (
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key expired') ||
    lower.includes('api_key_expired')
  ) {
    return {
      status: 403,
      code: 'invalid_api_key',
      diagnosticCategory: 'auth_failed',
      upstreamHttpStatus: httpStatus ?? 400,
      upstreamApiStatus: apiStatus,
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message:
        'Google Gemini API가 해당 키를 유효하지 않다고 응답했습니다. Google AI Studio에서 키가 삭제·만료되지 않았는지 확인해 주세요.',
    };
  }

  if (
    httpStatus === 429 ||
    apiStatus === 'RESOURCE_EXHAUSTED' ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      status: 429,
      code: 'ai_quota_exceeded',
      diagnosticCategory: 'quota_exceeded',
      upstreamHttpStatus: httpStatus ?? 429,
      upstreamApiStatus: apiStatus ?? 'RESOURCE_EXHAUSTED',
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message:
        '등록한 개인 Gemini API 키의 일일 또는 분당 호출 한도에 도달했습니다. Google AI Studio 무료 할당량은 태평양 표준시 자정(한국시간 오후 4~5시경)에 초기화됩니다.',
    };
  }

  if (httpStatus === 401 || apiStatus === 'UNAUTHENTICATED' || lower.includes('unauthenticated')) {
    return {
      status: 401,
      code: 'api_key_permission_denied',
      diagnosticCategory: 'auth_failed',
      upstreamHttpStatus: httpStatus ?? 401,
      upstreamApiStatus: apiStatus ?? 'UNAUTHENTICATED',
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message:
        'Gemini API 인증에 실패했습니다. 개인 API 키가 유효한지 또는 Generative Language API 사용 권한이 있는지 확인해 주세요.',
    };
  }

  if (
    httpStatus === 403 ||
    apiStatus === 'PERMISSION_DENIED' ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied')
  ) {
    return {
      status: 403,
      code: 'model_permission_denied',
      diagnosticCategory: 'model_permission_denied',
      upstreamHttpStatus: httpStatus ?? 403,
      upstreamApiStatus: apiStatus ?? 'PERMISSION_DENIED',
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message: `API 키 또는 Google Cloud 프로젝트에서 모델(${modelName}) 호출 권한이 거부되었습니다. Generative Language API 활성화 여부, 결제 등급(무료/유료 모델), IP/리퍼러 제한을 확인해 주세요.`,
    };
  }

  const isExplicitNotFound =
    httpStatus === 404 ||
    apiStatus === 'NOT_FOUND' ||
    lower.includes('is not found') ||
    lower.includes('not_found') ||
    lower.includes('no longer available') ||
    lower.includes('deprecated') ||
    lower.includes('retired');

  if (
    !isExplicitNotFound &&
    (lower.includes('not supported for generatecontent') ||
      lower.includes('does not support generatecontent'))
  ) {
    return {
      status: 502,
      code: 'model_generate_unsupported',
      diagnosticCategory: 'model_generate_unsupported',
      upstreamHttpStatus: httpStatus ?? 400,
      upstreamApiStatus: apiStatus,
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message: `선택된 모델(${modelName})이 텍스트 생성(generateContent) 메서드를 지원하지 않습니다.`,
    };
  }

  if (
    httpStatus === 400 ||
    apiStatus === 'INVALID_ARGUMENT' ||
    lower.includes('invalid_argument') ||
    lower.includes('invalid argument')
  ) {
    const isThinkingHint = lower.includes('thinking');
    const isSchemaHint = lower.includes('schema') || lower.includes('json');
    const detail = isThinkingHint
      ? ' (해당 모델에서 thinkingConfig 옵션이 지원되지 않음)'
      : isSchemaHint
        ? ' (JSON 스키마/응답 형식 옵션 비호환)'
        : '';
    return {
      status: 400,
      code: 'invalid_request_format',
      diagnosticCategory: 'invalid_request_format',
      upstreamHttpStatus: httpStatus ?? 400,
      upstreamApiStatus: apiStatus ?? 'INVALID_ARGUMENT',
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message: `Gemini 모델(${modelName}) 요청 형식 또는 생성 옵션이 호환되지 않습니다${detail}.`,
    };
  }

  if (isExplicitNotFound || lower.includes('not found')) {
    const isNewUserRetired =
      lower.includes('no longer available to new users') ||
      lower.includes('no longer available');
    const isApiVersionMismatch = lower.includes('not found for api version');
    const currentApiVersion = process.env.GOOGLE_GENAI_API_VERSION?.trim() || 'v1';
    const specificReason = isNewUserRetired
      ? `models.list 목록에는 표시되더라도 Google이 신규 키·계정에서 모델(${modelName})의 generateContent 호출을 종료(제한)하여 HTTP 404를 반환했습니다. 목록에서 확인된 최신 모델로 GEMINI_MODEL을 변경해 주세요.`
      : isApiVersionMismatch
        ? `모델(${modelName})이 현재 API 버전(${currentApiVersion}) 엔드포인트에서 지원되지 않아 HTTP 404를 반환했습니다.`
        : `설정된 Gemini 모델(${modelName})을 현재 API 키의 계정에서 호출할 수 없거나 지원이 종료되었습니다. 사용 가능한 모델로 GEMINI_MODEL을 변경해 주세요.`;
    return {
      status: 502,
      code: 'model_not_found',
      diagnosticCategory: 'model_not_supported',
      upstreamHttpStatus: httpStatus ?? 404,
      upstreamApiStatus: apiStatus ?? 'NOT_FOUND',
      upstreamErrorMessage: parsed.upstreamErrorMessage,
      message: specificReason,
    };
  }

  return {
    status: 502,
    code: 'ai_upstream_error',
    diagnosticCategory: 'server_error',
    upstreamHttpStatus: httpStatus,
    upstreamApiStatus: apiStatus,
    upstreamErrorMessage: parsed.upstreamErrorMessage,
    message:
      'AI 응답을 처리하는 중 일시적인 오류가 발생했습니다. 잠시 후 다시 시도하거나 기본 기능을 이용해 주세요.',
  };
}
