import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
  type AiBriefingResult,
  type AiPlannerRawResult,
  type AiPlannerRequest,
  type AiPlannerResponse,
  type AiRawNoticeOutput,
  type AiTokenUsage,
  type GeminiApiKeyType,
} from '../src/lib/aiTypes.ts';
import {
  detectGeminiApiKeyType,
  normalizeGeminiApiKeyInput,
} from '../src/lib/byokKeyFormat.ts';
import { getGeminiModelName, mapGeminiError } from './aiConfig.ts';

const NOTICE_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ['task', 'event'] },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          dueDate: { type: Type.STRING, nullable: true },
          priority: {
            type: Type.STRING,
            enum: ['low', 'normal', 'high', 'urgent'],
          },
          eventStartDate: { type: Type.STRING, nullable: true },
          eventEndDate: { type: Type.STRING, nullable: true },
          allDay: { type: Type.BOOLEAN },
          startTime: { type: Type.STRING, nullable: true },
          endTime: { type: Type.STRING, nullable: true },
          location: { type: Type.STRING, nullable: true },
          dateEvidence: { type: Type.STRING, nullable: true },
          dateUncertain: { type: Type.BOOLEAN },
          uncertaintyReason: { type: Type.STRING, nullable: true },
          rationale: { type: Type.STRING, nullable: true },
          semanticDuplicateId: { type: Type.STRING, nullable: true },
          semanticDuplicateReason: { type: Type.STRING, nullable: true },
        },
        required: ['kind', 'title'],
      },
    },
    unparsedSummary: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['candidates'],
};

const BRIEFING_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    priorityFocus: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          reason: { type: Type.STRING },
          linkedTaskId: { type: Type.STRING, nullable: true },
        },
        required: ['title', 'reason'],
      },
    },
    imminentAlerts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
    conflictAlerts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
    missedChecks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: [
    'summary',
    'priorityFocus',
    'imminentAlerts',
    'conflictAlerts',
    'missedChecks',
  ],
};

const PLANNER_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    coreAdvice: { type: Type.STRING },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          order: { type: Type.INTEGER },
          recommendedStart: { type: Type.STRING, nullable: true },
          recommendedEnd: { type: Type.STRING, nullable: true },
          estimatedMinutes: { type: Type.INTEGER },
          reason: { type: Type.STRING },
        },
        required: ['taskId', 'order', 'estimatedMinutes', 'reason'],
      },
    },
    attentionTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['taskId', 'reason'],
      },
    },
    deferredTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          taskId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['taskId', 'reason'],
      },
    },
  },
  required: [
    'coreAdvice',
    'recommendations',
    'attentionTasks',
    'deferredTasks',
  ],
};

export function createGeminiClient(apiKey: string): GoogleGenAI {
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
    );
  }
  // GoogleGenAI with { apiKey } injects x-goog-api-key (never Authorization: Bearer),
  // which is required by Google for both AIza... standard keys and AQ.... authorization keys.
  return new GoogleGenAI({
    apiKey: cleanKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractUsageMetadata(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}): AiTokenUsage {
  const m = response.usageMetadata;
  const inputTokens = typeof m?.promptTokenCount === 'number' ? m.promptTokenCount : 0;
  const outputTokens =
    typeof m?.candidatesTokenCount === 'number' ? m.candidatesTokenCount : 0;
  const thoughtTokens =
    typeof m?.thoughtsTokenCount === 'number' ? m.thoughtsTokenCount : 0;
  const totalTokens =
    typeof m?.totalTokenCount === 'number'
      ? m.totalTokenCount
      : inputTokens + outputTokens + thoughtTokens;
  return { inputTokens, outputTokens, thoughtTokens, totalTokens };
}

async function runWithTimeoutAndAbort<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Request timed out'));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    fn()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

export class GeminiServiceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GeminiServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface GeminiTestClientLike {
  models: {
    list: (params?: { config?: { pageSize?: number } }) => Promise<{
      page?: Array<{ name?: string; supportedActions?: string[] }>;
    }>;
    generateContent: (params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }) => Promise<{
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
    }>;
  };
}

export interface GeminiPersonalKeyTestResult {
  model: string;
  usage: AiTokenUsage;
  authVerified: boolean;
  keyType: GeminiApiKeyType;
  warning?: string;
}

const ZERO_USAGE: AiTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};

