import {
  getKstDateInputValue,
  sanitizeMultiline,
  sanitizeSingleLine,
} from './dateKst';
import { timestampToDate } from './briefing';
import { parseKoreanDateTimeExpression } from './koreanDateParser';
import {
  VALIDATION_LIMITS,
  type CalendarEventRecord,
  type TaskPriority,
  type TaskRecord,
} from '../types/domain';

export type ImportCandidateKind = 'task' | 'event';
export type ImportSourceMode = 'text' | 'ocr';

export interface ImportCandidate {
  id: string;
  selected: boolean;
  kind: ImportCandidateKind;
  title: string;
  description: string;
  // Task fields
  dueDateStr: string;
  priority: TaskPriority;
  // Event fields
  eventDateStr: string;
  eventEndDateStr: string;
  allDay: boolean;
  startTimeStr: string;
  endTimeStr: string;
  location: string;
  // Review & ambiguity metadata
  rawSnippet: string;
  matchedDateHint: string | null;
  needsConfirmation: boolean;
  confirmationReasons: string[];
  duplicateWarnings: string[];
}

export interface ParseSchoolNoticeResult {
  candidates: ImportCandidate[];
  unparsedLines: string[];
}

const TASK_VERB_REGEX =
  /(제출|회신|작성|확인|신청|취합|보고|입력|업로드|결재|점검|배부|수합|완료|검토|준비|전달)/;
const EVENT_NOUN_REGEX =
  /(회의|연수|협의회|행사|간담회|워크숍|설명회|수업\s*공개|공개\s*수업|참관|평가회|위원회|출장|상담|면담|모임|오리엔테이션|발표회|총회)/;
const URGENT_REGEX = /(긴급|즉시|필수|오늘까지|금일까지|당일)/;

const METADATA_LINE_REGEX =
  /^(일시|날짜|시간|기한|마감|장소|위치|대상|내용|안건|준비물|비고|문의)\s*[:：]/;
const ITEM_START_REGEX =
  /^(?:(?:\d{1,2}|[가-힣])[.)]\s+|\(\d{1,2}\)\s+|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[-*•○●□■▶▷※]\s*|\[[^\]]+\]\s*)/;

function stripLeadingMarker(line: string): string {
  return line.replace(ITEM_START_REGEX, '').trim();
}

function addOneHour(timeStr: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!match) return '10:00';
  const total = Math.min(23 * 60 + 59, Number(match[1]) * 60 + Number(match[2]) + 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function stripDateCuesForComparison(title: string): string {
  return title
    .replace(/\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?(?:\s*\([월화수목금토일]\))?/g, ' ')
    .replace(/\d{1,2}\s*(?:월|\/|\.)\s*\d{1,2}\s*일?(?:\s*\([월화수목금토일]\))?/g, ' ')
    .replace(/(?:오늘|내일|모레|금주|이번\s*주|차주|다음\s*주)(?:\s*[월화수목금토일](?:요일)?)?/g, ' ')
    .replace(/(?:까지|마감|기한)/g, ' ');
}

export function normalizeTitleForDuplicateCheck(title: string): string {
  return stripDateCuesForComparison(title)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\s\-_.,:;!?'"()[\]{}/~·•○□▶]/g, '')
    .trim();
}

function titlesLookSimilar(a: string, b: string): boolean {
  const na = normalizeTitleForDuplicateCheck(a);
  const nb = normalizeTitleForDuplicateCheck(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }

  // Fallback token overlap for reordered words (e.g. "3학년 교무실 학년 협의" vs "학년 협의")
  const tokensA = stripDateCuesForComparison(a)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const tokensB = stripDateCuesForComparison(b)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const setB = new Set(tokensB);
    const overlap = tokensA.filter((t) => setB.has(t)).length;
    const minLen = Math.min(tokensA.length, tokensB.length);
    if (overlap >= 2 && overlap / minLen >= 0.75) {
      return true;
    }
  }

  return false;
}

