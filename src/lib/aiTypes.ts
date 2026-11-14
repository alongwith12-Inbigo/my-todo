export const AI_LIMITS = {
  MAX_NOTICE_CHARS: 8000,
  MAX_EXISTING_CONTEXT_ITEMS: 40,
  MAX_BRIEFING_TASKS: 30,
  MAX_BRIEFING_EVENTS: 20,
  MAX_CANDIDATES: 25,
  REQUEST_TIMEOUT_MS: 25000,
  RATE_LIMIT_MAX_REQUESTS: 12,
  RATE_LIMIT_WINDOW_MS: 60_000,
} as const;

export interface AiStatusResponse {
  configured: boolean;
  model: string;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  maxNoticeChars: number;
}

export interface MinimalExistingContextItem {
  id: string;
  kind: 'task' | 'event';
  title: string;
  dateKey: string | null;
}

export interface AiAnalyzeNoticeRequest {
  text: string;
  todayKey?: string;
  existingItems?: MinimalExistingContextItem[];
}

export interface AiRawExtractedCandidate {
  kind: 'task' | 'event';
  title: string;
  description?: string;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  eventStartDate?: string | null;
  eventEndDate?: string | null;
  allDay?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  dateEvidence?: string | null;
  dateUncertain?: boolean;
  uncertaintyReason?: string | null;
  rationale?: string | null;
  semanticDuplicateId?: string | null;
  semanticDuplicateReason?: string | null;
}

export interface AiRawNoticeOutput {
  candidates: AiRawExtractedCandidate[];
  unparsedSummary?: string[];
}

export interface AiAnalyzeNoticeResponse {
  model: string;
  rawOutput: AiRawNoticeOutput;
}

export interface MinimalBriefingTask {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'on_hold';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDateKey: string | null;
  remindDateKey: string | null;
  bucket: 'overdue' | 'dueToday' | 'remindDue' | 'imminent' | 'doing' | 'undated';
}

export interface MinimalBriefingEvent {
  id: string;
  title: string;
  dateKey: string;
  timeRange: string;
  allDay: boolean;
  location: string;
}

export interface AiBriefingRequest {
  todayKey: string;
  imminentDays: number;
  tasks: MinimalBriefingTask[];
  events: MinimalBriefingEvent[];
}

export interface AiBriefingFocusItem {
  title: string;
  reason: string;
  linkedTaskId: string | null;
}

export interface AiBriefingAlertItem {
  title: string;
  detail: string;
}

export interface AiBriefingResult {
  summary: string;
  priorityFocus: AiBriefingFocusItem[];
  imminentAlerts: AiBriefingAlertItem[];
  conflictAlerts: AiBriefingAlertItem[];
  missedChecks: AiBriefingAlertItem[];
}

export interface AiBriefingResponse {
  model: string;
  generatedAtIso: string;
  briefing: AiBriefingResult;
}