function pickFallbackGenerateContentModel(
  listedModels: Array<{ name?: string; supportedActions?: string[] }> | undefined,
  configuredModel: string,
): string | null {
  if (!Array.isArray(listedModels) || listedModels.length === 0) return null;
  const candidates = listedModels
    .filter((item) => {
      const name = typeof item?.name === 'string' ? item.name : '';
      const shortName = name.replace(/^models\//, '');
      if (!shortName.toLowerCase().includes('gemini')) return false;
      if (shortName === configuredModel) return false;
      if (Array.isArray(item.supportedActions) && item.supportedActions.length > 0) {
        return item.supportedActions.includes('generateContent');
      }
      return true;
    })
    .map((item) => String(item.name).replace(/^models\//, ''));

  if (candidates.length === 0) return null;
  const preferredOrder = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
  ];
  for (const preferred of preferredOrder) {
    if (candidates.includes(preferred)) return preferred;
  }
  return candidates[0];
}

export async function testGeminiPersonalKey(
  apiKey: string,
  signal?: AbortSignal,
  clientOverride?: GeminiTestClientLike,
): Promise<GeminiPersonalKeyTestResult> {
  const cleanKey = normalizeGeminiApiKeyInput(apiKey);
  if (!cleanKey) {
    throw new GeminiServiceError(
      403,
      'personal_key_required',
      '개인 Gemini API 키가 등록되어 있지 않습니다.',
    );
  }
  const keyType = detectGeminiApiKeyType(cleanKey);
  const configuredModel = getGeminiModelName();
  const ai = clientOverride ?? createGeminiClient(cleanKey);
  const deadlineMs = Date.now() + 9000;
  const remainingMs = () => Math.max(1500, deadlineMs - Date.now());

  // 1. Verify actual Gemini API authentication via GET /models (x-goog-api-key)
  let listedModels: Array<{ name?: string; supportedActions?: string[] }> | undefined;
  try {
    const pager = await runWithTimeoutAndAbort(
      () => ai.models.list({ config: { pageSize: 20 } }),
      remainingMs(),
      signal,
    );
    listedModels = pager?.page;
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }

  // 2. Probe text generation on configured model (auth already verified above)
  try {
    const response = await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model: configuredModel,
          contents: 'Reply with OK.',
          config: {
            maxOutputTokens: 16,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL,
            },
          },
        }),
      remainingMs(),
      signal,
    );
    return {
      model: configuredModel,
      usage: extractUsageMetadata(response),
      authVerified: true,
      keyType,
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err);

    if (
      mapped.code === 'invalid_api_key' ||
      mapped.code === 'api_key_permission_denied' ||
      mapped.code === 'gemini_auth_header_error' ||
      mapped.code === 'ai_aborted' ||
      mapped.code === 'ai_timeout' ||
      mapped.code === 'upstream_network_error'
    ) {
      throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
    }

    if (mapped.code === 'model_not_found') {
      const fallbackModel = pickFallbackGenerateContentModel(
        listedModels,
        configuredModel,
      );
      if (fallbackModel) {
        try {
          const fallbackRes = await runWithTimeoutAndAbort(
            () =>
              ai.models.generateContent({
                model: fallbackModel,
                contents: 'Reply with OK.',
                config: {
                  maxOutputTokens: 16,
                  thinkingConfig: {
                    thinkingLevel: ThinkingLevel.MINIMAL,
                  },
                },
              }),
            remainingMs(),
            signal,
          );
          return {
            model: fallbackModel,
            usage: extractUsageMetadata(fallbackRes),
            authVerified: true,
            keyType,
            warning: `API 키 인증은 정상입니다. 다만 서버 기본 모델(${configuredModel}) 대신 사용 가능한 모델(${fallbackModel})로 연결되었습니다. Vercel 환경변수 GEMINI_MODEL=${fallbackModel} 설정을 권장합니다.`,
          };
        } catch (fallbackErr) {
          const fallbackMapped = mapGeminiError(fallbackErr);
          if (
            fallbackMapped.code === 'invalid_api_key' ||
            fallbackMapped.code === 'api_key_permission_denied' ||
            fallbackMapped.code === 'gemini_auth_header_error'
          ) {
            throw new GeminiServiceError(
              fallbackMapped.status,
              fallbackMapped.code,
              fallbackMapped.message,
            );
          }
        }
      }

      return {
        model: fallbackModel ?? configuredModel,
        usage: ZERO_USAGE,
        authVerified: true,
        keyType,
        warning: `API 키 인증은 정상 확인되었습니다. 다만 설정된 모델(${configuredModel})을 사용할 수 없어 Vercel 환경변수 GEMINI_MODEL(${fallbackModel ?? 'gemini-2.5-flash'} 등) 설정 확인이 필요합니다.`,
      };
    }

    if (mapped.code === 'ai_quota_exceeded') {
      return {
        model: configuredModel,
        usage: ZERO_USAGE,
        authVerified: true,
        keyType,
        warning:
          'API 키 인증은 정상 확인되었습니다. 다만 현재 해당 키의 Gemini 생성 호출 한도(429)에 도달한 상태입니다. 할당량 초기화 후 AI 기능을 실행해 주세요.',
      };
    }

    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}