function extractLocation(blockText: string): string {
  const explicitMatch = /(?:장소|위치|실시\s*장소)\s*[:：]\s*([^\n,;]+)/.exec(blockText);
  if (explicitMatch) {
    return sanitizeSingleLine(explicitMatch[1], VALIDATION_LIMITS.LOCATION_MAX_LEN);
  }

  const parenMatch =
    /\(([^()\n]{2,30}(?:실|관|홀|강당|센터|본부|Zoom|줌|온라인|운동장|도서관|교실))\)/.exec(
      blockText,
    );
  if (parenMatch) {
    return sanitizeSingleLine(parenMatch[1], VALIDATION_LIMITS.LOCATION_MAX_LEN);
  }

  const inlineRoomMatch =
    /(?:^|[\s,])((?:본관|별관|신관|후관)?\s*(?:\d+층\s*)?[가-힣a-zA-Z0-9]{1,12}(?:대회의실|소회의실|회의실|교무실|시청각실|방송실|과학실|컴퓨터실|강당|도서관|상담실|보건실|행정실|Zoom|줌))(?=$|[\s,.)])/.exec(
      blockText,
    );
  if (inlineRoomMatch) {
    return sanitizeSingleLine(inlineRoomMatch[1], VALIDATION_LIMITS.LOCATION_MAX_LEN);
  }

  return '';
}

