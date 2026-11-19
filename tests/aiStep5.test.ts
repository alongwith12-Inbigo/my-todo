import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import {
  handleAiBriefingRequest,
  handleAiStatusRequest,
  handleAnalyzeNoticeRequest,
} from '../server/aiRoutes.ts';
import { mapGeminiError } from '../server/aiConfig.ts';
import {
  ServerAuthError,
  verifyFirebaseUserAndAccess,
} from '../server/firebaseServerAuth.ts';
import { SlidingWindowRateLimiter } from '../server/rateLimiter.ts';
import {
  buildMinimalBriefingPayload,
  buildMinimalExistingContext,
} from '../src/lib/aiBriefing.ts';
import {
  normalizeAiBriefingResult,
  normalizeAiNoticeCandidates,
} from '../src/lib/aiImportValidator.ts';
import {
  analyzeNoticeWithGemini,
  clearGeminiModelCacheForTesting,
} from '../server/geminiService.ts';
import {
  classifyNoticeAiError,
  sanitizeClientDiagnosticText,
  type NoticeAiClientErrorLike,
} from '../src/lib/aiNoticeError.ts';
import { AI_LIMITS } from '../src/lib/aiTypes.ts';
import { inspectAndMaskPrivacy } from '../src/lib/privacyGuard.ts';
import type { CalendarEventRecord, TaskRecord } from '../src/types/domain.ts';

