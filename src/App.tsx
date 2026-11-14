import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { formatKstTodayHeader } from './lib/dateKst';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { LoginView } from './features/auth/LoginView';
import { PendingApprovalView } from './features/auth/PendingApprovalView';
import { SettingsView } from './features/settings/SettingsView';
import type { NavSection } from './types/domain';

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'today', label: '오늘' },
  { id: 'tasks', label: '업무' },
  { id: 'calendar', label: '일정' },
  { id: 'notes', label: '메모' },
  { id: 'settings', label: '설정' },
];

function WorkspaceShell() {
  const {
    firebaseUser,
    authReady,
    accessRecord,
    accessLoading,
    workspace,
    workspaceLoading,
    signOutUser,
  } = useAuth();
  const [activeNav, setActiveNav] = useState<NavSection>('today');

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        인증 상태를 확인하는 중입니다...
      </div>
    );
  }

  if (!firebaseUser) {
    return <LoginView />;
  }

  if (accessLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        계정 승인 상태를 확인하는 중입니다...
      </div>
    );
  }

  if (!accessRecord || accessRecord.status !== 'active') {
    return <PendingApprovalView />;
  }

  if (workspaceLoading || !workspace) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        개인 업무 공간을 준비하는 중입니다...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Three-Zone Top Bar Contract */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveNav('today')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            오늘의 학교는?
          </button>

          {/* Zone 2: 5 Concise Single-Line Navigation Links */}
          <nav
            aria-label="주요 메뉴"
            className="hidden md:flex items-center gap-6 text-sm font-medium"
          >
            {NAV_ITEMS.map((item) => {
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 cursor-pointer ${
                    isActive
                      ? 'text-teal-700 border-teal-700'
                      : 'text-slate-600 border-transparent hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Account / Sign-Out Action */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline text-xs font-medium text-slate-600 truncate max-w-[140px]">
              {workspace.profile.displayName}
            </span>
            <button
              type="button"
              onClick={signOutUser}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
              <span>로그아웃</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Row */}
        <nav
          aria-label="모바일 주요 메뉴"
          className="md:hidden border-t border-slate-100 px-4 flex items-center justify-between overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveNav(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`px-3 py-2.5 text-xs font-medium whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
                  isActive
                    ? 'text-teal-700 border-teal-700'
                    : 'text-slate-600 border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-8">
        {activeNav === 'settings' ? (
          <SettingsView />
        ) : (
          <section className="space-y-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-4">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  {formatKstTodayHeader()}
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                  <span>Asia/Seoul</span>
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                  {activeNav === 'today' && '오늘의 브리핑'}
                  {activeNav === 'tasks' && '업무 관리'}
                  {activeNav === 'calendar' && '일정 관리'}
                  {activeNav === 'notes' && '포스트잇 메모'}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => setActiveNav('settings')}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {accessRecord.role === 'admin'
                  ? '설정 및 사용자 승인 관리'
                  : '프로필 · 환경설정'}
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className="w-5 h-5 text-teal-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-1.5">
                  <h2 className="text-base font-semibold text-slate-900">
                    1단계 기반 구축 및 계정 승인 체계가 적용되었습니다
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    현재 계정(<strong>{workspace.profile.displayName}</strong> ·{' '}
                    {accessRecord.role === 'admin' ? '관리자' : '일반 교사'})은
                    승인 완료 상태이며, 개인 데이터 경로(
                    <code className="font-mono text-xs text-slate-800">
                      users/{firebaseUser.uid}
                    </code>
                    )가 보안 규칙으로 격리 활성화되었습니다.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100 text-xs text-slate-600">
                <div>
                  <p className="font-semibold text-slate-900">다음 2단계 예정</p>
                  <p className="mt-1">
                    오늘의 브리핑 계산 로직 및 빠른 업무 등록·상태 관리
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">데이터 보안 상태</p>
                  <p className="mt-1">
                    관리자 포함 타인의 개인 업무·일정·메모 열람 차단 적용됨
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">무료 운영 최적화</p>
                  <p className="mt-1">
                    세션 캐싱 · 오프라인 영속성 · 범위 제한 조회 적용됨
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WorkspaceShell />
    </AuthProvider>
  );
}
