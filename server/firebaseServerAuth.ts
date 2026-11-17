import fs from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  accessStatus: string;
  role: string;
}

export class ServerAuthError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ServerAuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface FirebaseClientConfigFile {
  projectId: string;
  firestoreDatabaseId: string;
}

const UID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

let cachedConfig: FirebaseClientConfigFile | null = null;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
);

function loadFirebaseProjectConfig(): FirebaseClientConfigFile {
  if (cachedConfig) return cachedConfig;

  const envProjectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const envDbId =
    process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim() ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID?.trim();
  if (envProjectId && envDbId) {
    cachedConfig = {
      projectId: envProjectId,
      firestoreDatabaseId: envDbId,
    };
    return cachedConfig;
  }

  const candidatePaths = [
    new URL('../firebase-applet-config.json', import.meta.url),
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
  ];

  for (const candidate of candidatePaths) {
    try {
      const rawText = fs.readFileSync(candidate, 'utf8');
      const raw = JSON.parse(rawText) as Partial<FirebaseClientConfigFile>;
      if (raw.projectId && raw.firestoreDatabaseId) {
        cachedConfig = {
          projectId: raw.projectId,
          firestoreDatabaseId: raw.firestoreDatabaseId,
        };
        return cachedConfig;
      }
    } catch {
      // Try next candidate path
    }
  }

  throw new ServerAuthError(
    500,
    'firebase_config_missing',
    '서버에서 Firebase 프로젝트 설정(firebase-applet-config.json 또는 FIREBASE_PROJECT_ID / FIREBASE_FIRESTORE_DATABASE_ID)을 읽을 수 없습니다.',
  );
}

export function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  const headerValue = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!headerValue || typeof headerValue !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

export interface AuthVerifierDeps {
  projectId?: string;
  firestoreDatabaseId?: string;
  verifyJwt?: (
    token: string,
    projectId: string,
  ) => Promise<{
    uid: string;
    email: string;
    emailVerified: boolean;
  }>;
  fetchAccessDoc?: (params: {
    projectId: string;
    firestoreDatabaseId: string;
    uid: string;
    idToken: string;
  }) => Promise<{ status: string; role: string } | null>;
}

async function defaultVerifyFirebaseJwt(token: string, projectId: string) {
  const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

  const uid = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  const emailVerified = payload.email_verified === true;

  return { uid, email, emailVerified };
}

async function defaultFetchFirestoreAccessDoc(params: {
  projectId: string;
  firestoreDatabaseId: string;
  uid: string;
  idToken: string;
}): Promise<{ status: string; role: string } | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    params.projectId,
  )}/databases/${encodeURIComponent(
    params.firestoreDatabaseId,
  )}/documents/access/${encodeURIComponent(params.uid)}`;

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.idToken}`,
      },
    });
  } catch {
    throw new ServerAuthError(
      503,
      'access_check_failed',
      '계정 승인 상태를 확인하는 중 네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }

  if (res.status === 404) {
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new ServerAuthError(
      403,
      'access_denied',
      '계정 승인 정보를 확인할 수 있는 권한이 없습니다.',
    );
  }
  if (!res.ok) {
    throw new ServerAuthError(
      503,
      'access_check_failed',
      '계정 승인 상태를 확인하는 중 일시적 오류가 발생했습니다.',
    );
  }

  const json = (await res.json()) as {
    fields?: {
      status?: { stringValue?: string };
      role?: { stringValue?: string };
    };
  };

  const status = json.fields?.status?.stringValue ?? '';
  const role = json.fields?.role?.stringValue ?? 'teacher';
  return { status, role };
}

export async function verifyFirebaseUserAndAccess(
  authorizationHeader: string | string[] | undefined,
  deps: AuthVerifierDeps = {},
): Promise<VerifiedFirebaseUser> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new ServerAuthError(
      401,
      'unauthenticated',
      '로그인이 필요합니다. 다시 로그인한 후 이용해 주세요.',
    );
  }

  const config =
    deps.projectId && deps.firestoreDatabaseId
      ? {
          projectId: deps.projectId,
          firestoreDatabaseId: deps.firestoreDatabaseId,
        }
      : loadFirebaseProjectConfig();

  let decoded: { uid: string; email: string; emailVerified: boolean };
  try {
    const verifyFn = deps.verifyJwt ?? defaultVerifyFirebaseJwt;
    decoded = await verifyFn(token, config.projectId);
  } catch (err) {
    if (err instanceof ServerAuthError) throw err;
    throw new ServerAuthError(
      401,
      'invalid_token',
      '인증 토큰이 유효하지 않거나 만료되었습니다. 새로고침 또는 다시 로그인해 주세요.',
    );
  }

  if (!decoded.uid || !UID_PATTERN.test(decoded.uid)) {
    throw new ServerAuthError(
      401,
      'invalid_uid',
      '사용자 식별 정보가 올바르지 않습니다.',
    );
  }

  if (!decoded.emailVerified) {
    throw new ServerAuthError(
      403,
      'email_unverified',
      '이메일 인증이 완료된 Google 계정만 AI 기능을 사용할 수 있습니다.',
    );
  }

  const fetchAccess = deps.fetchAccessDoc ?? defaultFetchFirestoreAccessDoc;
  const accessDoc = await fetchAccess({
    projectId: config.projectId,
    firestoreDatabaseId: config.firestoreDatabaseId,
    uid: decoded.uid,
    idToken: token,
  });

  if (!accessDoc) {
    throw new ServerAuthError(
      403,
      'access_not_found',
      '승인 요청 정보를 찾을 수 없습니다. 관리자 승인 후 이용해 주세요.',
    );
  }

  if (accessDoc.status !== 'active') {
    const reasonMap: Record<string, string> = {
      pending: '관리자 승인 대기 중인 계정입니다. 승인 완료 후 AI 기능을 사용할 수 있습니다.',
      suspended: '일시 정지된 계정입니다. AI 기능을 사용할 수 없습니다.',
      rejected: '이용이 거절된 계정입니다. AI 기능을 사용할 수 없습니다.',
    };
    throw new ServerAuthError(
      403,
      'account_not_active',
      reasonMap[accessDoc.status] || '활성화되지 않은 계정입니다.',
    );
  }

  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.emailVerified,
    accessStatus: accessDoc.status,
    role: accessDoc.role,
  };
}