function makeTask(overrides: Partial<TaskRecord> & { id: string; title: string }): TaskRecord {
  const nowTs = Timestamp.fromDate(new Date('2026-11-14T00:00:00+09:00'));
  return {
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: null,
    scheduledAt: null,
    remindAt: null,
    completedAt: null,
    sourceType: 'manual',
    relatedEventId: null,
    isDeleted: false,
    deletedAt: null,
    version: 1,
    createdAt: nowTs,
    updatedAt: nowTs,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<CalendarEventRecord> & { id: string; title: string },
): CalendarEventRecord {
  const startTs = Timestamp.fromDate(new Date('2026-11-14T14:00:00+09:00'));
  const endTs = Timestamp.fromDate(new Date('2026-11-14T15:00:00+09:00'));
  return {
    startsAt: startTs,
    endsAt: endTs,
    allDay: false,
    location: '본관 2층 회의실',
    description: '',
    relatedTaskId: null,
    version: 1,
    createdAt: startTs,
    updatedAt: startTs,
    schemaVersion: 1,
    ...overrides,
  };
}

test('privacyGuard detects and masks high-risk RRN, phone, email, student ID, and names', () => {
  const raw =
    '김민수 학생(2학년 3반 12번, 010-2345-6789, minsu@school.kr) 주민번호 080312-3123456 확인 후 11월 20일까지 제출';
  const result = inspectAndMaskPrivacy(raw);

  assert.equal(result.hasPii, true);
  assert.equal(result.hasHighRisk, true);
  assert.ok(!result.maskedText.includes('080312-3123456'));
  assert.ok(!result.maskedText.includes('010-2345-6789'));
  assert.ok(!result.maskedText.includes('minsu@school.kr'));
  assert.ok(!result.maskedText.includes('김민수'));
  assert.ok(result.maskedText.includes('11월 20일까지 제출'));
});

test('privacyGuard returns clean status when notice contains no PII', () => {
  const raw = '11월 20일까지 디지털 수업사례 보고서를 업무포털로 제출해 주세요.';
  const result = inspectAndMaskPrivacy(raw);

  assert.equal(result.hasPii, false);
  assert.equal(result.hasHighRisk, false);
  assert.equal(result.findings.length, 0);
  assert.equal(result.maskedText, raw);
});

test('aiImportValidator applies Asia/Seoul yearless date rules without flagging year omission', () => {
  const now = new Date('2026-11-14T09:00:00+09:00');
  const existingTask = makeTask({
    id: 'task-existing-1',
    title: '수업사례 보고서 제출',
    dueAt: Timestamp.fromDate(new Date('2026-11-20T14:59:59Z')),
  });

  const normalized = normalizeAiNoticeCandidates(
    {
      candidates: [
        {
          kind: 'task',
          title: '디지털 수업사례 제출',
          description: '자료 취합 후 업로드',
          dueDate: '2026-11-20',
          priority: 'high',
          dateEvidence: '11월 20일까지',
          dateUncertain: false,
          rationale: '제출 기한이 명시된 교사 업무입니다.',
          semanticDuplicateId: 'task-existing-1',
          semanticDuplicateReason: '수업사례 보고서 제출 업무와 의미가 겹칩니다.',
        },
        {
          kind: 'task',
          title: '새해 학사계획 초안 제출',
          dueDate: '2026-01-10', // LLM mistakenly guessed 2026
          dateEvidence: '1월 10일까지',
          dateUncertain: true,
          uncertaintyReason: '연도가 생략되어 확인이 필요합니다.',
          rationale: '연초 제출 업무입니다.',
        },
        {
          kind: 'event',
          title: '교과 협의회',
          eventStartDate: '2026-11-21',
          dateEvidence: '11월 21일 2시',
          startTime: '14:00',
          location: '본관 2층 회의실',
          rationale: '시간과 장소가 포함된 회의 일정입니다.',
        },
      ],
    },
    {
      now,
      existingTasks: [existingTask],
      existingEvents: [],
    },
  );

  assert.equal(normalized.candidates.length, 3);

  const [c1, c2, c3] = normalized.candidates;
  // c1: yearless upcoming date -> 2026-11-20, no confirmation warning, semantic duplicate preserved
  assert.equal(c1.dueDateStr, '2026-11-20');
  assert.equal(c1.needsConfirmation, false);
  assert.equal(c1.origin, 'ai');
  assert.ok(c1.duplicateWarnings.some((w) => w.includes('수업사례 보고서 제출')));

  // c2: yearless past date (1월 10일 on 2026-11-14) -> corrected to 2027-01-10, year omission reason suppressed
  assert.equal(c2.dueDateStr, '2027-01-10');
  assert.equal(c2.needsConfirmation, false);

  // c3: "2시" without 오전/오후 -> genuinely ambiguous time, flagged for confirmation
  assert.equal(c3.kind, 'event');
  assert.equal(c3.needsConfirmation, true);
  assert.ok(c3.confirmationReasons.some((r) => r.includes('오전/오후')));
});

test('buildMinimalBriefingPayload minimizes fields and strips PII, and validator guards linkedTaskId', () => {
  const now = new Date('2026-11-14T09:00:00+09:00');
  const task1 = makeTask({
    id: 'task-1',
    title: '박지훈 학생 상담일지 제출 (010-1111-2222)',
    description: '매우 긴 상세 메모는 AI 브리핑에 전송되지 않아야 합니다.',
    dueAt: Timestamp.fromDate(new Date('2026-11-14T14:59:59Z')),
    priority: 'high',
  });
  const ev1 = makeEvent({
    id: 'ev-1',
    title: '2학년부 부장회의',
    description: '긴 상세 설명은 제외',
  });

  const payload = buildMinimalBriefingPayload([task1], [ev1], { now, imminentDays: 3 });
  assert.equal(payload.tasks.length, 1);
  assert.ok(!payload.tasks[0].title.includes('010-1111-2222'));
  assert.ok(!payload.tasks[0].title.includes('박지훈'));
  assert.equal('description' in payload.tasks[0], false);
  assert.equal('description' in payload.events[0], false);

  const ctx = buildMinimalExistingContext([task1], [ev1]);
  assert.equal(ctx.length, 2);

  const briefing = normalizeAiBriefingResult(
    {
      summary: '오늘 마감 업무 1건과 부장회의가 있습니다.',
      priorityFocus: [
        { title: '상담일지 제출', reason: '오늘 마감', linkedTaskId: 'task-1' },
        { title: '타인 업무 위조 ID', reason: '테스트', linkedTaskId: 'foreign-id' },
      ],
      imminentAlerts: [],
      conflictAlerts: [],
      missedChecks: [],
    },
    new Set(payload.tasks.map((t) => t.id)),
  );

  assert.equal(briefing.priorityFocus[0].linkedTaskId, 'task-1');
  assert.equal(briefing.priorityFocus[1].linkedTaskId, null);
});

test('verifyFirebaseUserAndAccess enforces 401/403 security gates accurately', async () => {
  // Missing token -> 401
  await assert.rejects(
    () => verifyFirebaseUserAndAccess(undefined, { projectId: 'p', firestoreDatabaseId: 'd' }),
    (err: unknown) => err instanceof ServerAuthError && err.statusCode === 401,
  );

  // Unverified email -> 403
  await assert.rejects(
    () =>
      verifyFirebaseUserAndAccess('Bearer tok', {
        projectId: 'p',
        firestoreDatabaseId: 'd',
        verifyJwt: async () => ({
          uid: 'user1',
          email: 'a@icedu.kr',
          emailVerified: false,
        }),
      }),
    (err: unknown) => err instanceof ServerAuthError && err.statusCode === 403,
  );

  // Pending user -> 403
  await assert.rejects(
    () =>
      verifyFirebaseUserAndAccess('Bearer tok', {
        projectId: 'p',
        firestoreDatabaseId: 'd',
        verifyJwt: async () => ({
          uid: 'user1',
          email: 'a@icedu.kr',
          emailVerified: true,
        }),
        fetchAccessDoc: async () => ({ status: 'pending', role: 'teacher' }),
      }),
    (err: unknown) =>
      err instanceof ServerAuthError &&
      err.statusCode === 403 &&
      err.code === 'account_not_active',
  );

  // Active verified user -> passes
  const verified = await verifyFirebaseUserAndAccess('Bearer tok', {
    projectId: 'p',
    firestoreDatabaseId: 'd',
    verifyJwt: async () => ({
      uid: 'user1',
      email: 'a@icedu.kr',
      emailVerified: true,
    }),
    fetchAccessDoc: async () => ({ status: 'active', role: 'teacher' }),
  });
  assert.equal(verified.uid, 'user1');
  assert.equal(verified.accessStatus, 'active');
});

test('server AI routes enforce auth, unconfigured fallback, input length, and rate limits', async () => {
  const activeAuth = async (header: string | string[] | undefined) => {
    if (!header) {
      throw new ServerAuthError(401, 'unauthenticated', '로그인 필요');
    }
    return {
      uid: 'teacher-1',
      email: 't@icedu.kr',
      emailVerified: true,
      accessStatus: 'active',
      role: 'teacher',
    };
  };

  // Unauthenticated /api/ai/status -> 401
  const unauthStatus = await handleAiStatusRequest(undefined, { verifyAuth: activeAuth });
  assert.equal(unauthStatus.status, 401);

  // Unconfigured key on analyze-notice -> 503 with fallback guidance
  const unconfigured = await handleAnalyzeNoticeRequest(
    { authorizationHeader: 'Bearer ok', body: { text: '11월 20일까지 제출' } },
    { verifyAuth: activeAuth, isConfigured: () => false },
  );
  assert.equal(unconfigured.status, 503);

  // Overlength input -> 400
  const overlong = await handleAnalyzeNoticeRequest(
    {
      authorizationHeader: 'Bearer ok',
      body: { text: '가'.repeat(AI_LIMITS.MAX_NOTICE_CHARS + 10) },
    },
    { verifyAuth: activeAuth, isConfigured: () => true },
  );
  assert.equal(overlong.status, 400);

  // Rate limit exceeded -> 429
  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  const deps = {
    verifyAuth: activeAuth,
    isConfigured: () => true,
    rateLimiter: limiter,
    analyzeNotice: async () => ({
      model: 'gemini-4-hydrogen',
      rawOutput: { candidates: [] },
    }),
    generateBriefing: async () => ({
      model: 'gemini-4-hydrogen',
      generatedAtIso: '2026-11-14T00:00:00Z',
      briefing: {
        summary: '요약',
        priorityFocus: [],
        imminentAlerts: [],
        conflictAlerts: [],
        missedChecks: [],
      },
    }),
  };

  const ok1 = await handleAnalyzeNoticeRequest(
    { authorizationHeader: 'Bearer ok', body: { text: '11월 20일까지 제출' } },
    deps,
  );
  assert.equal(ok1.status, 200);

  const ok2 = await handleAiBriefingRequest(
    {
      authorizationHeader: 'Bearer ok',
      body: { todayKey: '2026-11-14', imminentDays: 3, tasks: [], events: [] },
    },
    deps,
  );
  assert.equal(ok2.status, 200);

  const limited = await handleAnalyzeNoticeRequest(
    { authorizationHeader: 'Bearer ok', body: { text: '11월 21일 회의' } },
    deps,
  );
  assert.equal(limited.status, 429);
  assert.ok(limited.headers?.['Retry-After']);
});

test('mapGeminiError never leaks raw API key strings or internal details', () => {
  const mapped = mapGeminiError(
    new Error('API key not valid: AIzaSecretKeyShouldNeverAppearInUi'),
  );
  assert.equal(mapped.status, 403);
  assert.equal(mapped.code, 'invalid_api_key');
  assert.ok(!mapped.message.includes('AIzaSecretKeyShouldNeverAppearInUi'));
});

test('analyze_notice stays isolated from planner model overrides and returns structured 5xx diagnostics without retries', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  const prevPlannerModel = process.env.GEMINI_PLANNER_MODEL;
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_PLANNER_MODEL = 'gemini-3.5-flash-lite';

    let callCount = 0;
    let capturedParams:
      | {
          model: string;
          config?: {
            maxOutputTokens?: number;
            responseMimeType?: string;
            responseSchema?: unknown;
            thinkingConfig?: { thinkingLevel?: string };
          };
        }
      | undefined;

    const mockClient = {
      models: {
        list: async () => ({ page: [] }),
        generateContent: async (params: {
          model: string;
          contents: string;
          config?: Record<string, unknown>;
        }) => {
          callCount += 1;
          capturedParams = params as typeof capturedParams;
          const err = new Error(
            JSON.stringify({
              error: {
                code: 500,
                status: 'INTERNAL',
                message:
                  'Internal error encountered. (key=AIzaShouldBeRedactedFromMessage)',
              },
            }),
          ) as Error & { status: number };
          err.status = 500;
          throw err;
        },
      },
    };

    const routeRes = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: 'Bearer active-token',
        body: { text: '11월 20일까지 생활기록부 점검표 제출 바랍니다.' },
      },
      {
        verifyAuth: async () => ({
          uid: 'teacher-notice-5xx',
          email: 't@icedu.kr',
          emailVerified: true,
          accessStatus: 'active',
          role: 'teacher',
        }),
        isConfigured: () => true,
        rateLimiter: new SlidingWindowRateLimiter(10, 60_000),
        analyzeNotice: async (input, signal, apiKey, requestId) =>
          await analyzeNoticeWithGemini(
            apiKey ?? 'test-injected-key',
            input,
            signal,
            mockClient,
            requestId,
          ),
      },
    );

    assert.equal(callCount, 1);
    assert.equal(capturedParams?.model, 'gemini-3.8-flash');
    assert.equal(capturedParams?.config?.maxOutputTokens, 4096);
    assert.equal(capturedParams?.config?.responseMimeType, 'application/json');
    assert.ok(capturedParams?.config?.responseSchema);
    assert.equal(capturedParams?.config?.thinkingConfig?.thinkingLevel, 'LOW');

    assert.equal(routeRes.status, 502);
    const body = routeRes.body as Record<string, unknown>;
    assert.equal(body.error, 'ai_upstream_error');
    assert.equal(body.diagnosticCategory, 'server_error');
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.equal(body.upstreamHttpStatus, 500);
    assert.equal(body.upstreamApiStatus, 'INTERNAL');
    assert.equal(body.requestApiVersion, 'v1');
    assert.equal(
      body.requestEndpoint,
      'models/gemini-3.8-flash:generateContent',
    );
    assert.ok(typeof body.upstreamErrorMessage === 'string');
    assert.ok(
      !String(body.upstreamErrorMessage).includes('AIzaShouldBeRedactedFromMessage'),
    );
  } finally {
    console.warn = origWarn;
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
    if (prevPlannerModel === undefined) delete process.env.GEMINI_PLANNER_MODEL;
    else process.env.GEMINI_PLANNER_MODEL = prevPlannerModel;
  }
});

