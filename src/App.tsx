import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useKstClock } from './hooks/useKstClock';
import type { TaskFilterTab } from './repositories/taskRepo';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { LoginView } from './features/auth/LoginView';
import { PendingApprovalView } from './features/auth/PendingApprovalView';
import { CalendarView } from './features/calendar/CalendarView';
import { EventDataProvider, useEventData } from './features/calendar/EventDataContext';
import { NoteDataProvider } from './features/notes/NoteDataContext';
import { NotesView } from './features/notes/NotesView';
import { NotificationBell } from './features/notifications/NotificationBell';
import { SettingsView } from './features/settings/SettingsView';
import { TaskDataProvider, useTaskData } from './features/tasks/TaskDataContext';
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

function AuthenticatedWorkspace({
  displayName,
  onSignOut,
}: {
  displayName: string;
  onSignOut: () => void;
}) {
  const { now, todayKey } = useKstClock();
  const { refreshBriefing } = useTaskData();
  const { refreshEvents } = useEventData();

  const [activeNav, setActiveNav] = useState<NavSection>('today');
  const [tasksInitialFilter, setTasksInitialFilter] =
    useState<TaskFilterTab>('active');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  const lastDateKeyRef = useRef(todayKey);
  useEffect(() => {
    if (lastDateKeyRef.current !== todayKey) {
      lastDateKeyRef.current = todayKey;
      void refreshBriefing();
      void refreshEvents();
    }
  }, [todayKey, refreshBriefing, refreshEvents]);

  function handleOpenTasksView(initialFilter: TaskFilterTab = 'active') {
    setTasksInitialFilter(initialFilter);
    setActiveNav('tasks');
  }

  function handleOpenTask(taskId: string) {
    setFocusedTaskId(taskId);
    setActiveNav('today');
  }

  function handleOpenTaskInTasksView(taskId: string) {
    setTasksInitialFilter('active');
    setFocusedTaskId(taskId);
    setActiveNav('tasks');
  }

  function handleOpenCalendar(eventId?: string) {
    if (eventId) {
      setFocusedEventId(eventId);
    }
    setActiveNav('calendar');
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

          {/* Zone 3: Notification Bell + Account / Sign-Out Action */}
          <div className="flex items-center gap-2.5 shrink-0">
            <NotificationBell
              now={now}
              onSelectTask={handleOpenTask}
              onSelectEvent={(eventId) => handleOpenCalendar(eventId)}
            />
            <span className="hidden sm:inline text-xs font-medium text-slate-600 truncate max-w-[140px]">
              {displayName}
            </span>
            <button
              type="button"
              onClick={onSignOut}
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
          <TodayBriefingView
            now={now}
            todayKey={todayKey}
            onOpenTasksView={handleOpenTasksView}
            onOpenCalendar={handleOpenCalendar}
            focusedTaskId={focusedTaskId}
            onClearFocusedTask={() => setFocusedTaskId(null)}
          />
        )}

        {activeNav === 'tasks' && (
          <TasksView
            initialFilter={tasksInitialFilter}
            focusedTaskId={focusedTaskId}
            onClearFocusedTask={() => setFocusedTaskId(null)}
            onOpenEvent={(eventId) => handleOpenCalendar(eventId)}
          />
        )}

        {activeNav === 'calendar' && (
          <CalendarView
            todayKey={todayKey}
            now={now}
            focusedEventId={focusedEventId}
            onClearFocusedEvent={() => setFocusedEventId(null)}
            onOpenTask={handleOpenTask}
          />
        )}

        {activeNav === 'notes' && (
          <NotesView
            todayKey={todayKey}
            now={now}
            onOpenTask={handleOpenTaskInTasksView}
          />
        )}

        {activeNav === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

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
    <TaskDataProvider>
      <EventDataProvider>
        <NoteDataProvider>
          <AuthenticatedWorkspace
            displayName={workspace.profile.displayName}
            onSignOut={signOutUser}
          />
        </NoteDataProvider>
      </EventDataProvider>
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
