import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import { normalizeAiNoticeCandidates } from '../src/lib/aiImportValidator';
import { AI_LIMITS } from '../src/lib/aiTypes';
import { parseKoreanDateTimeExpression } from '../src/lib/koreanDateParser';
import {
  parseSchoolNoticeText,
  recomputeDuplicateWarnings,
  segmentNoticeBlocks,
} from '../src/lib/importParser';
import type { CalendarEventRecord, TaskRecord } from '../src/types/domain';

// Fixed KST anchor: 2026-11-14 10:00 KST (Saturday) -> 2026-11-14T01:00:00Z
const FIXED_NOW = new Date('2026-11-14T01:00:00Z');

test('parseKoreanDateTimeExpression resolves explicit, yearless (today/future/past in KST), relative, and class-period dates', () => {
  // 1) Explicit year (keeps entered year even if in the past)
  const fullPast = parseKoreanDateTimeExpression('2026년 10월 1일 행사 안내', FIXED_NOW);
  assert.equal(fullPast.dateKey, '2026-10-01');
  assert.equal(fullPast.yearExplicit, true);
  assert.equal(fullPast.needsConfirmation, false);

  const fullFuture = parseKoreanDateTimeExpression('2026.11.30.까지 제출', FIXED_NOW);
  assert.equal(fullFuture.dateKey, '2026-11-30');
  assert.equal(fullFuture.yearExplicit, true);
  assert.equal(fullFuture.hasDeadlineCue, true);
  assert.equal(fullFuture.needsConfirmation, false);

  // 2) Year omitted: today or future -> current KST year (2026), NO confirmation needed
  const todayMd = parseKoreanDateTimeExpression('11월 14일까지 제출', FIXED_NOW);
  assert.equal(todayMd.dateKey, '2026-11-14');
  assert.equal(todayMd.yearExplicit, false);
  assert.equal(todayMd.needsConfirmation, false);

  const novMd = parseKoreanDateTimeExpression('11월 20일까지 회신 부탁드립니다.', FIXED_NOW);
  assert.equal(novMd.dateKey, '2026-11-20');
  assert.equal(novMd.yearExplicit, false);
  assert.equal(novMd.hasDeadlineCue, true);
  assert.equal(novMd.needsConfirmation, false);

  const decMd = parseKoreanDateTimeExpression('12월 5일 학부모 간담회', FIXED_NOW);
  assert.equal(decMd.dateKey, '2026-12-05');
  assert.equal(decMd.yearExplicit, false);
  assert.equal(decMd.needsConfirmation, false);

  // 3) Year omitted & already passed in current KST year -> next year (2027), NO confirmation needed
  const janMd = parseKoreanDateTimeExpression('1월 10일 교육계획 제출', FIXED_NOW);
  assert.equal(janMd.dateKey, '2027-01-10');
  assert.equal(janMd.yearExplicit, false);
  assert.equal(janMd.needsConfirmation, false);

  // 4) Slash date + explicit time after numbered bullet -> NO confirmation needed
  const slashTime = parseKoreanDateTimeExpression('1. 11/23(월) 13:10 대회의실', FIXED_NOW);
  assert.equal(slashTime.dateKey, '2026-11-23');
  assert.equal(slashTime.startTime, '13:10');
  assert.equal(slashTime.needsConfirmation, false);

  // 5) Relative date + class period -> flags confirmation for bell schedule
  const relPeriod = parseKoreanDateTimeExpression('내일 5교시 수업 공개', FIXED_NOW);
  assert.equal(relPeriod.dateKey, '2026-11-15');
  assert.equal(relPeriod.periodLabel, '5교시');
  assert.equal(relPeriod.needsConfirmation, true);

  // 6) Ambiguous time (missing 오전/오후) -> still flags confirmation
  const ambTime = parseKoreanDateTimeExpression('11월 20일 2시 교무실 협의', FIXED_NOW);
  assert.equal(ambTime.dateKey, '2026-11-20');
  assert.equal(ambTime.needsConfirmation, true);

  // 7) Next week Friday from Saturday 2026-11-14 -> 2026-11-20
  const nextFri = parseKoreanDateTimeExpression('다음 주 금요일 오후 2시~3시 30분', FIXED_NOW);
  assert.equal(nextFri.dateKey, '2026-11-20');
  assert.equal(nextFri.startTime, '14:00');
  assert.equal(nextFri.endTime, '15:30');
  assert.equal(nextFri.needsConfirmation, false);
});

test('segmentNoticeBlocks keeps metadata sub-lines attached to parent notice item', () => {
  const sample = `
[교직원 협의회 안내]
일시: 11/23(월) 13:10
장소: 본관 2층 대회의실
내용: 기말고사 감독 배정

1. 안전교육 연수 이수증 11월 20일까지 제출
2. 내일 5교시 3학년 교무실 학년 협의
`;
  const blocks = segmentNoticeBlocks(sample);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].length, 4);
  assert.match(blocks[1][0], /안전교육/);
  assert.match(blocks[2][0], /학년 협의/);
});