test('analyzeNoticeWithGemini attaches model name to empty/invalid JSON errors', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    const mockClient = {
      models: {
        list: async () => ({ page: [] }),
        generateContent: async () => ({ text: '   ' }),
      },
    };

    await assert.rejects(
      () =>
        analyzeNoticeWithGemini(
          'AQ.DummyKeyForJsonErrorTest_1234',
          { text: '11월 20일까지 제출' },
          undefined,
          mockClient,
          'req_empty_notice',
        ),
      (err: unknown) => {
        const svcErr = err as { code?: string; model?: string; diagnosticCategory?: string };
        return (
          svcErr.code === 'ai_empty_response' &&
          svcErr.model === 'gemini-3.8-flash' &&
          svcErr.diagnosticCategory === 'server_error'
        );
      },
    );
  } finally {
    console.warn = origWarn;
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('classifyNoticeAiError distinguishes all required categories and redacts secrets', () => {
  const makeClientErr = (
    status: number,
    code: string,
    message: string,
    category?: NoticeAiClientErrorLike['category'],
    errorDetail?: NoticeAiClientErrorLike['errorDetail'],
  ): NoticeAiClientErrorLike => ({
    name: 'AiClientError',
    status,
    code,
    message,
    category,
    errorDetail,
  });

  const authErr = classifyNoticeAiError(
    makeClientErr(
      401,
      'api_key_permission_denied',
      '인증 실패',
      'gemini_api',
      { diagnosticCategory: 'auth_failed', model: 'gemini-3.8-flash' },
    ),
  );
  assert.equal(authErr.category, 'auth');
  assert.equal(authErr.categoryLabel, '인증 오류');

  const modelErr = classifyNoticeAiError(
    makeClientErr(
      404,
      'model_not_found',
      '모델 미지원',
      'gemini_api',
      { diagnosticCategory: 'model_not_supported', model: 'gemini-3.8-flash' },
    ),
  );
  assert.equal(modelErr.category, 'model_unsupported');
  assert.equal(modelErr.categoryLabel, '모델 미지원·권한·형식 오류');

  const quotaErr = classifyNoticeAiError(
    makeClientErr(429, 'rate_limit_exceeded', '호출 한도 초과', 'gemini_api'),
  );
  assert.equal(quotaErr.category, 'quota');
  assert.equal(quotaErr.categoryLabel, '사용량 제한');

  const serverErr = classifyNoticeAiError(
    makeClientErr(
      502,
      'ai_upstream_error',
      'Google Gemini 서버에서 일시적인 내부 오류가 발생했습니다.',
      'gemini_api',
      {
        diagnosticCategory: 'server_error',
        model: 'gemini-3.8-flash',
        upstreamHttpStatus: 500,
        upstreamApiStatus: 'INTERNAL',
        upstreamErrorMessage:
          'Internal error with AIzaLeak1234567890 and AQ.LeakSecretToken1234 and Bearer eyJabc.def.ghi',
      },
    ),
  );
  assert.equal(serverErr.category, 'server_error');
  assert.equal(serverErr.categoryLabel, '서버 내부 오류');
  assert.ok(!serverErr.errorDetail?.upstreamErrorMessage?.includes('AIzaLeak1234567890'));
  assert.ok(!serverErr.errorDetail?.upstreamErrorMessage?.includes('AQ.LeakSecretToken1234'));
  assert.ok(!serverErr.errorDetail?.upstreamErrorMessage?.includes('eyJabc.def.ghi'));

  const timeoutErr = classifyNoticeAiError(
    makeClientErr(
      504,
      'ai_timeout',
      '시간 초과',
      'gemini_api',
      {
        diagnosticCategory: 'timeout',
        timeoutSource: 'local',
        timeoutMs: 25000,
        latencyMs: 25001,
      },
    ),
  );
  assert.equal(timeoutErr.category, 'timeout');
  assert.equal(timeoutErr.categoryLabel, '시간 초과');
  assert.ok(timeoutErr.guidance.includes('25초'));

  const netErr = classifyNoticeAiError(
    makeClientErr(0, 'network_error', '네트워크 오류', 'network'),
  );
  assert.equal(netErr.category, 'network');
  assert.equal(netErr.categoryLabel, '네트워크 오류');

  const sanitized = sanitizeClientDiagnosticText(
    'x-goog-api-key: secret123 ?key=abc999 normal detail',
  );
  assert.ok(!sanitized.includes('secret123'));
  assert.ok(!sanitized.includes('abc999'));
  assert.ok(sanitized.includes('normal detail'));
});

