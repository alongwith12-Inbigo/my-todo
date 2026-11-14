import type { Timestamp } from 'firebase/firestore';

export const SCHEMA_VERSION = 1 as const;

export const VALIDATION_LIMITS = {
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  ID_MAX_LEN: 128,
  EMAIL_MIN_LEN: 3,
  EMAIL_MAX_LEN: 254,
  DISPLAY_NAME_MIN_LEN: 1,
  DISPLAY_NAME_MAX_LEN: 80,
  SCHOOL_NAME_MAX_LEN: 80,
  SUBJECT_MAX_LEN: 60,
  ADMIN_NOTE_MAX_LEN: 300,
  TITLE_MIN_LEN: 1,
  TITLE_MAX_LEN: 120,
  DESCRIPTION_MAX_LEN: 2000,
  LOCATION_MAX_LEN: 120,
  NOTE_CONTENT_MAX_LEN: 2000,
  IMMINENT_DAYS_MIN: 1,
  IMMINENT_DAYS_MAX: 14,
  TIMETABLE_NAME_MIN_LEN: 1,
  TIMETABLE_NAME_MAX_LEN: 80,
  TIMETABLE_SEMESTER_MAX_LEN: 40,
  TIMETABLE_PERIOD_MAX: 12,
  TIMETABLE_SUBJECT_MAX_LEN: 80,
  TIMETABLE_CLASS_MAX_LEN: 40,
  TIMETABLE_ROOM_MAX_LEN: 40,
  TIMETABLE_NOTE_MAX_LEN: 160,
  TIMETABLE_REASON_MAX_LEN: 120,
} as const;

export type AccountStatus = 'pending' | 'active' | 'suspended' | 'rejected';
export type AccountRole = 'teacher' | 'admin';

export interface AccessRecord {
  uid: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  role: AccountRole;
  requestedAt: Timestamp;
  reviewedAt: Timestamp | null;
  reviewedBy: string | null;
  note: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export interface UserProfile {
  displayName: string;
  email: string;
  schoolName: string;
  subject: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export type CalendarViewMode = 'week' | 'month';

export interface UserPreferences {
  timezone: 'Asia/Seoul';
  imminentDays: number;
  defaultCalendarView: CalendarViewMode;
  browserNotifyEnabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'on_hold';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSourceType =
  | 'manual'
  | 'note'
  | 'import_text'
  | 'import_ocr'
  | 'import_ai';

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Timestamp | null;
  scheduledAt: Timestamp | null;
  remindAt: Timestamp | null;
  completedAt: Timestamp | null;
  sourceType: TaskSourceType;
  relatedEventId: string | null;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export type NoteColor = 'butter' | 'mint' | 'sky' | 'peach' | 'lavender';

export interface CalendarEventRecord {
  id: string;
  title: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  allDay: boolean;
  location: string;
  description: string;
  relatedTaskId: string | null;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export interface StickyNoteRecord {
  id: string;
  content: string;
  color: NoteColor;
  isPinned: boolean;
  sortOrder: number;
  convertedTaskId: string | null;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export type TimetableWeekday = 1 | 2 | 3 | 4 | 5;
export type TimetableSlotKind = 'class' | 'free' | 'fixed_duty' | 'other';
export type TimetableSourceType = 'manual' | 'excel' | 'ocr';

export interface TimetablePeriodTime {
  period: number;
  label: string;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface TimetableSlot {
  day: TimetableWeekday;
  period: number;
  kind: TimetableSlotKind;
  subject: string;
  className: string;
  classroom: string;
  note: string;
  /**
   * Explicitly records whether a free/other period may be used for task work.
   * Free periods default to false and must never be assumed workable automatically.
   */
  workAvailable: boolean;
}

export interface TimetableRecord {
  id: string;
  name: string;
  semesterLabel: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  workStart: string; // HH:MM
  workEnd: string; // HH:MM
  lunchStart: string; // HH:MM
  lunchEnd: string; // HH:MM
  periodCount: number;
  periodTimes: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableSlot>; // key: `${day}_${period}`
  isActive: boolean;
  sourceType: TimetableSourceType;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export interface TimetableOverrideSlot {
  period: number;
  kind: TimetableSlotKind;
  subject: string;
  className: string;
  classroom: string;
  note: string;
  workAvailable: boolean;
}

export interface TimetableOverrideRecord {
  id: string; // dateKey YYYY-MM-DD
  dateKey: string; // YYYY-MM-DD
  baseTimetableId: string | null;
  reason: string;
  workStart: string | null;
  workEnd: string | null;
  lunchStart: string | null;
  lunchEnd: string | null;
  periodTimes: Record<string, TimetablePeriodTime>;
  slots: Record<string, TimetableOverrideSlot>; // key: `${period}`
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  schemaVersion: number;
}

export type NavSection =
  | 'today'
  | 'tasks'
  | 'calendar'
  | 'notes'
  | 'settings';


