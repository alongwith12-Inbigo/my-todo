export const AI_LIMITS = {
  MAX_NOTICE_CHARS: 20000,
  NOTICE_INPUT_MAX_CHARS: 30000,
  MAX_EXISTING_CONTEXT_ITEMS: 40,
  MAX_BRIEFING_TASKS: 30,
  MAX_BRIEFING_EVENTS: 20,
  MAX_CANDIDATES: 50,
  MAX_PLANNER_TASKS: 15,
  MAX_PLANNER_SLOTS: 8,
  MAX_PLANNER_RECOMMENDATIONS: 5,
  MAX_ADJUST_CONSTRAINT_CHARS: 180,
  REQUEST_TIMEOUT_MS: 25000,
  RATE_LIMIT_MAX_REQUESTS: 12,
  RATE_LIMIT_WINDOW_MS: 60_000,
  DEFAULT_DAILY_PLAN_LIMIT: 3,
  DEFAULT_DAILY_TOTAL_LIMIT: 5,
  MAX_DAILY_PLAN_LIMIT: 10,
  MAX_DAILY_TOTAL_LIMIT: 20,
} as const;

export type AiPersistenceMode = 'encrypted_vault' | 'session_memory_only';

export type AiErrorCategory =
  | 'input_format'
  | 'request_format'
  | 'auth'
  | 'encryption_config'
  | 'gemini_api'
  | 'network'
  | 'server_internal';

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface AiUsageSnapshot {
  todayDateKey: string;
  todayPlanCount: number;
  todayNoticeCount?: number;
  todayTotalCount: number;
  monthKey: string;
  monthTotalCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThoughtTokens: number;
  lastModel: string | null;
  lastUsedAtIso: string | null;
}

export type GeminiApiKeyType = 'auth_aq' | 'standard_aiza' | 'generic';

export type GeminiDiagnosticErrorCategory =
  | 'auth_failed'
  | 'auth_header_error'
  | 'model_permission_denied'
  | 'model_not_supported'
  | 'model_generate_unsupported'
  | 'invalid_request_format'
  | 'quota_exceeded'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'server_error';

export interface AiStatusResponse {
  configured: boolean;
  hasPersonalKey: boolean;
  keyType?: GeminiApiKeyType | null;
  persistenceMode: AiPersistenceMode;
  encryptionConfigured?: boolean;
  serverlessRuntime?: boolean;
  model: string;
  aiEnabled: boolean;
  dailyPlanLimit: number;
  dailyTotalLimit: number;
  usage: AiUsageSnapshot;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  maxNoticeChars: number;
}

export interface AiByokSaveRequest {
  apiKey: string;
  testBeforeSave?: boolean;
  verifyAuthBeforeSave?: boolean;
}

export interface AiByokSaveResponse {
  ok: boolean;
  hasPersonalKey: boolean;
  keyType?: GeminiApiKeyType;
  persistenceMode: AiPersistenceMode;
  message: string;
  warning?: string;
  usage?: AiTokenUsage;
}

export interface AiByokTestRequest {
  apiKey?: string;
}

export interface AiByokTestResponse {
  ok: boolean;
  model: string;
  configuredModel: string;
  apiKeyAuthOk: boolean;
  modelAccessible: boolean;
  generateContentOk: boolean;
  latencyMs: number;
  keyType?: GeminiApiKeyType;
  message: string;
  warning?: string;
  errorCode?: string;
  detailCode?: string;
  category?: AiErrorCategory;
  diagnosticCategory?: GeminiDiagnosticErrorCategory;
  upstreamHttpStatus?: number;
  upstreamApiStatus?: string;
  upstreamErrorMessage?: string;
  requestApiVersion?: string;
  requestEndpoint?: string;
  modelListCached?: boolean;
  availableGenerateModels?: string[];
  recommendedModel?: string | null;
  usage?: AiTokenUsage;
}

export interface AiPreferencesUpdateRequest {
  aiEnabled?: boolean;
  dailyPlanLimit?: number;
  dailyTotalLimit?: number;
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
  usage?: AiTokenUsage;
  usageSnapshot?: AiUsageSnapshot;
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
  usage?: AiTokenUsage;
  usageSnapshot?: AiUsageSnapshot;
}

/**
 * Compressed Task representation for AI Today Work Planner (max 15 items, zero description/notes).
 */
export interface MinimalPlannerTask {
  id: string;
  t: string; // sanitized title (max 70 chars)
  d: string | null; // dueDateKey YYYY-MM-DD
  ov: boolean; // overdue
  dd: number | null; // D-day relative to todayKey
  p: 'u' | 'h' | 'n' | 'l'; // urgent | high | normal | low
  s: 'td' | 'dg' | 'oh'; // todo | doing | on_hold
  m: number | null; // user-supplied estimatedMinutes (nullable)
  tdy: boolean; // due/scheduled/reminded today
  ev?: boolean; // linked to an event scheduled today
}

export interface MinimalPlannerSlot {
  st: string; // HH:MM
  et: string; // HH:MM
  min: number; // usable minutes
  lb: string; // short label
}

export interface AiPlannerRequest {
  todayKey: string;
  currentTimeHhMm: string;
  totalIncompleteCount: number;
  overdueCount: number;
  dueTodayCount: number;
  timetableConfigured: boolean;
  remainingWorkableMinutes: number;
  workableSlots: MinimalPlannerSlot[];
  blockedEventsSummary: string[];
  academicAlertsSummary: string[];
  tasks: MinimalPlannerTask[];
  constraint?: string;
}

export interface AiPlannerRawRecommendation {
  taskId: string;
  order: number;
  recommendedStart: string | null; // HH:MM
  recommendedEnd: string | null; // HH:MM
  estimatedMinutes: number;
  reason: string;
  tier?: 'must' | 'optional';
  strategy?: string | null;
}

export interface AiPlannerRawAttentionItem {
  taskId: string;
  reason: string;
}

export interface AiPlannerRawDeferredItem {
  taskId: string;
  reason: string;
}

export interface AiPlannerRawResult {
  coreAdvice: string;
  recommendations: AiPlannerRawRecommendation[];
  attentionTasks: AiPlannerRawAttentionItem[];
  deferredTasks: AiPlannerRawDeferredItem[];
}

export interface AiPlannerResponse {
  model: string;
  generatedAtIso: string;
  rawPlan: AiPlannerRawResult;
  usage?: AiTokenUsage;
  usageSnapshot?: AiUsageSnapshot;
}
