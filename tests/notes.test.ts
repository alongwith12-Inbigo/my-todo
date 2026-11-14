import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDefaultTaskTitleFromNote,
  computeReorderedNoteUpdates,
  getNextNoteSortOrder,
  sortStickyNotes,
} from '../src/lib/notes';
import type { StickyNoteRecord } from '../src/types/domain';

function ts(iso: string) {
  const date = new Date(iso);
  return {
    toMillis: () => date.getTime(),
    toDate: () => date,
  } as unknown as StickyNoteRecord['updatedAt'];
}

function makeNote(
  id: string,
  overrides: Partial<StickyNoteRecord> = {},
): StickyNoteRecord {
  return {
    id,
    content: `메모 ${id}`,
    color: 'butter',
    isPinned: false,
    sortOrder: 0,
    convertedTaskId: null,
    version: 1,
    createdAt: ts('2026-05-15T00:00:00Z'),
    updatedAt: ts('2026-05-15T00:00:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

test('sortStickyNotes puts pinned notes first, then sortOrder asc, then updatedAt desc', () => {
  const n1 = makeNote('n1', { isPinned: false, sortOrder: 10 });
  const n2 = makeNote('n2', { isPinned: true, sortOrder: 30 });
  const n3 = makeNote('n3', { isPinned: true, sortOrder: 10 });
  const n4 = makeNote('n4', {
    isPinned: false,
    sortOrder: 10,
    updatedAt: ts('2026-05-15T02:00:00Z'),
  });

  const sorted = sortStickyNotes([n1, n2, n3, n4]);
  assert.deepEqual(
    sorted.map((n) => n.id),
    ['n3', 'n2', 'n4', 'n1'],
  );
});

test('buildDefaultTaskTitleFromNote extracts first non-empty line and truncates cleanly', () => {
  assert.equal(
    buildDefaultTaskTitleFromNote('\n  \n  학부모 상담 안내문 발송  \n세부 내용'),
    '학부모 상담 안내문 발송',
  );
  assert.equal(buildDefaultTaskTitleFromNote('   \n  '), '메모에서 전환한 업무');
  assert.equal(buildDefaultTaskTitleFromNote('가'.repeat(150)).length, 120);
});

test('computeReorderedNoteUpdates handles distinct swaps and colliding sortOrder normalization', () => {
  const a = makeNote('a', { sortOrder: 10 });
  const b = makeNote('b', { sortOrder: 20 });
  const swap = computeReorderedNoteUpdates([a, b], 'b', 'up');
  assert.deepEqual(swap, [
    { id: 'b', sortOrder: 10 },
    { id: 'a', sortOrder: 20 },
  ]);

  // Colliding sortOrders (e.g., 0, 0, 0 from legacy or external desktop creation)
  const c1 = makeNote('c1', { sortOrder: 0, updatedAt: ts('2026-05-15T03:00:00Z') });
  const c2 = makeNote('c2', { sortOrder: 0, updatedAt: ts('2026-05-15T02:00:00Z') });
  const c3 = makeNote('c3', { sortOrder: 0, updatedAt: ts('2026-05-15T01:00:00Z') });

  // Order starts [c1, c2, c3]; move c2 up -> [c2, c1, c3] -> sortOrders 0, 10, 20
  const normalized = computeReorderedNoteUpdates([c1, c2, c3], 'c2', 'up');
  const map = new Map(normalized.map((u) => [u.id, u.sortOrder]));
  const c2Order = map.get('c2') ?? c2.sortOrder;
  const c1Order = map.get('c1') ?? c1.sortOrder;
  const c3Order = map.get('c3') ?? c3.sortOrder;
  assert.ok(c2Order < c1Order && c1Order < c3Order);

  assert.equal(getNextNoteSortOrder([]), 10);
  assert.equal(getNextNoteSortOrder([a, b]), 30);
});
