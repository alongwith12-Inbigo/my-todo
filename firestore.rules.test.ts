import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

const PROJECT_ID = 'school-partner-rules-test';
const RULES_PATH = process.env.RULES_FILE || 'firestore.rules';

let testEnv: RulesTestEnvironment;

function makeAccessDoc(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'teacher1',
    email: 'teacher1@school.kr',
    displayName: '김선생',
    status: 'pending',
    role: 'teacher',
    requestedAt: serverTimestamp(),
    reviewedAt: null,
    reviewedBy: null,
    note: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    schemaVersion: 1,
    ...overrides,
  };
}

function makeTaskDoc(overrides: Record<string, unknown> = {}) {
  return {
    title: '학부모 상담 일정 정리',
    description: '1학기 상담 주간 안내문 확인',
    status: 'todo',
    priority: 'normal',
    dueAt: null,
    scheduledAt: null,
    remindAt: null,
    completedAt: null,
    sourceType: 'manual',
    relatedEventId: null,
    isDeleted: false,
    deletedAt: null,
    version: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    schemaVersion: 1,
    ...overrides,
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();

    // Seed an active admin (bootstrapped out-of-band via Admin SDK / Console)
    await setDoc(doc(db, 'access', 'admin1'), {
      uid: 'admin1',
      email: 'admin1@school.kr',
      displayName: '관리자 교사',
      status: 'active',
      role: 'admin',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: 'admin1',
      note: 'Bootstrap admin',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    // Seed an active teacher (teacherActive) with private task
    await setDoc(doc(db, 'access', 'teacherActive'), {
      uid: 'teacherActive',
      email: 'active@school.kr',
      displayName: '이교사',
      status: 'active',
      role: 'teacher',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: 'admin1',
      note: '',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    await setDoc(doc(db, 'users', 'teacherActive', 'tasks', 'task1'), {
      title: '생기부 점검',
      description: '개인 메모',
      status: 'todo',
      priority: 'high',
      dueAt: null,
      scheduledAt: null,
      remindAt: null,
      completedAt: null,
      sourceType: 'manual',
      relatedEventId: null,
      isDeleted: false,
      deletedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    await setDoc(doc(db, 'users', 'teacherActive', 'profile', 'main'), {
      displayName: '이교사',
      email: 'active@school.kr',
      schoolName: '한빛고등학교',
      subject: '수학',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    // Seed a pending teacher
    await setDoc(doc(db, 'access', 'teacherPending'), {
      uid: 'teacherPending',
      email: 'pending@school.kr',
      displayName: '박교사',
      status: 'pending',
      role: 'teacher',
      requestedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      note: '',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    // Seed a suspended teacher
    await setDoc(doc(db, 'access', 'teacherSuspended'), {
      uid: 'teacherSuspended',
      email: 'suspended@school.kr',
      displayName: '정지교사',
      status: 'suspended',
      role: 'teacher',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: 'admin1',
      note: '퇴직 처리',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
});

describe('Access & Approval Rules', () => {
  it('allows a new email-verified user to submit ONLY a pending teacher application', async () => {
    const db = testEnv
      .authenticatedContext('teacher1', {
        email: 'teacher1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertSucceeds(setDoc(doc(db, 'access', 'teacher1'), makeAccessDoc()));
    await assertSucceeds(getDoc(doc(db, 'access', 'teacher1')));
  });

  it('rejects unauthenticated access (Dirty Dozen #1)', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'access', 'teacherActive')));
    await assertFails(setDoc(doc(db, 'access', 'anon'), makeAccessDoc({ uid: 'anon' })));
    await assertFails(getDoc(doc(db, 'users', 'teacherActive', 'tasks', 'task1')));
  });

  it('rejects unverified email signup (Dirty Dozen #2)', async () => {
    const db = testEnv
      .authenticatedContext('teacher1', {
        email: 'teacher1@school.kr',
        email_verified: false,
      })
      .firestore();

    await assertFails(setDoc(doc(db, 'access', 'teacher1'), makeAccessDoc()));
  });

  it('rejects self-admin or pre-approved status on signup (Dirty Dozen #3)', async () => {
    const db = testEnv
      .authenticatedContext('teacher1', {
        email: 'teacher1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(db, 'access', 'teacher1'), makeAccessDoc({ role: 'admin' })),
    );
    await assertFails(
      setDoc(doc(db, 'access', 'teacher1'), makeAccessDoc({ status: 'active' })),
    );
  });

  it('rejects impersonation on signup (Dirty Dozen #4)', async () => {
    const db = testEnv
      .authenticatedContext('teacher1', {
        email: 'teacher1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(db, 'access', 'otherUser'), makeAccessDoc({ uid: 'otherUser' })),
    );
    await assertFails(
      setDoc(
        doc(db, 'access', 'teacher1'),
        makeAccessDoc({ email: 'spoof@school.kr' }),
      ),
    );
  });

  it('prevents non-admin users from updating or approving their own access record (Dirty Dozen #5)', async () => {
    const pendingDb = testEnv
      .authenticatedContext('teacherPending', {
        email: 'pending@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      updateDoc(doc(pendingDb, 'access', 'teacherPending'), {
        status: 'active',
        updatedAt: serverTimestamp(),
      }),
    );

    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      updateDoc(doc(activeDb, 'access', 'teacherActive'), {
        role: 'admin',
        updatedAt: serverTimestamp(),
      }),
    );

    // Also non-admin cannot list other users' access requests
    await assertFails(getDocs(collection(activeDb, 'access')));
  });

  it('allows active admin to list access records and approve/suspend/reject teachers', async () => {
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertSucceeds(getDocs(collection(adminDb, 'access')));

    await assertSucceeds(
      updateDoc(doc(adminDb, 'access', 'teacherPending'), {
        status: 'active',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'admin1',
        note: '재직 확인 완료',
        updatedAt: serverTimestamp(),
      }),
    );

    await assertSucceeds(
      updateDoc(doc(adminDb, 'access', 'teacherActive'), {
        status: 'suspended',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'admin1',
        note: '일시 중지',
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('prevents admin from self-lockout (Dirty Dozen #12) and prevents any client delete on access', async () => {
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      updateDoc(doc(adminDb, 'access', 'admin1'), {
        role: 'teacher',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'admin1',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(adminDb, 'access', 'admin1'), {
        status: 'suspended',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'admin1',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(deleteDoc(doc(adminDb, 'access', 'teacherPending')));
  });
});

describe('Admin Privacy Isolation & Workspace Gates', () => {
  it('forbids admin from reading or listing another teacher private tasks or profile (Dirty Dozen #6)', async () => {
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(getDoc(doc(adminDb, 'users', 'teacherActive', 'tasks', 'task1')));
    await assertFails(getDocs(collection(adminDb, 'users', 'teacherActive', 'tasks')));
    await assertFails(getDoc(doc(adminDb, 'users', 'teacherActive', 'profile', 'main')));
    await assertFails(getDocs(collection(adminDb, 'users', 'teacherActive', 'notes')));
    await assertFails(getDocs(collection(adminDb, 'users', 'teacherActive', 'events')));
  });

  it('forbids admin from writing into another teacher private workspace (Dirty Dozen #7)', async () => {
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(adminDb, 'users', 'teacherActive', 'tasks', 'injected'), makeTaskDoc()),
    );
    await assertFails(
      updateDoc(doc(adminDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        title: '관리자 수정 시도',
        version: 2,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('blocks pending and suspended users from accessing their own workspace (Dirty Dozen #8)', async () => {
    const pendingDb = testEnv
      .authenticatedContext('teacherPending', {
        email: 'pending@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(pendingDb, 'users', 'teacherPending', 'tasks', 't1'), makeTaskDoc()),
    );
    await assertFails(getDocs(collection(pendingDb, 'users', 'teacherPending', 'tasks')));

    const suspendedDb = testEnv
      .authenticatedContext('teacherSuspended', {
        email: 'suspended@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(suspendedDb, 'users', 'teacherSuspended', 'tasks', 't1'), makeTaskDoc()),
    );
  });

  it('allows active owner to read/write their own workspace while enforcing validation blueprints', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertSucceeds(getDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1')));
    await assertSucceeds(
      setDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task2'), makeTaskDoc()),
    );

    // Dirty Dozen #9: Shadow field injection
    await assertFails(
      setDoc(
        doc(activeDb, 'users', 'teacherActive', 'tasks', 'taskShadow'),
        makeTaskDoc({ isSuperAdmin: true }),
      ),
    );

    // Dirty Dozen #10: Resource / ID poisoning
    await assertFails(
      setDoc(
        doc(activeDb, 'users', 'teacherActive', 'tasks', 'bad$id'),
        makeTaskDoc(),
      ),
    );
    await assertFails(
      setDoc(
        doc(activeDb, 'users', 'teacherActive', 'tasks', 'taskLong'),
        makeTaskDoc({ title: '가'.repeat(121) }),
      ),
    );

    // Dirty Dozen #11: Timestamp forgery
    await assertFails(
      setDoc(
        doc(activeDb, 'users', 'teacherActive', 'tasks', 'taskTime'),
        makeTaskDoc({ createdAt: Timestamp.fromMillis(1000) }),
      ),
    );
  });

  it('verifies admin filtered access query, cross-teacher isolation, and profile/settings boundaries', async () => {
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    // Admin list queries matching accessRepo.ts
    await assertSucceeds(
      getDocs(
        query(
          collection(adminDb, 'access'),
          where('status', '==', 'pending'),
          orderBy('requestedAt', 'desc'),
          limit(50),
        ),
      ),
    );
    await assertSucceeds(
      getDocs(
        query(collection(adminDb, 'access'), orderBy('requestedAt', 'desc'), limit(50)),
      ),
    );

    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore();

    // Active owner can update own profile partially, but not immutable email
    await assertSucceeds(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'profile', 'main'), {
        displayName: '이선생',
        schoolName: '한빛고등학교',
        subject: '수학',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'profile', 'main'), {
        email: 'hacked@school.kr',
        updatedAt: serverTimestamp(),
      }),
    );

    // Active owner can create and partially update preferences with Asia/Seoul
    await assertSucceeds(
      setDoc(doc(activeDb, 'users', 'teacherActive', 'settings', 'preferences'), {
        timezone: 'Asia/Seoul',
        imminentDays: 3,
        defaultCalendarView: 'week',
        browserNotifyEnabled: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'settings', 'preferences'), {
        timezone: 'Asia/Seoul',
        imminentDays: 5,
        defaultCalendarView: 'month',
        browserNotifyEnabled: true,
        updatedAt: serverTimestamp(),
      }),
    );
    // Reject non-KST timezone
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'settings', 'preferences'), {
        timezone: 'America/New_York',
        imminentDays: 5,
        defaultCalendarView: 'month',
        browserNotifyEnabled: true,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('enforces task lifecycle (completedAt consistency, optimistic version, soft-delete) and events/notes/imports/system rules', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore();
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    // Cannot mark done without completedAt
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        status: 'done',
        completedAt: null,
        version: 2,
        updatedAt: serverTimestamp(),
      }),
    );
    // Cannot skip version increment
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        status: 'done',
        completedAt: serverTimestamp(),
        version: 1,
        updatedAt: serverTimestamp(),
      }),
    );
    // Valid done transition
    await assertSucceeds(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        status: 'done',
        completedAt: serverTimestamp(),
        version: 2,
        updatedAt: serverTimestamp(),
      }),
    );
    // Cannot permanently delete before soft-delete
    await assertFails(deleteDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1')));
    // Soft-delete then permanent delete succeeds
    await assertSucceeds(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        version: 3,
        updatedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(deleteDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1')));

    // Events: endsAt >= startsAt enforced
    const t1 = Timestamp.fromMillis(1700000000000);
    const t2 = Timestamp.fromMillis(1700003600000);
    await assertFails(
      setDoc(doc(activeDb, 'users', 'teacherActive', 'events', 'evBad'), {
        title: '역전된 일정',
        startsAt: t2,
        endsAt: t1,
        allDay: false,
        location: '',
        description: '',
        relatedTaskId: null,
        version: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertSucceeds(
      setDoc(doc(activeDb, 'users', 'teacherActive', 'events', 'ev1'), {
        title: '교직원 회의',
        startsAt: t1,
        endsAt: t2,
        allDay: false,
        location: '대회의실',
        description: '',
        relatedTaskId: null,
        version: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );

    // Notes: convert once only
    await assertSucceeds(
      setDoc(doc(activeDb, 'users', 'teacherActive', 'notes', 'n1'), {
        content: '학급비 정산 확인',
        color: 'butter',
        isPinned: true,
        sortOrder: 1,
        convertedTaskId: null,
        version: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'notes', 'n1'), {
        convertedTaskId: 'task1',
        version: 2,
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'notes', 'n1'), {
        convertedTaskId: 'task2',
        version: 3,
        updatedAt: serverTimestamp(),
      }),
    );

    // System config: admin only write, verified user get
    await assertFails(
      setDoc(doc(activeDb, 'system', 'config'), {
        appName: '오늘의 학교는?',
        minSchemaVersion: 1,
        registrationOpen: true,
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertSucceeds(
      setDoc(doc(adminDb, 'system', 'config'), {
        appName: '오늘의 학교는?',
        minSchemaVersion: 1,
        registrationOpen: true,
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertSucceeds(getDoc(doc(activeDb, 'system', 'config')));
  });
});