export async function analyzeNoticeWithGemini(
  apiKey: string,
  input: AiAnalyzeNoticeRequest,
  signal?: AbortSignal,
): Promise<AiAnalyzeNoticeResponse> {
  const model = getGeminiModelName();
  const ai = createGeminiClient(apiKey);
  const todayKey = input.todayKey || new Date().toISOString().slice(0, 10);

  const existingList = (input.existingItems ?? [])
    .slice(0, AI_LIMITS.MAX_EXISTING_CONTEXT_ITEMS)
    .map((item) => `- [${item.kind}:${item.id}] ${item.title} (${item.dateKey ?? '날짜없음'})`)
    .join('\n');

  const prompt = [
    `당신은 한국 고등학교 교사의 개인 업무·일정 비서입니다.`,
    `기준 날짜(Asia/Seoul): ${todayKey}`,
    ``,
    `[규칙]`,
    `1. 원문에 없는 사실, 날짜, 시각, 장소를 추측하거나 지어내지 마세요.`,
    `2. 제출·회신·작성·취합·확인·입력 등 행위가 중심이면 kind='task', 회의·연수·상담·행사·출장·수업공개 등 일정 참여가 중심이면 kind='event'로 분류하세요.`,
    `3. 연도가 생략된 월/일(예: '11월 20일', '1월 10일')은 기준 날짜(${todayKey}) 기준으로 오늘이거나 미래면 올해, 이미 지났으면 다음 해의 YYYY-MM-DD로 해석하세요. 연도 생략 자체는 dateUncertain=true 사유로 삼지 마세요.`,
    `4. '2시', '3교시'처럼 오전/오후 또는 구체 시각이 불명확하거나 날짜가 전혀 없는 경우에만 dateUncertain=true 및 uncertaintyReason을 짧게 작성하세요.`,
    `5. dateEvidence에는 날짜/시각을 해석한 원문 표현을 그대로 적고, rationale에는 업무/일정으로 판단한 짧은 근거(1문장)를 적으세요.`,
    `6. 기존 목록과 의미가 겹치는 항목이 보이면(예: '디지털 수업사례 제출' vs '수업사례 보고서 제출') semanticDuplicateId에 해당 기존 id를, semanticDuplicateReason에 짧은 사유를 적으세요. 없으면 null로 두세요.`,
    `7. 원문 내 [성명], [연락처], [이메일], [고유식별번호 제외됨] 같은 마스킹 토큰은 그대로 존중하고 복원하려 하지 마세요.`,
    ``,
    existingList ? `[현재 등록된 기존 업무/일정 참고 목록]\n${existingList}\n` : '',
    `[분석할 학교 쪽지/안내문]\n${input.text}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: NOTICE_RESPONSE_SCHEMA,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
          },
        }),
      AI_LIMITS.REQUEST_TIMEOUT_MS,
      signal,
    );

    const text = response.text;
    if (!text) {
      throw new Error('Empty JSON response from Gemini');
    }

    const parsed = JSON.parse(text) as AiRawNoticeOutput;
    return {
      model,
      rawOutput: {
        candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
        unparsedSummary: Array.isArray(parsed.unparsedSummary)
          ? parsed.unparsedSummary
          : [],
      },
      usage: extractUsageMetadata(response),
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}

export async function generateBriefingWithGemini(
  apiKey: string,
  input: AiBriefingRequest,
  signal?: AbortSignal,
): Promise<AiBriefingResponse> {
  const model = getGeminiModelName();
  const ai = createGeminiClient(apiKey);

  const tasksText =
    input.tasks.length > 0
      ? input.tasks
          .map(
            (t) =>
              `- [id:${t.id}] (${t.bucket}/${t.priority}/${t.status}) ${t.title} | 마감:${t.dueDateKey ?? '없음'} | 재확인:${t.remindDateKey ?? '없음'}`,
          )
          .join('\n')
      : '(등록된 미완료 업무 없음)';

  const eventsText =
    input.events.length > 0
      ? input.events
          .map(
            (e) =>
              `- [id:${e.id}] ${e.dateKey} ${e.timeRange} ${e.title}${e.location ? ` @${e.location}` : ''}`,
          )
          .join('\n')
      : '(다가오는 일정 없음)';

  const prompt = [
    `당신은 한국 고등학교 교사의 오늘의 브리핑 도우미입니다.`,
    `기준 날짜(Asia/Seoul): ${input.todayKey} (마감 임박 기준: ${input.imminentDays}일 이내)`,
    ``,
    `[규칙]`,
    `1. 제공된 목록에 있는 항목만 참고하여 짧고 실무적인 한국어로 요약하세요. 없는 업무나 일정을 만들어내지 마세요.`,
    `2. summary: 오늘 하루 핵심 흐름을 1~2문장으로 요약`,
    `3. priorityFocus: 오늘 먼저 챙길 업무 1~4건 제안 (linkedTaskId는 목록에 있는 id만 사용)`,
    `4. imminentAlerts: 기한 초과 또는 임박 마감 주의 항목`,
    `5. conflictAlerts: 같은 날 일정과 업무 마감이 겹치거나 일정 시간이 몰려 주의가 필요한 부분`,
    `6. missedChecks: 날짜 미지정, 재확인 미설정 등 놓치기 쉬운 확인 포인트`,
    ``,
    `[미완료 업무 요약]\n${tasksText}`,
    ``,
    `[오늘 및 다가오는 일정 요약]\n${eventsText}`,
  ].join('\n');

  try {
    const response = await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: BRIEFING_RESPONSE_SCHEMA,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
          },
        }),
      AI_LIMITS.REQUEST_TIMEOUT_MS,
      signal,
    );

    const text = response.text;
    if (!text) {
      throw new Error('Empty JSON briefing response from Gemini');
    }

    const parsed = JSON.parse(text) as AiBriefingResult;
    return {
      model,
      generatedAtIso: new Date().toISOString(),
      briefing: parsed,
      usage: extractUsageMetadata(response),
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}

export async function generateDayPlanWithGemini(
  apiKey: string,
  input: AiPlannerRequest,
  signal?: AbortSignal,
): Promise<AiPlannerResponse> {
  const model = getGeminiModelName();
  const ai = createGeminiClient(apiKey);

  const compactInput = {
    today: input.todayKey,
    now: input.currentTimeHhMm,
    counts: {
      total: input.totalIncompleteCount,
      overdue: input.overdueCount,
      dueToday: input.dueTodayCount,
    },
    timetableConfigured: input.timetableConfigured,
    availMin: input.remainingWorkableMinutes,
    slots: input.workableSlots,
    events: input.blockedEventsSummary,
    academic: input.academicAlertsSummary,
    tasks: input.tasks,
    ...(input.constraint ? { constraint: input.constraint } : {}),
  };

  const prompt = [
    `당신은 한국 교사의 '오늘의 업무 실행 플래너'입니다.`,
    `규칙:`,
    `1. 제공된 tasks의 id만 사용하세요(최대 5건 추천). 없는 id/업무 금지.`,
    `2. recommendedStart/End(HH:MM)는 반드시 slots 구간 내부에만 겹치지 않게 배치하세요. slots가 비어 있으면 null로 두세요.`,
    `3. estimatedMinutes는 task.m 값이 있으면 그대로 사용하고, null일 때만 15~90 사이 합리적 정수(5단위)로 추정하세요.`,
    `4. 마감(ov/dd), 중요도(p: u>h>n>l), 남은 시간, 집중 블록/짧은 공강 적합성을 판단해 우선순위를 정하고 큰 업무는 분할 제안하세요.`,
    `5. reason은 1문장(35자 내외), coreAdvice는 1~2문장(90자 내외)으로 간결히 작성하세요.`,
    `입력JSON:${JSON.stringify(compactInput)}`,
  ].join('\n');

  try {
    const response = await runWithTimeoutAndAbort(
      () =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            maxOutputTokens: 1200,
            responseMimeType: 'application/json',
            responseSchema: PLANNER_RESPONSE_SCHEMA,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
          },
        }),
      AI_LIMITS.REQUEST_TIMEOUT_MS,
      signal,
    );

    const text = response.text;
    if (!text) {
      throw new Error('Empty JSON planner response from Gemini');
    }

    const parsed = JSON.parse(text) as AiPlannerRawResult;
    return {
      model,
      generatedAtIso: new Date().toISOString(),
      rawPlan: {
        coreAdvice: typeof parsed.coreAdvice === 'string' ? parsed.coreAdvice : '',
        recommendations: Array.isArray(parsed.recommendations)
          ? parsed.recommendations.slice(0, AI_LIMITS.MAX_PLANNER_RECOMMENDATIONS)
          : [],
        attentionTasks: Array.isArray(parsed.attentionTasks)
          ? parsed.attentionTasks.slice(0, 6)
          : [],
        deferredTasks: Array.isArray(parsed.deferredTasks)
          ? parsed.deferredTasks.slice(0, 6)
          : [],
      },
      usage: extractUsageMetadata(response),
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}
