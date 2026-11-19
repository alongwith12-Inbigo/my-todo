import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import {
  buildAiPlannerContext,
  buildDeterministicDayPlan,
  clipIntervalsToCurrentTime,
  excludePlanItemFromToday,
  movePlanItemOrder,
  reassignPlanItemSlot,
  validateAndRepairAiPlan,
} from '../src/lib/aiPlanner.ts';
import { AI_LIMITS } from '../src/lib/aiTypes.ts';
import {
  buildCreateTaskPayload,
  buildTaskDetailsPatch,
  TaskValidationError,
} from '../src/repositories/taskOperations.ts';
import { ThinkingLevel } from '@google/genai';
import {
  applyUsageIncrement,
  checkDailyQuotaForKind,
  decryptApiKeyForUid,
  encryptApiKeyForUid,
  maskGeminiApiKey,
  normalizeGeminiApiKeyInput,
  parseCookies,
  REDACTED_VAULT_KEY_HINT,
  sealByokCookieValue,
  unsealByokCookieValue,
  validateGeminiApiKeyFormat,
  type StoredAiUserState,
} from '../server/byokVault.ts';
import {
  dispatchVercelAiRoute,
  handleAiPlannerRequest,
  handleAiStatusRequest,
  handleAnalyzeNoticeRequest,
  handleDeleteByokKeyRequest,
  handleSaveByokKeyRequest,
  handleTestByokKeyRequest,
} from '../server/aiRoutes.ts';
import { config as plannerRouteConfig } from '../api/ai/planner.ts';
import {
  getGeminiModelProfile,
  getGeminiPlannerModelName,
  mapGeminiError,
  resolveSafeRequestId,
  sanitizeUpstreamErrorMessage,
  toCompatibilitySummary,
} from '../server/aiConfig.ts';
import { ServerAuthError } from '../server/firebaseServerAuth.ts';
import {
  analyzeNoticeWithGemini,
  buildThinkingConfigForModel,
  clearGeminiModelCacheForTesting,
  createGeminiClient,
  GeminiServiceError,
  generateDayPlanWithGemini,
  getEffectiveGeminiApiVersion,
  getKeyTestProbeTimeoutMs,
  inspectListedGeminiModels,
  parseGeminiJsonResponse,
  testGeminiPersonalKey,
} from '../server/geminiService.ts';
import { SlidingWindowRateLimiter } from '../server/rateLimiter.ts';
import { detectGeminiApiKeyType } from '../src/lib/byokKeyFormat.ts';
import type {
  AcademicEventRecord,
  CalendarEventRecord,
  TaskRecord,
  TimetableOverrideRecord,
  TimetableRecord,
} from '../src/types/domain.ts';

function makeTask(
  overrides: Partial<TaskRecord> & { id: string; title: string },
): TaskRecord {
  const nowTs = Timestamp.fromDate(new Date('2026-11-16T00:00:00+09:00'));
  return {
    description: '상세 메모나 학생 상담 원문은 AI로 전송되지 않아야 합니다.',
    status: 'todo',
    priority: 'normal',
    dueAt: null,
    scheduledAt: null,
    remindAt: null,
    completedAt: null,
    estimatedMinutes: null,
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

function makeTimetable(): TimetableRecord {
  const nowTs = Timestamp.fromDate(new Date('2026-11-16T00:00:00+09:00'));
  return {
    id: 'tt-1',
    name: '2026-2학기 시간표',
    semesterLabel: '2026-2학기',
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-12-31',
    isActive: true,
    sourceType: 'manual',
    workStart: '08:30',
    workEnd: '16:30',
    lunchStart: '12:20',
    lunchEnd: '13:20',
    periodCount: 5,
    periodTimes: {
      '1': { period: 1, label: '1교시', startTime: '09:00', endTime: '09:50' },
      '2': { period: 2, label: '2교시', startTime: '10:00', endTime: '10:50' },
      '3': { period: 3, label: '3교시', startTime: '11:00', endTime: '11:50' },
      '4': { period: 4, label: '4교시', startTime: '13:20', endTime: '14:10' },
      '5': { period: 5, label: '5교시', startTime: '14:20', endTime: '15:10' },
    },
    slots: {
      // 2026-11-16 is Monday (day 1)
      '1_1': {
        day: 1,
        period: 1,
        kind: 'class',
        subject: '통합사회',
        className: '1-2',
        classroom: '1-2',
        note: '',
        workAvailable: false,
      },
      '1_2': {
        day: 1,
        period: 2,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: true,
      },
      '1_3': {
        day: 1,
        period: 3,
        kind: 'fixed_duty',
        subject: '생활지도',
        className: '',
        classroom: '',
        note: '',
        workAvailable: false,
      },
      '1_4': {
        day: 1,
        period: 4,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: true,
      },
      '1_5': {
        day: 1,
        period: 5,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: false, // unworkable free period
      },
    },
    version: 1,
    createdAt: nowTs,
    updatedAt: nowTs,
    schemaVersion: 1,
  };
}

test('buildAiPlannerContext respects current KST time, classes, fixed_duty, lunch, unworkable free, personal events, and compresses <=15 tasks without descriptions', () => {
  const now = new Date('2026-11-16T09:30:00+09:00'); // Monday 09:30 KST
  const todayKey = '2026-11-16';
  const timetable = makeTimetable();

  // Personal meeting during 13:20~14:00 (overlaps 4th period workable free 13:20~14:10)
  const personalEvent: CalendarEventRecord = {
    id: 'ev-1',
    title: '학년 협의회',
    startsAt: Timestamp.fromDate(new Date('2026-11-16T13:20:00+09:00')),
    endsAt: Timestamp.fromDate(new Date('2026-11-16T14:00:00+09:00')),
    allDay: false,
    location: '교무실',
    description: '비공개 회의록',
    relatedTaskId: null,
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };

  // Create 18 incomplete tasks + 1 done task + 1 deleted task
  const tasks: TaskRecord[] = [
    ...Array.from({ length: 18 }, (_, i) =>
      makeTask({
        id: `t-${i + 1}`,
        title: `업무 항목 ${i + 1}`,
        priority: i === 0 ? 'urgent' : i < 4 ? 'high' : 'normal',
        dueAt:
          i === 0
            ? Timestamp.fromDate(new Date('2026-11-15T23:59:59+09:00'))
            : Timestamp.fromDate(new Date('2026-11-16T23:59:59+09:00')),
        estimatedMinutes: i === 0 ? 30 : null,
        description: `절대 AI로 전송 금지 비밀메모 ${i + 1}`,
      }),
    ),
    makeTask({ id: 't-done', title: '완료된 업무', status: 'done' }),
    makeTask({ id: 't-del', title: '삭제된 업무', isDeleted: true }),
  ];

  const ctx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks,
    events: [personalEvent],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
  });

  // Period 1 (09:00-09:50) is class; period 2 (10:00-10:50) is workable free;
  // Period 3 (11:00-11:50) is fixed_duty; lunch 12:20-13:20 excluded;
  // Period 4 (13:20-14:10) minus 13:20-14:00 meeting leaves 14:00-14:10 (10m);
  // Period 5 (14:20-15:10) has workAvailable: false.
  assert.ok(ctx.remainingWorkableIntervals.some((s) => s.startTime === '10:00' && s.endTime === '10:50'));
  assert.ok(!ctx.remainingWorkableIntervals.some((s) => s.startTime === '09:00'));
  assert.ok(!ctx.remainingWorkableIntervals.some((s) => s.startTime === '11:00'));
  assert.ok(!ctx.remainingWorkableIntervals.some((s) => s.startTime === '14:20'));

  // Compressed tasks strictly <= 15 and exclude descriptions/done/deleted
  assert.equal(ctx.compressedRequest.tasks.length, AI_LIMITS.MAX_PLANNER_TASKS);
  assert.equal(ctx.compressedRequest.tasks[0].id, 't-1');
  assert.equal(ctx.compressedRequest.tasks[0].ov, true);
  assert.equal(ctx.compressedRequest.tasks[0].m, 30);
  const serialized = JSON.stringify(ctx.compressedRequest);
  assert.ok(!serialized.includes('절대 AI로 전송 금지'));
  assert.ok(!serialized.includes('비공개 회의록'));
  assert.ok(!serialized.includes('t-done'));
  assert.ok(!serialized.includes('t-del'));
});

test('academic calendar needs_check holds automatic workable slots until override is confirmed', () => {
  const now = new Date('2026-11-16T08:00:00+09:00');
  const todayKey = '2026-11-16';
  const timetable = makeTimetable();
  const academicEvent: AcademicEventRecord = {
    id: 'acad-1',
    title: '수능 예비소집 단축수업',
    startDate: '2026-11-16',
    endDate: '2026-11-16',
    startTime: null,
    endTime: null,
    category: 'shortened_schedule',
    location: '',
    schoolYear: 2026,
    sourceType: 'manual',
    sourceLabel: '수기 등록',
    sourceText: '',
    timetableImpact: 'needs_check',
    overrideDateKey: null,
    dedupeKey: '2026-11-16_shortened',
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };

  const unconfirmedCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks: [makeTask({ id: 't1', title: '공문 제출' })],
    events: [],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [academicEvent],
  });

  assert.equal(unconfirmedCtx.remainingWorkableMinutes, 0);
  assert.ok(unconfirmedCtx.unconfirmedAcademicWarnings.length > 0);

  // Once teacher confirms override for today, workable slots unlock
  const confirmedOverride: TimetableOverrideRecord = {
    id: '2026-11-16',
    dateKey: '2026-11-16',
    baseTimetableId: 'tt-1',
    reason: '단축수업 확정',
    workStart: null,
    workEnd: null,
    lunchStart: null,
    lunchEnd: null,
    periodTimes: {},
    slots: {
      '2': {
        period: 2,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: true,
      },
    },
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };

  const confirmedCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks: [makeTask({ id: 't1', title: '공문 제출' })],
    events: [],
    timetables: [timetable],
    overridesByDate: { '2026-11-16': confirmedOverride },
    academicEvents: [academicEvent],
  });

  assert.ok(confirmedCtx.remainingWorkableMinutes > 0);
  assert.equal(confirmedCtx.unconfirmedAcademicWarnings.length, 0);
});

test('validateAndRepairAiPlan drops hallucinated IDs, preserves user estimatedMinutes, and repairs colliding class slots', () => {
  const now = new Date('2026-11-16T09:05:00+09:00');
  const todayKey = '2026-11-16';
  const timetable = makeTimetable();
  const tasks = [
    makeTask({ id: 'real-1', title: '가정통신문 결재', estimatedMinutes: 25, priority: 'urgent' }),
    makeTask({ id: 'real-2', title: '출석부 정리', estimatedMinutes: null, priority: 'normal' }),
  ];

  const ctx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks,
    events: [],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
  });

  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '오전 공강에 긴급 업무를 먼저 처리하세요.',
      recommendations: [
        {
          taskId: 'hallucinated-id',
          order: 1,
          recommendedStart: '10:00',
          recommendedEnd: '10:30',
          estimatedMinutes: 30,
          reason: '없는 업무',
        },
        {
          taskId: 'real-1',
          order: 2,
          // Collides with 1교시 class (09:00~09:50)! Must be repaired to 10:00~10:25
          recommendedStart: '09:00',
          recommendedEnd: '09:30',
          estimatedMinutes: 60, // user set 25m -> must stay 25m!
          reason: '긴급 결재 업무입니다.',
        },
        {
          taskId: 'real-2',
          order: 3,
          recommendedStart: '10:30',
          recommendedEnd: '10:50',
          estimatedMinutes: 20,
          reason: '이어서 처리하세요.',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    ctx,
    { model: 'gemini-4-hydrogen', generatedAtIso: '2026-11-16T00:00:00Z' },
  );

  assert.equal(validated.recommendations.length, 2);
  assert.equal(validated.recommendations[0].taskId, 'real-1');
  assert.equal(validated.recommendations[0].estimatedMinutes, 25);
  assert.equal(validated.recommendations[0].durationSource, 'user');
  assert.equal(validated.recommendations[0].slotStatus, 'repaired');
  assert.equal(validated.recommendations[0].slotStart, '10:00');
  assert.equal(validated.recommendations[0].slotEnd, '10:25');

  assert.equal(validated.recommendations[1].taskId, 'real-2');
  assert.equal(validated.recommendations[1].durationSource, 'ai_estimated');
  assert.equal(validated.recommendations[1].slotStart, '10:30');
  assert.ok(validated.validationRepairs.length >= 2);
});

test('local zero-AI adjustments (move, exclude, reassign) and fingerprint cache key behave deterministically', () => {
  const now = new Date('2026-11-16T08:30:00+09:00');
  const todayKey = '2026-11-16';
  const timetable = makeTimetable();
  const tasks = [
    makeTask({ id: 't1', title: '업무 1', priority: 'urgent', estimatedMinutes: 20 }),
    makeTask({ id: 't2', title: '업무 2', priority: 'high', estimatedMinutes: 20 }),
  ];

  const ctx1 = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks,
    events: [],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
  });
  const ctx2 = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey,
    now,
    tasks,
    events: [],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(ctx1.fingerprint, ctx2.fingerprint);

  const detPlan = buildDeterministicDayPlan(ctx1);
  assert.equal(detPlan.mode, 'deterministic');
  assert.equal(detPlan.recommendations.length, 2);

  const moved = movePlanItemOrder(
    detPlan,
    't2',
    'up',
    ctx1.remainingWorkableIntervals,
  );
  assert.equal(moved.recommendations[0].taskId, 't2');
  assert.equal(moved.recommendations[1].taskId, 't1');

  const slot1320Idx = ctx1.remainingWorkableIntervals.findIndex(
    (seg) => seg.startTime === '13:20',
  );
  assert.ok(slot1320Idx >= 0);

  const reassigned = reassignPlanItemSlot(
    moved,
    't1',
    slot1320Idx,
    ctx1.remainingWorkableIntervals,
  );
  assert.equal(reassigned.recommendations[1].slotStart, '13:20');

  const excluded = excludePlanItemFromToday(
    reassigned,
    't2',
    ctx1.remainingWorkableIntervals,
  );
  assert.equal(excluded.recommendations.length, 1);
  assert.equal(excluded.recommendations[0].taskId, 't1');
  assert.ok(excluded.deferredTasks.some((d) => d.taskId === 't2'));
});

