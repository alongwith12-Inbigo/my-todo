export const KST_TIMEZONE = 'Asia/Seoul';

const kstDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

const kstDateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatKstTodayHeader(date: Date = new Date()): string {
  return kstDateFormatter.format(date);
}

export function formatKstDateTime(date: Date | null | undefined): string {
  if (!date) return '-';
  return kstDateTimeFormatter.format(date);
}

export function sanitizeSingleLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function sanitizeMultiline(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function isValidFirestoreId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}
