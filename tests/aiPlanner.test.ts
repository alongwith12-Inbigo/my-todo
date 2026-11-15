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
import {
  applyUsageIncrement,
  checkDailyQuotaForKind,
  decryptApiKeyForUid,
  encryptApiKeyForUid,
  maskGeminiApiKey,
  normalizeGeminiApiKeyInput,
  sealByokCookieValue,
  unsealByokCookieValue,
  validateGeminiApiKeyFormat,
  type StoredAiUserState,
} from '../server/byokVault.ts';
import {
  dispatchVercelAiRoute,
  handleAiPlannerRequest,
  handleAiStatusRequest,
  handleSaveByokKeyRequest,
  handleTestByokKeyRequest,
} from '../server/aiRoutes.ts';
import { mapGeminiError } from '../server/aiConfig.ts';
import { ServerAuthError } from '../server/firebaseServerAuth.ts';
import {
  createGeminiClient,
  GeminiServiceError,
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
  assert.equal(maskGeminiApiKey(sampleKey), 'AIzaSy...3456');

  const enc = encryptApiKeyForUid(sampleKey, 'uid-alpha');
  assert.ok(!enc.ciphertext.includes('AIza'));
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
    mapGeminiError(new Error('PERMISSION_DENIED: API disabled')).code,
    'api_key_permission_denied',
  );
  assert.equal(mapGeminiError(new Error('404 model not found')).code, 'model_not_found');
  assert.equal(mapGeminiError(new Error('429 RESOURCE_EXHAUSTED')).code, 'ai_quota_exceeded');

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

test('AQ. Authorization key compatibility: x-goog-api-key SDK headers, Firestore vault limits, route metadata, and auth-first connection test', async () => {
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

  // 2. Encryption & masking satisfy firestore.rules bounds even at 380-char AQ. keys
  const longAqKey = `AQ.${'Ab8_Cd9-Ef0'.repeat(34)}XYZ`;
  assert.ok(longAqKey.length <= 380);
  const encLong = encryptApiKeyForUid(longAqKey, 'uid-aq-1');
  assert.ok(encLong.ciphertext.length <= 512);
  assert.match(encLong.keyHint, /^.+\.\.\..+$/);
  assert.ok(encLong.keyHint.length >= 4 && encLong.keyHint.length <= 32);
  assert.equal(decryptApiKeyForUid(encLong, 'uid-aq-1'), longAqKey);
  assert.equal(decryptApiKeyForUid(encLong, 'uid-aq-2'), null);
  assert.equal(maskGeminiApiKey(dummyAqKey), 'AQ.Ab8...6789');

  // 3. auth-first connection test: models.list success verifies Gemini API authentication
  const okRes = await testGeminiPersonalKey(dummyAqKey, undefined, {
    models: {
      list: async () => ({
        page: [{ name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] }],
      }),
      generateContent: async () => ({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    },
  });
  assert.equal(okRes.authVerified, true);
  assert.equal(okRes.keyType, 'auth_aq');
  assert.equal(okRes.usage.totalTokens, 7);
  assert.equal(okRes.warning, undefined);

  // 4. Invalid API key or incompatible auth header on models.list throws distinct GeminiServiceError
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

  // 5. If models.list authenticates cleanly but configured model returns 404, fallback probe verifies auth without falsely claiming invalid key
  const modelFallbackRes = await testGeminiPersonalKey(dummyAqKey, undefined, {
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
  assert.equal(modelFallbackRes.authVerified, true);
  assert.equal(modelFallbackRes.keyType, 'auth_aq');
  assert.equal(modelFallbackRes.model, 'gemini-2.5-flash');
  assert.ok(modelFallbackRes.warning && modelFallbackRes.warning.includes('GEMINI_MODEL'));

  // 6. Route test returns keyType='auth_aq' cleanly without exposing raw key
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
      testApiKey: async () => modelFallbackRes,
    },
  );
  assert.equal(aqRouteRes.status, 200);
  const aqBody = aqRouteRes.body as { ok: boolean; keyType: string; keyHint: string; warning?: string };
  assert.equal(aqBody.ok, true);
  assert.equal(aqBody.keyType, 'auth_aq');
  assert.equal(aqBody.keyHint, 'AQ.Ab8...6789');
  assert.ok(aqBody.warning);
  assert.ok(!JSON.stringify(aqRouteRes.body).includes(dummyAqKey));
});