test('clipIntervalsToCurrentTime trims elapsed intervals cleanly', () => {
  const clipped = clipIntervalsToCurrentTime(
    [
      { startMin: 540, endMin: 590, startTime: '09:00', endTime: '09:50', minutes: 50 },
      { startMin: 600, endMin: 650, startTime: '10:00', endTime: '10:50', minutes: 50 },
    ],
    575, // 09:35
    10,
  );
  assert.equal(clipped.length, 2);
  assert.equal(clipped[0].startTime, '09:35');
  assert.equal(clipped[0].minutes, 15);
  assert.equal(clipped[1].startTime, '10:00');
});

test('BYOK AES-256-GCM encryption binds strictly to UID, masks key, validates format, and enforces daily quota', () => {
  const sampleKey = 'AIzaSyFakePersonalKeyForUnitTest123456';
  assert.equal(validateGeminiApiKeyFormat('short').valid, false);
  assert.equal(validateGeminiApiKeyFormat('AIza with spaces 1234567890').valid, false);
  assert.equal(validateGeminiApiKeyFormat(sampleKey).valid, true);
  assert.equal(maskGeminiApiKey(sampleKey), REDACTED_VAULT_KEY_HINT);

  const enc = encryptApiKeyForUid(sampleKey, 'uid-alpha');
  assert.ok(!enc.ciphertext.includes('AIza'));
  assert.equal(enc.keyHint, REDACTED_VAULT_KEY_HINT);
  assert.ok(!enc.keyHint.includes('AIza') && !enc.keyHint.includes('3456'));
  assert.equal(decryptApiKeyForUid(enc, 'uid-alpha'), sampleKey);
  assert.equal(decryptApiKeyForUid(enc, 'uid-beta'), null);

  const sealedCookie = sealByokCookieValue(sampleKey, 'uid-alpha');
  assert.equal(unsealByokCookieValue(sealedCookie, 'uid-alpha'), sampleKey);
  assert.equal(unsealByokCookieValue(sealedCookie, 'uid-beta'), null);

  let state: StoredAiUserState = {
    existsInFirestore: false,
    aiEnabled: true,
    dailyPlanLimit: 2,
    dailyTotalLimit: 3,
    todayDateKey: '2026-11-16',
    todayPlanCount: 0,
    todayTotalCount: 0,
    monthKey: '2026-11',
    monthTotalCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThoughtTokens: 0,
    lastModel: null,
    lastUsedAtIso: null,
  };

  state = applyUsageIncrement(
    state,
    'planner',
    'gemini-4-hydrogen',
    { inputTokens: 400, outputTokens: 200, thoughtTokens: 50, totalTokens: 650 },
    new Date('2026-11-16T09:00:00+09:00'),
  );
  state = applyUsageIncrement(
    state,
    'planner',
    'gemini-4-hydrogen',
    { inputTokens: 350, outputTokens: 180, thoughtTokens: 40, totalTokens: 570 },
    new Date('2026-11-16T10:00:00+09:00'),
  );

  assert.equal(state.todayPlanCount, 2);
  assert.equal(state.totalInputTokens, 750);
  const planBlocked = checkDailyQuotaForKind(state, 'planner');
  assert.equal(planBlocked.allowed, false);
  assert.equal(planBlocked.code, 'daily_plan_quota_exceeded');

  // Other AI actions still allowed until dailyTotalLimit (3)
  assert.equal(checkDailyQuotaForKind(state, 'briefing').allowed, true);
  state = applyUsageIncrement(
    state,
    'briefing',
    'gemini-4-hydrogen',
    undefined,
    new Date('2026-11-16T11:00:00+09:00'),
  );
  const totalBlocked = checkDailyQuotaForKind(state, 'notice');
  assert.equal(totalBlocked.allowed, false);
  assert.equal(totalBlocked.code, 'daily_total_quota_exceeded');

  // Next KST day resets counters automatically
  state = applyUsageIncrement(
    state,
    'planner',
    'gemini-4-hydrogen',
    undefined,
    new Date('2026-11-17T08:00:00+09:00'),
  );
  assert.equal(state.todayDateKey, '2026-11-17');
  assert.equal(state.todayPlanCount, 1);
  assert.equal(state.todayTotalCount, 1);
});

test('planner route requires caller personal key (no operator fallback) and supports BYOK cookie flow', async () => {
  const activeAuth = async (header: string | string[] | undefined) => {
    if (!header) {
      throw new ServerAuthError(401, 'unauthenticated', '로그인 필요');
    }
    return {
      uid: 'teacher-byok-1',
      email: 't@icedu.kr',
      emailVerified: true,
      accessStatus: 'active',
      role: 'teacher',
    };
  };

  // Without personal key -> 403 personal_key_required (never falls back to operator env)
  const missingKeyRes = await handleAiPlannerRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: {
        todayKey: '2026-11-16',
        currentTimeHhMm: '09:00',
        tasks: [{ id: 't1', t: '업무', d: null, ov: false, dd: null, p: 'n', s: 'td', m: null, tdy: true }],
      },
    },
    {
      verifyAuth: activeAuth,
      rateLimiter: new SlidingWindowRateLimiter(10, 60_000),
      resolveApiKey: async () => null,
    },
  );
  assert.equal(missingKeyRes.status, 403);
  assert.equal(
    (missingKeyRes.body as { error: string }).error,
    'personal_key_required',
  );

  // Save BYOK sets HttpOnly encrypted cookie
  const saveRes = await handleSaveByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: 'AIzaSyFakeKeyForSaveRoute12345678', testBeforeSave: false },
      isSecure: false,
    },
    { verifyAuth: activeAuth },
  );
  assert.equal(saveRes.status, 200);
  assert.equal('keyHint' in (saveRes.body as Record<string, unknown>), false);
  const setCookie = String(saveRes.headers?.['Set-Cookie'] ?? '');
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(!setCookie.includes('AIzaSyFakeKeyForSaveRoute12345678'));
});

test('taskOperations supports optional nullable estimatedMinutes and rejects out-of-range values', () => {
  const defaultPayload = buildCreateTaskPayload({ title: '기본 업무' });
  assert.equal(defaultPayload.estimatedMinutes, null);

  const validPayload = buildCreateTaskPayload({
    title: '30분 업무',
    estimatedMinutes: 30,
  });
  assert.equal(validPayload.estimatedMinutes, 30);

  const patch = buildTaskDetailsPatch(1, { estimatedMinutes: 45 });
  assert.equal(patch.estimatedMinutes, 45);

  const cleared = buildTaskDetailsPatch(2, { estimatedMinutes: null });
  assert.equal(cleared.estimatedMinutes, null);

  assert.throws(
    () => buildCreateTaskPayload({ title: '잘못된 시간', estimatedMinutes: 2 }),
    TaskValidationError,
  );
  assert.throws(
    () => buildTaskDetailsPatch(1, { estimatedMinutes: 600 }),
    TaskValidationError,
  );
});

test('validateGeminiApiKeyFormat allows both AIza... and AQ.... dummy keys and strips edge whitespace/invisible Unicode chars', () => {
  const validDummyCases = [
    'AIzaSyDummyKeyAbCdEfGhIjKlMnOpQrStUvWx_01-234',
    'AIzaSyDummy9876543210-_abcdefghijklmnop',
    'AQ.Ab8RN6DummyAuthKeySegment_01-23456789ABCDEF',
    'AQ.Ab8RN6Dummy.MultiSegment_Part2-XYZ123456789',
    'D'.repeat(20),
    'Ab_0-9'.repeat(63) + '12', // 380 chars max boundary
  ];

  for (const key of validDummyCases) {
    const res = validateGeminiApiKeyFormat(key);
    assert.equal(res.valid, true, `Expected valid for key length ${key.length}`);
    assert.equal(res.apiKey, key);
  }

  assert.equal(detectGeminiApiKeyType('AQ.Ab8RN6DummyAuthKey_1234567890'), 'auth_aq');
  assert.equal(detectGeminiApiKeyType('AIzaSyDummyKeyAbCdEfGhIjKlMnOp123'), 'standard_aiza');

  const cleanAqDummyKey = 'AQ.Ab8RN6Dummy_Copy-Paste.Key_1234567890ABCDEF';
  const copyPasteArtifacts = [
    `  ${cleanAqDummyKey}  `,
    `\r\n${cleanAqDummyKey}\n`,
    `\t\u00A0\u3000${cleanAqDummyKey}\u00A0\t`,
    `\uFEFF\u200B${cleanAqDummyKey}\u200C\u200D`,
    `\u200E\u202A\u2060\u00AD\u061C\u180E\u034F${cleanAqDummyKey}\u202E\u200F\u2060\u3164\u2800`,
    `\r\n \u200B\uFEFF${cleanAqDummyKey}\u200B \n\r`,
  ];

  for (const noisy of copyPasteArtifacts) {
    assert.equal(normalizeGeminiApiKeyInput(noisy), cleanAqDummyKey);
    const res = validateGeminiApiKeyFormat(noisy);
    assert.equal(res.valid, true);
    assert.equal(res.apiKey, cleanAqDummyKey);
    assert.equal(res.keyType, 'auth_aq');
  }
});

test('validateGeminiApiKeyFormat distinguishes dot errors, masked placeholders, internal whitespace, invisible chars, non-ASCII, special chars, and length without leaking key', () => {
  const classifiedCases: Array<{
    input: string;
    expectedReason: string;
  }> = [
    { input: 'AQ.Ab8DummyKey 123456789012345', expectedReason: 'internal_whitespace' },
    { input: 'AQ.Ab8DummyKey\n123456789012345', expectedReason: 'internal_whitespace' },
    { input: 'AQ.Ab8DummyKey\t123456789012345', expectedReason: 'internal_whitespace' },
    { input: 'AQ.Ab8DummyKey\u200B123456789012345', expectedReason: 'internal_invisible_chars' },
    { input: 'AQ.Ab8DummyKey\u00AD123456789012345', expectedReason: 'internal_invisible_chars' },
    { input: 'AQ.Ab8••••••••••••1234567890', expectedReason: 'masked_placeholder' },
    { input: 'AQ.Ab8Dummy...12345678901234', expectedReason: 'masked_placeholder' },
    { input: 'AQ..Ab8DummyKey12345678901234', expectedReason: 'masked_placeholder' },
    { input: 'AQ.Ab8****DummyKey1234567890', expectedReason: 'masked_placeholder' },
    { input: '.AQAb8DummyKey12345678901234', expectedReason: 'invalid_dot_placement' },
    { input: 'AQ.Ab8DummyKey12345678901234.', expectedReason: 'invalid_dot_placement' },
    { input: 'AQ.한글포함더미키123456789012', expectedReason: 'non_ascii_chars' },
    { input: 'AQ.Ab8DummyKey!123456789012345', expectedReason: 'invalid_special_chars' },
    { input: 'AQ.Ab8DummyKey+123456789012345=', expectedReason: 'invalid_special_chars' },
    { input: '"AQ.Ab8DummyKey1234567890123456"', expectedReason: 'invalid_special_chars' },
    { input: 'D'.repeat(19), expectedReason: 'invalid_length' },
    { input: 'D'.repeat(381), expectedReason: 'invalid_length' },
  ];

  const seenMessages = new Set<string>();
  for (const item of classifiedCases) {
    const res = validateGeminiApiKeyFormat(item.input);
    assert.equal(res.valid, false);
    assert.equal(res.category, 'input_format');
    assert.equal(res.reasonCode, item.expectedReason);
    assert.ok(res.message && res.message.length > 0);
    seenMessages.add(res.message);
    assert.ok(!res.message.includes('Ab8Dummy'));
    assert.ok(!res.message.includes(item.input));
  }
  assert.equal(seenMessages.size, 7);

  const emptyCases = ['', '   ', '\r\n\t', '\u200B\uFEFF\u2060\u180E'];
  for (const empty of emptyCases) {
    const res = validateGeminiApiKeyFormat(empty);
    assert.equal(res.valid, false);
    assert.equal(res.reasonCode, 'empty_key');
    assert.equal(res.message, 'Gemini API 키를 입력해 주세요.');
  }

  assert.equal(validateGeminiApiKeyFormat(null).reasonCode, 'non_string_key');
  assert.equal(validateGeminiApiKeyFormat(1234567890).reasonCode, 'non_string_key');
});

