import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../../lib/firebase';
import { subscribeMyAccessRecord } from '../../repositories/accessRepo';
import {
  clearWorkspaceCache,
  loadOrInitializeWorkspace,
} from '../../repositories/workspaceRepo';
import type {
  AccessRecord,
  UserPreferences,
  UserProfile,
} from '../../types/domain';
import firebaseConfig from '../../../firebase-applet-config.json';

interface WorkspaceData {
  profile: UserProfile;
  preferences: UserPreferences;
}

interface AuthContextValue {
  firebaseUser: User | null;
  authReady: boolean;
  accessRecord: AccessRecord | null;
  accessLoading: boolean;
  accessError: string | null;
  workspace: WorkspaceData | null;
  workspaceLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  setWorkspace: (data: WorkspaceData) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function formatFirebaseErrorMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('Quota exceeded')) {
    if (raw.includes('Free daily read units')) {
      return `일일 무료 Firestore 읽기 한도를 초과했습니다. 내일 한도가 초기화되거나 Firebase 콘솔에서 확인할 수 있습니다: https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore/databases/${firebaseConfig.firestoreDatabaseId}/data?openUpgradeDialog=true`;
    }
    return 'Firestore 무료 사용 한도를 초과했습니다. 내일 한도가 초기화됩니다.';
  }
  if (
    code === 'permission-denied' ||
    raw.includes('Missing or insufficient permissions')
  ) {
    return '접근 권한이 없거나 아직 계정이 승인되지 않았습니다.';
  }
  if (
    code === 'failed-precondition' ||
    raw.includes('requires an index')
  ) {
    return '이 조회에 필요한 Firestore 복합 인덱스가 아직 생성되지 않았습니다. 콘솔 오류 링크 또는 firestore.indexes.json 기준으로 인덱스를 생성해 주세요.';
  }
  if (
    code === 'auth/unauthorized-domain' ||
    raw.includes('auth/unauthorized-domain')
  ) {
    const host =
      typeof window !== 'undefined' ? window.location.hostname : '(현재 도메인)';
    return `현재 도메인(${host})이 Firebase Authentication의 승인된 도메인 목록에 등록되어 있지 않거나 캐시가 갱신되지 않았습니다. Firebase Console → Authentication → 설정(Settings) → 승인된 도메인에 "${host}"를 확인한 뒤 브라우저를 새로고침(Ctrl+Shift+R)하고 다시 시도해 주세요. (콘솔: https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings)`;
  }
  if (
    code === 'auth/popup-closed-by-user' ||
    raw.includes('auth/popup-closed-by-user')
  ) {
    return 'Google 로그인 창이 닫혔습니다. 다시 시도해 주세요.';
  }
  if (
    code === 'auth/popup-blocked' ||
    raw.includes('auth/popup-blocked')
  ) {
    return '브라우저에서 로그인 팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.';
  }
  return raw;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [accessRecord, setAccessRecord] = useState<AccessRecord | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (!user) {
        setAccessRecord(null);
        setAccessError(null);
        setWorkspace(null);
        clearWorkspaceCache();
      }
    });
    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!firebaseUser) {
      setAccessLoading(false);
      return;
    }

    setAccessLoading(true);
    setAccessError(null);

    const unsubscribeAccess = subscribeMyAccessRecord(
      firebaseUser.uid,
      (record) => {
        setAccessRecord(record);
        setAccessLoading(false);
      },
      (err) => {
        setAccessError(formatFirebaseErrorMessage(err));
        setAccessLoading(false);
      },
    );

    return () => {
      unsubscribeAccess();
    };
  }, [firebaseUser]);

  const accessStatus = accessRecord?.status;
  const accessEmail = accessRecord?.email;
  const accessDisplayName = accessRecord?.displayName;

  useEffect(() => {
    if (!firebaseUser || accessStatus !== 'active') {
      setWorkspace(null);
      setWorkspaceLoading(false);
      return;
    }

    let cancelled = false;
    setWorkspaceLoading(true);

    loadOrInitializeWorkspace({
      uid: firebaseUser.uid,
      email: firebaseUser.email || accessEmail || '',
      displayName:
        accessDisplayName || firebaseUser.displayName || '교사',
    })
      .then((entry) => {
        if (!cancelled) {
          setWorkspace(entry);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAccessError(formatFirebaseErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkspaceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [firebaseUser, accessStatus, accessEmail, accessDisplayName]);

  const signInWithGoogle = useCallback(async () => {
    setAccessError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAccessError(formatFirebaseErrorMessage(err));
      throw err;
    }
  }, []);

  const signOutUser = useCallback(async () => {
    clearWorkspaceCache(firebaseUser?.uid);
    setWorkspace(null);
    setAccessRecord(null);
    setAccessError(null);
    await signOut(auth);
  }, [firebaseUser?.uid]);

  const value = useMemo<AuthContextValue>(
    () => ({
      firebaseUser,
      authReady,
      accessRecord,
      accessLoading,
      accessError,
      workspace,
      workspaceLoading,
      signInWithGoogle,
      signOutUser,
      setWorkspace,
    }),
    [
      firebaseUser,
      authReady,
      accessRecord,
      accessLoading,
      accessError,
      workspace,
      workspaceLoading,
      signInWithGoogle,
      signOutUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth는 AuthProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
