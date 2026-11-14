import {
  getKstDateInputValue,
  isValidDateInputString,
  sanitizeMultiline,
  sanitizeSingleLine,
} from './dateKst.ts';
import {
  recomputeDuplicateWarnings,
  type ImportCandidate,
} from './importParser.ts';
import { parseKoreanDateTimeExpression } from './koreanDateParser.ts';
import {
  AI_LIMITS,
  type AiBriefingResult,
  type AiRawExtractedCandidate,
  type AiRawNoticeOutput,
} from './aiTypes.ts';
import {
  VALIDATION_LIMITS,
  type CalendarEventRecord,
  type TaskPriority,
  type TaskRecord,
} from '../types/domain.ts';

const ALLOWED_PRIORITIES: ReadonlySet<TaskPriority> = new Set([
  'low',
  'normal',
  'high',
  'urgent',
]);

function isValidTimeStr(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function addOneHour(timeStr: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!match) return '10:00';
  const total = Math.min(23 * 60 + 59, Number(match[1]) * 60 + Number(match[2]) + 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function normalizePriority(value: unknown): TaskPriority {
  if (typeof value === 'string' && ALLOWED_PRIORITIES.has(value as TaskPriority)) {
    return value as TaskPriority;
  }
  return 'normal';
}

function isYearOmissionOnlyReason(reason: string): boolean {
  return /연도.*생략|연도.*없|연도.*명시/.test(reason);
}

/**
 * Cross-validates an AI-supplied date against Asia/Seoul + Step 4 koreanDateParser rules:
 * - If dateEvidence has a month/day without year, enforce Step 4 rule (today/future -> this year, past -> next year)
 * - Never treat year omission alone as needing confirmation
 * - Flag confirmation only for genuinely missing or ambiguous date/time expressions
 */
function crossValidateDateWithKoreanRules(
  aiDateStr: string | null | undefined,
  dateEvidence: string | null | undefined,
  now: Date,
): {
  resolvedDateKey: string | null;
  matchedHint: string | null;
  extraReasons: string[];
  parsedStartTime: string | null;
  parsedEndTime: string | null;
} {
  const cleanAiDate =
    typeof aiDateStr === 'string' && isValidDateInputString(aiDateStr.trim())
      ? aiDateStr.trim()
      : null;

  const evidence = typeof dateEvidence === 'string' ? dateEvidence.trim() : '';
  if (!evidence) {
    return {
      resolvedDateKey: cleanAiDate,
      matchedHint: cleanAiDate,
      extraReasons: [],
      parsedStartTime: null,
      parsedEndTime: null,
    };
  }

  const parsed = parseKoreanDateTimeExpression(evidence, now);
  const extraReasons = parsed.confirmationReasons.filter(
    (reason) => !isYearOmissionOnlyReason(reason),
  );

  // When koreanDateParser deterministically resolves the date expression (including yearless rollover),
  // prefer its Asia/Seoul calculation over LLM guesses on year rollover.
  const resolvedDateKey = parsed.dateKey ?? cleanAiDate;

  return {
    resolvedDateKey,
    matchedHint: parsed.matchedText || evidence,
    extraReasons,
    parsedStartTime: parsed.startTime,
    parsedEndTime: parsed.endTime,
  };
}

export function normalizeAiNoticeCandidates(
  rawOutput: AiRawNoticeOutput,
  options: {
    now?: Date;
    existingTasks?: TaskRecord[];
    existingEvents?: CalendarEventRecord[];
  } = {},
): {
  candidates: ImportCandidate[];
  unparsedLines: string[];
} {
  const now = options.now ?? new Date();
  const todayKey = getKstDateInputValue(now);
  const existingTasks = options.existingTasks ?? [];
  const existingEvents = options.existingEvents ?? [];

  const rawList = Array.isArray(rawOutput?.candidates)
    ? rawOutput.candidates.slice(0, AI_LIMITS.MAX_CANDIDATES)
    : [];

  const existingById = new Map<string, string>();
  for (const t of existingTasks) {
    if (!t.isDeleted) existingById.set(t.id, `기존 업무("${t.title}")`);
  }
  for (const e of existingEvents) {
    existingById.set(e.id, `기존 일정("${e.title}")`);
  }

  const normalized: ImportCandidate[] = [];

  rawList.forEach((raw: AiRawExtractedCandidate, idx: number) => {
    if (!raw || typeof raw !== 'object') return;
    const title = sanitizeSingleLine(
      typeof raw.title === 'string' ? raw.title : '',
      VALIDATION_LIMITS.TITLE_MAX_LEN,
    );
    if (!title) return;

    const kind = raw.kind === 'event' ? 'event' : 'task';
    const description = sanitizeMultiline(
      typeof raw.description === 'string' ? raw.description : '',
      VALIDATION_LIMITS.DESCRIPTION_MAX_LEN,
    );
    const location = sanitizeSingleLine(
      typeof raw.location === 'string' ? raw.location : '',
      VALIDATION_LIMITS.LOCATION_MAX_LEN,
    );
    const priority = normalizePriority(raw.priority);

    const primaryAiDate =
      kind === 'task' ? raw.dueDate : raw.eventStartDate || raw.dueDate;
    const dateCheck = crossValidateDateWithKoreanRules(
      primaryAiDate,
      raw.dateEvidence,
      now,
    );

    const reasons: string[] = [...dateCheck.extraReasons];
    if (
      raw.dateUncertain &&
      typeof raw.uncertaintyReason === 'string' &&
      raw.uncertaintyReason.trim() &&
      !isYearOmissionOnlyReason(raw.uncertaintyReason)
    ) {
      reasons.push(sanitizeSingleLine(raw.uncertaintyReason, 160));
    }

    if (kind === 'event' && !dateCheck.resolvedDateKey) {
      reasons.push('일정 날짜가 명확하지 않아 시작 날짜를 직접 확인해 주세요.');
    }

    const startTimeStr = isValidTimeStr(raw.startTime)
      ? raw.startTime.trim()
      : dateCheck.parsedStartTime || '09:00';
    let endTimeStr = isValidTimeStr(raw.endTime)
      ? raw.endTime.trim()
      : dateCheck.parsedEndTime || addOneHour(startTimeStr);

    if (endTimeStr <= startTimeStr) {
      endTimeStr = addOneHour(startTimeStr);
    }

    const hasExplicitTime =
      isValidTimeStr(raw.startTime) || Boolean(dateCheck.parsedStartTime);
    const allDay =
      kind === 'event'
        ? typeof raw.allDay === 'boolean'
          ? raw.allDay
          : !hasExplicitTime
        : false;

    const eventStart = dateCheck.resolvedDateKey || todayKey;
    const cleanEnd =
      typeof raw.eventEndDate === 'string' &&
      isValidDateInputString(raw.eventEndDate.trim()) &&
      raw.eventEndDate.trim() >= eventStart
        ? raw.eventEndDate.trim()
        : eventStart;

    const aiRationale =
      typeof raw.rationale === 'string' && raw.rationale.trim()
        ? sanitizeSingleLine(raw.rationale, 200)
        : undefined;

    let semanticDuplicateNote: string | undefined;
    const extraDupWarnings: string[] = [];
    if (
      typeof raw.semanticDuplicateId === 'string' &&
      raw.semanticDuplicateId.trim()
    ) {
      const matchedLabel = existingById.get(raw.semanticDuplicateId.trim());
      const dupReason =
        typeof raw.semanticDuplicateReason === 'string' &&
        raw.semanticDuplicateReason.trim()
          ? sanitizeSingleLine(raw.semanticDuplicateReason, 140)
          : '유사한 의미의 기존 항목이 있습니다.';
      if (matchedLabel) {
        semanticDuplicateNote = `${matchedLabel}와 유사: ${dupReason}`;
        extraDupWarnings.push(`AI 의미 유사 경고 — ${semanticDuplicateNote}`);
      }
    }

    const uniqueReasons = Array.from(new Set(reasons.filter(Boolean)));

    normalized.push({
      id: `ai-cand-${idx + 1}`,
      selected: true,
      kind,
      title,
      description,
      dueDateStr: kind === 'task' ? dateCheck.resolvedDateKey ?? '' : '',
      priority,
      eventDateStr: eventStart,
      eventEndDateStr: cleanEnd,
      allDay,
      startTimeStr,
      endTimeStr,
      location,
      rawSnippet:
        typeof raw.dateEvidence === 'string' && raw.dateEvidence.trim()
          ? raw.dateEvidence.trim()
          : title,
      matchedDateHint: dateCheck.matchedHint,
      needsConfirmation: uniqueReasons.length > 0,
      confirmationReasons: uniqueReasons,
      duplicateWarnings: extraDupWarnings,
      origin: 'ai',
      aiRationale,
      semanticDuplicateNote,
    });
  });

  const withRuleDuplicates = recomputeDuplicateWarnings(
    normalized,
    existingTasks,
    existingEvents,
  ).map((cand, idx) => {
    const aiExtra = normalized[idx]?.duplicateWarnings ?? [];
    const mergedWarnings = Array.from(
      new Set([...cand.duplicateWarnings, ...aiExtra]),
    );
    return {
      ...cand,
      duplicateWarnings: mergedWarnings,
    };
  });

  const unparsedLines = Array.isArray(rawOutput?.unparsedSummary)
    ? rawOutput.unparsedSummary
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 10)
        .map((line) => sanitizeSingleLine(line, 200))
    : [];

  return {
    candidates: withRuleDuplicates,
    unparsedLines,
  };
}

export function normalizeAiBriefingResult(
  raw: unknown,
  validTaskIds: ReadonlySet<string>,
): AiBriefingResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? sanitizeMultiline(obj.summary, 400)
      : '오늘의 주요 업무와 일정을 정리했습니다.';

  const normalizeFocus = (items: unknown) => {
    if (!Array.isArray(items)) return [];
    return items
      .slice(0, 5)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const rec = entry as Record<string, unknown>;
        const title = sanitizeSingleLine(
          typeof rec.title === 'string' ? rec.title : '',
          120,
        );
        const reason = sanitizeSingleLine(
          typeof rec.reason === 'string' ? rec.reason : '',
          200,
        );
        if (!title) return null;
        const rawId =
          typeof rec.linkedTaskId === 'string' ? rec.linkedTaskId.trim() : '';
        const linkedTaskId = rawId && validTaskIds.has(rawId) ? rawId : null;
        return { title, reason: reason || '우선 확인 권장', linkedTaskId };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  };

  const normalizeAlerts = (items: unknown) => {
    if (!Array.isArray(items)) return [];
    return items
      .slice(0, 5)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const rec = entry as Record<string, unknown>;
        const title = sanitizeSingleLine(
          typeof rec.title === 'string' ? rec.title : '',
          120,
        );
        const detail = sanitizeSingleLine(
          typeof rec.detail === 'string' ? rec.detail : '',
          220,
        );
        if (!title) return null;
        return { title, detail: detail || '세부 내용을 확인해 주세요.' };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  };

  return {
    summary,
    priorityFocus: normalizeFocus(obj.priorityFocus),
    imminentAlerts: normalizeAlerts(obj.imminentAlerts),
    conflictAlerts: normalizeAlerts(obj.conflictAlerts),
    missedChecks: normalizeAlerts(obj.missedChecks),
  };
}