test('BYOK routes distinguish input format, request JSON, auth, Vercel encryption env, and Gemini upstream errors cleanly', async () => {
  const activeAuth = async () => ({
    uid: 'teacher-byok-copy-test',
    email: 'teacher@icedu.kr',
    emailVerified: true,
    accessStatus: 'active' as const,
    role: 'teacher',
  });

  const cleanDummyKey = 'AIzaSyDummy_Route-Test_1234567890ABCDEF';
  const pastedFromUi = `\uFEFF\u200B \n${cleanDummyKey}\r\n\u200C `;

  // 1. Valid dummy key with surrounding copy artifacts passes normalized key to server test & saves cleanly
  const testedKeysOnSave: string[] = [];
  const saveRes = await handleSaveByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: JSON.stringify({ apiKey: pastedFromUi, testBeforeSave: true }),
      isSecure: false,
    },
    {
      verifyAuth: activeAuth,
      testApiKey: async (apiKey) => {
        testedKeysOnSave.push(apiKey);
        return {
          model: 'gemini-4-hydrogen',
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            thoughtTokens: 0,
            totalTokens: 6,
          },
        };
      },
    },
  );
  assert.equal(saveRes.status, 200);
  assert.deepEqual(testedKeysOnSave, [cleanDummyKey]);
  assert.ok(!JSON.stringify(saveRes.body).includes(cleanDummyKey));

  // 2. Test route passes normalized key and rejects invalid internal chars with input_format category
  const testedKeysOnTestRoute: string[] = [];
  const testRes = await handleTestByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: pastedFromUi },
    },
    {
      verifyAuth: activeAuth,
      testApiKey: async (apiKey) => {
        testedKeysOnTestRoute.push(apiKey);
        return {
          model: 'gemini-4-hydrogen',
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            thoughtTokens: 0,
            totalTokens: 6,
          },
        };
      },
    },
  );
  assert.equal(testRes.status, 200);
  assert.deepEqual(testedKeysOnTestRoute, [cleanDummyKey]);
  assert.ok(!JSON.stringify(testRes.body).includes(cleanDummyKey));

  const badInternalKey = 'AIzaSyDummy Key With$Special123';
  const badTestRes = await handleTestByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: badInternalKey },
    },
    {
      verifyAuth: activeAuth,
      testApiKey: async () => {
        throw new Error('Should not reach testApiKey for invalid format');
      },
    },
  );
  assert.equal(badTestRes.status, 400);
  const badBody = badTestRes.body as {
    error: string;
    category: string;
    detailCode: string;
    message: string;
  };
  assert.equal(badBody.error, 'invalid_key_format');
  assert.equal(badBody.category, 'input_format');
  assert.equal(badBody.detailCode, 'internal_whitespace');
  assert.ok(!JSON.stringify(badTestRes.body).includes('AIzaSy'));

  // 3. Malformed JSON string body -> request_format (distinct from input_format)
  const malformedJsonRes = await handleSaveByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: '{bad json',
    },
    { verifyAuth: activeAuth },
  );
  assert.equal(malformedJsonRes.status, 400);
  assert.equal((malformedJsonRes.body as { category: string }).category, 'request_format');
  assert.equal((malformedJsonRes.body as { error: string }).error, 'invalid_request_body');

  // 4. Auth failure -> auth category (distinct from input_format & encryption_config)
  const unauthRes = await handleSaveByokKeyRequest({
    authorizationHeader: undefined,
    body: { apiKey: cleanDummyKey },
  });
  assert.equal(unauthRes.status, 401);
  assert.equal((unauthRes.body as { category: string }).category, 'auth');
  assert.equal((unauthRes.body as { error: string }).error, 'unauthenticated');

  // 5. Vercel serverless runtime without BYOK_ENCRYPTION_SECRET -> encryption_config error (503)
  const prevVercel = process.env.VERCEL;
  const prevSecret = process.env.BYOK_ENCRYPTION_SECRET;
  try {
    process.env.VERCEL = '1';
    delete process.env.BYOK_ENCRYPTION_SECRET;

    const statusOnVercel = await handleAiStatusRequest('Bearer test-token', {
      verifyAuth: activeAuth,
    });
    assert.equal(statusOnVercel.status, 200);
    assert.equal(
      (statusOnVercel.body as { encryptionConfigured?: boolean }).encryptionConfigured,
      false,
    );
    assert.equal(
      (statusOnVercel.body as { serverlessRuntime?: boolean }).serverlessRuntime,
      true,
    );

    const saveWithoutSecret = await handleSaveByokKeyRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: { apiKey: cleanDummyKey, testBeforeSave: false },
      },
      { verifyAuth: activeAuth },
    );
    assert.equal(saveWithoutSecret.status, 503);
    assert.equal(
      (saveWithoutSecret.body as { error: string }).error,
      'encryption_secret_missing',
    );
    assert.equal(
      (saveWithoutSecret.body as { category: string }).category,
      'encryption_config',
    );
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevSecret === undefined) delete process.env.BYOK_ENCRYPTION_SECRET;
    else process.env.BYOK_ENCRYPTION_SECRET = prevSecret;
  }

  // 6. Gemini upstream errors map distinctly from input format / auth / encryption errors
  assert.equal(mapGeminiError(new Error('API_KEY_INVALID')).code, 'invalid_api_key');
  assert.equal(
    mapGeminiError(new Error('401 UNAUTHENTICATED: invalid credentials')).code,
    'api_key_permission_denied',
  );
  assert.equal(
    mapGeminiError(new Error('403 PERMISSION_DENIED: model disabled')).code,
    'model_permission_denied',
  );
  assert.equal(
    mapGeminiError(
      new Error('400 INVALID_ARGUMENT: Thinking level is not supported for this model.'),
      'gemini-2.5-flash',
    ).code,
    'invalid_request_format',
  );
  assert.equal(mapGeminiError(new Error('404 model not found')).code, 'model_not_found');
  assert.equal(mapGeminiError(new Error('429 RESOURCE_EXHAUSTED')).code, 'ai_quota_exceeded');
  assert.equal(mapGeminiError(new Error('504 DEADLINE_EXCEEDED')).code, 'ai_timeout');

  // 7. Vercel dispatcher returns clean JSON 500 if unexpected error is thrown
  let dispatchedStatus = 0;
  let dispatchedBody: unknown = null;
  const headersSent: Record<string, string | string[]> = {};
  await dispatchVercelAiRoute(
    { method: 'POST', headers: {} },
    {
      status(code: number) {
        dispatchedStatus = code;
        return this;
      },
      json(payload: unknown) {
        dispatchedBody = payload;
      },
      setHeader(name: string, value: string | string[]) {
        headersSent[name] = value;
      },
    },
    'POST',
    async () => {
      throw new Error('Unexpected test boom');
    },
  );
  assert.equal(dispatchedStatus, 500);
  assert.equal((dispatchedBody as { error: string }).error, 'internal_error');
  assert.equal((dispatchedBody as { category: string }).category, 'server_internal');
  assert.equal(headersSent['Cache-Control'], 'no-store');
});

test('AQ. Authorization key compatibility: x-goog-api-key SDK headers, redacted vault hint, and honest 5-part connection test', async () => {
  // 1. SDK authentication header verification: createGeminiClient injects x-goog-api-key (NEVER Authorization: Bearer)
  const dummyAqKey = 'AQ.Ab8RN6DummyAuthKeyForSdkHeaderCheck_0123456789';
  const client = createGeminiClient(` \uFEFF${dummyAqKey}\n `) as unknown as {
    apiClient: {
      clientOptions: {
        httpOptions?: { baseUrl?: string };
        auth?: { addAuthHeaders: (headers: Headers) => Promise<void> };
      };
    };
  };
  const headers = new Headers();
  await client.apiClient.clientOptions.auth?.addAuthHeaders(headers);
  assert.equal(headers.get('x-goog-api-key'), dummyAqKey);
  assert.equal(headers.get('authorization'), null);
  assert.equal(
    client.apiClient.clientOptions.httpOptions?.baseUrl,
    'https://generativelanguage.googleapis.com/',
  );

  // 2. Encryption & redacted vault hint satisfy firestore.rules bounds with zero key characters exposed
  const longAqKey = `AQ.${'Ab8_Cd9-Ef0'.repeat(34)}XYZ`;
  assert.ok(longAqKey.length <= 380);
  const encLong = encryptApiKeyForUid(longAqKey, 'uid-aq-1');
  assert.ok(encLong.ciphertext.length <= 512);
  assert.equal(encLong.keyHint, REDACTED_VAULT_KEY_HINT);
  assert.match(encLong.keyHint, /^.+\.\.\..+$/);
  assert.ok(encLong.keyHint.length >= 4 && encLong.keyHint.length <= 32);
  assert.ok(!encLong.keyHint.includes('AQ.') && !encLong.keyHint.includes('XYZ'));
  assert.equal(decryptApiKeyForUid(encLong, 'uid-aq-1'), longAqKey);
  assert.equal(decryptApiKeyForUid(encLong, 'uid-aq-2'), null);
  assert.equal(maskGeminiApiKey(dummyAqKey), REDACTED_VAULT_KEY_HINT);

  // 3. Connection test passes ONLY when both models.list and generateContent succeed
  clearGeminiModelCacheForTesting();
  const okRes = await testGeminiPersonalKey(dummyAqKey, undefined, {
    models: {
      list: async () => ({
        page: [
          { name: 'models/gemini-4-hydrogen', supportedActions: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
        ],
      }),
      generateContent: async () => ({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    },
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.apiKeyAuthOk, true);
  assert.equal(okRes.modelAccessible, true);
  assert.equal(okRes.generateContentOk, true);
  assert.equal(okRes.keyType, 'auth_aq');
  assert.equal(okRes.usage.totalTokens, 7);
  assert.equal(okRes.warning, undefined);

  // 4. Invalid API key or incompatible auth header on models.list throws distinct GeminiServiceError
  clearGeminiModelCacheForTesting();
  await assert.rejects(
    () =>
      testGeminiPersonalKey(dummyAqKey, undefined, {
        models: {
          list: async () => {
            throw new Error('400 API_KEY_INVALID: API key not valid');
          },
          generateContent: async () => ({}),
        },
      }),
    (err: unknown) => err instanceof GeminiServiceError && err.code === 'invalid_api_key',
  );

  clearGeminiModelCacheForTesting();
  await assert.rejects(
    () =>
      testGeminiPersonalKey(dummyAqKey, undefined, {
        models: {
          list: async () => {
            throw new Error('401 ACCESS_TOKEN_TYPE_UNSUPPORTED');
          },
          generateContent: async () => ({}),
        },
      }),
    (err: unknown) => err instanceof GeminiServiceError && err.code === 'gemini_auth_header_error',
  );
  assert.equal(
    mapGeminiError(new Error('401 ACCESS_TOKEN_TYPE_UNSUPPORTED')).code,
    'gemini_auth_header_error',
  );

  // 5. CRITICAL: When models.list succeeds but configured model generateContent fails (404),
  //    test must report ok=false, apiKeyAuthOk=true, generateContentOk=false (never mask as pass!)
  clearGeminiModelCacheForTesting();
  const prevModel = process.env.GEMINI_MODEL;
  let modelMismatchRes;
  try {
    process.env.GEMINI_MODEL = 'gemini-missing-model';
    modelMismatchRes = await testGeminiPersonalKey(dummyAqKey, undefined, {
      models: {
        list: async () => ({
          page: [{ name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] }],
        }),
        generateContent: async ({ model }) => {
          if (model !== 'gemini-2.5-flash') {
            throw new Error(`404 models/${model} is not found`);
          }
          return {
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          };
        },
      },
    });
  } finally {
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
  assert.equal(modelMismatchRes.ok, false);
  assert.equal(modelMismatchRes.apiKeyAuthOk, true);
  assert.equal(modelMismatchRes.modelAccessible, false);
  assert.equal(modelMismatchRes.generateContentOk, false);
  assert.equal(modelMismatchRes.configuredModel, 'gemini-missing-model');
  assert.equal(modelMismatchRes.diagnosticCategory, 'model_not_supported');
  assert.equal(modelMismatchRes.recommendedModel, 'gemini-2.5-flash');
  assert.deepEqual(modelMismatchRes.availableGenerateModels, ['gemini-2.5-flash']);
  assert.equal(modelMismatchRes.keyType, 'auth_aq');
  assert.ok(modelMismatchRes.warning && modelMismatchRes.warning.includes('GEMINI_MODEL'));

  // 6. Route test returns structured 5-part diagnostic without keyHint or raw key
  const activeAuth = async () => ({
    uid: 'teacher-aq-1',
    email: 'aq@icedu.kr',
    emailVerified: true,
    accessStatus: 'active' as const,
    role: 'teacher',
  });
  const aqRouteRes = await handleTestByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: ` \n${dummyAqKey}\t ` },
    },
    {
      verifyAuth: activeAuth,
      testApiKey: async () => modelMismatchRes,
    },
  );
  assert.equal(aqRouteRes.status, 200);
  const aqBody = aqRouteRes.body as Record<string, unknown>;
  assert.equal(aqBody.ok, false);
  assert.equal(aqBody.apiKeyAuthOk, true);
  assert.equal(aqBody.generateContentOk, false);
  assert.equal(aqBody.modelAccessible, false);
  assert.equal(aqBody.configuredModel, 'gemini-missing-model');
  assert.equal(aqBody.keyType, 'auth_aq');
  assert.equal('keyHint' in aqBody, false);
  assert.ok(!JSON.stringify(aqRouteRes.body).includes(dummyAqKey));
  assert.ok(!JSON.stringify(aqRouteRes.body).includes('Ab8RN6'));
  assert.ok(!JSON.stringify(aqRouteRes.body).includes('6789'));
});

test('thinkingConfig uses bounded thinkingBudget on gemini-2.5-flash, avoids MINIMAL on gemini-4, and day planner works + falls back on 404', async () => {
  // 1. Model-aware thinkingConfig rules
  assert.equal(buildThinkingConfigForModel('gemini-2.5-flash', 'probe'), undefined);
  assert.deepEqual(buildThinkingConfigForModel('gemini-2.5-flash', 'minimal_extract'), {
    thinkingBudget: 128,
  });
  assert.deepEqual(buildThinkingConfigForModel('gemini-2.5-flash', 'low_reasoning'), {
    thinkingBudget: 512,
  });
  assert.deepEqual(buildThinkingConfigForModel('gemini-2.5-pro', 'low_reasoning'), {
    thinkingBudget: 512,
  });
  assert.deepEqual(buildThinkingConfigForModel('gemini-4-hydrogen', 'probe'), {
    thinkingLevel: ThinkingLevel.LOW,
  });
  assert.deepEqual(buildThinkingConfigForModel('gemini-3.1-flash-lite-preview', 'probe'), {
    thinkingLevel: ThinkingLevel.MINIMAL,
  });
  assert.deepEqual(buildThinkingConfigForModel('gemini-3-flash-preview', 'low_reasoning'), {
    thinkingLevel: ThinkingLevel.LOW,
  });

  // 2. inspectListedGeminiModels filters to active generateContent text models only
  const inspection = inspectListedGeminiModels(
    [
      { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-tts', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.0-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3-flash-preview', supportedActions: ['generateContent'] },
    ],
    'gemini-missing-test',
  );
  assert.deepEqual(inspection.availableGenerateModels, [
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
  ]);
  assert.equal(inspection.recommendedFallbackModel, 'gemini-3-flash-preview');

  const samplePlannerInput = {
    todayKey: '2026-11-16',
    currentTimeHhMm: '09:00',
    totalIncompleteCount: 1,
    overdueCount: 0,
    dueTodayCount: 1,
    timetableConfigured: true,
    remainingWorkableMinutes: 50,
    workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
    blockedEventsSummary: [],
    academicAlertsSummary: [],
    tasks: [
      { id: 't1', t: '가정통신문 결재', d: '2026-11-16', ov: false, dd: 0, p: 'u' as const, s: 'td' as const, m: 25, tdy: true },
    ],
  };

  const prevModel = process.env.GEMINI_MODEL;
  try {
    // 3. With GEMINI_MODEL=gemini-2.5-flash, generateDayPlanWithGemini sends bounded thinkingBudget & higher maxOutputTokens
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    const capturedConfigs: Array<Record<string, unknown> | undefined> = [];
    const planOk = await generateDayPlanWithGemini(
      'AQ.Ab8DummyPlannerKey_1234567890ABCDEF',
      samplePlannerInput,
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            capturedConfigs.push(params.config);
            return {
              text: JSON.stringify({
                coreAdvice: '2교시 공강에 긴급 결재를 완료하세요.',
                recommendations: [
                  {
                    taskId: 't1',
                    order: 1,
                    recommendedStart: '10:00',
                    recommendedEnd: '10:25',
                    estimatedMinutes: 25,
                    tier: 'must',
                    strategy: '공문 양식 확인 후 즉시 결재 상신',
                    reason: '오늘 마감 긴급 업무입니다.',
                  },
                ],
                attentionTasks: [],
                deferredTasks: [],
              }),
              usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
            };
          },
        },
      },
    );
    assert.equal(planOk.model, 'gemini-2.5-flash');
    assert.equal(capturedConfigs.length, 1);
    assert.deepEqual(capturedConfigs[0]?.thinkingConfig, { thinkingBudget: 512 });
    assert.equal(capturedConfigs[0]?.maxOutputTokens, 3072);
    assert.equal(planOk.rawPlan.recommendations[0].taskId, 't1');
    assert.equal(planOk.rawPlan.recommendations[0].tier, 'must');

    // 4. When configured model returns 404 NOT_FOUND, planner does NOT silently switch models or retry blindly;
    //    it queries models.list (0-token diagnostic) once and throws 502 model_not_found with recommendedModel metadata.
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-unavailable-alias';
    const attemptedModels: string[] = [];
    await assert.rejects(
      () =>
        generateDayPlanWithGemini(
          'AQ.Ab8DummyPlannerKey_1234567890ABCDEF',
          samplePlannerInput,
          undefined,
          {
            models: {
              list: async () => ({
                page: [
                  { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
                  { name: 'models/gemini-2.5-flash-tts', supportedActions: ['generateContent'] },
                  { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
                ],
              }),
              generateContent: async (params) => {
                attemptedModels.push(params.model);
                throw new Error('404 models/gemini-unavailable-alias is not found');
              },
            },
          },
        ),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'model_not_found' &&
        err.diagnosticCategory === 'model_not_supported' &&
        err.upstreamHttpStatus === 404 &&
        err.upstreamApiStatus === 'NOT_FOUND' &&
        err.recommendedModel === 'gemini-2.5-flash' &&
        err.availableGenerateModels?.includes('gemini-2.5-flash') === true,
    );
    assert.deepEqual(attemptedModels, ['gemini-unavailable-alias']);

    // 5. Permission denied (403) must NOT be hidden or retried as model_not_found
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    await assert.rejects(
      () =>
        generateDayPlanWithGemini(
          'AQ.Ab8DummyPlannerKey_1234567890ABCDEF',
          samplePlannerInput,
          undefined,
          {
            models: {
              list: async () => ({
                page: [{ name: 'models/gemini-3-flash-preview', supportedActions: ['generateContent'] }],
              }),
              generateContent: async () => {
                throw new Error('403 PERMISSION_DENIED: model not permitted for project');
              },
            },
          },
        ),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.code === 'model_permission_denied' &&
        err.diagnosticCategory === 'model_permission_denied' &&
        err.upstreamHttpStatus === 403,
    );
  } finally {
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('verifyAuthBeforeSave avoids generateContent on save, and no route ever exposes keyHint or partial key strings', async () => {
  const activeAuth = async () => ({
    uid: 'teacher-no-leak-1',
    email: 'noleak@icedu.kr',
    emailVerified: true,
    accessStatus: 'active' as const,
    role: 'teacher',
  });
  const aqDummyKey = 'AQ.Ab8RN6DummySecretKeyNeverExpose_TvAg99';
  let authOnlyCalls = 0;
  let generateProbeCalls = 0;

  const saveRes = await handleSaveByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: aqDummyKey, verifyAuthBeforeSave: true },
      isSecure: false,
    },
    {
      verifyAuth: activeAuth,
      verifyKeyAuthOnly: async (key) => {
        authOnlyCalls += 1;
        assert.equal(key, aqDummyKey);
        return { keyType: 'auth_aq', availableGenerateModels: ['gemini-2.5-flash'] };
      },
      testApiKey: async () => {
        generateProbeCalls += 1;
        throw new Error('testApiKey must NOT run during verifyAuthBeforeSave');
      },
    },
  );
  assert.equal(saveRes.status, 200);
  assert.equal(authOnlyCalls, 1);
  assert.equal(generateProbeCalls, 0);

  const statusRes = await handleAiStatusRequest('Bearer test-token', {
    verifyAuth: activeAuth,
  });
  assert.equal(statusRes.status, 200);

  const delRes = await handleDeleteByokKeyRequest(
    { authorizationHeader: 'Bearer test-token', isSecure: false },
    { verifyAuth: activeAuth },
  );
  assert.equal(delRes.status, 200);

  for (const res of [saveRes, statusRes, delRes]) {
    const bodyObj = res.body as Record<string, unknown>;
    assert.equal('keyHint' in bodyObj, false);
    const serialized = JSON.stringify(bodyObj);
    assert.ok(!serialized.includes('AQ.Ab8'));
    assert.ok(!serialized.includes('TvAg'));
    assert.ok(!serialized.includes(aqDummyKey));
  }
});

