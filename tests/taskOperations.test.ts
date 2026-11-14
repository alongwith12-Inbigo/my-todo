import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateTaskPayload,
  buildRestorePatch,
  buildSoftDeletePatch,
  buildTaskDetailsPatch,
  buildTaskStatusPatch,
  TaskValidationError,
} from '../src/repositories/taskOperations';
import { SCHEMA_VERSION } from '../src/types/domain';

const FAKE_SENTINEL = { _sentinel: 'serverTimestamp' } as unknown as ReturnType<
  typeof import('firebase/firestore').serverTimestamp
>;

test('buildCreateTaskPayload initializes todo task with version 1 and null completedAt', () => {
  const payload = buildCreateTaskPayload(
    {
      title: '  학부모   상담   안내문  ',
      description: '  첫째 줄\n둘째 줄  ',
      priority: 'high',
    },
    FAKE_SENTINEL,
  );

  assert.equal(payload.title, '학부모 상담 안내문');
  assert.equal(payload.description, '첫째 줄\n둘째 줄');
  assert.equal(payload.status, 'todo');
  assert.equal(payload.priority, 'high');
  assert.equal(payload.completedAt, null);
  assert.equal(payload.isDeleted, false);
  assert.equal(payload.deletedAt, null);
  assert.equal(payload.version, 1);
  assert.equal(payload.schemaVersion, SCHEMA_VERSION);
  assert.equal(payload.createdAt, FAKE_SENTINEL);
  assert.equal(payload.updatedAt, FAKE_SENTINEL);
});

test('buildCreateTaskPayload sets completedAt sentinel when created directly as done', () => {
  const payload = buildCreateTaskPayload(
    { title: '완료된 상태로 등록', status: 'done' },
    FAKE_SENTINEL,
  );
  assert.equal(payload.status, 'done');
  assert.equal(payload.completedAt, FAKE_SENTINEL);
});

test('buildCreateTaskPayload rejects empty title or invalid relatedEventId', () => {
  assert.throws(
    () => buildCreateTaskPayload({ title: '   ' }, FAKE_SENTINEL),
    TaskValidationError,
  );
  assert.throws(
    () => buildCreateTaskPayload({ title: '테스트', relatedEventId: 'bad$id' }, FAKE_SENTINEL),
    TaskValidationError,
  );
});

test('buildTaskDetailsPatch includes only allowed Branch 1 fields and increments version', () => {
  const patch = buildTaskDetailsPatch(
    3,
    { title: '수정된 제목', priority: 'urgent' },
    FAKE_SENTINEL,
  );
  assert.deepEqual(Object.keys(patch).sort(), ['priority', 'title', 'updatedAt', 'version']);
  assert.equal(patch.version, 4);
  assert.equal(patch.updatedAt, FAKE_SENTINEL);
});

test('buildTaskDetailsPatch rejects empty patch or invalid version', () => {
  assert.throws(() => buildTaskDetailsPatch(1, {}, FAKE_SENTINEL), TaskValidationError);
  assert.throws(
    () => buildTaskDetailsPatch(0, { title: '제목' }, FAKE_SENTINEL),
    TaskValidationError,
  );
});

test('buildTaskStatusPatch enforces completedAt consistency across done and reopen transitions', () => {
  const donePatch = buildTaskStatusPatch(2, 'done', FAKE_SENTINEL);
  assert.equal(donePatch.status, 'done');
  assert.equal(donePatch.completedAt, FAKE_SENTINEL);
  assert.equal(donePatch.version, 3);

  const reopenPatch = buildTaskStatusPatch(3, 'todo', FAKE_SENTINEL);
  assert.equal(reopenPatch.status, 'todo');
  assert.equal(reopenPatch.completedAt, null);
  assert.equal(reopenPatch.version, 4);
});

test('buildSoftDeletePatch and buildRestorePatch follow Branch 3 and Branch 4 shapes', () => {
  const delPatch = buildSoftDeletePatch(4, FAKE_SENTINEL);
  assert.deepEqual(delPatch, {
    isDeleted: true,
    deletedAt: FAKE_SENTINEL,
    version: 5,
    updatedAt: FAKE_SENTINEL,
  });

  const resPatch = buildRestorePatch(5, FAKE_SENTINEL);
  assert.deepEqual(resPatch, {
    isDeleted: false,
    deletedAt: null,
    version: 6,
    updatedAt: FAKE_SENTINEL,
  });
});
