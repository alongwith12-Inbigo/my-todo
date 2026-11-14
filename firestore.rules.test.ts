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
  type Firestore,
} from 'firebase/firestore';
import {
  createTask,
  permanentlyDeleteTask,
  postponeTask,
  restoreTask,
  softDeleteTask,
  TaskConcurrencyError,
  TaskValidationError,
  transitionTaskStatus,
  updateTaskDetails,
} from './src/repositories/taskOperations';
import {
  fetchBriefingTaskSet,
  fetchMoreUndatedTasks,
  fetchSingleTask,
  fetchTasksPage,
} from './src/repositories/taskQueries';
import {
  createEvent,
  deleteEvent,
  EventConcurrencyError,
  EventValidationError,
  fetchEventsInRange,
  fetchSingleEvent,
  updateEvent,
} from './src/repositories/eventOperations';
import {
  convertNoteToTask,
  createNote,
  deleteNote,
  fetchAllNotes,
  NoteConcurrencyError,
  NoteValidationError,
  reorderNotes,
  updateNote,
} from './src/repositories/noteOperations';
import { classifyTodayBriefing } from './src/lib/briefing';

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

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8088';
const [host, portStr] = emulatorHost.split(':');
const port = Number(portStr) || 8088;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host,
      port,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
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

    // Seed a rejected teacher
    await setDoc(doc(db, 'access', 'teacherRejected'), {
      uid: 'teacherRejected',
      email: 'rejected@school.kr',
      displayName: '반려교사',
      status: 'rejected',
      role: 'teacher',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: 'admin1',
      note: '소속 확인 불가',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    // Seed a suspended admin (must lose all admin & workspace privileges)
    await setDoc(doc(db, 'access', 'adminSuspended'), {
      uid: 'adminSuspended',
      email: 'admin-suspended@school.kr',
      displayName: '정지관리자',
      status: 'suspended',
      role: 'admin',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: 'admin1',
      note: '권한 일시 중지',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    // Seed a second active teacher for cross-teacher isolation tests
    await setDoc(doc(db, 'access', 'teacherActive2'), {
      uid: 'teacherActive2',
      email: 'active2@school.kr',
      displayName: '최교사',
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

    await setDoc(doc(db, 'users', 'teacherActive2', 'tasks', 'taskSecret'), {
      title: '다른 교사 비공개 업무',
      description: '열람 차단 검증용',
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

  it('blocks rejected users, suspended admins, immutable access tampering, and cross-teacher private data reads/writes', async () => {
    const rejectedDb = testEnv
      .authenticatedContext('teacherRejected', {
        email: 'rejected@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      setDoc(doc(rejectedDb, 'users', 'teacherRejected', 'tasks', 't1'), makeTaskDoc()),
    );
    await assertFails(getDocs(collection(rejectedDb, 'users', 'teacherRejected', 'tasks')));

    const suspendedAdminDb = testEnv
      .authenticatedContext('adminSuspended', {
        email: 'admin-suspended@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(getDocs(collection(suspendedAdminDb, 'access')));
    await assertFails(
      updateDoc(doc(suspendedAdminDb, 'access', 'teacherPending'), {
        status: 'active',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'adminSuspended',
        updatedAt: serverTimestamp(),
      }),
    );

    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore();

    // Admin cannot tamper with immutable fields (uid/email) on access/{uid}
    await assertFails(
      updateDoc(doc(adminDb, 'access', 'teacherPending'), {
        email: 'tampered@school.kr',
        status: 'active',
        reviewedAt: serverTimestamp(),
        reviewedBy: 'admin1',
        updatedAt: serverTimestamp(),
      }),
    );

    // Cross-teacher isolation: teacherActive cannot read/write teacherActive2's workspace
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore();

    await assertFails(
      getDoc(doc(activeDb, 'users', 'teacherActive2', 'tasks', 'taskSecret')),
    );
    await assertFails(getDocs(collection(activeDb, 'users', 'teacherActive2', 'tasks')));
    await assertFails(
      setDoc(
        doc(activeDb, 'users', 'teacherActive2', 'tasks', 'injected'),
        makeTaskDoc(),
      ),
    );
  });
});

describe('Step 2 Task Operations & Concurrency Compatibility', () => {
  it('supports create, edit details, postpone dates, complete/reopen, soft-delete, restore, and permanent delete via taskOperations', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    // 1. Create
    const created = await assertSucceeds(
      createTask(activeDb, 'teacherActive', {
        title: '기말고사 시험 감독표 작성',
        description: '교무부 공지 확인 후 배정',
        priority: 'high',
      }),
    );
    assert.equal(created.version, 1);

    const taskRef = doc(activeDb, 'users', 'teacherActive', 'tasks', created.id);
    const snap1 = await getDoc(taskRef);
    assert.equal(snap1.data()?.status, 'todo');
    assert.equal(snap1.data()?.completedAt, null);

    // 2. Edit details (Branch 1)
    const edited = await assertSucceeds(
      updateTaskDetails(activeDb, 'teacherActive', created.id, 1, {
        title: '기말고사 시험 감독표 최종 확정',
        priority: 'urgent',
      }),
    );
    assert.equal(edited.version, 2);

    // 3. Postpone / Reschedule dates (Branch 1)
    const nextDue = Timestamp.fromMillis(Date.now() + 86_400_000 * 3);
    const nextRemind = Timestamp.fromMillis(Date.now() + 86_400_000 * 2);
    const postponed = await assertSucceeds(
      postponeTask(activeDb, 'teacherActive', created.id, 2, {
        dueAt: nextDue,
        remindAt: nextRemind,
      }),
    );
    assert.equal(postponed.version, 3);
    const snap3 = await getDoc(taskRef);
    assert.equal(snap3.data()?.status, 'todo');
    assert.ok(snap3.data()?.dueAt instanceof Timestamp);

    // 4. Transition to done (Branch 2) -> completedAt populated
    const completed = await assertSucceeds(
      transitionTaskStatus(activeDb, 'teacherActive', created.id, 3, 'done'),
    );
    assert.equal(completed.version, 4);
    assert.equal(completed.status, 'done');
    const snap4 = await getDoc(taskRef);
    const completedAtBeforeTrash = snap4.data()?.completedAt;
    assert.ok(completedAtBeforeTrash instanceof Timestamp);

    // Idempotent same-status call does not increment version or overwrite completedAt
    const sameStatus = await assertSucceeds(
      transitionTaskStatus(activeDb, 'teacherActive', created.id, 4, 'done'),
    );
    assert.equal(sameStatus.version, 4);

    // 5. Soft-delete (Branch 3) while done -> completedAt preserved
    const trashed = await assertSucceeds(
      softDeleteTask(activeDb, 'teacherActive', created.id, 4),
    );
    assert.equal(trashed.version, 5);

    // Cannot edit or transition status while in trash
    await assert.rejects(
      updateTaskDetails(activeDb, 'teacherActive', created.id, 5, { title: '수정 불가' }),
      TaskValidationError,
    );
    await assertFails(
      updateDoc(taskRef, {
        title: '규칙 직접 우회 시도',
        version: 6,
        updatedAt: serverTimestamp(),
      }),
    );

    // 6. Restore from trash (Branch 4) -> preserves status='done' and completedAt
    const restored = await assertSucceeds(
      restoreTask(activeDb, 'teacherActive', created.id, 5),
    );
    assert.equal(restored.version, 6);
    const snap6 = await getDoc(taskRef);
    assert.equal(snap6.data()?.isDeleted, false);
    assert.equal(snap6.data()?.deletedAt, null);
    assert.equal(snap6.data()?.status, 'done');
    assert.ok(snap6.data()?.completedAt instanceof Timestamp);

    // 7. Reopen done -> todo -> completedAt cleared to null
    const reopened = await assertSucceeds(
      transitionTaskStatus(activeDb, 'teacherActive', created.id, 6, 'todo'),
    );
    assert.equal(reopened.version, 7);
    const snap7 = await getDoc(taskRef);
    assert.equal(snap7.data()?.status, 'todo');
    assert.equal(snap7.data()?.completedAt, null);

    // 8. Cannot permanently delete before soft-delete, succeeds after soft-delete
    await assert.rejects(
      permanentlyDeleteTask(activeDb, 'teacherActive', created.id),
      TaskValidationError,
    );
    await assertSucceeds(softDeleteTask(activeDb, 'teacherActive', created.id, 7));
    await assertSucceeds(permanentlyDeleteTask(activeDb, 'teacherActive', created.id));
  });

  it('rejects concurrent stale-version updates and mixed Branch1+Branch2 updates', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    // First client updates version 1 -> 2
    const first = await assertSucceeds(
      updateTaskDetails(activeDb, 'teacherActive', 'task1', 1, {
        title: '선행 수정 완료',
      }),
    );
    assert.equal(first.version, 2);

    // Stale client still holding expectedVersion=1 gets TaskConcurrencyError
    await assert.rejects(
      updateTaskDetails(activeDb, 'teacherActive', 'task1', 1, {
        title: '뒤늦은 덮어쓰기 시도',
      }),
      (err: unknown) =>
        err instanceof TaskConcurrencyError &&
        err.expectedVersion === 1 &&
        err.actualVersion === 2,
    );

    // Verify first client's title was preserved
    const snap = await getDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'));
    assert.equal(snap.data()?.title, '선행 수정 완료');
    assert.equal(snap.data()?.version, 2);

    // Verify raw updateDoc mixing Branch 1 (title) + Branch 2 (status) is rejected by rules
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'tasks', 'task1'), {
        title: '혼합 수정 시도',
        status: 'on_hold',
        version: 3,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('fetches briefing tasks without missing overdue/remind items across undated pagination and supports filtered task pagination', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    const now = new Date('2026-05-15T01:00:00Z'); // 2026-05-15 10:00 KST
    const overdueTs = Timestamp.fromDate(new Date('2026-05-13T14:59:59Z'));
    const remindTodayTs = Timestamp.fromDate(new Date('2026-05-15T00:00:00Z'));

    // Create 3 undated tasks, 1 overdue task, 1 remind-today task, 1 done task
    await createTask(activeDb, 'teacherActive', { title: '날짜없음 1' }, 'u1');
    await createTask(activeDb, 'teacherActive', { title: '날짜없음 2' }, 'u2');
    await createTask(activeDb, 'teacherActive', { title: '날짜없음 3' }, 'u3');
    const overdueRes = await createTask(
      activeDb,
      'teacherActive',
      { title: '기한초과 업무', priority: 'urgent', dueAt: overdueTs },
      'dueOverdue',
    );
    const remindRes = await createTask(
      activeDb,
      'teacherActive',
      { title: '오늘 재확인 업무', remindAt: remindTodayTs },
      'remindToday',
    );
    await createTask(
      activeDb,
      'teacherActive',
      { title: '이미 완료된 업무', status: 'done' },
      'doneTask',
    );

    // Fetch briefing with small undatedPageSize=2 -> must STILL include dueOverdue & remindToday!
    const briefingRes = await assertSucceeds(
      fetchBriefingTaskSet(activeDb, 'teacherActive', {
        imminentDays: 3,
        now,
        undatedPageSize: 2,
      }),
    );

    const fetchedIds = new Set(briefingRes.tasks.map((t) => t.id));
    assert.ok(fetchedIds.has('dueOverdue'));
    assert.ok(fetchedIds.has('remindToday'));
    assert.equal(fetchedIds.has('doneTask'), false);
    assert.equal(briefingRes.hasMoreUndated, true);
    assert.ok(briefingRes.undatedCursor);

    // Load next page of undated tasks
    const moreUndated = await assertSucceeds(
      fetchMoreUndatedTasks(
        activeDb,
        'teacherActive',
        briefingRes.undatedCursor!,
        2,
      ),
    );
    assert.ok(moreUndated.tasks.length >= 1);

    const summary = classifyTodayBriefing(
      [...briefingRes.tasks, ...moreUndated.tasks],
      { now, imminentDays: 3 },
    );
    assert.deepEqual(
      summary.overdue.map((t) => t.id),
      ['dueOverdue'],
    );
    assert.deepEqual(
      summary.remindDue.map((t) => t.id),
      ['remindToday'],
    );

    // Clear remindAt (해제) on remindToday and verify via fetchSingleTask
    await assertSucceeds(
      postponeTask(activeDb, 'teacherActive', 'remindToday', remindRes.version, {
        remindAt: null,
      }),
    );
    const updatedRemind = await assertSucceeds(
      fetchSingleTask(activeDb, 'teacherActive', 'remindToday'),
    );
    assert.equal(updatedRemind?.remindAt, null);
    assert.equal(updatedRemind?.version, 2);

    // Filtered TasksPage pagination ('active', pageSize=2)
    const page1 = await assertSucceeds(
      fetchTasksPage(activeDb, 'teacherActive', {
        filter: 'active',
        sortField: 'updatedAt',
        pageSize: 2,
      }),
    );
    assert.equal(page1.tasks.length, 2);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor);

    const page2 = await assertSucceeds(
      fetchTasksPage(activeDb, 'teacherActive', {
        filter: 'active',
        sortField: 'updatedAt',
        pageSize: 2,
        cursor: page1.nextCursor,
      }),
    );
    assert.ok(page2.tasks.length >= 1);
    const page1Ids = new Set(page1.tasks.map((t) => t.id));
    for (const item of page2.tasks) {
      assert.equal(page1Ids.has(item.id), false);
    }

    // Done & Trash filters
    const donePage = await assertSucceeds(
      fetchTasksPage(activeDb, 'teacherActive', {
        filter: 'done',
        pageSize: 10,
      }),
    );
    assert.deepEqual(
      donePage.tasks.map((t) => t.id),
      ['doneTask'],
    );

    await assertSucceeds(
      softDeleteTask(activeDb, 'teacherActive', 'dueOverdue', overdueRes.version),
    );
    const trashPage = await assertSucceeds(
      fetchTasksPage(activeDb, 'teacherActive', {
        filter: 'trash',
        pageSize: 10,
      }),
    );
    assert.deepEqual(
      trashPage.tasks.map((t) => t.id),
      ['dueOverdue'],
    );

    // Cross-teacher isolation via query layer must fail
    await assertFails(
      fetchBriefingTaskSet(activeDb, 'teacherActive2', { now }),
    );
  });
});

describe('Step 3 Calendar Events, Sticky Notes & Cross-Isolation', () => {
  it('supports Event CRUD, concurrency check, multi-day range queries, and safe task detachment on delete', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    // Create a linked task first
    const linkedTask = await assertSucceeds(
      createTask(activeDb, 'teacherActive', {
        title: '연수 사전 설문 제출',
      }),
    );

    // 1. Create timed & multi-day events
    const startMs = new Date('2026-05-14T15:00:00Z').getTime(); // 2026-05-15 00:00 KST
    const endMs = new Date('2026-05-16T14:59:59Z').getTime(); // 2026-05-16 23:59 KST
    const created = await assertSucceeds(
      createEvent(activeDb, 'teacherActive', {
        title: '현장체험학습 인솔',
        startsAt: Timestamp.fromMillis(startMs),
        endsAt: Timestamp.fromMillis(endMs),
        allDay: true,
        location: '수목원',
        description: '안전 지도 체크',
        relatedTaskId: linkedTask.id,
      }),
    );
    assert.equal(created.version, 1);

    // Attach relatedEventId back onto task (Branch 1)
    const updatedTask = await assertSucceeds(
      updateTaskDetails(activeDb, 'teacherActive', linkedTask.id, 1, {
        relatedEventId: created.id,
      }),
    );
    assert.equal(updatedTask.version, 2);

    // Query May 16 KST ONLY -> must STILL return multi-day event spanning May 15~16!
    const may16Start = new Date('2026-05-15T15:00:00Z').getTime();
    const may16End = new Date('2026-05-16T14:59:59Z').getTime();
    const rangeEvents = await assertSucceeds(
      fetchEventsInRange(activeDb, 'teacherActive', may16Start, may16End),
    );
    assert.deepEqual(
      rangeEvents.map((e) => e.id),
      [created.id],
    );

    // 2. Update event & verify stale version conflict
    const edited = await assertSucceeds(
      updateEvent(activeDb, 'teacherActive', created.id, 1, {
        title: '현장체험학습 인솔 (최종)',
        location: '국립수목원 정문',
      }),
    );
    assert.equal(edited.version, 2);

    await assert.rejects(
      updateEvent(activeDb, 'teacherActive', created.id, 1, {
        title: '오래된 버전 덮어쓰기',
      }),
      EventConcurrencyError,
    );

    // Invalid inverted range rejected both client & rules side
    await assert.rejects(
      createEvent(activeDb, 'teacherActive', {
        title: '시간 역전',
        startsAt: Timestamp.fromMillis(endMs),
        endsAt: Timestamp.fromMillis(startMs),
        allDay: false,
      }),
      EventValidationError,
    );

    // 3. Deleting linked event clears task.relatedEventId without deleting/harming the task
    const delResult = await assertSucceeds(
      deleteEvent(activeDb, 'teacherActive', created.id),
    );
    assert.equal(delResult.clearedTaskId, linkedTask.id);
    assert.equal(await fetchSingleEvent(activeDb, 'teacherActive', created.id), null);

    const taskAfterEventDelete = await fetchSingleTask(
      activeDb,
      'teacherActive',
      linkedTask.id,
    );
    assert.ok(taskAfterEventDelete);
    assert.equal(taskAfterEventDelete.isDeleted, false);
    assert.equal(taskAfterEventDelete.relatedEventId, null);
    assert.equal(taskAfterEventDelete.version, 3);
  });

  it('supports Sticky Note CRUD, reorder transaction, and atomic 1-time note-to-task conversion while keeping source note intact', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    // 1. Create two notes
    const n1 = await assertSucceeds(
      createNote(activeDb, 'teacherActive', {
        content: '학급비 영수증 스캔하기\n행정실 제출 필요',
        color: 'butter',
        isPinned: false,
        sortOrder: 10,
      }),
    );
    const n2 = await assertSucceeds(
      createNote(activeDb, 'teacherActive', {
        content: '체육대회 반티 신청 취합',
        color: 'mint',
        isPinned: true,
        sortOrder: 20,
      }),
    );

    // 2. Edit note + optimistic lock
    const n1Edited = await assertSucceeds(
      updateNote(activeDb, 'teacherActive', n1.id, 1, {
        color: 'sky',
        isPinned: true,
      }),
    );
    assert.equal(n1Edited.version, 2);

    await assert.rejects(
      updateNote(activeDb, 'teacherActive', n1.id, 1, {
        content: '오래된 수정 시도',
      }),
      NoteConcurrencyError,
    );

    // 3. Reorder notes inside transaction
    await assertSucceeds(
      reorderNotes(activeDb, 'teacherActive', [
        { id: n1.id, expectedVersion: 2, sortOrder: 30 },
        { id: n2.id, expectedVersion: 1, sortOrder: 10 },
      ]),
    );
    const allNotesRes = await assertSucceeds(fetchAllNotes(activeDb, 'teacherActive'));
    assert.deepEqual(
      allNotesRes.notes.map((n) => n.id),
      [n2.id, n1.id],
    );

    // 4. Atomic note-to-task conversion keeps original note and sets sourceType='note'
    const conv = await assertSucceeds(
      convertNoteToTask(activeDb, 'teacherActive', n1.id, 3, {
        title: '학급비 영수증 스캔하기',
        description: '학급비 영수증 스캔하기\n행정실 제출 필요',
        priority: 'high',
      }),
    );
    assert.equal(conv.noteVersion, 4);

    const createdTask = await fetchSingleTask(activeDb, 'teacherActive', conv.taskId);
    assert.ok(createdTask);
    assert.equal(createdTask.sourceType, 'note');
    assert.equal(createdTask.title, '학급비 영수증 스캔하기');

    const noteAfterConvertSnap = await getDoc(
      doc(activeDb, 'users', 'teacherActive', 'notes', n1.id),
    );
    assert.equal(noteAfterConvertSnap.exists(), true);
    assert.equal(noteAfterConvertSnap.data()?.convertedTaskId, conv.taskId);

    // 5. Duplicate conversion rejected by repository AND rules
    await assert.rejects(
      convertNoteToTask(activeDb, 'teacherActive', n1.id, 4, {
        title: '중복 생성 시도',
      }),
      NoteValidationError,
    );
    await assertFails(
      updateDoc(doc(activeDb, 'users', 'teacherActive', 'notes', n1.id), {
        convertedTaskId: 'anotherTask',
        version: 5,
        updatedAt: serverTimestamp(),
      }),
    );

    // 6. Delete note succeeds
    await assertSucceeds(deleteNote(activeDb, 'teacherActive', n2.id));
  });

  it('blocks other teachers, admins, and suspended users from accessing events and notes', async () => {
    const activeDb = testEnv
      .authenticatedContext('teacherActive', {
        email: 'active@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;
    const otherDb = testEnv
      .authenticatedContext('teacherActive2', {
        email: 'active2@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;
    const adminDb = testEnv
      .authenticatedContext('admin1', {
        email: 'admin1@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;
    const suspendedDb = testEnv
      .authenticatedContext('teacherSuspended', {
        email: 'suspended@school.kr',
        email_verified: true,
      })
      .firestore() as unknown as Firestore;

    const ev = await createEvent(activeDb, 'teacherActive', {
      title: '비공개 개인 일정',
      startsAt: Timestamp.fromMillis(1700000000000),
      endsAt: Timestamp.fromMillis(1700003600000),
      allDay: false,
    });
    const note = await createNote(activeDb, 'teacherActive', {
      content: '비공개 개인 포스트잇',
    });

    // Other teacher blocked
    await assertFails(fetchSingleEvent(otherDb, 'teacherActive', ev.id));
    await assertFails(fetchAllNotes(otherDb, 'teacherActive'));
    await assertFails(
      deleteNote(otherDb, 'teacherActive', note.id),
    );

    // Admin blocked from teacher private events & notes
    await assertFails(fetchSingleEvent(adminDb, 'teacherActive', ev.id));
    await assertFails(fetchAllNotes(adminDb, 'teacherActive'));

    // Suspended user blocked from own workspace events & notes
    await assertFails(
      createEvent(suspendedDb, 'teacherSuspended', {
        title: '정지 계정 일정 시도',
        startsAt: Timestamp.fromMillis(1700000000000),
        endsAt: Timestamp.fromMillis(1700003600000),
        allDay: false,
      }),
    );
    await assertFails(fetchAllNotes(suspendedDb, 'teacherSuspended'));
  });
});