test('SDK wire inspection, upstream 404 redaction/classification, single-probe test, models.list caching, and max-1 fallback retry', async () => {
  // 1. Inspect actual @google/genai SDK fetch calls for models.list and generateContent
  const dummyAqKey = 'AQ.Ab8RN6WireInspectDummyKey_0123456789ABCD';
  const traceRequests: Array<{ url: string; method: string; apiKeyHeader: string | null; authHeader: string | null }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    traceRequests.push({
      url: reqUrl,
      method: (init?.method ?? 'GET').toUpperCase(),
      apiKeyHeader: headers.get('x-goog-api-key'),
      authHeader: headers.get('authorization'),
    });
    if (reqUrl.includes(':generateContent')) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const sdkClient = createGeminiClient(dummyAqKey);
    await sdkClient.models.list({ config: { pageSize: 100 } });
    await sdkClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Reply with OK.',
      config: { maxOutputTokens: 16 },
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(traceRequests.length, 2);
  assert.equal(traceRequests[0].method, 'GET');
  assert.equal(
    traceRequests[0].url,
    'https://generativelanguage.googleapis.com/v1/models?pageSize=100',
  );
  assert.equal(traceRequests[1].method, 'POST');
  assert.equal(
    traceRequests[1].url,
    'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
  );
  assert.ok(!traceRequests[1].url.includes('models/models/'));
  assert.ok(!traceRequests[1].url.includes('key='));
  assert.equal(traceRequests[0].apiKeyHeader, dummyAqKey);
  assert.equal(traceRequests[1].apiKeyHeader, dummyAqKey);
  assert.equal(traceRequests[0].authHeader, null);
  assert.equal(traceRequests[1].authHeader, null);

  // 2. Sanitize & classify Google 404 messages without exposing key fragments
  const sanitized = sanitizeUpstreamErrorMessage(
    '404 NOT_FOUND for key=AIzaSyDummyLeak1234567890ABCDEF and AQ.Ab8SecretPart1234567890 and Bearer secret.jwt.token',
  );
  assert.ok(sanitized);
  assert.ok(!sanitized.includes('AIzaSy'));
  assert.ok(!sanitized.includes('AQ.Ab8'));
  assert.ok(!sanitized.includes('secret.jwt.token'));
  assert.ok(sanitized.includes('[REDACTED_KEY]'));

  const newUsers404 = mapGeminiError(
    new Error(
      '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.","status":"NOT_FOUND"}}',
    ),
    'gemini-2.5-flash',
  );
  assert.equal(newUsers404.code, 'model_not_found');
  assert.equal(newUsers404.upstreamHttpStatus, 404);
  assert.equal(newUsers404.upstreamApiStatus, 'NOT_FOUND');
  assert.ok(newUsers404.upstreamErrorMessage?.includes('no longer available to new users'));
  assert.ok(newUsers404.message.includes('신규 키·계정'));

  const versionMismatch404 = mapGeminiError(
    new Error(
      '404 NOT_FOUND: models/gemini-3-flash-preview is not found for API version v1, or is not supported for generateContent.',
    ),
    'gemini-3-flash-preview',
  );
  assert.equal(versionMismatch404.code, 'model_not_found');
  assert.ok(versionMismatch404.message.includes('API 버전(v1)'));

  // 3. testGeminiPersonalKey runs strictly ONE generateContent call (no 2nd probe on 404) & caches models.list
  clearGeminiModelCacheForTesting();
  const prevModel = process.env.GEMINI_MODEL;
  try {
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    let listCalls = 0;
    let generateCalls = 0;
    const mock404Client = {
      models: {
        list: async () => {
          listCalls += 1;
          return {
            page: [
              { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
              { name: 'models/gemini-2.5-pro', supportedActions: ['generateContent'] },
              { name: 'models/gemini-3.5-flash', supportedActions: ['generateContent'] },
            ],
          };
        },
        generateContent: async () => {
          generateCalls += 1;
          throw new Error(
            '404 NOT_FOUND: This model models/gemini-2.5-flash is no longer available to new users.',
          );
        },
      },
    };

    const firstDiag = await testGeminiPersonalKey(dummyAqKey, undefined, mock404Client);
    assert.equal(firstDiag.ok, false);
    assert.equal(firstDiag.apiKeyAuthOk, true);
    assert.equal(firstDiag.modelAccessible, false);
    assert.equal(firstDiag.generateContentOk, false);
    assert.equal(firstDiag.requestApiVersion, getEffectiveGeminiApiVersion());
    assert.equal(firstDiag.requestEndpoint, 'models/gemini-2.5-flash:generateContent');
    assert.equal(firstDiag.modelListCached, false);
    assert.equal(firstDiag.recommendedModel, 'gemini-3.5-flash');
    assert.ok(firstDiag.upstreamErrorMessage?.includes('no longer available to new users'));
    assert.equal(listCalls, 1);
    assert.equal(generateCalls, 1); // Strictly 1 generateContent call!

    // Second test reuses models.list cache (0 additional list calls, 1 generateContent probe)
    const secondDiag = await testGeminiPersonalKey(dummyAqKey, undefined, mock404Client);
    assert.equal(secondDiag.modelListCached, true);
    assert.equal(listCalls, 1);
    assert.equal(generateCalls, 2);

    // Route forwards requestEndpoint, requestApiVersion, modelListCached, upstreamErrorMessage cleanly
    const routeDiagRes = await handleTestByokKeyRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: { apiKey: dummyAqKey },
      },
      {
        verifyAuth: async () => ({
          uid: 'teacher-diag-1',
          email: 'diag@icedu.kr',
          emailVerified: true,
          accessStatus: 'active' as const,
          role: 'teacher',
        }),
        testApiKey: async () => firstDiag,
      },
    );
    assert.equal(routeDiagRes.status, 200);
    const routeBody = routeDiagRes.body as Record<string, unknown>;
    assert.equal(routeBody.requestApiVersion, 'v1');
    assert.equal(routeBody.requestEndpoint, 'models/gemini-2.5-flash:generateContent');
    assert.equal(routeBody.modelListCached, false);
    assert.ok(
      typeof routeBody.upstreamErrorMessage === 'string' &&
        routeBody.upstreamErrorMessage.includes('no longer available to new users'),
    );
    assert.ok(!JSON.stringify(routeBody).includes(dummyAqKey));

    // 4. Planner and notice analysis perform strictly 1 generateContent call on 404 (no blind fallback retry)
    //    and reuse the cached 0-token models.list diagnostics without repeating models.list or turning 404 into 504
    clearGeminiModelCacheForTesting();
    let plannerListCalls = 0;
    let plannerGenerateCalls = 0;
    const samplePlannerInput = {
      todayKey: '2026-11-16',
      currentTimeHhMm: '09:00',
      totalIncompleteCount: 1,
      overdueCount: 0,
      dueTodayCount: 1,
      timetableConfigured: true,
      remainingWorkableMinutes: 50,
      workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
      blockedEventsSummary: [],
      academicAlertsSummary: [],
      tasks: [
        { id: 't1', t: '문서 정리', d: '2026-11-16', ov: false, dd: 0, p: 'n' as const, s: 'td' as const, m: 20, tdy: true },
      ],
    };
    const diagnosticClient = {
      models: {
        list: async () => {
          plannerListCalls += 1;
          return {
            page: [
              { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
              { name: 'models/gemini-3.5-flash', supportedActions: ['generateContent'] },
            ],
          };
        },
        generateContent: async () => {
          plannerGenerateCalls += 1;
          throw new Error(
            '404 NOT_FOUND: This model models/gemini-2.5-flash is no longer available to new users.',
          );
        },
      },
    };

    await assert.rejects(
      () => generateDayPlanWithGemini(dummyAqKey, samplePlannerInput, undefined, diagnosticClient, 'req_plan_404_1'),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'model_not_found' &&
        err.diagnosticCategory === 'model_not_supported' &&
        err.upstreamHttpStatus === 404 &&
        err.upstreamApiStatus === 'NOT_FOUND' &&
        err.requestId === 'req_plan_404_1' &&
        err.recommendedModel === 'gemini-3.5-flash',
    );
    assert.equal(plannerListCalls, 1);
    assert.equal(plannerGenerateCalls, 1); // Strictly 1 generateContent call — NO speculative retry on another model

    // Second 404 call reuses cached models.list (0 extra list calls) and still makes only 1 generateContent call
    await assert.rejects(
      () =>
        analyzeNoticeWithGemini(
          dummyAqKey,
          { text: '11월 20일까지 제출', todayKey: '2026-11-16', existingItems: [] },
          undefined,
          diagnosticClient,
          'req_notice_404_2',
        ),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'model_not_found' &&
        err.requestId === 'req_notice_404_2' &&
        err.recommendedModel === 'gemini-3.5-flash',
    );
    assert.equal(plannerListCalls, 1);
    assert.equal(plannerGenerateCalls, 2);
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('planner supports must/optional tiers, execution strategy, and linked-today-event signal without leaking descriptions', () => {
  const now = new Date('2026-11-16T08:30:00+09:00');
  const todayKey = '2026-11-16';
  const timetable = makeTimetable();
  const meeting: CalendarEventRecord = {
    id: 'ev-today-meeting',
    title: '교과 협의회',
    startsAt: Timestamp.fromDate(new Date('2026-11-16T14:20:00+09:00')),
    endsAt: Timestamp.fromDate(new Date('2026-11-16T15:10:00+09:00')),
    allDay: false,
    location: '회의실',
    description: '비공개 회의 안건 상세',
    relatedTaskId: null,
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };

  const tasks = [
    makeTask({
      id: 't-must',
      title: '협의회 안건 자료 준비',
      priority: 'high',
      dueAt: Timestamp.fromDate(new Date('2026-11-16T23:59:59+09:00')),
      relatedEventId: 'ev-today-meeting',
      estimatedMinutes: 30,
      description: '민감 메모 절대 전송 금지',
    }),
    makeTask({
      id: 't-opt',
      title: '교구 목록 정비',
      priority: 'low',
      estimatedMinutes: 25,
      description: '민감 메모2',
    }),
  ];

  const ctx = buildAiPlannerContext({
    uid: 'teacher-strategy',
    todayKey,
    now,
    tasks,
    events: [meeting],
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
  });

  const mustCompact = ctx.compressedRequest.tasks.find((t) => t.id === 't-must');
  assert.equal(mustCompact?.ev, true);
  assert.ok(!JSON.stringify(ctx.compressedRequest).includes('민감 메모'));

  const detPlan = buildDeterministicDayPlan(ctx);
  assert.equal(detPlan.recommendations[0].tier, 'must');
  assert.ok(detPlan.recommendations[0].strategy?.includes('일정'));
  assert.equal(detPlan.recommendations[1].tier, 'optional');

  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '오전 공강에 회의 자료를 먼저 준비하세요.',
      recommendations: [
        {
          taskId: 't-must',
          order: 1,
          recommendedStart: '10:00',
          recommendedEnd: '10:30',
          estimatedMinutes: 30,
          tier: 'must',
          reason: '오후 협의회 전에 마쳐야 합니다.',
          strategy: '자료 핵심 항목 3가지만 먼저 정리 후 출력하세요.',
        },
        {
          taskId: 't-opt',
          order: 2,
          recommendedStart: '13:20',
          recommendedEnd: '13:45',
          estimatedMinutes: 25,
          tier: 'optional',
          reason: '여유 시간대에 처리 가능합니다.',
          strategy: '목록 시트 기준 누락 품목만 우선 확인하세요.',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    ctx,
    { model: 'gemini-2.5-flash', generatedAtIso: '2026-11-16T00:00:00Z' },
  );

  assert.equal(validated.recommendations[0].tier, 'must');
  assert.equal(
    validated.recommendations[0].strategy,
    '자료 핵심 항목 3가지만 먼저 정리 후 출력하세요.',
  );
  assert.equal(validated.recommendations[1].tier, 'optional');
});

test('planner truncation/invalid JSON maps to 502 (never 500 internal_error), notice analysis bounds thinking, and failed calls never increment usage', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  clearGeminiModelCacheForTesting();
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';

  try {
    // 1. parseGeminiJsonResponse classifies truncated MAX_TOKENS JSON as 502 ai_response_truncated (NOT SyntaxError -> 500)
    assert.throws(
      () =>
        parseGeminiJsonResponse({
          response: {
            text: '{"coreAdvice":"우선 급한 공문부터","recommendations":[{"taskId":"t1","tier":"must","strategy":"핵심만',
            candidates: [{ finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 450, thoughtsTokenCount: 950, totalTokenCount: 2300 },
          },
          model: 'gemini-2.5-flash',
          operation: 'planner',
          emptyMessage: 'empty',
        }),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'ai_response_truncated',
    );

    // 2. parseGeminiJsonResponse classifies malformed JSON without MAX_TOKENS as 502 ai_invalid_json
    assert.throws(
      () =>
        parseGeminiJsonResponse({
          response: {
            text: 'not valid json {broken',
            candidates: [{ finishReason: 'STOP' }],
          },
          model: 'gemini-2.5-flash',
          operation: 'planner',
          emptyMessage: 'empty',
        }),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'ai_invalid_json',
    );

    // 3. generateDayPlanWithGemini on truncated response returns 502 GeminiServiceError instead of 500
    const samplePlannerInput = {
      todayKey: '2026-11-17',
      currentTimeHhMm: '09:00',
      totalIncompleteCount: 1,
      overdueCount: 0,
      dueTodayCount: 1,
      timetableConfigured: true,
      remainingWorkableMinutes: 50,
      workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
      blockedEventsSummary: [],
      academicAlertsSummary: [],
      tasks: [
        { id: 't1', t: '공문 회신', d: '2026-11-17', ov: false, dd: 0, p: 'u' as const, s: 'td' as const, m: 25, tdy: true },
      ],
    };

    await assert.rejects(
      () =>
        generateDayPlanWithGemini(
          'AQ.Ab8DummyPlannerTruncKey_1234567890',
          samplePlannerInput,
          undefined,
          {
            models: {
              list: async () => ({ page: [] }),
              generateContent: async () => ({
                text: '{"coreAdvice":"중단됨',
                candidates: [{ finishReason: 'MAX_TOKENS' }],
                usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400, thoughtsTokenCount: 1000, totalTokenCount: 2200 },
              }),
            },
          },
        ),
      (err: unknown) =>
        err instanceof GeminiServiceError &&
        err.status === 502 &&
        err.code === 'ai_response_truncated',
    );

    // 4. analyzeNoticeWithGemini on 23-line notice sends minimal_extract thinkingBudget=128 & maxOutputTokens=3072,
    //    and if thinkingConfig is rejected with 400 on clientOverride, retries once without thinkingConfig and caches.
    const twentyThreeLineNotice = Array.from(
      { length: 23 },
      (_, idx) => `${idx + 1}. 11월 ${20 + (idx % 5)}일까지 ${idx + 1}번 학급 안내문 확인 및 제출`,
    ).join('\n');
    let noticeAttempt = 0;
    const noticeConfigs: Array<Record<string, unknown> | undefined> = [];
    const noticeRes = await analyzeNoticeWithGemini(
      'AQ.Ab8DummyNoticeKey_1234567890ABCDEF',
      { text: twentyThreeLineNotice, todayKey: '2026-11-17', existingItems: [] },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            noticeAttempt += 1;
            noticeConfigs.push(params.config);
            if (noticeAttempt === 1) {
              throw new Error('400 INVALID_ARGUMENT: Unknown name "thinkingConfig" at generation_config');
            }
            return {
              text: JSON.stringify({
                candidates: [
                  {
                    kind: 'task',
                    title: '학급 안내문 확인 및 제출',
                    description: '',
                    dueDate: '2026-11-20',
                    priority: 'normal',
                  },
                ],
                unparsedSummary: [],
              }),
              usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80, totalTokenCount: 380 },
            };
          },
        },
      },
    );
    assert.equal(noticeAttempt, 2);
    assert.deepEqual(noticeConfigs[0]?.thinkingConfig, { thinkingBudget: 128 });
    assert.equal(noticeConfigs[0]?.maxOutputTokens, 3072);
    assert.equal(noticeConfigs[1]?.thinkingConfig, undefined);
    assert.equal(noticeRes.rawOutput.candidates.length, 1);

    // 5. Route-level usage policy: failed requests (timeout / truncated) do NOT increment usage;
    //    successful notice vs planner requests separate todayNoticeCount and todayPlanCount.
    const uid = 'teacher-usage-policy-1';
    const activeAuth = async () => ({
      uid,
      email: 'policy@icedu.kr',
      emailVerified: true,
      accessStatus: 'active' as const,
      role: 'teacher',
    });
    const resolveKey = async () => ({
      apiKey: 'AQ.Ab8DummyPolicyKey_1234567890ABCDEF',
      keyType: 'auth_aq' as const,
    });

    // Failed notice timeout -> 504 ai_timeout, usage remains 0
    const timeoutRes = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: { text: twentyThreeLineNotice, todayKey: '2026-11-17' },
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: resolveKey,
        analyzeNotice: async () => {
          throw new GeminiServiceError(504, 'ai_timeout', 'AI 서버 응답 시간이 초과되었습니다.');
        },
      },
    );
    assert.equal(timeoutRes.status, 504);

    // Failed planner truncated -> 502 ai_response_truncated (NOT 500), usage remains 0
    const truncatedRouteRes = await handleAiPlannerRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: samplePlannerInput,
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: resolveKey,
        generateDayPlan: async () => {
          throw new GeminiServiceError(502, 'ai_response_truncated', 'AI 응답 길이 초과');
        },
      },
    );
    assert.equal(truncatedRouteRes.status, 502);

    const statusAfterFailures = await handleAiStatusRequest('Bearer test-token', {
      verifyAuth: activeAuth,
      resolveApiKey: resolveKey,
    });
    const failUsage = (statusAfterFailures.body as { usage: { todayPlanCount: number; todayNoticeCount: number; todayTotalCount: number } }).usage;
    assert.equal(failUsage.todayPlanCount, 0);
    assert.equal(failUsage.todayNoticeCount, 0);
    assert.equal(failUsage.todayTotalCount, 0);

    // Success notice analysis -> todayNoticeCount=1, todayPlanCount=0, todayTotalCount=1
    const okNotice = await handleAnalyzeNoticeRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: { text: '11월 20일까지 제출', todayKey: '2026-11-17' },
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: resolveKey,
        analyzeNotice: async () => noticeRes,
      },
    );
    assert.equal(okNotice.status, 200);
    const noticeSnap = (okNotice.body as { usageSnapshot?: { todayPlanCount: number; todayNoticeCount: number; todayTotalCount: number } }).usageSnapshot;
    assert.equal(noticeSnap?.todayPlanCount, 0);
    assert.equal(noticeSnap?.todayNoticeCount, 1);
    assert.equal(noticeSnap?.todayTotalCount, 1);

    // Success planner -> todayPlanCount=1, todayNoticeCount=1, todayTotalCount=2
    const okPlanner = await handleAiPlannerRequest(
      {
        authorizationHeader: 'Bearer test-token',
        body: samplePlannerInput,
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: resolveKey,
        generateDayPlan: async () => ({
          model: 'gemini-2.5-flash',
          generatedAtIso: '2026-11-17T01:00:00Z',
          rawPlan: {
            coreAdvice: '공강 활용',
            recommendations: [],
            attentionTasks: [],
            deferredTasks: [],
          },
          usage: { inputTokens: 100, outputTokens: 50, thoughtTokens: 120, totalTokens: 270 },
        }),
      },
    );
    assert.equal(okPlanner.status, 200);
    const planSnap = (okPlanner.body as { usageSnapshot?: { todayPlanCount: number; todayNoticeCount: number; todayTotalCount: number } }).usageSnapshot;
    assert.equal(planSnap?.todayPlanCount, 1);
    assert.equal(planSnap?.todayNoticeCount, 1);
    assert.equal(planSnap?.todayTotalCount, 2);

    // 6. Malformed cookie percent encoding never crashes parseCookies with 500 URIError
    const parsedMalformedCookie = parseCookies('bad=%E0%A4%A; good=hello%20world');
    assert.equal(parsedMalformedCookie.bad, '%E0%A4%A');
    assert.equal(parsedMalformedCookie.good, 'hello world');
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('Gemini 404 vs 504 classification, requestId propagation, env apiVersion, and notice/planner config parity', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  const prevApiVersion = process.env.GOOGLE_GENAI_API_VERSION;
  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    delete process.env.GOOGLE_GENAI_API_VERSION;

    // 1. Upstream HTTP status (404 / 400 / 403 / 503) takes precedence over substring words like "timeout" or "abort"
    const notFoundWithTimeoutWord = mapGeminiError(
      Object.assign(new Error('404 NOT_FOUND: model lookup before timeout failed'), { status: 404 }),
      'gemini-2.5-flash',
    );
    assert.equal(notFoundWithTimeoutWord.status, 502);
    assert.equal(notFoundWithTimeoutWord.code, 'model_not_found');
    assert.equal(notFoundWithTimeoutWord.diagnosticCategory, 'model_not_supported');
    assert.equal(notFoundWithTimeoutWord.upstreamHttpStatus, 404);

    const invalidArgWithAbortWord = mapGeminiError(
      Object.assign(new Error('400 INVALID_ARGUMENT: schema validation aborted'), { status: 400 }),
      'gemini-2.5-flash',
    );
    assert.equal(invalidArgWithAbortWord.status, 400);
    assert.equal(invalidArgWithAbortWord.code, 'invalid_request_format');

    const localTimeout = mapGeminiError(
      Object.assign(new Error('Request timed out'), { name: 'LocalTimeoutError' }),
      'gemini-2.5-flash',
    );
    assert.equal(localTimeout.status, 504);
    assert.equal(localTimeout.code, 'ai_timeout');
    assert.equal(localTimeout.diagnosticCategory, 'timeout');

    const localAbort = mapGeminiError(
      Object.assign(new Error('Request aborted'), { name: 'LocalAbortError' }),
      'gemini-2.5-flash',
    );
    assert.equal(localAbort.status, 499);
    assert.equal(localAbort.code, 'ai_aborted');

    // 2. createGeminiClient respects GOOGLE_GENAI_API_VERSION ('v1' default, 'beta' -> 'v1beta')
    assert.equal(getEffectiveGeminiApiVersion(), 'v1');
    const defaultClient = createGeminiClient('AQ.Ab8DummyVersionKey_1234567890ABCDEF') as unknown as {
      apiClient?: { getApiVersion?: () => string };
    };
    assert.equal(defaultClient.apiClient?.getApiVersion?.(), 'v1');

    process.env.GOOGLE_GENAI_API_VERSION = 'beta';
    assert.equal(getEffectiveGeminiApiVersion(), 'v1beta');
    const betaClient = createGeminiClient('AQ.Ab8DummyVersionKey_1234567890ABCDEF') as unknown as {
      apiClient?: { getApiVersion?: () => string };
    };
    assert.equal(betaClient.apiClient?.getApiVersion?.(), 'v1beta');
    delete process.env.GOOGLE_GENAI_API_VERSION;

    // 3. resolveSafeRequestId reuses safe x-vercel-id / x-request-id and rejects API-key-like or unsafe headers
    assert.equal(resolveSafeRequestId({ 'x-vercel-id': 'icn1::abc123-999' }), 'icn1::abc123-999');
    assert.equal(resolveSafeRequestId({ 'x-request-id': 'req_custom_42' }), 'req_custom_42');
    const rejectedKeyHeader = resolveSafeRequestId({ 'x-request-id': 'AQ.SecretShouldNotBecomeId' });
    assert.match(rejectedKeyHeader, /^req_[a-f0-9]{12}$/);

    // 4. analyzeNoticeWithGemini & generateDayPlanWithGemini share identical model + endpoint + maxOutputTokens,
    //    differing only in schema & thinkingBudget (128 vs 512)
    const noticeReqCaptured: Array<{ model: string; config?: Record<string, unknown> }> = [];
    const plannerReqCaptured: Array<{ model: string; config?: Record<string, unknown> }> = [];

    await analyzeNoticeWithGemini(
      'AQ.Ab8DummyParityKey_1234567890ABCDEF',
      { text: '11월 20일까지 공문 제출', todayKey: '2026-11-16', existingItems: [] },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            noticeReqCaptured.push({ model: params.model, config: params.config });
            return {
              text: JSON.stringify({ candidates: [], unparsedSummary: [] }),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            };
          },
        },
      },
      'req_parity_notice',
    );

    await generateDayPlanWithGemini(
      'AQ.Ab8DummyParityKey_1234567890ABCDEF',
      {
        todayKey: '2026-11-16',
        currentTimeHhMm: '09:00',
        totalIncompleteCount: 1,
        overdueCount: 0,
        dueTodayCount: 1,
        timetableConfigured: true,
        remainingWorkableMinutes: 50,
        workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
        blockedEventsSummary: [],
        academicAlertsSummary: [],
        tasks: [
          { id: 't1', t: '공문 제출', d: '2026-11-16', ov: false, dd: 0, p: 'n', s: 'td', m: 20, tdy: true },
        ],
      },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            plannerReqCaptured.push({ model: params.model, config: params.config });
            return {
              text: JSON.stringify({
                coreAdvice: '공강 활용',
                recommendations: [],
                attentionTasks: [],
                deferredTasks: [],
              }),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            };
          },
        },
      },
      'req_parity_planner',
    );

    assert.equal(noticeReqCaptured[0]?.model, plannerReqCaptured[0]?.model);
    assert.equal(noticeReqCaptured[0]?.config?.maxOutputTokens, 3072);
    assert.equal(plannerReqCaptured[0]?.config?.maxOutputTokens, 3072);
    assert.equal(noticeReqCaptured[0]?.config?.responseMimeType, 'application/json');
    assert.equal(plannerReqCaptured[0]?.config?.responseMimeType, 'application/json');
    assert.deepEqual(noticeReqCaptured[0]?.config?.thinkingConfig, { thinkingBudget: 128 });
    assert.deepEqual(plannerReqCaptured[0]?.config?.thinkingConfig, { thinkingBudget: 512 });

    // 5. dispatchVercelAiRoute propagates requestId and returns 502 model_not_found (never 504) on 404 error
    const responseHeaders: Record<string, string | string[]> = {};
    let responseStatus = 0;
    let responseBody: Record<string, unknown> = {};
    const mockRes = {
      setHeader(name: string, value: string | string[]) {
        responseHeaders[name] = value;
      },
      status(code: number) {
        responseStatus = code;
        return mockRes;
      },
      json(payload: unknown) {
        responseBody = (payload ?? {}) as Record<string, unknown>;
      },
    };

    await dispatchVercelAiRoute(
      {
        method: 'POST',
        headers: { 'x-vercel-id': 'icn1::trace-404-route' },
        body: { text: '11월 20일까지 제출' },
      },
      mockRes,
      'POST',
      (signal, requestId) =>
        handleAnalyzeNoticeRequest(
          {
            authorizationHeader: 'Bearer test-token',
            body: { text: '11월 20일까지 제출', todayKey: '2026-11-16' },
            signal,
            requestId,
          },
          {
            verifyAuth: async () => ({
              uid: 'teacher-404-trace',
              email: 'trace@icedu.kr',
              emailVerified: true,
              accessStatus: 'active',
              role: 'teacher',
            }),
            resolveApiKey: async () => ({
              apiKey: 'AQ.Ab8DummyTraceKey_NeverExpose1234',
              keyType: 'auth_aq',
            }),
            analyzeNotice: async (_input, _signal, _apiKey, reqId) => {
              throw new GeminiServiceError(
                502,
                'model_not_found',
                'models.list 목록에는 표시되더라도 Google이 모델 호출을 거부했습니다.',
                {
                  diagnosticCategory: 'model_not_supported',
                  upstreamHttpStatus: 404,
                  upstreamApiStatus: 'NOT_FOUND',
                  requestId: reqId,
                  requestApiVersion: 'v1',
                  requestEndpoint: 'models/gemini-2.5-flash:generateContent',
                  availableGenerateModels: ['gemini-2.5-flash', 'gemini-3-flash-preview'],
                  recommendedModel: 'gemini-3-flash-preview',
                },
              );
            },
          },
        ),
    );

    assert.equal(responseStatus, 502);
    assert.equal(responseHeaders['X-Request-Id'], 'icn1::trace-404-route');
    assert.equal(responseBody.error, 'model_not_found');
    assert.equal(responseBody.diagnosticCategory, 'model_not_supported');
    assert.equal(responseBody.upstreamHttpStatus, 404);
    assert.equal(responseBody.upstreamApiStatus, 'NOT_FOUND');
    assert.equal(responseBody.requestId, 'icn1::trace-404-route');
    assert.equal(responseBody.requestApiVersion, 'v1');
    assert.equal(responseBody.requestEndpoint, 'models/gemini-2.5-flash:generateContent');
    assert.equal(responseBody.recommendedModel, 'gemini-3-flash-preview');
    assert.ok(!JSON.stringify(responseBody).includes('AQ.Ab8DummyTraceKey'));
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
    if (prevApiVersion === undefined) delete process.env.GOOGLE_GENAI_API_VERSION;
    else process.env.GOOGLE_GENAI_API_VERSION = prevApiVersion;
  }
});

