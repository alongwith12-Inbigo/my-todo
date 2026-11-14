import { useState } from 'react';
import { Calendar, LogOut, StickyNote } from 'lucide-react';
import { formatKstTodayHeader } from './lib/dateKst';
import type { TaskFilterTab } from './repositories/taskRepo';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { LoginView } from './features/auth/LoginView';
import { PendingApprovalView } from './features/auth/PendingApprovalView';
import { SettingsView } from './features/settings/SettingsView';
import { TaskDataProvider } from './features/tasks/TaskDataContext';
import { TasksView } from './features/tasks/TasksView';
import { TodayBriefingView } from './features/tasks/TodayBriefingView';
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
  const [tasksInitialFilter, setTasksInitialFilter] =
    useState<TaskFilterTab>('active');

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

  function handleOpenTasksView(initialFilter: TaskFilterTab = 'active') {
    setTasksInitialFilter(initialFilter);
    setActiveNav('tasks');
  }

  return (
    <TaskDataProvider>
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
          {activeNav === 'today' && (
            <TodayBriefingView onOpenTasksView={handleOpenTasksView} />
          )}

          {activeNav === 'tasks' && (
            <TasksView initialFilter={tasksInitialFilter} />
          )}

          {activeNav === 'calendar' && (
            <section className="space-y-6">
              <div className="border-b border-slate-200 pb-4">
                <p className="text-xs font-medium text-slate-500">
                  {formatKstTodayHeader()}
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                  <span>Asia/Seoul</span>
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                  일정 관리
                </h1>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
                <Calendar
                  className="w-8 h-8 text-teal-700 mx-auto"
                  aria-hidden="true"
                />
                <h2 className="text-base font-semibold text-slate-900">
                  3단계에서 주간·월간 일정 관리 기능이 추가됩니다
                </h2>
                <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                  이번 2단계에서는 오늘의 브리핑과 업무 관리에 집중했습니다. 3단계에서
                  학사·개인 일정을 등록하면 오늘의 브리핑과 연동됩니다.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveNav('today')}
                  className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 cursor-pointer"
                >
                  오늘의 브리핑으로 돌아가기
                </button>
              </div>
            </section>
          )}

          {activeNav === 'notes' && (
            <section className="space-y-6">
              <div className="border-b border-slate-200 pb-4">
                <p className="text-xs font-medium text-slate-500">
                  {formatKstTodayHeader()}
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                  <span>Asia/Seoul</span>
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                  포스트잇 메모
                </h1>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
                <StickyNote
                  className="w-8 h-8 text-teal-700 mx-auto"
                  aria-hidden="true"
                />
                <h2 className="text-base font-semibold text-slate-900">
                  포스트잇 메모는 다음 단계에서 제공됩니다
                </h2>
                <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                  메모 작성과 메모→업무 전환 기능은 다음 개발 단계에서 연결됩니다.
                  지금은 업무 관리 화면에서 바로 업무를 등록·관리할 수 있습니다.
                </p>
                <button
                  type="button"
                  onClick={() => handleOpenTasksView('active')}
                  className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 cursor-pointer"
                >
                  업무 관리로 이동
                </button>
              </div>
            </section>
          )}

          {activeNav === 'settings' && <SettingsView />}
        </main>
      </div>
    </TaskDataProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WorkspaceShell />
    </AuthProvider>
  );
}
