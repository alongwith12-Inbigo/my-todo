import { GoogleGenAI, Type, type Schema } from '@google/genai';
import {
  AI_LIMITS,
  type AiAnalyzeNoticeRequest,
  type AiAnalyzeNoticeResponse,
  type AiBriefingRequest,
  type AiBriefingResponse,
  type AiBriefingResult,
  type AiRawNoticeOutput,
} from '../src/lib/aiTypes.ts';
import {
  getGeminiApiKey,
  getGeminiModelName,
  mapGeminiError,
} from './aiConfig.ts';

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

function createGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
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

export async function analyzeNoticeWithGemini(
  input: AiAnalyzeNoticeRequest,
  signal?: AbortSignal,
): Promise<AiAnalyzeNoticeResponse> {
  const model = getGeminiModelName();
  const ai = createGeminiClient();
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
    };
  } catch (err) {
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}

export async function generateBriefingWithGemini(
  input: AiBriefingRequest,
  signal?: AbortSignal,
): Promise<AiBriefingResponse> {
  const model = getGeminiModelName();
  const ai = createGeminiClient();

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
    };
  } catch (err) {
    const mapped = mapGeminiError(err);
    throw new GeminiServiceError(mapped.status, mapped.code, mapped.message);
  }
}
