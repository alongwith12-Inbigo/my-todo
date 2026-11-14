import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import {
  buildCreateEventPayload,
  EventValidationError,
} from '../src/repositories/eventOperations';
import {
  buildCreateNotePayload,
  NoteValidationError,
} from '../src/repositories/noteOperations';
import { SCHEMA_VERSION } from '../src/types/domain';

const FAKE_SENTINEL = { _sentinel: 'serverTimestamp' } as unknown as ReturnType<
  typeof import('firebase/firestore').serverTimestamp
>;

test('buildCreateEventPayload validates title, time ordering, and relatedTaskId', () => {
  const startsAt = Timestamp.fromDate(new Date('2026-05-15T01:00:00Z'));
  const endsAt = Timestamp.fromDate(new Date('2026-05-15T02:00:00Z'));

  const payload = buildCreateEventPayload(
    {
      title: '  교직원   전체 회의  ',
      startsAt,
      endsAt,
      allDay: false,
      location: '  본관 2층 회의실  ',
      description: '  안건 정리  ',
      relatedTaskId: 'task_123',
    },
    FAKE_SENTINEL,
  );

  assert.equal(payload.title, '교직원 전체 회의');
  assert.equal(payload.location, '본관 2층 회의실');
  assert.equal(payload.description, '안건 정리');
  assert.equal(payload.relatedTaskId, 'task_123');
  assert.equal(payload.version, 1);
  assert.equal(payload.schemaVersion, SCHEMA_VERSION);

  assert.throws(
    () =>
      buildCreateEventPayload(
        { title: '   ', startsAt, endsAt, allDay: false },
        FAKE_SENTINEL,
      ),
    EventValidationError,
  );

  assert.throws(
    () =>
      buildCreateEventPayload(
        { title: '역전 일정', startsAt: endsAt, endsAt: startsAt, allDay: false },
        FAKE_SENTINEL,
      ),
    EventValidationError,
  );
});

test('buildCreateNotePayload validates content, color, sortOrder, and initializes convertedTaskId as null', () => {
  const payload = buildCreateNotePayload(
    {
      content: '  학급비 정산 영수증 챙기기  ',
      color: 'mint',
      isPinned: true,
      sortOrder: 20,
    },
    FAKE_SENTINEL,
  );

  assert.equal(payload.content, '학급비 정산 영수증 챙기기');
  assert.equal(payload.color, 'mint');
  assert.equal(payload.isPinned, true);
  assert.equal(payload.sortOrder, 20);
  assert.equal(payload.convertedTaskId, null);
  assert.equal(payload.version, 1);
  assert.equal(payload.schemaVersion, SCHEMA_VERSION);

  assert.throws(
    () => buildCreateNotePayload({ content: '   ' }, FAKE_SENTINEL),
    NoteValidationError,
  );
  assert.throws(
    () =>
      buildCreateNotePayload(
        { content: '정상 내용', sortOrder: -1 },
        FAKE_SENTINEL,
      ),
    NoteValidationError,
  );
});