test('gemini-4-hydrogen profile separation, thinkingLevel/JSON compatibility, and single-shot candidateModel verification', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  try {
    clearGeminiModelCacheForTesting();

    // 1. Model profile separation: gemini-4-hydrogen uses thinkingLevel=LOW and 4096 maxOutputTokens,
    //    while gemini-2.5-flash keeps thinkingBudget=128/512 and 3072 maxOutputTokens
    const h4Profile = getGeminiModelProfile('gemini-4-hydrogen');
    assert.equal(h4Profile.family, 'gemini-4');
    assert.equal(h4Profile.thinkingParamType, 'thinkingLevel');
    assert.equal(h4Profile.probe.maxOutputTokens, 128);
    assert.equal(h4Profile.probe.thinkingLevel, 'LOW');
    assert.equal(h4Profile.operations.analyze_notice.maxOutputTokens, 4096);
    assert.equal(h4Profile.operations.planner.maxOutputTokens, 4096);
    const h4Compat = toCompatibilitySummary(h4Profile);
    assert.equal(h4Compat.noticeThinkingSummary, 'thinkingLevel=LOW');
    assert.equal(h4Compat.plannerThinkingSummary, 'thinkingLevel=LOW');
    assert.equal(h4Compat.structuredJsonSupported, true);

    const g25Profile = getGeminiModelProfile('gemini-2.5-flash');
    assert.equal(g25Profile.family, 'gemini-2.5');
    assert.equal(g25Profile.thinkingParamType, 'thinkingBudget');
    assert.equal(g25Profile.operations.analyze_notice.thinkingBudget, 128);
    assert.equal(g25Profile.operations.planner.thinkingBudget, 512);
    assert.equal(g25Profile.operations.planner.maxOutputTokens, 3072);

    // 2. When GEMINI_MODEL=gemini-4-hydrogen, notice & planner send thinkingLevel=LOW + responseSchema + 4096 maxOutputTokens (never thinkingBudget)
    process.env.GEMINI_MODEL = 'gemini-4-hydrogen';
    const capturedNoticeConfigs: Array<Record<string, unknown> | undefined> = [];
    const capturedPlannerConfigs: Array<Record<string, unknown> | undefined> = [];

    await analyzeNoticeWithGemini(
      'AQ.Ab8DummyH4Key_1234567890ABCDEF',
      { text: '11월 25일까지 학사일정 제출', todayKey: '2026-11-17', existingItems: [] },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            capturedNoticeConfigs.push(params.config);
            return {
              text: JSON.stringify({ candidates: [], unparsedSummary: [] }),
              usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20, thoughtsTokenCount: 15, totalTokenCount: 125 },
            };
          },
        },
      },
      'req_h4_notice',
    );
    assert.deepEqual(capturedNoticeConfigs[0]?.thinkingConfig, { thinkingLevel: ThinkingLevel.LOW });
    assert.equal(capturedNoticeConfigs[0]?.maxOutputTokens, 4096);
    assert.equal(capturedNoticeConfigs[0]?.responseMimeType, 'application/json');
    assert.ok(capturedNoticeConfigs[0]?.responseSchema);

    await generateDayPlanWithGemini(
      'AQ.Ab8DummyH4Key_1234567890ABCDEF',
      {
        todayKey: '2026-11-17',
        currentTimeHhMm: '09:00',
        totalIncompleteCount: 1,
        overdueCount: 0,
        dueTodayCount: 1,
        timetableConfigured: true,
        remainingWorkableMinutes: 50,
        workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
        blockedEventsSummary: [],
        academicAlertsSummary: [],
        tasks: [
          { id: 't1', t: '학사일정 제출', d: '2026-11-17', ov: false, dd: 0, p: 'u', s: 'td', m: 20, tdy: true },
        ],
      },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            capturedPlannerConfigs.push(params.config);
            return {
              text: JSON.stringify({
                coreAdvice: '공강 시간에 처리하세요.',
                recommendations: [],
                attentionTasks: [],
                deferredTasks: [],
              }),
              usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 35, thoughtsTokenCount: 40, totalTokenCount: 215 },
            };
          },
        },
      },
      'req_h4_planner',
    );
    assert.deepEqual(capturedPlannerConfigs[0]?.thinkingConfig, { thinkingLevel: ThinkingLevel.LOW });
    assert.equal(capturedPlannerConfigs[0]?.maxOutputTokens, 4096);
    assert.equal(capturedPlannerConfigs[0]?.responseMimeType, 'application/json');
    assert.ok(capturedPlannerConfigs[0]?.responseSchema);

    // 3. Single-shot candidateModel probe: GEMINI_MODEL stays 'gemini-2.5-flash',
    //    first test fails 404 on 2.5-flash, then candidate probe tests 'gemini-4-hydrogen' with 1 call,
    //    0 extra models.list calls (reuses 10m cache), no JSON schema, and minimal output tokens.
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    let listCalls = 0;
    const probeCalls: Array<{ model: string; contents: string; config?: Record<string, unknown> }> = [];
    const probeClient = {
      models: {
        list: async () => {
          listCalls += 1;
          return {
            page: [
              { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
              { name: 'models/gemini-4-hydrogen', supportedActions: ['generateContent'] },
            ],
          };
        },
        generateContent: async (params: { model: string; contents: string; config?: Record<string, unknown> }) => {
          probeCalls.push(params);
          if (params.model === 'gemini-2.5-flash') {
            throw Object.assign(new Error('404 NOT_FOUND: no longer available to new users'), { status: 404 });
          }
          return {
            text: 'OK',
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 18, totalTokenCount: 25 },
          };
        },
      },
    };

    const currentFail = await testGeminiPersonalKey(
      'AQ.Ab8DummyCandidateProbeKey_123456',
      undefined,
      probeClient,
      'req_probe_25',
    );
    assert.equal(currentFail.ok, false);
    assert.equal(currentFail.configuredModel, 'gemini-2.5-flash');
    assert.equal(currentFail.recommendedModel, 'gemini-4-hydrogen');
    assert.equal(listCalls, 1);
    assert.equal(probeCalls.length, 1);

    const candidatePass = await testGeminiPersonalKey(
      'AQ.Ab8DummyCandidateProbeKey_123456',
      undefined,
      probeClient,
      'req_probe_h4',
      { candidateModel: 'gemini-4-hydrogen' },
    );
    assert.equal(candidatePass.ok, true);
    assert.equal(candidatePass.isCandidateTest, true);
    assert.equal(candidatePass.model, 'gemini-4-hydrogen');
    assert.equal(candidatePass.configuredModel, 'gemini-2.5-flash');
    assert.equal(process.env.GEMINI_MODEL, 'gemini-2.5-flash'); // Never mutated
    assert.equal(candidatePass.httpStatus, 200);
    assert.equal(candidatePass.finishReason, 'STOP');
    assert.equal(candidatePass.usage.totalTokens, 25);
    assert.equal(candidatePass.compatibility?.noticeThinkingSummary, 'thinkingLevel=LOW');
    assert.equal(listCalls, 1); // Cached models.list reused (0 extra list calls)
    assert.equal(probeCalls.length, 2); // Strictly 1 generateContent call per test invocation
    assert.equal(probeCalls[1]?.contents, 'Reply with OK only.');
    assert.equal(probeCalls[1]?.config?.maxOutputTokens, 128);
    assert.equal(probeCalls[1]?.config?.responseSchema, undefined);
    assert.equal(probeCalls[1]?.config?.responseMimeType, undefined);
    assert.deepEqual(probeCalls[1]?.config?.thinkingConfig, { thinkingLevel: ThinkingLevel.LOW });

    // 4. Route validation rejects deprecated or malformed candidateModel with 400 and forwards valid candidateModel
    const activeAuth = async () => ({
      uid: 'teacher-candidate-test',
      email: 'cand@icedu.kr',
      emailVerified: true,
      accessStatus: 'active' as const,
      role: 'teacher',
    });
    const invalidRouteRes = await handleTestByokKeyRequest(
      {
        authorizationHeader: 'Bearer token',
        body: { candidateModel: 'gemini-2.0-flash' },
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: async () => ({
          apiKey: 'AQ.Ab8DummyCandidateRouteKey_123456',
          keyType: 'auth_aq',
        }),
      },
    );
    assert.equal(invalidRouteRes.status, 400);
    assert.equal((invalidRouteRes.body as { errorCode: string }).errorCode, 'invalid_model_name');

    let capturedRouteCandidate: string | undefined;
    const validRouteRes = await handleTestByokKeyRequest(
      {
        authorizationHeader: 'Bearer token',
        body: { candidateModel: 'models/gemini-4-hydrogen' },
      },
      {
        verifyAuth: activeAuth,
        resolveApiKey: async () => ({
          apiKey: 'AQ.Ab8DummyCandidateRouteKey_123456',
          keyType: 'auth_aq',
        }),
        testApiKey: async (_key, _signal, _reqId, opts) => {
          capturedRouteCandidate = opts?.candidateModel;
          return candidatePass;
        },
      },
    );
    assert.equal(validRouteRes.status, 200);
    assert.equal(capturedRouteCandidate, 'gemini-4-hydrogen');
    const validRouteBody = validRouteRes.body as Record<string, unknown>;
    assert.equal(validRouteBody.isCandidateTest, true);
    assert.equal(validRouteBody.model, 'gemini-4-hydrogen');
    assert.equal(validRouteBody.configuredModel, 'gemini-2.5-flash');
    assert.equal(validRouteBody.httpStatus, 200);
    assert.ok(!JSON.stringify(validRouteBody).includes('AQ.Ab8DummyCandidateRouteKey'));
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('candidate model probe uses 20000ms timeout while standard test stays 8000ms, analyze_notice/planner stay 25000ms, and local vs upstream timeouts are clearly distinguished', async (t) => {
  const prevModel = process.env.GEMINI_MODEL;
  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';

    // 1. Timeout tiers remain strictly separated: 8000ms (standard test), 20000ms (candidate probe), 25000ms (notice), 45000ms (planner)
    assert.equal(AI_LIMITS.KEY_TEST_TIMEOUT_MS, 8000);
    assert.equal(AI_LIMITS.CANDIDATE_TEST_TIMEOUT_MS, 20000);
    assert.equal(AI_LIMITS.REQUEST_TIMEOUT_MS, 25000);
    assert.equal(AI_LIMITS.PLANNER_TIMEOUT_MS, 45000);
    assert.equal(getKeyTestProbeTimeoutMs(false), 8000);
    assert.equal(getKeyTestProbeTimeoutMs(true), 20000);
    assert.equal(getGeminiModelProfile('gemini-4-hydrogen').operations.analyze_notice.timeoutMs, 25000);
    assert.equal(getGeminiModelProfile('gemini-4-hydrogen').operations.planner.timeoutMs, 45000);
    assert.equal(getGeminiModelProfile('gemini-2.5-flash').operations.analyze_notice.timeoutMs, 25000);
    assert.equal(getGeminiModelProfile('gemini-2.5-flash').operations.planner.timeoutMs, 45000);

    // 2. mapGeminiError distinguishes local timer timeout vs Google API upstream timeout
    const localTimeoutMapped = mapGeminiError(
      Object.assign(new Error('Request timed out'), { name: 'LocalTimeoutError' }),
      'gemini-4-hydrogen',
    );
    assert.equal(localTimeoutMapped.code, 'ai_timeout');
    assert.equal(localTimeoutMapped.diagnosticCategory, 'timeout');
    assert.equal(localTimeoutMapped.timeoutSource, 'local');
    assert.equal(localTimeoutMapped.upstreamHttpStatus, undefined);
    assert.equal(localTimeoutMapped.upstreamErrorMessage, undefined);

    const upstreamTimeoutMapped = mapGeminiError(
      Object.assign(
        new Error(JSON.stringify({
          error: {
            code: 504,
            status: 'DEADLINE_EXCEEDED',
            message: 'Deadline expired before operation could complete.',
          },
        })),
        { status: 504 },
      ),
      'gemini-4-hydrogen',
    );
    assert.equal(upstreamTimeoutMapped.code, 'ai_timeout');
    assert.equal(upstreamTimeoutMapped.diagnosticCategory, 'timeout');
    assert.equal(upstreamTimeoutMapped.timeoutSource, 'upstream');
    assert.equal(upstreamTimeoutMapped.upstreamHttpStatus, 504);
    assert.equal(upstreamTimeoutMapped.upstreamApiStatus, 'DEADLINE_EXCEEDED');
    assert.equal(
      upstreamTimeoutMapped.upstreamErrorMessage,
      'Deadline expired before operation could complete.',
    );

    // 3. Real timer checks (mocked timers, zero real wait):
    //    - Standard key test times out locally at 8000ms (1 call, 0 retries, timeoutSource='local')
    //    - Candidate model probe survives past 8000ms (resolves at 11000ms -> ok=true, timeoutMs=20000)
    //    - Candidate model probe exceeding 20000ms times out locally at 20000ms (timeoutSource='local')
    let generateCalls = 0;
    const dummyKey = 'AQ.Ab8DummyTimeoutSplitKey_123456';

    // Warm models.list cache outside timer mock
    await testGeminiPersonalKey(
      dummyKey,
      undefined,
      {
        models: {
          list: async () => ({
            page: [
              { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
              { name: 'models/gemini-4-hydrogen', supportedActions: ['generateContent'] },
            ],
          }),
          generateContent: async () => ({
            text: 'OK',
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          }),
        },
      },
      'req_warm_cache',
    );

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const flushMicrotasks = async () => {
        for (let i = 0; i < 6; i += 1) {
          await Promise.resolve();
        }
      };

      // 3a. Non-candidate probe still times out at 8000ms
      generateCalls = 0;
      let abortedAt8000 = false;
      const slowNonCandidatePending = testGeminiPersonalKey(
        dummyKey,
        undefined,
        {
          models: {
            list: async () => ({ page: [] }),
            generateContent: async (params) => {
              generateCalls += 1;
              const sig = params.config?.abortSignal as AbortSignal | undefined;
              return await new Promise((_resolve, reject) => {
                sig?.addEventListener('abort', () => {
                  abortedAt8000 = true;
                  reject(new Error('aborted'));
                }, { once: true });
              });
            },
          },
        },
        'req_non_candidate_8s',
      );
      await flushMicrotasks();
      t.mock.timers.tick(8000);
      const nonCandidateTimeoutRes = await slowNonCandidatePending;
      assert.equal(abortedAt8000, true);
      assert.equal(generateCalls, 1);
      assert.equal(nonCandidateTimeoutRes.ok, false);
      assert.equal(nonCandidateTimeoutRes.isCandidateTest, false);
      assert.equal(nonCandidateTimeoutRes.timeoutMs, 8000);
      assert.equal(nonCandidateTimeoutRes.latencyMs, 8000);
      assert.equal(nonCandidateTimeoutRes.timeoutSource, 'local');
      assert.equal(nonCandidateTimeoutRes.diagnosticCategory, 'timeout');
      assert.equal(nonCandidateTimeoutRes.upstreamErrorMessage, undefined);

      // 3b. Candidate probe ('gemini-4-hydrogen') does NOT time out at 8000ms and succeeds at 11000ms
      generateCalls = 0;
      let resolveAt11s: ((val: {
        text: string;
        candidates: Array<{ finishReason: string }>;
        usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
      }) => void) | null = null;
      const candidate11sPending = testGeminiPersonalKey(
        dummyKey,
        undefined,
        {
          models: {
            list: async () => ({ page: [] }),
            generateContent: async () => {
              generateCalls += 1;
              return await new Promise((resolve) => {
                resolveAt11s = resolve;
              });
            },
          },
        },
        'req_candidate_11s',
        { candidateModel: 'gemini-4-hydrogen' },
      );
      await flushMicrotasks();
      t.mock.timers.tick(9000);
      await flushMicrotasks();
      assert.equal(generateCalls, 1);
      t.mock.timers.tick(2000); // Total elapsed: 11000ms (< 20000ms)
      resolveAt11s!({
        text: 'OK',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 20, totalTokenCount: 27 },
      });
      const candidate11sRes = await candidate11sPending;
      assert.equal(generateCalls, 1);
      assert.equal(candidate11sRes.ok, true);
      assert.equal(candidate11sRes.isCandidateTest, true);
      assert.equal(candidate11sRes.model, 'gemini-4-hydrogen');
      assert.equal(candidate11sRes.timeoutMs, 20000);
      assert.equal(candidate11sRes.latencyMs, 11000);
      assert.equal(candidate11sRes.timeoutSource, undefined);

      // 3c. Candidate probe exceeding 20000ms times out locally at 20000ms with strictly 1 call
      generateCalls = 0;
      let abortedAt20000 = false;
      const slowCandidatePending = testGeminiPersonalKey(
        dummyKey,
        undefined,
        {
          models: {
            list: async () => ({ page: [] }),
            generateContent: async (params) => {
              generateCalls += 1;
              const sig = params.config?.abortSignal as AbortSignal | undefined;
              return await new Promise((_resolve, reject) => {
                sig?.addEventListener('abort', () => {
                  abortedAt20000 = true;
                  reject(new Error('aborted'));
                }, { once: true });
              });
            },
          },
        },
        'req_candidate_20s_timeout',
        { candidateModel: 'gemini-4-hydrogen' },
      );
      await flushMicrotasks();
      t.mock.timers.tick(19999);
      assert.equal(abortedAt20000, false);
      t.mock.timers.tick(1);
      const candidateTimeoutRes = await slowCandidatePending;
      assert.equal(abortedAt20000, true);
      assert.equal(generateCalls, 1);
      assert.equal(candidateTimeoutRes.ok, false);
      assert.equal(candidateTimeoutRes.isCandidateTest, true);
      assert.equal(candidateTimeoutRes.timeoutMs, 20000);
      assert.equal(candidateTimeoutRes.latencyMs, 20000);
      assert.equal(candidateTimeoutRes.timeoutSource, 'local');
      assert.equal(candidateTimeoutRes.diagnosticCategory, 'timeout');
      assert.equal(candidateTimeoutRes.upstreamHttpStatus, undefined);
      assert.equal(candidateTimeoutRes.upstreamErrorMessage, undefined);

      // 3d. Route handler forwards latencyMs, timeoutMs, and timeoutSource cleanly for both local and upstream timeouts
      const routeResLocal = await handleTestByokKeyRequest(
        {
          authorizationHeader: 'Bearer token',
          body: { candidateModel: 'gemini-4-hydrogen' },
        },
        {
          verifyAuth: async () => ({
            uid: 'teacher-timeout-route',
            email: 'timeout@icedu.kr',
            emailVerified: true,
            accessStatus: 'active',
            role: 'teacher',
          }),
          resolveApiKey: async () => ({
            apiKey: dummyKey,
            keyType: 'auth_aq',
          }),
          testApiKey: async () => candidateTimeoutRes,
        },
      );
      assert.equal(routeResLocal.status, 200);
      const localBody = routeResLocal.body as Record<string, unknown>;
      assert.equal(localBody.latencyMs, 20000);
      assert.equal(localBody.timeoutMs, 20000);
      assert.equal(localBody.timeoutSource, 'local');
      assert.equal(localBody.diagnosticCategory, 'timeout');
      assert.ok(!JSON.stringify(localBody).includes('AQ.Ab8DummyTimeoutSplitKey'));

      const upstreamTimeoutRes = await testGeminiPersonalKey(
        dummyKey,
        undefined,
        {
          models: {
            list: async () => ({ page: [] }),
            generateContent: async () => {
              throw Object.assign(
                new Error(JSON.stringify({
                  error: {
                    code: 504,
                    status: 'DEADLINE_EXCEEDED',
                    message: 'Google API deadline exceeded upstream.',
                  },
                })),
                { status: 504 },
              );
            },
          },
        },
        'req_candidate_upstream_504',
        { candidateModel: 'gemini-4-hydrogen' },
      );
      assert.equal(upstreamTimeoutRes.ok, false);
      assert.equal(upstreamTimeoutRes.timeoutMs, 20000);
      assert.equal(upstreamTimeoutRes.timeoutSource, 'upstream');
      assert.equal(upstreamTimeoutRes.upstreamHttpStatus, 504);
      assert.equal(upstreamTimeoutRes.upstreamApiStatus, 'DEADLINE_EXCEEDED');
      assert.equal(
        upstreamTimeoutRes.upstreamErrorMessage,
        'Google API deadline exceeded upstream.',
      );
    } finally {
      t.mock.timers.reset();
    }
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('gemini-3.8-flash planner applies thinkingLevel=LOW, trims prompt/task bloat to 8 tasks without breaking schema, and logs requestId/latencyMs/timeoutMs/timeoutSource/model on 45000ms timeout', async (t) => {
  const prevModel = process.env.GEMINI_MODEL;
  const prevPlannerModel = process.env.GEMINI_PLANNER_MODEL;
  const capturedWarnings: string[] = [];
  const capturedInfos: string[] = [];
  const origWarn = console.warn;
  const origInfo = console.info;
  console.warn = (...args: unknown[]) => {
    capturedWarnings.push(args.map((a) => String(a)).join(' '));
  };
  console.info = (...args: unknown[]) => {
    capturedInfos.push(args.map((a) => String(a)).join(' '));
  };

  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    delete process.env.GEMINI_PLANNER_MODEL;

    // 1. Profile & timeout separation verification for gemini-3.8-flash
    const profile38 = getGeminiModelProfile('gemini-3.8-flash');
    assert.equal(profile38.family, 'gemini-3');
    assert.equal(profile38.thinkingParamType, 'thinkingLevel');
    assert.equal(profile38.operations.planner.thinkingLevel, 'LOW');
    assert.equal(profile38.operations.planner.maxOutputTokens, 4096);
    assert.equal(profile38.operations.planner.timeoutMs, 45000);
    assert.equal(profile38.operations.analyze_notice.timeoutMs, 25000);
    assert.equal(plannerRouteConfig.maxDuration, 60);

    // 2. Prompt bloat trim: 15 input tasks -> top 8 in compactInput, compact slots, empty arrays omitted,
    //    thinkingLevel=LOW + PLANNER_RESPONSE_SCHEMA preserved, 1 Gemini call, safe completion log emitted
    const fifteenTasks = Array.from({ length: 15 }, (_, idx) => ({
      id: `task-${idx + 1}`,
      t: `업무 제목 ${idx + 1}`,
      d: '2026-11-18',
      ov: idx === 0,
      dd: idx === 0 ? -1 : idx,
      p: (idx < 3 ? 'u' : 'n') as 'u' | 'n',
      s: 'td' as const,
      m: 20,
      tdy: idx < 4,
    }));

    let capturedContents = '';
    let capturedConfig: Record<string, unknown> | undefined;
    let plannerCalls = 0;

    const planRes = await generateDayPlanWithGemini(
      'AQ.Ab8DummyPlanner38Key_1234567890',
      {
        todayKey: '2026-11-18',
        currentTimeHhMm: '09:00',
        totalIncompleteCount: 15,
        overdueCount: 1,
        dueTodayCount: 3,
        timetableConfigured: true,
        remainingWorkableMinutes: 50,
        workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
        blockedEventsSummary: [],
        academicAlertsSummary: [],
        tasks: fifteenTasks,
      },
      undefined,
      {
        models: {
          list: async () => ({ page: [] }),
          generateContent: async (params) => {
            plannerCalls += 1;
            capturedContents = params.contents;
            capturedConfig = params.config;
            return {
              text: JSON.stringify({
                coreAdvice: '2교시 공강에 기한 지난 업무부터 처리하세요.',
                recommendations: [
                  {
                    taskId: 'task-1',
                    order: 1,
                    recommendedStart: '10:00',
                    recommendedEnd: '10:20',
                    estimatedMinutes: 20,
                    tier: 'must',
                    strategy: '서류 양식 먼저 확인 후 기안',
                    reason: '마감 기한 초과 긴급 업무',
                  },
                ],
                attentionTasks: [{ taskId: 'task-1', reason: '기한 초과' }],
                deferredTasks: [{ taskId: 'task-6', reason: '오늘 가용 시간 부족' }],
              }),
              usageMetadata: {
                promptTokenCount: 280,
                candidatesTokenCount: 95,
                thoughtsTokenCount: 60,
                totalTokenCount: 435,
              },
            };
          },
        },
      },
      'req_plan_38_ok',
    );

    assert.equal(plannerCalls, 1);
    assert.equal(planRes.model, 'gemini-3.8-flash');
    assert.deepEqual(capturedConfig?.thinkingConfig, { thinkingLevel: ThinkingLevel.LOW });
    assert.equal(capturedConfig?.maxOutputTokens, 4096);
    assert.equal(capturedConfig?.responseMimeType, 'application/json');
    assert.ok(capturedConfig?.responseSchema);
    assert.equal(planRes.rawPlan.recommendations[0].tier, 'must');
    assert.equal(planRes.rawPlan.recommendations[0].strategy, '서류 양식 먼저 확인 후 기안');

    const jsonMarker = '입력JSON:';
    const compactPayload = JSON.parse(
      capturedContents.slice(capturedContents.indexOf(jsonMarker) + jsonMarker.length),
    ) as {
      tasks: Array<{ id: string }>;
      slots?: string[];
      events?: unknown;
      academic?: unknown;
    };
    assert.equal(compactPayload.tasks.length, 8);
    assert.equal(compactPayload.tasks[0]?.id, 'task-1');
    assert.equal(compactPayload.tasks[7]?.id, 'task-8');
    assert.deepEqual(compactPayload.slots, ['10:00~10:50(50m)']);
    assert.equal('events' in compactPayload, false);
    assert.equal('academic' in compactPayload, false);

    const completionLog = capturedInfos.find((line) => line.includes('gemini_planner_completed'));
    assert.ok(completionLog);
    assert.ok(completionLog.includes('"requestId":"req_plan_38_ok"'));
    assert.ok(completionLog.includes('"model":"gemini-3.8-flash"'));
    assert.ok(completionLog.includes('"timeoutMs":45000'));
    assert.ok(completionLog.includes('"latencyMs":'));
    assert.ok(!completionLog.includes('AQ.Ab8DummyPlanner38Key'));

    // 3. 45000ms local timeout aborts request cleanly (1 call, 0 retries) and logs all required fields
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      let abortedOn45s = false;
      let timeoutCalls = 0;
      const pendingRouteRes = handleAiPlannerRequest(
        {
          authorizationHeader: 'Bearer test-token',
          requestId: 'req_plan_38_timeout',
          body: {
            todayKey: '2026-11-18',
            currentTimeHhMm: '09:00',
            totalIncompleteCount: 1,
            overdueCount: 0,
            dueTodayCount: 1,
            timetableConfigured: true,
            remainingWorkableMinutes: 50,
            workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
            blockedEventsSummary: [],
            academicAlertsSummary: [],
            tasks: [fifteenTasks[0]],
          },
        },
        {
          verifyAuth: async () => ({
            uid: 'teacher-plan-timeout',
            email: 'plan@icedu.kr',
            emailVerified: true,
            accessStatus: 'active',
            role: 'teacher',
          }),
          resolveApiKey: async () => ({
            apiKey: 'AQ.Ab8DummyPlannerTimeoutSecret_1234',
            keyType: 'auth_aq',
          }),
          generateDayPlan: async (input, signal, apiKey, reqId) =>
            generateDayPlanWithGemini(
              apiKey ?? '',
              input,
              signal,
              {
                models: {
                  list: async () => ({ page: [] }),
                  generateContent: async (params) => {
                    timeoutCalls += 1;
                    const sig = params.config?.abortSignal as AbortSignal | undefined;
                    return await new Promise((_resolve, reject) => {
                      sig?.addEventListener('abort', () => {
                        abortedOn45s = true;
                        reject(new Error('aborted'));
                      }, { once: true });
                    });
                  },
                },
              },
              reqId,
            ),
        },
      );

      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
      t.mock.timers.tick(44999);
      assert.equal(abortedOn45s, false);
      t.mock.timers.tick(1);
      const routeOut = await pendingRouteRes;

      assert.equal(abortedOn45s, true);
      assert.equal(timeoutCalls, 1);
      assert.equal(routeOut.status, 504);
      const body = routeOut.body as Record<string, unknown>;
      assert.equal(body.error, 'ai_timeout');
      assert.equal(body.requestId, 'req_plan_38_timeout');
      assert.ok(!JSON.stringify(body).includes('AQ.Ab8DummyPlannerTimeoutSecret'));

      const attemptWarn = capturedWarnings.find((line) =>
        line.includes('gemini_generate_attempt_failed') && line.includes('req_plan_38_timeout'),
      );
      assert.ok(attemptWarn);
      assert.ok(attemptWarn.includes('"model":"gemini-3.8-flash"'));
      assert.ok(attemptWarn.includes('"timeoutMs":45000'));
      assert.ok(attemptWarn.includes('"latencyMs":45000'));
      assert.ok(attemptWarn.includes('"timeoutSource":"local"'));

      const routeWarn = capturedWarnings.find((line) =>
        line.includes('ai_route_gemini_error') && line.includes('req_plan_38_timeout'),
      );
      assert.ok(routeWarn);
      assert.ok(routeWarn.includes('"model":"gemini-3.8-flash"'));
      assert.ok(routeWarn.includes('"timeoutMs":45000'));
      assert.ok(routeWarn.includes('"latencyMs":45000'));
      assert.ok(routeWarn.includes('"timeoutSource":"local"'));
      assert.ok(!routeWarn.includes('AQ.Ab8DummyPlannerTimeoutSecret'));
    } finally {
      t.mock.timers.reset();
    }
  } finally {
    console.warn = origWarn;
    console.info = origInfo;
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
    if (prevPlannerModel === undefined) delete process.env.GEMINI_PLANNER_MODEL;
    else process.env.GEMINI_PLANNER_MODEL = prevPlannerModel;
  }
});

