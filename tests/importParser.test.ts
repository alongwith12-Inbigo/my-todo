import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import { parseKoreanDateTimeExpression } from '../src/lib/koreanDateParser';
import {
  parseSchoolNoticeText,
  recomputeDuplicateWarnings,
  segmentNoticeBlocks,
} from '../src/lib/importParser';
import type { CalendarEventRecord, TaskRecord } from '../src/types/domain';

// Fixed KST anchor: 2026-11-14 10:00 KST (Saturday) -> 2026-11-14T01:00:00Z
const FIXED_NOW = new Date('2026-11-14T01:00:00Z');

test('parseKoreanDateTimeExpression resolves explicit, implicit-year, relative, and class-period dates in KST', () => {
  // 1) Explicit year
  const full = parseKoreanDateTimeExpression('2026.11.30.까지 제출', FIXED_NOW);
  assert.equal(full.dateKey, '2026-11-30');
  assert.equal(full.yearExplicit, true);
  assert.equal(full.hasDeadlineCue, true);
  assert.equal(full.needsConfirmation, false);

  // 2) Implicit year -> resolves using current KST year and flags confirmation
  const md = parseKoreanDateTimeExpression('11월 20일까지 회신 부탁드립니다.', FIXED_NOW);
  assert.equal(md.dateKey, '2026-11-20');
  assert.equal(md.yearExplicit, false);
  assert.equal(md.hasDeadlineCue, true);
  assert.equal(md.needsConfirmation, true);

  // 3) Slash date + time after numbered bullet
  const slashTime = parseKoreanDateTimeExpression('1. 11/23(월) 13:10 대회의실', FIXED_NOW);
  assert.equal(slashTime.dateKey, '2026-11-23');
  assert.equal(slashTime.startTime, '13:10');
  assert.equal(slashTime.needsConfirmation, true); // year omitted

  // 4) Relative date + class period -> flags confirmation for bell schedule
  const relPeriod = parseKoreanDateTimeExpression('내일 5교시 수업 공개', FIXED_NOW);
  assert.equal(relPeriod.dateKey, '2026-11-15');
  assert.equal(relPeriod.periodLabel, '5교시');
  assert.equal(relPeriod.needsConfirmation, true);

  // 5) Next week Friday from Saturday 2026-11-14 -> 2026-11-20
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

test('parseSchoolNoticeText classifies contextually and flags ambiguous or duplicate candidates', () => {
  const sample = `
1. 학교폭력 예방 연수 이수증 2026.11.20.까지 제출
2. 교직원 협의회
일시: 11/23(월) 13:10
장소: 본관 2층 대회의실
3. 교육과정 워크숍 안내 (장소: 시청각실, 오후 2시~4시)
4. 2026.11.25. 안내문 확인 및 학부모 간담회
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

  assert.equal(result.candidates.length, 4);

  // Item 1: contains "연수" noun, but context ("이수증 ... 까지 제출") makes it a TASK + detects duplicate
  assert.equal(result.candidates[0].kind, 'task');
  assert.equal(result.candidates[0].dueDateStr, '2026-11-20');
  assert.ok(result.candidates[0].duplicateWarnings.length >= 1);

  // Item 2: Event with time & location, year omitted -> needsConfirmation
  assert.equal(result.candidates[1].kind, 'event');
  assert.equal(result.candidates[1].eventDateStr, '2026-11-23');
  assert.equal(result.candidates[1].startTimeStr, '13:10');
  assert.equal(result.candidates[1].location, '본관 2층 대회의실');
  assert.equal(result.candidates[1].needsConfirmation, true);

  // Item 3: Event with location + time range, missing date -> needsConfirmation
  assert.equal(result.candidates[2].kind, 'event');
  assert.equal(result.candidates[2].location, '시청각실');
  assert.equal(result.candidates[2].startTimeStr, '14:00');
  assert.equal(result.candidates[2].endTimeStr, '16:00');
  assert.equal(result.candidates[2].needsConfirmation, true);

  // Item 4: Mixed task ("확인") + event ("간담회") -> flagged for confirmation
  assert.equal(result.candidates[3].needsConfirmation, true);

  // Removing duplicate clears batch warning dynamically
  const afterUpdate = recomputeDuplicateWarnings(
    result.candidates.slice(1),
    existingTasks,
    existingEvents,
  );
  assert.equal(afterUpdate[0].duplicateWarnings.length, 0);
});
