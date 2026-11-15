export const GEMINI_API_KEY_MIN_LEN = 20;
export const GEMINI_API_KEY_MAX_LEN = 256;

const EDGE_STRIP_PATTERN =
  /^[\s\u0000-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+|[\s\u0000-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+$/g;

const VALID_GEMINI_KEY_CHARS_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Strips leading/trailing spaces, line breaks, control characters, BOM,
 * and zero-width invisible characters while preserving internal characters
 * so genuine internal whitespace or invalid characters are still caught.
 */
export function normalizeGeminiApiKeyInput(raw: string): string {
  return raw.replace(EDGE_STRIP_PATTERN, '');
}

export interface GeminiKeyValidationResult {
  valid: boolean;
  apiKey?: string;
  message?: string;
}

export function validateGeminiApiKeyFormat(
  raw: unknown,
): GeminiKeyValidationResult {
  if (typeof raw !== 'string') {
    return { valid: false, message: 'API 키 문자열을 입력해 주세요.' };
  }

  const cleaned = normalizeGeminiApiKeyInput(raw);
  if (!cleaned) {
    return { valid: false, message: 'Gemini API 키를 입력해 주세요.' };
  }

  if (!VALID_GEMINI_KEY_CHARS_RE.test(cleaned)) {
    return {
      valid: false,
      message: 'API 키에 허용되지 않는 공백이나 특수문자가 포함되어 있습니다.',
    };
  }

  if (
    cleaned.length < GEMINI_API_KEY_MIN_LEN ||
    cleaned.length > GEMINI_API_KEY_MAX_LEN
  ) {
    return {
      valid: false,
      message:
        '올바른 Gemini API 키 길이가 아닙니다. Google AI Studio에서 발급한 키를 확인해 주세요.',
    };
  }

  return { valid: true, apiKey: cleaned };
}