test('GEMINI_PLANNER_MODEL optionally overrides planner without affecting analyze_notice', async () => {
  const prevModel = process.env.GEMINI_MODEL;
  const prevPlannerModel = process.env.GEMINI_PLANNER_MODEL;
  try {
    clearGeminiModelCacheForTesting();
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    delete process.env.GEMINI_PLANNER_MODEL;
    assert.equal(getGeminiPlannerModelName(), 'gemini-3.8-flash');

    process.env.GEMINI_PLANNER_MODEL = 'gemini-3.5-flash-lite';
    assert.equal(getGeminiPlannerModelName(), 'gemini-3.5-flash-lite');

    let plannerModelUsed = '';
    let noticeModelUsed = '';
    const mockClient = {
      models: {
        list: async () => ({ page: [] }),
        generateContent: async (params: { model: string; contents: string }) => {
          if (params.contents.includes('입력JSON:')) {
            plannerModelUsed = params.model;
            return {
              text: JSON.stringify({
                coreAdvice: '핵심 조언',
                recommendations: [],
                attentionTasks: [],
                deferredTasks: [],
              }),
            };
          }
          noticeModelUsed = params.model;
          return {
            text: JSON.stringify({
              candidates: [],
              unparsedSummary: [],
            }),
          };
        },
      },
    };

    await generateDayPlanWithGemini(
      'AQ.Ab8DummyPlannerOverrideKey_1234',
      {
        todayKey: '2026-11-18',
        currentTimeHhMm: '09:00',
        totalIncompleteCount: 1,
        overdueCount: 0,
        dueTodayCount: 1,
        timetableConfigured: true,
        remainingWorkableMinutes: 50,
        workableSlots: [{ st: '10:00', et: '10:50', min: 50, lb: '2교시 공강' }],
        blockedEventsSummary: [],
        academicAlertsSummary: [],
        tasks: [
          {
            id: 't1',
            t: '공문 제출',
            d: '2026-11-18',
            ov: false,
            dd: 0,
            p: 'u',
            s: 'td',
            m: 20,
            tdy: true,
          },
        ],
      },
      undefined,
      mockClient,
      'req_override_plan',
    );

    await analyzeNoticeWithGemini(
      'AQ.Ab8DummyNoticeUnchangedKey_1234',
      { text: '가정통신문 안내', todayKey: '2026-11-18' },
      undefined,
      mockClient,
      'req_override_notice',
    );

    assert.equal(plannerModelUsed, 'gemini-3.5-flash-lite');
    assert.equal(noticeModelUsed, 'gemini-3.8-flash');
  } finally {
    clearGeminiModelCacheForTesting();
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
    if (prevPlannerModel === undefined) delete process.env.GEMINI_PLANNER_MODEL;
    else process.env.GEMINI_PLANNER_MODEL = prevPlannerModel;
  }
});

