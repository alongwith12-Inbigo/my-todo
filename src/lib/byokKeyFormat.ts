import type { GeminiApiKeyType } from './aiTypes';

export const GEMINI_API_KEY_MIN_LEN = 20;
export const GEMINI_API_KEY_MAX_LEN = 380;

const EDGE_STRIP_PATTERN =
  /^[\s\p{Cc}\p{Cf}\p{Z}\u034F\u115F\u1160\u180E\u3164\uFFA0\u2800]+|[\s\p{Cc}\p{Cf}\p{Z}\u034F\u115F\u1160\u180E\u3164\uFFA0\u2800]+$/gu;

// Supports both Standard API Keys (AIza...) and Google AI Studio Authorization API Keys (AQ....)
// which use '.' as segment delimiters while rejecting leading/trailing or consecutive dots.
const VALID_GEMINI_KEY_CHARS_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const ANY_WHITESPACE_RE = /[\s\p{Z}]/u;
const ANY_INVISIBLE_OR_CONTROL_RE =
  /[\p{Cc}\p{Cf}\u034F\u115F\u1160\u180E\u3164\uFFA0\u2800]/u;
const MASKED_PLACEHOLDER_RE = /[\u2022\u25CF\u25E6*\u2026]|\.{2,}/;
const NON_ASCII_RE = /[^\x20-\x7E]/;

export type GeminiKeyFormatReason =
  | 'non_string_key'
  | 'empty_key'
  | 'masked_placeholder'
  | 'internal_whitespace'
  | 'internal_invisible_chars'
  | 'non_ascii_chars'
  | 'invalid_dot_placement'
  | 'invalid_special_chars'
  | 'invalid_length';

/**
 * Strips leading/trailing spaces, line breaks, control characters, BOM,
 * and Unicode format/zero-width invisible characters while preserving internal
 * characters so genuine internal whitespace or invalid characters are caught.
 */
export function normalizeGeminiApiKeyInput(raw: string): string {
  return raw.replace(EDGE_STRIP_PATTERN, '');
}

export function detectGeminiApiKeyType(apiKey: string): GeminiApiKeyType {
  const cleaned = normalizeGeminiApiKeyInput(apiKey);
  if (cleaned.startsWith('AQ.')) return 'auth_aq';
  if (cleaned.startsWith('AIza')) return 'standard_aiza';
  return 'generic';
}

export interface GeminiKeyValidationResult {
  valid: boolean;
  apiKey?: string;
  keyType?: GeminiApiKeyType;
  reasonCode?: GeminiKeyFormatReason;
  category?: 'input_format';
  message?: string;
}

export function validateGeminiApiKeyFormat(
  raw: unknown,
): GeminiKeyValidationResult {
  if (typeof raw !== 'string') {
    return {
      valid: false,
      reasonCode: 'non_string_key',
      category: 'input_format',
      message: 'API 키 문자열을 입력해 주세요.',
    };
  }

  const cleaned = normalizeGeminiApiKeyInput(raw);
  if (!cleaned) {
    return {
      valid: false,
      reasonCode: 'empty_key',
      category: 'input_format',
      message: 'Gemini API 키를 입력해 주세요.',
    };
  }

  if (!VALID_GEMINI_KEY_CHARS_RE.test(cleaned)) {
    if (MASKED_PLACEHOLDER_RE.test(cleaned)) {
      return {
        valid: false,
        reasonCode: 'masked_placeholder',
        category: 'input_format',
        message:
          '가려진 API 키 기호(•, *, …)가 포함되어 있습니다. Google AI Studio에서 마스킹되지 않은 전체 API 키를 복사해 주세요.',
      };
    }

    if (ANY_WHITESPACE_RE.test(cleaned)) {
      return {
        valid: false,
        reasonCode: 'internal_whitespace',
        category: 'input_format',
        message:
          'API 키 중간에 공백이나 줄바꿈이 포함되어 있습니다. 키가 두 줄로 나뉘거나 공백이 섞이지 않았는지 확인해 주세요.',
      };
    }

    if (ANY_INVISIBLE_OR_CONTROL_RE.test(cleaned)) {
      return {
        valid: false,
        reasonCode: 'internal_invisible_chars',
        category: 'input_format',
        message:
          'API 키 내부에 보이지 않는 제어 문자 또는 유니코드 서식 문자가 포함되어 있습니다. "API 키 보기" 아이콘으로 확인하거나 지우기 후 다시 입력해 주세요.',
      };
    }

    if (NON_ASCII_RE.test(cleaned)) {
      return {
        valid: false,
        reasonCode: 'non_ascii_chars',
        category: 'input_format',
        message:
          'API 키에 한글이나 전각 문자 등 영문 외 문자가 포함되어 있습니다. 한/영 입력 상태를 확인해 주세요.',
      };
    }

    if (cleaned.startsWith('.') || cleaned.endsWith('.')) {
      return {
        valid: false,
        reasonCode: 'invalid_dot_placement',
        category: 'input_format',
        message:
          'API 키의 맨 앞이나 맨 뒤에 마침표(.)가 잘못 포함되어 있습니다. Google AI Studio에서 복사한 전체 키(AQ.... 또는 AIza...)인지 확인해 주세요.',
      };
    }

    return {
      valid: false,
      reasonCode: 'invalid_special_chars',
      category: 'input_format',
      message:
        'API 키에 허용되지 않는 특수문자가 포함되어 있습니다. 영문·숫자·하이픈(-)·밑줄(_)·마침표(.) 외의 따옴표나 기호가 함께 복사되지 않았는지 확인해 주세요.',
    };
  }

  if (
    cleaned.length < GEMINI_API_KEY_MIN_LEN ||
    cleaned.length > GEMINI_API_KEY_MAX_LEN
  ) {
    return {
      valid: false,
      reasonCode: 'invalid_length',
      category: 'input_format',
      message:
        'Gemini API 키 길이가 올바르지 않습니다 (20~380자). Google AI Studio에서 발급한 전체 키인지 확인해 주세요.',
    };
  }

  return {
    valid: true,
    apiKey: cleaned,
    keyType: detectGeminiApiKeyType(cleaned),
  };
}