function cleanCandidateTitle(blockLines: string[], location: string): string {
  const rawFirst = stripLeadingMarker(blockLines[0] ?? '');
  let title = rawFirst
    .replace(/^(?:제목|안건|내용|업무|일정)\s*[:：]\s*/i, '')
    .trim();

  // If the first line was purely a bracket header like "[교직원 회의 안내]", combine with content/next line if short
  if (/^\[[^\]]+\]$/.test(title) && blockLines.length > 1) {
    const second = stripLeadingMarker(blockLines[1])
      .replace(/^(?:제목|안건|내용)\s*[:：]\s*/, '')
      .trim();
    if (second && !METADATA_LINE_REGEX.test(blockLines[1])) {
      title = `${title.replace(/^\[|\]$/g, '')} - ${second}`;
    } else {
      title = title.replace(/^\[|\]$/g, '');
    }
  }

  // Strip trailing inline metadata fragments like "(장소: 대회의실)" or ", 장소: ..."
  title = title
    .replace(/\s*[,·]\s*(?:일시|장소|기한|마감)\s*[:：].*$/, '')
    .replace(/\(\s*(?:일시|장소)\s*[:：][^)]*\)/g, '')
    .trim();

  if (location) {
    title = title.replace(new RegExp(`\\(${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g'), '').trim();
  }

  // Strip trailing date-only parenthetical when title remains informative
  const strippedDateParen = title
    .replace(/\(\s*(?:\d{4}[.\-/])?\d{1,2}[.\-/]\d{1,2}[^)]*\)\s*$/, '')
    .trim();
  if (strippedDateParen.length >= 4) {
    title = strippedDateParen;
  }

  return sanitizeSingleLine(title || rawFirst || '추출된 항목', VALIDATION_LIMITS.TITLE_MAX_LEN);
}

/**
 * Splits raw pasted or OCR text into logical school-notice item blocks,
 * keeping metadata sub-lines (`일시:`, `장소:`, `대상:`, `내용:`) attached
 * to their parent item block.
 */
export function segmentNoticeBlocks(rawText: string): string[][] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isMeta = METADATA_LINE_REGEX.test(line);
    const isNewItem = ITEM_START_REGEX.test(line);

    if (current.length === 0) {
      current.push(line);
      continue;
    }

    if (isMeta) {
      current.push(line);
      continue;
    }

    if (isNewItem) {
      blocks.push(current);
      current = [line];
      continue;
    }

    // If current block already has metadata lines or ends with sentence punctuation and this line starts a new sentence/notice, start a new block
    const prevHadMeta = current.some((l) => METADATA_LINE_REGEX.test(l));
    const prevLine = current[current.length - 1];
    const lineHasOwnSignal =
      TASK_VERB_REGEX.test(line) ||
      EVENT_NOUN_REGEX.test(line) ||
      /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*[./]\s*\d{1,2}|오늘|내일|모레|이번\s*주|다음\s*주/.test(
        line,
      );

    if (prevHadMeta && lineHasOwnSignal) {
      blocks.push(current);
      current = [line];
    } else if (
      !prevHadMeta &&
      /[.!?]$|요$|다$|함$|바람$/.test(prevLine) &&
      lineHasOwnSignal
    ) {
      blocks.push(current);
      current = [line];
    } else if (!prevHadMeta && current.length === 1 && lineHasOwnSignal) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function classifyCandidateKind(
  blockText: string,
  location: string,
  hasDeadlineCue: boolean,
  hasStartTime: boolean,
  hasExplicitScheduleLabel: boolean,
): { kind: ImportCandidateKind; ambiguousReasons: string[] } {
  let taskScore = 0;
  let eventScore = 0;
  const reasons: string[] = [];

  const hasTaskVerb = TASK_VERB_REGEX.test(blockText);
  const hasEventNoun = EVENT_NOUN_REGEX.test(blockText);

  if (hasTaskVerb) taskScore += 2;
  if (hasDeadlineCue) taskScore += 2;
  if (/(?:기한|마감)\s*[:：]/.test(blockText)) taskScore += 2;
  if (/(이수증|신청서|계획서|명단|결과서|설문|동의서|가정통신문|보고서).*(제출|회신|작성|신청|취합)/.test(blockText)) {
    taskScore += 2;
  }

  if (hasEventNoun) eventScore += 2;
  if (hasExplicitScheduleLabel) eventScore += 2;
  if (location) eventScore += 2;
  if (hasStartTime) eventScore += 2;
  if (/(참석|참여|개최|소집|진행)\s*(바랍니다|안내|예정)?/.test(blockText)) {
    eventScore += 1;
  }

  // Context override: e.g. "연수 이수증 11월 20일까지 제출" has an event noun inside a task deliverable
  if (hasTaskVerb && hasDeadlineCue && !location && !hasExplicitScheduleLabel) {
    taskScore += 2;
  }

  // Context override: e.g. "협의회 자료 확인 후 참석 (11/23 13:10 대회의실)"
  if (hasEventNoun && (location || hasStartTime) && !hasDeadlineCue) {
    eventScore += 2;
  }

  if (taskScore === 0 && eventScore === 0) {
    reasons.push('업무/일정 핵심 표현이 명확하지 않아 유형 확인이 필요합니다.');
    return { kind: 'task', ambiguousReasons: reasons };
  }

  if (Math.abs(taskScore - eventScore) <= 1 && taskScore > 0 && eventScore > 0) {
    reasons.push(
      '업무(제출·확인 등)와 일정(회의·시간·장소 등) 표현이 함께 있어 유형을 확인해 주세요.',
    );
  }

  return {
    kind: eventScore > taskScore ? 'event' : 'task',
    ambiguousReasons: reasons,
  };
}

export function recomputeDuplicateWarnings(
  candidates: ImportCandidate[],
  existingTasks: TaskRecord[] = [],
  existingEvents: CalendarEventRecord[] = [],
): ImportCandidate[] {
  return candidates.map((candidate, index) => {
    const warnings: string[] = [];
    const targetDate =
      candidate.kind === 'task' ? candidate.dueDateStr : candidate.eventDateStr;

    // 1) Duplicate within extracted candidates
    for (let j = 0; j < candidates.length; j++) {
      if (j === index) continue;
      const other = candidates[j];
      const otherDate = other.kind === 'task' ? other.dueDateStr : other.eventDateStr;
      if (
        titlesLookSimilar(candidate.title, other.title) &&
        (!targetDate || !otherDate || targetDate === otherDate)
      ) {
        warnings.push(`추출 목록 내 다른 후보("${other.title}")와 내용이 유사합니다.`);
        break;
      }
    }

    // 2) Duplicate against existing tasks
    for (const existingTask of existingTasks) {
      if (existingTask.isDeleted) continue;
      const existingDueKey = getKstDateInputValue(timestampToDate(existingTask.dueAt));
      if (
        titlesLookSimilar(candidate.title, existingTask.title) &&
        (!targetDate || !existingDueKey || targetDate === existingDueKey)
      ) {
        warnings.push(`기존 업무("${existingTask.title}")와 중복 가능성이 있습니다.`);
        break;
      }
    }

    // 3) Duplicate against existing events
    for (const existingEvent of existingEvents) {
      const existingStartKey = getKstDateInputValue(
        timestampToDate(existingEvent.startsAt),
      );
      if (
        titlesLookSimilar(candidate.title, existingEvent.title) &&
        (!targetDate || !existingStartKey || targetDate === existingStartKey)
      ) {
        warnings.push(`기존 일정("${existingEvent.title}")과 중복 가능성이 있습니다.`);
        break;
      }
    }

    return {
      ...candidate,
      duplicateWarnings: warnings,
    };
  });
}

export function parseSchoolNoticeText(
  rawText: string,
  options: {
    now?: Date;
    existingTasks?: TaskRecord[];
    existingEvents?: CalendarEventRecord[];
  } = {},
): ParseSchoolNoticeResult {
  const now = options.now ?? new Date();
  const todayKey = getKstDateInputValue(now);
  const blocks = segmentNoticeBlocks(rawText);

  const candidates: ImportCandidate[] = [];
  const unparsedLines: string[] = [];

  blocks.forEach((blockLines, idx) => {
    const blockText = blockLines.join('\n');
    const cleanText = blockLines.map(stripLeadingMarker).join(' ').trim();
    if (!cleanText || cleanText.length < 2) {
      return;
    }

    const parsedDt = parseKoreanDateTimeExpression(blockText, now);
    const location = extractLocation(blockText);
    const hasExplicitScheduleLabel = /(?:일시|시간|장소)\s*[:：]/.test(blockText);

    const { kind, ambiguousReasons } = classifyCandidateKind(
      blockText,
      location,
      parsedDt.hasDeadlineCue,
      Boolean(parsedDt.startTime),
      hasExplicitScheduleLabel,
    );

    const hasAnyMeaningfulSignal =
      TASK_VERB_REGEX.test(blockText) ||
      EVENT_NOUN_REGEX.test(blockText) ||
      Boolean(parsedDt.dateKey) ||
      Boolean(parsedDt.startTime) ||
      Boolean(location);

    if (!hasAnyMeaningfulSignal && cleanText.length < 6) {
      unparsedLines.push(cleanText);
      return;
    }

    const title = cleanCandidateTitle(blockLines, location);
    const description = sanitizeMultiline(
      blockText,
      VALIDATION_LIMITS.DESCRIPTION_MAX_LEN,
    );

    const reasons = [...parsedDt.confirmationReasons, ...ambiguousReasons];
    if (!parsedDt.dateKey) {
      reasons.push(
        kind === 'event'
          ? '일정 날짜가 추출되지 않았습니다. 날짜를 직접 지정해 주세요.'
          : '마감일 표현이 없어 마감일이 비어 있습니다. 필요하면 마감일을 지정해 주세요.',
      );
    }
    if (!hasAnyMeaningfulSignal) {
      reasons.push('업무·일정 핵심 키워드가 약해 내용을 확인해 주세요.');
    }

    const defaultEventDate = parsedDt.dateKey || todayKey;
    const isAllDay = kind === 'event' && !parsedDt.startTime && !parsedDt.periodLabel;
    const startTimeStr = parsedDt.startTime || '09:00';
    const endTimeStr = parsedDt.endTime || addOneHour(startTimeStr);

    const priority: TaskPriority = URGENT_REGEX.test(blockText) ? 'high' : 'normal';

    candidates.push({
      id: `cand-${idx + 1}`,
      selected: true,
      kind,
      title,
      description,
      dueDateStr: kind === 'task' ? parsedDt.dateKey ?? '' : '',
      priority,
      eventDateStr: defaultEventDate,
      eventEndDateStr: defaultEventDate,
      allDay: isAllDay,
      startTimeStr,
      endTimeStr,
      location,
      rawSnippet: blockText,
      matchedDateHint: parsedDt.matchedText,
      needsConfirmation: reasons.length > 0,
      confirmationReasons: reasons,
      duplicateWarnings: [],
    });
  });

  return {
    candidates: recomputeDuplicateWarnings(
      candidates,
      options.existingTasks,
      options.existingEvents,
    ),
    unparsedLines,
  };
}
