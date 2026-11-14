import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { isValidFirestoreId, sanitizeSingleLine } from '../lib/dateKst';
import {
  SCHEMA_VERSION,
  VALIDATION_LIMITS,
  type AccessRecord,
  type AccountRole,
  type AccountStatus,
} from '../types/domain';

let pendingSignupInFlight: string | null = null;

export async function getMyAccessRecord(uid: string): Promise<AccessRecord | null> {
  if (!isValidFirestoreId(uid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }
  const path = `access/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'access', uid));
    if (!snap.exists()) return null;
    return snap.data() as AccessRecord;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export function subscribeMyAccessRecord(
  uid: string,
  onData: (record: AccessRecord | null) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  if (!isValidFirestoreId(uid)) {
    onError(new Error('유효하지 않은 사용자 식별자입니다.'));
    return () => {};
  }
  const path = `access/${uid}`;
  return onSnapshot(
    doc(db, 'access', uid),
    (snap) => {
      onData(snap.exists() ? (snap.data() as AccessRecord) : null);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export async function submitAccessRequest(
  user: User,
  displayNameInput?: string,
): Promise<AccessRecord> {
  if (!isValidFirestoreId(user.uid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }
  if (!user.email || !user.emailVerified) {
    throw new Error('이메일 인증이 완료된 Google 계정만 가입 신청할 수 있습니다.');
  }
  if (pendingSignupInFlight === user.uid) {
    throw new Error('가입 신청이 이미 처리 중입니다.');
  }

  const displayName = sanitizeSingleLine(
    displayNameInput || user.displayName || user.email.split('@')[0] || '교사',
    VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN,
  );
  if (displayName.length < VALIDATION_LIMITS.DISPLAY_NAME_MIN_LEN) {
    throw new Error('이름을 1자 이상 입력해 주세요.');
  }

  pendingSignupInFlight = user.uid;
  const path = `access/${user.uid}`;
  try {
    const existing = await getDoc(doc(db, 'access', user.uid));
    if (existing.exists()) {
      return existing.data() as AccessRecord;
    }

    const now = serverTimestamp();
    await setDoc(doc(db, 'access', user.uid), {
      uid: user.uid,
      email: user.email,
      displayName,
      status: 'pending',
      role: 'teacher',
      requestedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      note: '',
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    });

    const created = await getDoc(doc(db, 'access', user.uid));
    return created.data() as AccessRecord;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  } finally {
    pendingSignupInFlight = null;
  }
}

export async function listAccessRequests(
  statusFilter: AccountStatus | 'all' = 'all',
  maxRows = 50,
): Promise<AccessRecord[]> {
  const safeLimit = Math.min(Math.max(1, maxRows), 100);
  const path = 'access';
  try {
    const baseCol = collection(db, 'access');
    const q =
      statusFilter === 'all'
        ? query(baseCol, orderBy('requestedAt', 'desc'), limit(safeLimit))
        : query(
            baseCol,
            where('status', '==', statusFilter),
            orderBy('requestedAt', 'desc'),
            limit(safeLimit),
          );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as AccessRecord);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function reviewAccessRequest(params: {
  targetUid: string;
  adminUid: string;
  status: AccountStatus;
  role: AccountRole;
  note: string;
}): Promise<void> {
  const { targetUid, adminUid, status, role, note } = params;
  if (!isValidFirestoreId(targetUid) || !isValidFirestoreId(adminUid)) {
    throw new Error('유효하지 않은 사용자 식별자입니다.');
  }
  if (targetUid === adminUid && (role !== 'admin' || status !== 'active')) {
    throw new Error('현재 로그인한 관리자 본인의 권한이나 활성 상태는 해제할 수 없습니다.');
  }

  const sanitizedNote = sanitizeSingleLine(note, VALIDATION_LIMITS.ADMIN_NOTE_MAX_LEN);
  const path = `access/${targetUid}`;
  try {
    await updateDoc(doc(db, 'access', targetUid), {
      status,
      role,
      reviewedAt: serverTimestamp(),
      reviewedBy: adminUid,
      note: sanitizedNote,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
