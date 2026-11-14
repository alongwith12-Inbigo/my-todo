import { timestampToMillis } from './briefing';
import { sanitizeSingleLine } from './dateKst';
import { VALIDATION_LIMITS, type NoteColor, type StickyNoteRecord } from '../types/domain';

export interface NoteColorStyle {
  id: NoteColor;
  label: string;
  cardBg: string;
  cardBorder: string;
  swatchBg: string;
}

export const NOTE_COLORS: readonly NoteColorStyle[] = [
  {
    id: 'butter',
    label: '연노랑',
    cardBg: 'bg-amber-50',
    cardBorder: 'border-amber-200/90',
    swatchBg: 'bg-amber-200',
  },
  {
    id: 'mint',
    label: '민트',
    cardBg: 'bg-emerald-50',
    cardBorder: 'border-emerald-200/90',
    swatchBg: 'bg-emerald-200',
  },
  {
    id: 'sky',
    label: '하늘',
    cardBg: 'bg-sky-50',
    cardBorder: 'border-sky-200/90',
    swatchBg: 'bg-sky-200',
  },
  {
    id: 'peach',
    label: '살구',
    cardBg: 'bg-orange-50',
    cardBorder: 'border-orange-200/90',
    swatchBg: 'bg-orange-200',
  },
  {
    id: 'lavender',
    label: '라벤더',
    cardBg: 'bg-violet-50',
    cardBorder: 'border-violet-200/90',
    swatchBg: 'bg-violet-200',
  },
] as const;

export function getNoteColorStyle(color: NoteColor): NoteColorStyle {
  return NOTE_COLORS.find((item) => item.id === color) ?? NOTE_COLORS[0];
}

export function sortStickyNotes(notes: StickyNoteRecord[]): StickyNoteRecord[] {
  return [...notes].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    const updatedA = timestampToMillis(a.updatedAt) ?? 0;
    const updatedB = timestampToMillis(b.updatedAt) ?? 0;
    if (updatedB !== updatedA) {
      return updatedB - updatedA;
    }
    return a.id.localeCompare(b.id);
  });
}

export function buildDefaultTaskTitleFromNote(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmptyLine) {
    return '메모에서 전환한 업무';
  }
  return sanitizeSingleLine(firstNonEmptyLine, VALIDATION_LIMITS.TITLE_MAX_LEN);
}

export function getNextNoteSortOrder(existingNotes: StickyNoteRecord[]): number {
  if (existingNotes.length === 0) return 10;
  let maxOrder = 0;
  for (const note of existingNotes) {
    if (note.sortOrder > maxOrder) maxOrder = note.sortOrder;
  }
  return Math.min(100000, maxOrder + 10);
}

export interface NoteOrderUpdate {
  id: string;
  sortOrder: number;
}

/**
 * Computes minimal sortOrder updates to move `noteId` up (-1) or down (+1)
 * within its pin group (pinned vs unpinned). Normalizes colliding sortOrders
 * to clean multiples of 10 so swaps always persist deterministically.
 */
export function computeReorderedNoteUpdates(
  groupNotes: StickyNoteRecord[],
  noteId: string,
  direction: 'up' | 'down',
): NoteOrderUpdate[] {
  const sorted = sortStickyNotes(groupNotes);
  const index = sorted.findIndex((n) => n.id === noteId);
  if (index === -1) return [];

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= sorted.length) return [];

  const reordered = [...sorted];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, moved);

  // Check if swapping the two adjacent items' distinct sortOrders suffices
  const a = sorted[index];
  const b = sorted[targetIndex];
  if (a.sortOrder !== b.sortOrder) {
    return [
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: a.sortOrder },
    ];
  }

  // Fallback when existing notes shared identical sortOrder: assign clean 10-step spacing
  const updates: NoteOrderUpdate[] = [];
  reordered.forEach((item, idx) => {
    const nextOrder = Math.min(100000, idx * 10);
    if (item.sortOrder !== nextOrder) {
      updates.push({ id: item.id, sortOrder: nextOrder });
    }
  });
  return updates;
}

export function sortConvertedNotes(
  notes: StickyNoteRecord[],
): StickyNoteRecord[] {
  return [...notes].sort((a, b) => {
    const updatedA = timestampToMillis(a.updatedAt) ?? 0;
    const updatedB = timestampToMillis(b.updatedAt) ?? 0;
    if (updatedB !== updatedA) {
      return updatedB - updatedA;
    }
    return a.id.localeCompare(b.id);
  });
}

export function partitionNotesByConversion(notes: StickyNoteRecord[]): {
  activeNotes: StickyNoteRecord[];
  convertedNotes: StickyNoteRecord[];
} {
  const active: StickyNoteRecord[] = [];
  const converted: StickyNoteRecord[] = [];

  for (const note of notes) {
    if (note.convertedTaskId !== null) {
      converted.push(note);
    } else {
      active.push(note);
    }
  }

  return {
    activeNotes: sortStickyNotes(active),
    convertedNotes: sortConvertedNotes(converted),
  };
}

export function filterNotesByQuery(
  notes: StickyNoteRecord[],
  searchTerm: string,
): StickyNoteRecord[] {
  const q = searchTerm.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter((n) => n.content.toLowerCase().includes(q));
}

