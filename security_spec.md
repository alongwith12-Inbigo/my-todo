# Security Specification — 오늘의 학교는?

## 1. Data Invariants
1. **Zero-Privilege Signup**: A signed-in, email-verified user may only create `/access/{uid}` for their own `uid` with `status == 'pending'`, `role == 'teacher'`, `reviewedAt == null`, `reviewedBy == null`, and `note == ''`.
2. **No Self-Elevation or Status Bypass**: Only an existing `active` `admin` (`access/{adminUid}.role == 'admin' && status == 'active'`) may update any document in `/access/{uid}`. Teachers, pending users, rejected users, and suspended users have zero update/delete rights on `/access/{uid}`.
3. **Admin Privacy Boundary**: Admins manage `/access/{uid}` and `/system/config` only. Admins are strictly denied `get`, `list`, `create`, `update`, and `delete` access to any other user's `/users/{uid}/**` documents (`profile`, `settings`, `tasks`, `events`, `notes`, `imports`).
4. **Active-Status Gate**: Any user whose `/access/{uid}.status` is not `'active'` (e.g. `pending`, `suspended`, `rejected`, or missing) is denied all reads and writes on `/users/{uid}/**`.
5. **No Hardcoded Admin Emails**: Neither `firestore.rules` nor client source code contains hardcoded administrator email addresses. The initial admin is provisioned out-of-band via Firebase Console or a trusted Admin SDK CLI script.
6. **Optimistic Version & Temporal Integrity**: All `createdAt` fields are immutable and must equal `request.time` on creation. All `updatedAt` fields must equal `request.time`. Tasks, events, and notes enforce `version == existing.version + 1` on updates.

## 2. The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated Access**: Anonymous or unauthenticated client attempts to read or write `/access/{uid}` or `/users/{uid}/tasks/{taskId}`.
2. **Unverified Email Signup**: Signed-in user with `email_verified: false` attempts to create `/access/{uid}`.
3. **Self-Admin Escalation on Signup**: New user attempts to create `/access/{uid}` with `role: 'admin'` or `status: 'active'`.
4. **Impersonation on Signup**: User A (`uidA`) attempts to create `/access/{uidB}` or sets `uid: uidB` / spoofed `email`.
5. **Self-Approval Update**: Pending/active teacher attempts to update their own `/access/{uid}` to `status: 'active'` or `role: 'admin'`.
6. **Admin Privacy Violation (Read)**: Active admin attempts `get` or `list` on another teacher's `/users/{teacherUid}/tasks/{taskId}`, `events`, `notes`, `profile`, `settings`, or `imports`.
7. **Admin Privacy Violation (Write)**: Active admin attempts to create/update/delete a task under `/users/{teacherUid}/tasks/{taskId}`.
8. **Pending/Suspended User Data Access**: A user with `status: 'pending'` or `status: 'suspended'` attempts to create or list `/users/{uid}/tasks`.
9. **Shadow Field Injection**: Active user attempts to include an undocumented ghost field (e.g. `isSuperAdmin: true`) in `/access/{uid}` or `/users/{uid}/tasks/{taskId}`.
10. **Resource / ID Poisoning**: User attempts to write a 200-char or invalid-character document ID (`../evil` or 200 chars) or a 3,000-char task title.
11. **Timestamp Forgery**: User attempts to write `createdAt` or `updatedAt` with a forged past/future client timestamp instead of `request.time`.
12. **Admin Self-Lockout**: Active admin attempts to demote themselves (`role: 'teacher'`) or suspend themselves (`status: 'suspended'`) via client SDK.
