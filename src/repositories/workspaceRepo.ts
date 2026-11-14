import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { isValidFirestoreId, sanitizeSingleLine } from '../lib/dateKst';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type CalendarViewMode,
  type UserPreferences,
  type UserProfile,
} from '../types/domain';

interface WorkspaceCacheEntry {
  profile: UserProfile;
  preferences: UserPreferences;
}

const workspaceCache = new Map<string, WorkspaceCacheEntry>();

export function clearWorkspaceCache(uid?: string): void {
  if (uid) {
    workspaceCache.delete(uid);
  } else {
    workspaceCache.clear();
  }
}

export async function loadOrInitializeWorkspace(params: {
  uid: string;
  email: string;
  displayName: string;
}): Promise<WorkspaceCacheEntry> {
  const { uid, email, displayName } = params;
  if (!isValidFirestoreId(uid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }

  const cached = workspaceCache.get(uid);
  if (cached) {
    return cached;
  }

  const profilePath = `users/${uid}/profile/main`;
  const prefsPath = `users/${uid}/settings/preferences`;

  let profile: UserProfile;
  let preferences: UserPreferences;

  try {
    const profileRef = doc(db, 'users', uid, 'profile', 'main');
    const profileSnap = await getDoc(profileRef);
    if (!profileSnap.exists()) {
      const safeName =
        sanitizeSingleLine(displayName, VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN) || '교사';
      const now = serverTimestamp();
      await setDoc(profileRef, {
        displayName: safeName,
        email,
        schoolName: '',
        subject: '',
        createdAt: now,
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION,
      });
      const createdSnap = await getDoc(profileRef);
      profile = createdSnap.data() as UserProfile;
    } else {
      profile = profileSnap.data() as UserProfile;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, profilePath);
  }

  try {
    const prefsRef = doc(db, 'users', uid, 'settings', 'preferences');
    const prefsSnap = await getDoc(prefsRef);
    if (!prefsSnap.exists()) {
      const now = serverTimestamp();
      await setDoc(prefsRef, {
        timezone: 'Asia/Seoul',
        imminentDays: 3,
        defaultCalendarView: 'week',
        browserNotifyEnabled: false,
        createdAt: now,
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION,
      });
      const createdSnap = await getDoc(prefsRef);
      preferences = createdSnap.data() as UserPreferences;
    } else {
      preferences = prefsSnap.data() as UserPreferences;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, prefsPath);
  }

  const entry = { profile, preferences };
  workspaceCache.set(uid, entry);
  return entry;
}

export async function updateUserProfile(
  uid: string,
  patch: {
    displayName: string;
    schoolName: string;
    subject: string;
  },
): Promise<UserProfile> {
  if (!isValidFirestoreId(uid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }
  const displayName = sanitizeSingleLine(
    patch.displayName,
    VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN,
  );
  if (displayName.length < VALIDATION_LIMITS.DISPLAY_NAME_MIN_LEN) {
    throw new Error('표시 이름을 입력해 주세요.');
  }
  const schoolName = sanitizeSingleLine(
    patch.schoolName,
    VALIDATION_LIMITS.SCHOOL_NAME_MAX_LEN,
  );
  const subject = sanitizeSingleLine(patch.subject, VALIDATION_LIMITS.SUBJECT_MAX_LEN);

  const path = `users/${uid}/profile/main`;
  try {
    const ref = doc(db, 'users', uid, 'profile', 'main');
    await updateDoc(ref, {
      displayName,
      schoolName,
      subject,
      updatedAt: serverTimestamp(),
    });
    const freshSnap = await getDoc(ref);
    const updated = freshSnap.data() as UserProfile;
    const prev = workspaceCache.get(uid);
    if (prev) {
      workspaceCache.set(uid, { ...prev, profile: updated });
    }
    return updated;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateUserPreferences(
  uid: string,
  patch: {
    imminentDays: number;
    defaultCalendarView: CalendarViewMode;
    browserNotifyEnabled: boolean;
  },
): Promise<UserPreferences> {
  if (!isValidFirestoreId(uid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }
  const imminentDays = Math.min(
    VALIDATION_LIMITS.IMMINENT_DAYS_MAX,
    Math.max(VALIDATION_LIMITS.IMMINENT_DAYS_MIN, Math.round(patch.imminentDays)),
  );

  const path = `users/${uid}/settings/preferences`;
  try {
    const ref = doc(db, 'users', uid, 'settings', 'preferences');
    await updateDoc(ref, {
      timezone: 'Asia/Seoul',
      imminentDays,
      defaultCalendarView: patch.defaultCalendarView,
      browserNotifyEnabled: patch.browserNotifyEnabled,
      updatedAt: serverTimestamp(),
    });
    const freshSnap = await getDoc(ref);
    const updated = freshSnap.data() as UserPreferences;
    const prev = workspaceCache.get(uid);
    if (prev) {
      workspaceCache.set(uid, { ...prev, preferences: updated });
    }
    return updated;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
