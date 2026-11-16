import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import {
  buildAiPlannerContext,
  getAvailabilityReasonShortLabel,
  getDefaultUnscheduledNote,
  validateAndRepairAiPlan,
} from '../src/lib/aiPlanner.ts';
import {
  AiPlannerSessionController,
  type GeminiPlannerExecutorResult,
} from '../src/lib/aiPlannerSession.ts';
import {
  getAiPlanStorageKey,
  loadPersistedAiState,
} from '../src/lib/aiPlanStorage.ts';
import {
  doesTaskMatchFilterTab,
  makeTaskPageCacheKey,
  patchCachedTaskPages,
  removeTaskFromCachedPages,
  type CachedTaskPage,
} from '../src/lib/taskCache.ts';
import {
  areTaskDetailsUnchanged,
  buildTaskDetailsPatch,
} from '../src/repositories/taskOperations.ts';
import type {
  AcademicEventRecord,
  CalendarEventRecord,
  TaskRecord,
  TimetableOverrideRecord,
  TimetableRecord,
} from '../src/types/domain.ts';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function makeTask(
  overrides: Partial<TaskRecord> & { id: string; title: string },
): TaskRecord {
  const nowTs = Timestamp.fromDate(new Date('2026-11-16T00:00:00+09:00'));
  return {
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: null,
    scheduledAt: null,
    remindAt: null,
    completedAt: null,
    estimatedMinutes: 30,
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

function makeWeekdayTimetable(
  options: { allFreeUnworkable?: boolean; tightWorkWindow?: boolean } = {},
): TimetableRecord {
  const nowTs = Timestamp.fromDate(new Date('2026-11-16T00:00:00+09:00'));
  return {
    id: 'tt-weekday',
    name: '2026-2학기 주간 시간표',
    semesterLabel: '2026-2학기',
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-12-31',
    isActive: true,
    sourceType: 'manual',
    workStart: options.tightWorkWindow ? '09:00' : '08:30',
    workEnd: options.tightWorkWindow ? '15:10' : '16:30',
    lunchStart: options.tightWorkWindow ? '11:50' : '12:20',
    lunchEnd: options.tightWorkWindow ? '13:20' : '13:20',
    periodCount: 5,
    periodTimes: options.tightWorkWindow
      ? {
          '1': { period: 1, label: '1교시', startTime: '09:00', endTime: '10:00' },
          '2': { period: 2, label: '2교시', startTime: '10:00', endTime: '10:50' },
          '3': { period: 3, label: '3교시', startTime: '10:50', endTime: '11:50' },
          '4': { period: 4, label: '4교시', startTime: '13:20', endTime: '14:10' },
          '5': { period: 5, label: '5교시', startTime: '14:10', endTime: '15:10' },
        }
      : {
          '1': { period: 1, label: '1교시', startTime: '09:00', endTime: '09:50' },
          '2': { period: 2, label: '2교시', startTime: '10:00', endTime: '10:50' },
          '3': { period: 3, label: '3교시', startTime: '11:00', endTime: '11:50' },
          '4': { period: 4, label: '4교시', startTime: '13:20', endTime: '14:10' },
          '5': { period: 5, label: '5교시', startTime: '14:20', endTime: '15:10' },
        },
    slots: {
      // Monday (day 1)
      '1_1': {
        day: 1,
        period: 1,
        kind: 'class',
        subject: '국어',
        className: '2-1',
        classroom: '2-1',
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
        workAvailable: !options.allFreeUnworkable,
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
        workAvailable: !options.allFreeUnworkable,
      },
      '1_5': {
        day: 1,
        period: 5,
        kind: 'class',
        subject: '국어',
        className: '2-2',
        classroom: '2-2',
        note: '',
        workAvailable: false,
      },
    },
    version: 1,
    createdAt: nowTs,
    updatedAt: nowTs,
    schemaVersion: 1,
  };
}

function makeFakeAiExecutor(
  overrideRecommendations?: GeminiPlannerExecutorResult['rawPlan']['recommendations'],
) {
  let callCount = 0;
  const executor = async (
    request: Parameters<
      Parameters<AiPlannerSessionController['runAiPlan']>[0]['executeGemini']
    >[0],
  ): Promise<GeminiPlannerExecutorResult> => {
    callCount += 1;
    const firstSlot = request.workableSlots[0];
    const recs =
      overrideRecommendations ??
      request.tasks.slice(0, 4).map((t, idx) => ({
        taskId: t.id,
        order: idx + 1,
        recommendedStart: idx === 0 && firstSlot ? firstSlot.st : null,
        recommendedEnd: idx === 0 && firstSlot ? firstSlot.et : null,
        estimatedMinutes: t.m ?? 25,
        reason: `${t.t} 우선 처리 권장`,
      }));
    return {
      model: 'gemini-4-hydrogen',
      generatedAtIso: '2026-11-16T00:10:00Z',
      usage: {
        inputTokens: 900,
        outputTokens: 320,
        thoughtTokens: 120,
        totalTokens: 1340,
      },
      rawPlan: {
        coreAdvice: '가용 시간대와 마감 순서를 기준으로 오늘 업무를 정리했습니다.',
        recommendations: recs,
        attentionTasks: [],
        deferredTasks: [],
      },
    };
  };
  return {
    executor,
    getCallCount: () => callCount,
  };
}

test('Scenario 1: Weekday with sufficient workable intervals assigns non-overlapping slots outside class and lunch', () => {
  const ctx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-16', // Monday
    now: new Date('2026-11-16T08:40:00+09:00'),
    tasks: [
      makeTask({ id: 't1', title: '가정통신문 발송', priority: 'urgent', estimatedMinutes: 30 }),
      makeTask({ id: 't2', title: '수행평가 채점', priority: 'high', estimatedMinutes: 40 }),
    ],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  assert.equal(ctx.availabilityReason, 'available');
  assert.ok(ctx.remainingWorkableMinutes >= 100);
  assert.ok(ctx.remainingWorkableIntervals.some((s) => s.startTime === '10:00' && s.endTime === '10:50'));
  assert.ok(ctx.remainingWorkableIntervals.some((s) => s.startTime === '13:20' && s.endTime === '14:10'));

  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '2교시와 4교시 공강을 활용하세요.',
      recommendations: [
        {
          taskId: 't1',
          order: 1,
          recommendedStart: '10:00',
          recommendedEnd: '10:30',
          estimatedMinutes: 30,
          reason: '긴급 업무',
        },
        {
          taskId: 't2',
          order: 2,
          recommendedStart: '13:20',
          recommendedEnd: '14:00',
          estimatedMinutes: 40,
          reason: '평가 일정 대비',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    ctx,
    { model: 'gemini-4-hydrogen', generatedAtIso: '2026-11-16T00:00:00Z' },
  );

  assert.equal(validated.availabilityReason, 'available');
  assert.equal(validated.recommendations[0].slotStatus, 'scheduled');
  assert.equal(validated.recommendations[0].slotStart, '10:00');
  assert.equal(validated.recommendations[0].slotEnd, '10:30');
  assert.equal(validated.recommendations[1].slotStatus, 'scheduled');
  assert.equal(validated.recommendations[1].slotStart, '13:20');
  assert.equal(validated.recommendations[1].slotEnd, '14:00');
});

test('Scenario 2: Weekday with 0 available time produces explicit reason and non-null unscheduled validationNote', () => {
  const baseTasks = [
    makeTask({ id: 't1', title: '공문 결재', priority: 'urgent', estimatedMinutes: 20 }),
    makeTask({ id: 't2', title: '출석부 확인', priority: 'high', estimatedMinutes: 15 }),
  ];

  // Case A: No timetable registered
  const noTimetableCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T09:00:00+09:00'),
    tasks: baseTasks,
    events: [],
    timetables: [],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(noTimetableCtx.remainingWorkableMinutes, 0);
  assert.equal(noTimetableCtx.availabilityReason, 'no_timetable');
  assert.equal(getAvailabilityReasonShortLabel(noTimetableCtx.availabilityReason), '시간표 미등록');

  // Case B: Timetable exists, but no workable free periods are marked (tight work window = no non-period gaps)
  const noFreeCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T09:00:00+09:00'),
    tasks: baseTasks,
    events: [],
    timetables: [makeWeekdayTimetable({ allFreeUnworkable: true, tightWorkWindow: true })],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(noFreeCtx.remainingWorkableMinutes, 0);
  assert.equal(noFreeCtx.availabilityReason, 'no_workable_free_periods');
  assert.equal(getAvailabilityReasonShortLabel(noFreeCtx.availabilityReason), '가능 공강 미설정');

  // Case C: After work hours (18:00 KST)
  const afterHoursCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T18:00:00+09:00'),
    tasks: baseTasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(afterHoursCtx.remainingWorkableMinutes, 0);
  assert.equal(afterHoursCtx.availabilityReason, 'after_work_hours');

  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '가용 시간이 부족해 우선순위만 정리했습니다.',
      recommendations: [
        {
          taskId: 't1',
          order: 1,
          recommendedStart: null,
          recommendedEnd: null,
          estimatedMinutes: 20,
          reason: '긴급 결재입니다.',
        },
        {
          taskId: 't2',
          order: 2,
          recommendedStart: '10:00',
          recommendedEnd: '10:15',
          estimatedMinutes: 15,
          reason: '출석 확인입니다.',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    afterHoursCtx,
    { model: 'gemini-4-hydrogen', generatedAtIso: '2026-11-16T09:00:00Z' },
  );

  assert.equal(validated.availabilityReason, 'after_work_hours');
  for (const item of validated.recommendations) {
    assert.equal(item.slotStatus, 'unscheduled_overflow');
    assert.equal(item.slotStart, null);
    assert.equal(item.slotEnd, null);
    assert.equal(item.validationNote, getDefaultUnscheduledNote('after_work_hours'));
  }
});

test('Scenario 3: Sunday 2026-11-15 with no override creates 0 arbitrary hours and explains weekend_or_holiday', () => {
  const sundayCtx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-15', // Sunday
    now: new Date('2026-11-15T10:00:00+09:00'),
    tasks: [
      makeTask({ id: 't1', title: '월요일 수업 준비', priority: 'high', estimatedMinutes: 30 }),
      makeTask({ id: 't2', title: '학급 공지 작성', priority: 'normal', estimatedMinutes: 20 }),
    ],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  assert.equal(sundayCtx.fullDayAvailability.isWeekday, false);
  assert.equal(sundayCtx.remainingWorkableMinutes, 0);
  assert.equal(sundayCtx.remainingWorkableIntervals.length, 0);
  assert.equal(sundayCtx.availabilityReason, 'weekend_or_holiday');
  assert.equal(getAvailabilityReasonShortLabel(sundayCtx.availabilityReason), '주말·휴일 (미지정)');
  assert.ok(sundayCtx.availabilityReasonDetail.includes('임의의 근무시간을 만들지 않습니다'));

  const validated = validateAndRepairAiPlan(
    {
      coreAdvice: '휴일에는 우선순위만 참고해 월요일 오전에 처리하세요.',
      recommendations: [
        {
          taskId: 't1',
          order: 1,
          recommendedStart: null,
          recommendedEnd: null,
          estimatedMinutes: 30,
          reason: '월요일 수업 준비',
        },
        {
          taskId: 't2',
          order: 2,
          recommendedStart: '10:00',
          recommendedEnd: '10:20',
          estimatedMinutes: 20,
          reason: '공지 작성',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    sundayCtx,
    { model: 'gemini-4-hydrogen', generatedAtIso: '2026-11-15T01:00:00Z' },
  );

  assert.equal(validated.availabilityReason, 'weekend_or_holiday');
  assert.equal(validated.remainingWorkableMinutes, 0);
  for (const item of validated.recommendations) {
    assert.equal(item.slotStatus, 'unscheduled_overflow');
    assert.equal(item.slotStart, null);
    assert.equal(item.slotEnd, null);
    assert.equal(item.validationNote, getDefaultUnscheduledNote('weekend_or_holiday'));
  }

  // Only when user explicitly adds a Sunday override should hours become available
  const explicitOverride: TimetableOverrideRecord = {
    id: '2026-11-15',
    dateKey: '2026-11-15',
    baseTimetableId: 'tt-weekday',
    reason: '주말 출근 근무',
    workStart: '09:00',
    workEnd: '12:00',
    lunchStart: null,
    lunchEnd: null,
    periodTimes: {
      '1': { period: 1, label: '오전 근무', startTime: '09:00', endTime: '11:00' },
    },
    slots: {
      '1': {
        period: 1,
        kind: 'free',
        subject: '',
        className: '',
        classroom: '',
        note: '',
        workAvailable: true,
      },
    },
    version: 1,
    createdAt: Timestamp.fromDate(new Date('2026-11-15T08:00:00+09:00')),
    updatedAt: Timestamp.fromDate(new Date('2026-11-15T08:00:00+09:00')),
    schemaVersion: 1,
  };
  const sundayWithOverride = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-15',
    now: new Date('2026-11-15T08:30:00+09:00'),
    tasks: [makeTask({ id: 't1', title: '주말 출근 업무' })],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: { '2026-11-15': explicitOverride },
    academicEvents: [],
  });
  assert.equal(sundayWithOverride.availabilityReason, 'available');
  assert.ok(sundayWithOverride.remainingWorkableMinutes > 0);
});

test('Scenario 4: Overlapping personal events, classes, and academic events never allow slot collisions', () => {
  const now = new Date('2026-11-16T08:30:00+09:00');
  const overlappingEvent: CalendarEventRecord = {
    id: 'ev-block-2nd',
    title: '교직원 회의',
    startsAt: Timestamp.fromDate(new Date('2026-11-16T10:00:00+09:00')),
    endsAt: Timestamp.fromDate(new Date('2026-11-16T10:50:00+09:00')),
    allDay: false,
    location: '회의실',
    description: '',
    relatedTaskId: null,
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };
  const academicEventBlock: AcademicEventRecord = {
    id: 'acad-block-4th',
    title: '학부모 공개수업 준비',
    startDate: '2026-11-16',
    endDate: '2026-11-16',
    startTime: '13:20',
    endTime: '13:50',
    category: 'school_event',
    location: '강당',
    schoolYear: 2026,
    sourceType: 'manual',
    sourceLabel: '수기',
    sourceText: '',
    timetableImpact: 'none',
    overrideDateKey: null,
    dedupeKey: '2026-11-16_school_event',
    version: 1,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    schemaVersion: 1,
  };

  const ctx = buildAiPlannerContext({
    uid: 'teacher-1',
    todayKey: '2026-11-16',
    now,
    tasks: [makeTask({ id: 't1', title: '안내문 수정', estimatedMinutes: 20 })],
    events: [overlappingEvent],
    timetables: [makeWeekdayTimetable({ tightWorkWindow: true })],
    overridesByDate: {},
    academicEvents: [academicEventBlock],
  });

  // 2교시(10:00-10:50) is blocked by personal meeting; 4교시 13:20-13:50 blocked by academic event -> only 13:50-14:10 remains
  assert.deepEqual(
    ctx.remainingWorkableIntervals.map((s) => `${s.startTime}-${s.endTime}`),
    ['13:50-14:10'],
  );

  const repaired = validateAndRepairAiPlan(
    {
      coreAdvice: '충돌 없는 시간으로 보정합니다.',
      recommendations: [
        {
          taskId: 't1',
          order: 1,
          // Collides with 1교시(09:00-09:50) and meeting(10:00-10:50) -> must repair to 13:50-14:10
          recommendedStart: '10:00',
          recommendedEnd: '10:20',
          estimatedMinutes: 20,
          reason: '회의 시간과 겹치게 잘못 제안됨',
        },
      ],
      attentionTasks: [],
      deferredTasks: [],
    },
    ctx,
    { model: 'gemini-4-hydrogen', generatedAtIso: '2026-11-16T00:00:00Z' },
  );

  assert.equal(repaired.recommendations[0].slotStatus, 'repaired');
  assert.equal(repaired.recommendations[0].slotStart, '13:50');
  assert.equal(repaired.recommendations[0].slotEnd, '14:10');
});

test('Scenario 5 & 6: Browser reload (F5) and tab return restore cached AI plan with 0 Gemini calls', async () => {
  const storage = new MemoryStorage();
  const tasks = [
    makeTask({ id: 't1', title: '가정통신문 결재', priority: 'urgent', estimatedMinutes: 25 }),
    makeTask({ id: 't2', title: '출결 마감', priority: 'high', estimatedMinutes: 20 }),
  ];
  const ctx = buildAiPlannerContext({
    uid: 'teacher-reload',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  const controller1 = new AiPlannerSessionController(storage);
  controller1.syncSession('teacher-reload', '2026-11-16');
  const fake = makeFakeAiExecutor();

  const firstRun = await controller1.runAiPlan({
    context: ctx,
    executeGemini: fake.executor,
  });
  assert.equal(firstRun.executedAiCall, true);
  assert.equal(firstRun.reason, 'generated');
  assert.equal(fake.getCallCount(), 1);

  controller1.setAiBriefingData({
    model: 'gemini-4-hydrogen',
    generatedAtIso: '2026-11-16T00:10:00Z',
    briefing: {
      summary: '오늘 긴급 업무 1건을 우선 처리하세요.',
      priorityFocus: [
        { title: '가정통신문 결재', reason: '오늘 마감', linkedTaskId: 't1' },
      ],
      imminentAlerts: [],
      conflictAlerts: [],
      missedChecks: [],
    },
  });

  // Scenario 6: User hides panel / moves across tabs and comes back
  controller1.setPlannerVisible(false);
  const reopenResult = await controller1.runAiPlan({
    context: ctx,
    forceRefresh: false,
    executeGemini: fake.executor,
  });
  assert.equal(reopenResult.executedAiCall, false);
  assert.equal(reopenResult.reason, 'fingerprint_cache_hit');
  assert.equal(reopenResult.plan?.fromCache, true);
  assert.equal(fake.getCallCount(), 1);

  // Scenario 5: Simulate browser F5 reload (brand new controller reading same Storage)
  const controller2 = new AiPlannerSessionController(storage);
  const restored = controller2.syncSession('teacher-reload', '2026-11-16');
  assert.equal(restored.plannerVisible, true);
  assert.equal(restored.validatedPlan?.mode, 'ai');
  assert.equal(restored.validatedPlan?.fromCache, true);
  assert.equal(restored.validatedPlan?.recommendations.length, 2);
  assert.equal(
    restored.aiBriefingData?.briefing.summary,
    '오늘 긴급 업무 1건을 우선 처리하세요.',
  );
  assert.equal(fake.getCallCount(), 1);
});

test('Scenario 7: Rapid duplicate clicks and concurrent requests execute Gemini at most once', async () => {
  const storage = new MemoryStorage();
  const controller = new AiPlannerSessionController(storage);
  controller.syncSession('teacher-dedupe', '2026-11-16');

  const ctx = buildAiPlannerContext({
    uid: 'teacher-dedupe',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks: [makeTask({ id: 't1', title: '평가 계획서 제출', priority: 'urgent' })],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  let callCount = 0;
  let releasePending!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });

  const slowExecutor = async (): Promise<GeminiPlannerExecutorResult> => {
    callCount += 1;
    await gate;
    return {
      model: 'gemini-4-hydrogen',
      generatedAtIso: '2026-11-16T00:15:00Z',
      rawPlan: {
        coreAdvice: '평가 계획서를 먼저 제출하세요.',
        recommendations: [
          {
            taskId: 't1',
            order: 1,
            recommendedStart: '10:00',
            recommendedEnd: '10:30',
            estimatedMinutes: 30,
            reason: '오늘 마감',
          },
        ],
        attentionTasks: [],
        deferredTasks: [],
      },
    };
  };

  const req1 = controller.runAiPlan({ context: ctx, executeGemini: slowExecutor });
  const req2 = controller.runAiPlan({ context: ctx, executeGemini: slowExecutor });
  const req3 = controller.runAiPlan({ context: ctx, forceRefresh: true, executeGemini: slowExecutor });

  assert.equal(controller.isInFlight(), true);
  releasePending();

  const [res1, res2, res3] = await Promise.all([req1, req2, req3]);
  assert.equal(callCount, 1);
  assert.equal(res1.executedAiCall, true);
  assert.equal(res2.executedAiCall, false);
  assert.equal(res2.reason, 'in_flight');
  assert.equal(res3.executedAiCall, false);
  assert.equal(res3.reason, 'in_flight');

  // Subsequent non-forced click hits fingerprint cache -> still 1 total call
  const res4 = await controller.runAiPlan({ context: ctx, executeGemini: slowExecutor });
  assert.equal(res4.executedAiCall, false);
  assert.equal(callCount, 1);
});

test('Scenario 8: Local reorder, exclude, slot reassign, and quick filter execute 0 Gemini calls and persist locally', async () => {
  const storage = new MemoryStorage();
  const controller = new AiPlannerSessionController(storage);
  controller.syncSession('teacher-local', '2026-11-16');

  const tasks = [
    makeTask({ id: 't1', title: '업무 1', priority: 'urgent', estimatedMinutes: 20 }),
    makeTask({ id: 't2', title: '업무 2', priority: 'high', estimatedMinutes: 20 }),
    makeTask({ id: 't3', title: '긴 업무 3', priority: 'normal', estimatedMinutes: 60 }),
  ];
  const ctx = buildAiPlannerContext({
    uid: 'teacher-local',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  const fake = makeFakeAiExecutor([
    {
      taskId: 't1',
      order: 1,
      recommendedStart: '10:00',
      recommendedEnd: '10:20',
      estimatedMinutes: 20,
      reason: '1번',
    },
    {
      taskId: 't2',
      order: 2,
      recommendedStart: '10:20',
      recommendedEnd: '10:40',
      estimatedMinutes: 20,
      reason: '2번',
    },
    {
      taskId: 't3',
      order: 3,
      recommendedStart: '13:20',
      recommendedEnd: '14:10',
      estimatedMinutes: 60,
      reason: '3번',
    },
  ]);

  await controller.runAiPlan({ context: ctx, executeGemini: fake.executor });
  assert.equal(fake.getCallCount(), 1);

  const moved = controller.moveItemOrder('t2', 'up', ctx.remainingWorkableIntervals);
  assert.equal(moved?.recommendations[0].taskId, 't2');

  const slot1320Idx = ctx.remainingWorkableIntervals.findIndex(
    (seg) => seg.startTime === '13:20',
  );
  assert.ok(slot1320Idx >= 0);
  const reassigned = controller.reassignItemSlot(
    't1',
    slot1320Idx,
    ctx.remainingWorkableIntervals,
  );
  assert.equal(reassigned?.recommendations[1].slotStart, '13:20');

  const excluded = controller.excludeItem('t3', ctx.remainingWorkableIntervals);
  assert.equal(excluded?.recommendations.length, 2);
  assert.ok(excluded?.deferredTasks.some((d) => d.taskId === 't3'));

  const filteredCtx = buildAiPlannerContext({
    uid: 'teacher-local',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
    filter: { maxTaskMinutes: 30, excludedTaskIds: ['t3'] },
  });
  const filtered = controller.applyQuickFilter(
    { maxTaskMinutes: 30, excludedTaskIds: ['t3'] },
    filteredCtx,
  );
  assert.equal(filtered.recommendations.length, 2);
  assert.equal(fake.getCallCount(), 1);

  // Local edits survive F5 reload cleanly with 0 Gemini calls
  const controllerAfterReload = new AiPlannerSessionController(storage);
  const reloaded = controllerAfterReload.syncSession('teacher-local', '2026-11-16');
  assert.equal(reloaded.plannerFilter.maxTaskMinutes, 30);
  assert.deepEqual(reloaded.plannerFilter.excludedTaskIds, ['t3']);
  assert.equal(fake.getCallCount(), 1);
});

test('Scenario 9: Task modification marks plan stale without auto-calling Gemini until explicit forceRefresh', async () => {
  const storage = new MemoryStorage();
  const controller = new AiPlannerSessionController(storage);
  controller.syncSession('teacher-stale', '2026-11-16');

  const initialTasks = [
    makeTask({ id: 't1', title: '생활기록부 점검', priority: 'high', estimatedMinutes: 25 }),
  ];
  const ctx1 = buildAiPlannerContext({
    uid: 'teacher-stale',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks: initialTasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });

  const fake = makeFakeAiExecutor();
  await controller.runAiPlan({ context: ctx1, executeGemini: fake.executor });
  assert.equal(fake.getCallCount(), 1);
  assert.equal(controller.isPlanStale(ctx1.dataFingerprint), false);

  // Clock ticks by 2 minutes (08:47) with identical tasks/timetable -> NOT stale
  const ctxClockTickOnly = buildAiPlannerContext({
    uid: 'teacher-stale',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:47:00+09:00'),
    tasks: initialTasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(controller.isPlanStale(ctxClockTickOnly.dataFingerprint), false);

  // User adds/edits a task -> dataFingerprint changes -> stale becomes true
  const updatedTasks = [
    ...initialTasks,
    makeTask({ id: 't2', title: '긴급 학부모 상담 연락', priority: 'urgent', estimatedMinutes: 20 }),
  ];
  const ctxUpdated = buildAiPlannerContext({
    uid: 'teacher-stale',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:50:00+09:00'),
    tasks: updatedTasks,
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });
  assert.equal(controller.isPlanStale(ctxUpdated.dataFingerprint), true);

  // Default runAiPlan without forceRefresh reuses existing today's plan (0 Gemini calls)
  const reuseOutcome = await controller.runAiPlan({
    context: ctxUpdated,
    forceRefresh: false,
    executeGemini: fake.executor,
  });
  assert.equal(reuseOutcome.executedAiCall, false);
  assert.equal(reuseOutcome.reason, 'existing_today_plan_reused');
  assert.equal(fake.getCallCount(), 1);

  // Explicit "다시 AI 분석" button (forceRefresh: true) executes Gemini 1 time
  const refreshOutcome = await controller.runAiPlan({
    context: ctxUpdated,
    forceRefresh: true,
    executeGemini: fake.executor,
  });
  assert.equal(refreshOutcome.executedAiCall, true);
  assert.equal(refreshOutcome.reason, 'generated');
  assert.equal(fake.getCallCount(), 2);
  assert.equal(controller.isPlanStale(ctxUpdated.dataFingerprint), false);
});

test('Scenario 10: UID account switch isolates & purges AI cache, and Firestore helpers skip no-op writes & patch caches', async () => {
  const storage = new MemoryStorage();
  const controller = new AiPlannerSessionController(storage);
  controller.syncSession('uid-A', '2026-11-16');

  const fake = makeFakeAiExecutor();
  const ctxA = buildAiPlannerContext({
    uid: 'uid-A',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks: [makeTask({ id: 'a-1', title: 'A 교사 업무' })],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });
  await controller.runAiPlan({ context: ctxA, executeGemini: fake.executor });
  assert.ok(storage.getItem(getAiPlanStorageKey('uid-A')) !== null);

  // Switching to uid-B purges uid-A storage and starts clean
  const stateB = controller.syncSession('uid-B', '2026-11-16');
  assert.equal(stateB.uid, 'uid-B');
  assert.equal(stateB.validatedPlan, null);
  assert.equal(storage.getItem(getAiPlanStorageKey('uid-A')), null);
  assert.equal(loadPersistedAiState('uid-A', '2026-11-16', storage), null);

  // Sign-out clears active user state
  const ctxB = buildAiPlannerContext({
    uid: 'uid-B',
    todayKey: '2026-11-16',
    now: new Date('2026-11-16T08:45:00+09:00'),
    tasks: [makeTask({ id: 'b-1', title: 'B 교사 업무' })],
    events: [],
    timetables: [makeWeekdayTimetable()],
    overridesByDate: {},
    academicEvents: [],
  });
  await controller.runAiPlan({ context: ctxB, executeGemini: fake.executor });
  assert.ok(storage.getItem(getAiPlanStorageKey('uid-B')) !== null);
  controller.resetForSignOut();
  assert.equal(storage.getItem(getAiPlanStorageKey('uid-B')), null);

  // Firestore optimization helper 1: identical task details produce unchanged=true (0 writes)
  const existingTask = makeTask({
    id: 'task-noop',
    title: '동일 제목',
    description: '동일 메모',
    priority: 'normal',
    estimatedMinutes: 30,
  });
  const samePatch = buildTaskDetailsPatch(existingTask.version, {
    title: '동일 제목',
    description: '동일 메모',
    priority: 'normal',
    estimatedMinutes: 30,
  });
  assert.equal(areTaskDetailsUnchanged(existingTask, samePatch), true);

  const modifiedPatch = buildTaskDetailsPatch(existingTask.version, {
    title: '수정된 제목',
  });
  assert.equal(areTaskDetailsUnchanged(existingTask, modifiedPatch), false);

  // Firestore optimization helper 2: incremental page cache patching avoids re-querying tabs
  const activeKey = makeTaskPageCacheKey('active', 'dueAt');
  const doneKey = makeTaskPageCacheKey('done', 'dueAt');
  const unremindedKey = makeTaskPageCacheKey('unreminded', 'dueAt');
  const initialPages: Record<string, CachedTaskPage> = {
    [activeKey]: {
      tasks: [existingTask],
      hasMore: false,
      nextCursor: null,
      usedIndexFallback: false,
    },
    [doneKey]: {
      tasks: [],
      hasMore: false,
      nextCursor: null,
      usedIndexFallback: false,
    },
    [unremindedKey]: {
      tasks: [existingTask],
      hasMore: false,
      nextCursor: null,
      usedIndexFallback: false,
    },
  };

  const completedTask: TaskRecord = { ...existingTask, status: 'done', version: 2 };
  assert.equal(doesTaskMatchFilterTab(completedTask, 'done'), true);
  assert.equal(doesTaskMatchFilterTab(completedTask, 'active'), false);

  const afterDone = patchCachedTaskPages(initialPages, completedTask);
  assert.equal(afterDone[activeKey].tasks.length, 0);
  assert.equal(afterDone[unremindedKey].tasks.length, 0);
  assert.equal(afterDone[doneKey].tasks.length, 1);
  assert.equal(afterDone[doneKey].tasks[0].version, 2);

  const afterPermDelete = removeTaskFromCachedPages(afterDone, completedTask.id);
  assert.equal(afterPermDelete[doneKey].tasks.length, 0);
});
