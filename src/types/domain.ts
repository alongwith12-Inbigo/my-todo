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

export type NavSection = 'today' | 'tasks' | 'calendar' | 'notes' | 'settings';