test('parseSchoolNoticeText classifies contextually, applies yearless rule to tasks/events, and flags only genuine ambiguity', () => {
  const sample = `
1. 학교폭력 예방 연수 이수증 2026.11.20.까지 제출
2. 교직원 협의회
일시: 11/23(월) 13:10
장소: 본관 2층 대회의실
3. 교육과정 워크숍 안내 (장소: 시청각실, 오후 2시~4시)
4. 2026.11.25. 안내문 확인 및 학부모 간담회
5. 1월 10일 새 학기 교육과정 회의 (오전 10:00, 시청각실)
6. 1월 15일까지 학급비 정산서 제출
`;

  const existingTasks: TaskRecord[] = [
    {
      id: 't-existing',
      title: '학교폭력 예방 연수 이수증 제출',
      description: '',
      status: 'todo',
      priority: 'normal',
      dueAt: Timestamp.fromDate(new Date('2026-11-20T14:59:59Z')),
      scheduledAt: null,
      remindAt: null,
      completedAt: null,
      sourceType: 'manual',
      relatedEventId: null,
      isDeleted: false,
      deletedAt: null,
      version: 1,
      createdAt: Timestamp.fromDate(FIXED_NOW),
      updatedAt: Timestamp.fromDate(FIXED_NOW),
      schemaVersion: 1,
    },
  ];
  const existingEvents: CalendarEventRecord[] = [];

  const result = parseSchoolNoticeText(sample, {
    now: FIXED_NOW,
    existingTasks,
    existingEvents,
  });

  assert.equal(result.candidates.length, 6);

  // Item 1: Task + detects duplicate
  assert.equal(result.candidates[0].kind, 'task');
  assert.equal(result.candidates[0].dueDateStr, '2026-11-20');
  assert.equal(result.candidates[0].needsConfirmation, false);
  assert.ok(result.candidates[0].duplicateWarnings.length >= 1);

  // Item 2: Event with time & location, year omitted (11/23 >= 11/14) -> 2026-11-23, NO confirmation needed
  assert.equal(result.candidates[1].kind, 'event');
  assert.equal(result.candidates[1].eventDateStr, '2026-11-23');
  assert.equal(result.candidates[1].startTimeStr, '13:10');
  assert.equal(result.candidates[1].location, '본관 2층 대회의실');
  assert.equal(result.candidates[1].needsConfirmation, false);

  // Item 3: Event with location + time range, missing date -> needsConfirmation
  assert.equal(result.candidates[2].kind, 'event');
  assert.equal(result.candidates[2].location, '시청각실');
  assert.equal(result.candidates[2].startTimeStr, '14:00');
  assert.equal(result.candidates[2].endTimeStr, '16:00');
  assert.equal(result.candidates[2].needsConfirmation, true);

  // Item 4: Mixed task ("확인") + event ("간담회") -> flagged for confirmation
  assert.equal(result.candidates[3].needsConfirmation, true);

  // Item 5: Past month/day without year for EVENT -> rolls over to 2027, NO confirmation needed
  assert.equal(result.candidates[4].kind, 'event');
  assert.equal(result.candidates[4].eventDateStr, '2027-01-10');
  assert.equal(result.candidates[4].startTimeStr, '10:00');
  assert.equal(result.candidates[4].needsConfirmation, false);

  // Item 6: Past month/day without year for TASK -> rolls over to 2027, NO confirmation needed
  assert.equal(result.candidates[5].kind, 'task');
  assert.equal(result.candidates[5].dueDateStr, '2027-01-15');
  assert.equal(result.candidates[5].needsConfirmation, false);

  // Removing duplicate clears batch warning dynamically
  const afterUpdate = recomputeDuplicateWarnings(
    result.candidates.slice(1),
    existingTasks,
    existingEvents,
  );
  assert.equal(afterUpdate[0].duplicateWarnings.length, 0);
});

test('Long multi-line task lists (>10,000 chars and >25 items) are parsed and normalized without early clipping', () => {
  assert.ok(AI_LIMITS.NOTICE_INPUT_MAX_CHARS >= 30000);
  assert.ok(AI_LIMITS.MAX_NOTICE_CHARS >= 20000);
  assert.ok(AI_LIMITS.MAX_CANDIDATES >= 50);

  const longNotePadding = '세부 안내 사항 및 학급별 전달 내용을 빠짐없이 확인해 주시기 바랍니다. '.repeat(7);
  const longLines = Array.from({ length: 40 }, (_, i) =>
    `${i + 1}. 11월 20일까지 ${i + 1}번 학급 업무 보고서 제출 - ${longNotePadding}`,
  );
  const bulkText = longLines.join('\n');
  assert.ok(bulkText.length > 10000);
  assert.ok(bulkText.length <= AI_LIMITS.MAX_NOTICE_CHARS);

  const parsed = parseSchoolNoticeText(bulkText, { now: FIXED_NOW });
  assert.equal(parsed.candidates.length, 40);
  assert.equal(parsed.candidates[39].kind, 'task');
  assert.equal(parsed.candidates[39].dueDateStr, '2026-11-20');

  const rawAiCandidates = Array.from({ length: 45 }, (_, i) => ({
    kind: 'task' as const,
    title: `대량 업무 ${i + 1} 제출`,
    dueDate: '2026-11-20',
  }));
  const aiNormalized = normalizeAiNoticeCandidates(
    { candidates: rawAiCandidates, unparsedSummary: [] },
    { now: FIXED_NOW },
  );
  assert.equal(aiNormalized.candidates.length, 45);
});

