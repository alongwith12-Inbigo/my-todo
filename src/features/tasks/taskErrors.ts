import { formatFirebaseErrorMessage } from '../auth/AuthContext';
import {
  TaskConcurrencyError,
  TaskValidationError,
} from '../../repositories/taskRepo';

export function formatTaskErrorMessage(error: unknown): string {
  if (error instanceof TaskConcurrencyError) {
    return error.message;
  }
  if (error instanceof TaskValidationError) {
    return error.message;
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const raw = error instanceof Error ? error.message : String(error);

  if (
    code === 'unavailable' ||
    raw.includes('the client is offline') ||
    raw.includes('Failed to get document because the client is offline') ||
    raw.includes('network')
  ) {
    return '네트워크 연결이 불안정하거나 오프라인 상태입니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  }

  if (code === 'not-found' || raw.includes('No document to update')) {
    return '대상 업무가 이미 삭제되었거나 찾을 수 없습니다. 목록을 새로고침해 주세요.';
  }

  return formatFirebaseErrorMessage(error);
}