test('validateAndRepairAiPlan offloads slots/attention/deferred locally, respects constraint, preserves tier/strategy, and falls back on empty AI recommendations', () => {
  const now = new Date('2026-11-16T08:40:00+09:00');
  const timetable = makeTimetable();
  // Monday slots in makeTimetable():
  // period 1: class (09:00-09:50)
  // period 2: workable free (10:00-10:50, 50m)
  // period 3: fixed_duty (11:00-11:50)
  // lunch: 12:20-13:20
  // period 4: workable free (13:20-14:10, 50m)
  // period 5: workable free (14:20-15:10, 50m)
  const tasks: TaskRecord[] = [
    makeTask({
      id: 't-heavy-overdue',
      title: '생기부 마감 점검',
      priority: 'urgent',
      dueAt: Timestamp.fromDate(new Date('2026-11-15T17:00:00+09:00')),
      estimatedMinutes: 40,
    }),
    makeTask({
      id: 't-light-today',
      title: '학부모 안내 문자 발송',
      priority: 'normal',
      dueAt: Timestamp.fromDate(new Date('2026-11-16T17:00:00+09:00')),
      estimatedMinutes: 15,
    }),
    makeTask({
      id: 't-unselected-1',
      title: '교과협의회 자료 정리',
      priority: 'normal',
      estimatedMinutes: 30,
    }),
    makeTask({
      id: 't-unselected-urgent',
      title: '출결 마감 확인',
      priority: 'urgent',
      dueAt: Timestamp.fromDate(new Date('2026-11-16T17:00:00+09:00')),
      estimatedMinutes: 20,
    }),
  ];

  const context = buildAiPlannerContext({
    uid: 'teacher-offload',
    now,
    todayKey: '2026-11-16',
    timetables: [timetable],
    overridesByDate: {},
    academicEvents: [],
    events: [],
    tasks,
    filter: {
      constraintText: '오후에는 가벼운 업무만',
    },
  });

  // 1. AI returns null slots and empty attentionTasks/deferredTasks while keeping tier/strategy
  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '오전 공강에 핵심 생기부 업무를 마치고 오후에는 짧은 안내 문자를 처리하세요.',
      recommendations: [
        {
          taskId: 't-heavy-overdue',
          order: 1,
          recommendedStart: null,
          recommendedEnd: null,
          estimatedMinutes: 40,
          tier: 'must',
          strategy: '미입력 학반 목록부터 먼저 추출 후 일괄 보완',
          reason: '기한 지난 필수 업무',
        },
        {
          taskId: 't-light-today',
          order: 2,
          recommendedStart: null,
          recommendedEnd: null,
          estimatedMinutes: 15,
          tier: 'optional',
          strategy: '문자 템플릿 복사 후 1반씩 순차 발송',
          reason: '오후 짧은 공강에 적합한 가벼운 업무',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    context,
    {
      model: 'gemini-3.8-flash',
      generatedAtIso: now.toISOString(),
    },
  );

  assert.equal(validated.recommendations.length, 2);
  assert.equal(validated.validationRepairs.length, 0);

  const first = validated.recommendations[0];
  const second = validated.recommendations[1];
  assert.equal(first.tier, 'must');
  assert.equal(first.strategy, '미입력 학반 목록부터 먼저 추출 후 일괄 보완');
  assert.equal(first.slotStatus, 'scheduled');
  // 40m heavy task placed in morning workable slot (<= 12:30, avoiding 09:00-09:50 class & 11:00-11:50 duty)
  assert.ok(first.slotStart && first.slotEnd);
  assert.ok(first.slotStart >= '10:00' && first.slotEnd <= '10:50');

  // 15m light task placed in afternoon workable slot (>= 13:20, avoiding lunch 12:20-13:20)
  assert.equal(second.tier, 'optional');
  assert.equal(second.strategy, '문자 템플릿 복사 후 1반씩 순차 발송');
  assert.equal(second.slotStatus, 'scheduled');
  assert.ok(second.slotStart && second.slotEnd);
  assert.ok(second.slotStart >= '13:20');

  // attentionTasks & deferredTasks filled deterministically; unselected tasks never dropped
  assert.ok(validated.attentionTasks.some((t) => t.taskId === 't-heavy-overdue'));
  assert.ok(validated.attentionTasks.some((t) => t.taskId === 't-unselected-urgent'));
  assert.ok(validated.deferredTasks.some((t) => t.taskId === 't-unselected-1'));
  assert.ok(!validated.deferredTasks.some((t) => t.taskId === 't-heavy-overdue'));

  // 2. Empty AI recommendations triggers clean deterministic fallback while preserving coreAdvice
  const fallbackValidated = validateAndRepairAiPlan(
    {
      coreAdvice: '핵심 조언 유지',
      recommendations: [],
      attentionTasks: [],
      deferredTasks: [],
    },
    context,
    {
      model: 'gemini-3.8-flash',
      generatedAtIso: now.toISOString(),
    },
  );
  assert.ok(fallbackValidated.recommendations.length > 0);
  assert.equal(fallbackValidated.coreAdvice, '핵심 조언 유지');
  assert.ok(fallbackValidated.validationRepairs.some((msg) => msg.includes('기본 우선순위')));
});
