import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatKstDateTime,
  formatKstTodayHeader,
  isValidFirestoreId,
  sanitizeMultiline,
  sanitizeSingleLine,
} from '../src/lib/dateKst';

test('formatKstTodayHeader formats in Asia/Seoul timezone', () => {
  // 2026-03-01T16:00:00Z is 2026-03-02 01:00:00 KST
  const date = new Date('2026-03-01T16:00:00Z');
  const formatted = formatKstTodayHeader(date);
  assert.match(formatted, /2026/);
  assert.match(formatted, /3월/);
  assert.match(formatted, /2일/);
});

test('formatKstDateTime returns dash for null/undefined', () => {
  assert.equal(formatKstDateTime(null), '-');
  assert.equal(formatKstDateTime(undefined), '-');
});

test('sanitizeSingleLine collapses whitespace and enforces maxLength', () => {
  assert.equal(sanitizeSingleLine('  공문   접수 \n 확인  ', 20), '공문 접수 확인');
  assert.equal(sanitizeSingleLine('가나다라마바사', 4), '가나다라');
});

test('sanitizeMultiline preserves internal newlines and enforces maxLength', () => {
  assert.equal(sanitizeMultiline('  첫째 줄\n둘째 줄  ', 50), '첫째 줄\n둘째 줄');
});

test('isValidFirestoreId enforces length and character whitelist', () => {
  assert.equal(isValidFirestoreId('user_123-ABC'), true);
  assert.equal(isValidFirestoreId(''), false);
  assert.equal(isValidFirestoreId('bad/id'), false);
  assert.equal(isValidFirestoreId('bad$id'), false);
  assert.equal(isValidFirestoreId('a'.repeat(129)), false);
});
