/**
 * Trusted out-of-band Bootstrap Admin script.
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json \
 *   node scripts/bootstrap-admin.mjs --uid <FIREBASE_USER_UID>
 *
 * Never bundle service account keys or hardcode admin emails in client source code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const uidIdx = args.indexOf('--uid');
  const emailIdx = args.indexOf('--email');
  const targetUid = uidIdx !== -1 ? args[uidIdx + 1] : null;
  const targetEmail = emailIdx !== -1 ? args[emailIdx + 1] : null;

  if (!targetUid && !targetEmail) {
    console.error('사용법: node scripts/bootstrap-admin.mjs --uid <UID> (또는 --email <EMAIL>)');
    process.exit(1);
  }

  let adminAppModule;
  let adminAuthModule;
  let adminFirestoreModule;
  try {
    adminAppModule = await import('firebase-admin/app');
    adminAuthModule = await import('firebase-admin/auth');
    adminFirestoreModule = await import('firebase-admin/firestore');
  } catch {
    console.error(
      'firebase-admin 패키지가 필요합니다. 신뢰된 로컬 환경에서 `npm install -D firebase-admin` 후 실행해 주세요.',
    );
    process.exit(1);
  }

  const configPath = resolve(process.cwd(), 'firebase-applet-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  const app = adminAppModule.initializeApp({
    projectId: config.projectId,
  });

  const auth = adminAuthModule.getAuth(app);
  const db = adminFirestoreModule.getFirestore(app, config.firestoreDatabaseId);

  const userRecord = targetUid
    ? await auth.getUser(targetUid)
    : await auth.getUserByEmail(targetEmail);

  const now = adminFirestoreModule.FieldValue.serverTimestamp();
  const accessRef = db.collection('access').doc(userRecord.uid);
  const existing = await accessRef.get();

  if (existing.exists) {
    await accessRef.update({
      role: 'admin',
      status: 'active',
      reviewedAt: now,
      reviewedBy: userRecord.uid,
      note: 'Bootstrap admin granted via trusted CLI',
      updatedAt: now,
    });
  } else {
    await accessRef.set({
      uid: userRecord.uid,
      email: userRecord.email || '',
      displayName: userRecord.displayName || '관리자',
      status: 'active',
      role: 'admin',
      requestedAt: now,
      reviewedAt: now,
      reviewedBy: userRecord.uid,
      note: 'Bootstrap admin granted via trusted CLI',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  }

  console.log(`관리자 권한 부여 완료: uid=${userRecord.uid}, email=${userRecord.email}`);
}

main().catch((err) => {
  console.error('초기화 스크립트 실행 실패:', err);
  process.exit(1);
});
