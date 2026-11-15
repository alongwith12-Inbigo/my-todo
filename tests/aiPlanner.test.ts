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
  handleAiPlannerRequest,
  handleSaveByokKeyRequest,
  handleTestByokKeyRequest,
} from '../server/aiRoutes.ts';
import { ServerAuthError } from '../server/firebaseServerAuth.ts';
import { SlidingWindowRateLimiter } from '../server/rateLimiter.ts';
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

test('validateGeminiApiKeyFormat allows valid keys with A-Z a-z 0-9 _ - and strips edge whitespace/invisible chars', () => {
  const validCases = [
    'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz_01-234',
    'AIzaSy9876543210-_abcdefghijklmnopqrstuvwxyz',
    'A'.repeat(20),
    'Ab_0-9'.repeat(42) + '1234', // 256 chars max boundary
  ];

  for (const key of validCases) {
    const res = validateGeminiApiKeyFormat(key);
    assert.equal(res.valid, true, `Expected valid for key length ${key.length}`);
    assert.equal(res.apiKey, key);
  }

  const cleanKey = 'AIzaSyTest_Copy-Paste_1234567890ABCDEFG';
  const copyPasteArtifacts = [
    `  ${cleanKey}  `,
    `\r\n${cleanKey}\n`,
    `\t\u00A0\u3000${cleanKey}\u00A0\t`,
    `\uFEFF\u200B${cleanKey}\u200C\u200D`,
    `\u200E\u202A\u2060\u00AD${cleanKey}\u202E\u200F\u2060`,
    `\r\n \u200B\uFEFF${cleanKey}\u200B \n\r`,
  ];

  for (const noisy of copyPasteArtifacts) {
    assert.equal(normalizeGeminiApiKeyInput(noisy), cleanKey);
    const res = validateGeminiApiKeyFormat(noisy);
    assert.equal(res.valid, true);
    assert.equal(res.apiKey, cleanKey);
  }
});

test('validateGeminiApiKeyFormat rejects internal whitespace, invalid chars, and bad lengths without leaking raw key', () => {
  const invalidFormatCases = [
    'AIzaSyFakeKey 123456789012345', // internal space
    'AIzaSyFakeKey\n123456789012345', // internal newline
    'AIzaSyFakeKey\t123456789012345', // internal tab
    'AIzaSyFakeKey\u200B123456789012345', // internal zero-width char
    'AIzaSyFakeKey!123456789012345',
    'AIzaSyFakeKey@123456789012345',
    'AIzaSyFakeKey+123456789012345=',
    'AIzaSyFakeKey/123456789012345',
    '"AIzaSyFakeKey1234567890123456"',
    'AIzaSy한글포함키테스트1234567890',
  ];

  for (const bad of invalidFormatCases) {
    const res = validateGeminiApiKeyFormat(bad);
    assert.equal(res.valid, false);
    assert.equal(
      res.message,
      'API 키에 허용되지 않는 공백이나 특수문자가 포함되어 있습니다.',
    );
    assert.ok(!res.message?.includes('AIzaSy'));
    assert.ok(!res.message?.includes(bad));
  }

  const emptyCases = ['', '   ', '\r\n\t', '\u200B\uFEFF\u2060'];
  for (const empty of emptyCases) {
    const res = validateGeminiApiKeyFormat(empty);
    assert.equal(res.valid, false);
    assert.equal(res.message, 'Gemini API 키를 입력해 주세요.');
  }

  assert.equal(validateGeminiApiKeyFormat('A'.repeat(19)).valid, false);
  assert.equal(validateGeminiApiKeyFormat('A'.repeat(257)).valid, false);
  assert.equal(validateGeminiApiKeyFormat(null).valid, false);
  assert.equal(validateGeminiApiKeyFormat(1234567890).valid, false);
});

test('BYOK save and test routes pass normalized key to server connection test and block internal invalid chars without leaking key', async () => {
  const activeAuth = async () => ({
    uid: 'teacher-byok-copy-test',
    email: 'teacher@icedu.kr',
    emailVerified: true,
    accessStatus: 'active' as const,
    role: 'teacher',
  });

  const cleanKey = 'AIzaSyRoute_Test-Key_1234567890ABCDEFGH';
  const pastedFromUi = `\uFEFF\u200B \n${cleanKey}\r\n\u200C `;

  const testedKeysOnSave: string[] = [];
  const saveRes = await handleSaveByokKeyRequest(
    {
      authorizationHeader: 'Bearer test-token',
      body: { apiKey: pastedFromUi, testBeforeSave: true },
      isSecure: false,
    },
    {
      verifyAuth: activeAuth,
      testApiKey: async (apiKey) => {
        testedKeysOnSave.push(apiKey);
        return {
          model: 'gemini-3.1-flash-lite-preview',
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
  assert.deepEqual(testedKeysOnSave, [cleanKey]);
  assert.ok(!JSON.stringify(saveRes.body).includes(cleanKey));

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
          model: 'gemini-3.1-flash-lite-preview',
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
  assert.deepEqual(testedKeysOnTestRoute, [cleanKey]);
  assert.ok(!JSON.stringify(testRes.body).includes(cleanKey));

  const badInternalKey = 'AIzaSyBad Key With$Special123456';
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
  const badBodyStr = JSON.stringify(badTestRes.body);
  assert.ok(badBodyStr.includes('invalid_key_format'));
  assert.ok(!badBodyStr.includes('AIzaSy'));
  assert.ok(!badBodyStr.includes(badInternalKey));
});

