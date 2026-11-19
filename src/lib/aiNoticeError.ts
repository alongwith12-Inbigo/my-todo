import type { AiErrorCategory, AiPlannerErrorDetail } from './aiTypes';

export type NoticeAiErrorCategory =
  | 'auth'
  | 'model_unsupported'
  | 'quota'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'setting_or_input';

export interface NoticeAiClientErrorLike {
  name?: string;
  message: string;
  status?: number;
  code?: string;
  category?: AiErrorCategory;
  errorDetail?: AiPlannerErrorDetail;
}

export interface ClassifiedNoticeAiError {
  category: NoticeAiErrorCategory;
  categoryLabel: string;
  message: string;
  guidance: string;
  errorCode?: string;
  httpStatus?: number;
  errorDetail?: AiPlannerErrorDetail;
}

const SENSITIVE_KEY_PATTERNS = [
  /AIza[0-9A-Za-z_-]{10,}/g,
  /AQ\.[0-9A-Za-z_-]{10,}/g,
  /Bearer\s+[0-9A-Za-z._-]+/gi,
  /(x-goog-api-key\s*[:=]\s*)[^\s,;]+/gi,
  /([?&]key=)[^&\s]+/gi,
];

export function sanitizeClientDiagnosticText(text: string): string {
  let sanitized = text;
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    sanitized = sanitized.replace(pattern, (...args) => {
      const prefix = typeof args[1] === 'string' && args.length > 3 ? args[1] : '';
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return sanitized.trim().slice(0, 260);
}

function sanitizeErrorDetail(
  detail: AiPlannerErrorDetail | undefined,
): AiPlannerErrorDetail | undefined {
  if (!detail) return undefined;
  return {
    ...detail,
    ...(detail.upstreamErrorMessage
      ? { upstreamErrorMessage: sanitizeClientDiagnosticText(detail.upstreamErrorMessage) }
      : {}),
  };
}

export function getNoticeAiErrorCategoryLabel(
  category: NoticeAiErrorCategory,
): string {
  switch (category) {
    case 'auth':
      return '인증 오류';
    case 'model_unsupported':
      return '모델 미지원·권한·형식 오류';
    case 'quota':
      return '사용량 제한';
    case 'server_error':
      return '서버 내부 오류';
    case 'timeout':
      return '시간 초과';
    case 'network':
      return '네트워크 오류';
    case 'setting_or_input':
    default:
      return '설정·입력 확인';
  }
}

function isNoticeClientErrorLike(err: unknown): err is NoticeAiClientErrorLike {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as Partial<NoticeAiClientErrorLike>;
  return (
    typeof candidate.message === 'string' &&
    (candidate.name === 'AiClientError' ||
      typeof candidate.code === 'string' ||
      typeof candidate.status === 'number' ||
      candidate.errorDetail !== undefined)
  );
}

export function classifyNoticeAiError(err: unknown): ClassifiedNoticeAiError {
  if (!isNoticeClientErrorLike(err)) {
    const rawMsg =
      err instanceof Error
        ? sanitizeClientDiagnosticText(err.message)
        : 'AI 분석에 실패했습니다. 아래 버튼으로 기본 분석을 이용해 주세요.';
    return {
      category: 'server_error',
      categoryLabel: getNoticeAiErrorCategoryLabel('server_error'),
      message: rawMsg || 'AI 분석에 실패했습니다. 아래 버튼으로 기본 분석을 이용해 주세요.',
      guidance: '잠시 후 다시 시도하거나 아래 「대신 기본 분석 실행」을 이용해 주세요.',
    };
  }

  const code = err.code ?? '';
  const diag = err.errorDetail?.diagnosticCategory;
  const errorDetail = sanitizeErrorDetail(err.errorDetail);
  const message = sanitizeClientDiagnosticText(err.message);

  // 1. Auth errors (Firebase session/approval, personal key missing, Gemini key auth)
  if (
    diag === 'auth_failed' ||
    diag === 'auth_header_error' ||
    code === 'invalid_api_key' ||
    code === 'api_key_permission_denied' ||
    code === 'gemini_auth_header_error' ||
    code === 'personal_key_required' ||
    code === 'unauthenticated' ||
    code === 'auth_header_missing' ||
    code === 'invalid_auth_token' ||
    code === 'account_not_active' ||
    code === 'auth_not_configured' ||
    err.category === 'auth' ||
    err.status === 401
  ) {
    const isPersonalKeyMissing = code === 'personal_key_required';
    return {
      category: 'auth',
      categoryLabel: getNoticeAiErrorCategoryLabel('auth'),
      message,
      guidance: isPersonalKeyMissing
        ? '[설정 > AI 스마트 업무비서]에서 본인의 Gemini API 키를 등록하거나, 아래 「대신 기본 분석 실행」을 이용해 주세요.'
        : '개인 Gemini API 키 유효성 또는 Google 로그인 상태를 확인한 뒤 다시 시도해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 2. Quota / Rate limit errors
  if (
    diag === 'quota_exceeded' ||
    code === 'ai_quota_exceeded' ||
    code === 'rate_limit_exceeded' ||
    code === 'daily_total_quota_exceeded' ||
    code === 'daily_plan_quota_exceeded' ||
    code === 'concurrent_ai_request' ||
    err.status === 429
  ) {
    const isAppDailyLimit =
      code === 'daily_total_quota_exceeded' || code === 'daily_plan_quota_exceeded';
    return {
      category: 'quota',
      categoryLabel: getNoticeAiErrorCategoryLabel('quota'),
      message,
      guidance: isAppDailyLimit
        ? '설정에서 일일 AI 호출 한도를 조정하거나, 오늘은 추가 호출 없이 「대신 기본 분석 실행」을 이용해 주세요.'
        : '잠시 기다렸다가 다시 시도하거나 「대신 기본 분석 실행」을 이용해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 3. Model unsupported / permission denied / invalid request format
  if (
    diag === 'model_not_supported' ||
    diag === 'model_generate_unsupported' ||
    diag === 'model_permission_denied' ||
    diag === 'invalid_request_format' ||
    code === 'model_not_found' ||
    code === 'model_generate_unsupported' ||
    code === 'model_permission_denied' ||
    code === 'invalid_model_name' ||
    code === 'invalid_request_format'
  ) {
    return {
      category: 'model_unsupported',
      categoryLabel: getNoticeAiErrorCategoryLabel('model_unsupported'),
      message,
      guidance:
        '업무·일정 등록 AI 분석이 사용 중인 서버 기본 모델(GEMINI_MODEL) 이름, API 버전(v1/v1beta), 또는 요청 옵션 호환성을 확인해야 합니다. 지금 바로 처리하려면 「대신 기본 분석 실행」을 이용해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 4. Timeout errors
  if (diag === 'timeout' || code === 'ai_timeout' || err.status === 504) {
    const isLocal = errorDetail?.timeoutSource === 'local';
    return {
      category: 'timeout',
      categoryLabel: getNoticeAiErrorCategoryLabel('timeout'),
      message,
      guidance: isLocal
        ? '앱 서버 제한 시간(25초) 내에 Google API 응답이 도착하지 않았습니다. 공지 길이를 줄여 다시 시도하거나 「대신 기본 분석 실행」을 이용해 주세요.'
        : 'Google API 응답 시간이 초과되었습니다. 잠시 후 다시 시도하거나 「대신 기본 분석 실행」을 이용해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 5. Network errors
  if (
    diag === 'network' ||
    code === 'network_error' ||
    code === 'upstream_network_error' ||
    err.category === 'network'
  ) {
    return {
      category: 'network',
      categoryLabel: getNoticeAiErrorCategoryLabel('network'),
      message,
      guidance:
        '인터넷 연결 또는 AI API 통신 상태를 확인한 뒤 다시 시도하거나 「대신 기본 분석 실행」을 이용해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 6. Cancelled or input/setting validation errors
  if (
    diag === 'aborted' ||
    code === 'ai_aborted' ||
    code === 'ai_disabled_by_user' ||
    code === 'empty_input' ||
    code === 'input_too_long' ||
    code === 'invalid_request_body'
  ) {
    return {
      category: 'setting_or_input',
      categoryLabel: getNoticeAiErrorCategoryLabel('setting_or_input'),
      message,
      guidance: '입력 내용이나 AI 사용 설정을 확인해 주세요.',
      errorCode: code || undefined,
      httpStatus: err.status,
      errorDetail,
    };
  }

  // 7. Server internal errors (Google upstream 5xx, server vault/config, malformed/truncated JSON)
  return {
    category: 'server_error',
    categoryLabel: getNoticeAiErrorCategoryLabel('server_error'),
    message,
    guidance:
      code === 'encryption_secret_missing' ||
      code === 'firebase_config_missing' ||
      code === 'vault_persistence_failed'
        ? '서버 환경 설정 또는 보관소 문제로 요청을 완료하지 못했습니다. 아래 「대신 기본 분석 실행」으로 바로 등록할 수 있습니다.'
        : 'Google Gemini 서버 일시 장애 또는 모델 내부 오류입니다. 잠시 후 다시 시도하거나 아래 「대신 기본 분석 실행」을 이용해 주세요.',
    errorCode: code || undefined,
    httpStatus: err.status,
    errorDetail,
  };
}
