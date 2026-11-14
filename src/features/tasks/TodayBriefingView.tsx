import { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Link2,
  MapPin,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { classifyTodayBriefing, timestampToDate } from '../../lib/briefing';
import { classifyTodayEvents, getMinutesUntilEventStart } from '../../lib/calendar';
import {
  formatKstEventTimeRange,
  formatKstTodayHeader,
  getKstGreeting,
} from '../../lib/dateKst';
import type { TaskFilterTab } from '../../repositories/taskRepo';
import type { CalendarEventRecord, TaskRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useEventData } from '../calendar/EventDataContext';
import { EventModal } from '../calendar/EventModal';
import { useTaskData } from './TaskDataContext';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskQuickAddBar } from './TaskQuickAddBar';
import { TaskRow } from './TaskRow';

interface TodayBriefingViewProps {
  now: Date;
  todayKey: string;
  onOpenTasksView: (initialFilter?: TaskFilterTab) => void;
  onOpenCalendar: (eventId?: string) => void;
  focusedTaskId?: string | null;
  onClearFocusedTask?: () => void;
}

const PREVIEW_LIMIT = 5;

interface BriefingSectionProps {
  title: string;
  subtitle?: string;
  tasks: TaskRecord[];
  tone?: 'danger' | 'warn' | 'default';
  onSelectTask: (task: TaskRecord) => void;
  onError: (msg: string) => void;
  onViewAllInTasks?: () => void;
}

function BriefingSection({
  title,
  subtitle,
  tasks,
  tone = 'default',
  onSelectTask,
  onError,
  onViewAllInTasks,
}: BriefingSectionProps) {
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;

  const visibleTasks = expanded ? tasks : tasks.slice(0, PREVIEW_LIMIT);
  const hiddenCount = tasks.length - visibleTasks.length;

  return (
    <section
      aria-label={title}
      className={`rounded-xl border p-5 space-y-3 ${
        tone === 'danger'
          ? 'bg-red-50/30 border-red-200'
          : 'bg-white border-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2
            className={`text-base font-bold ${
              tone === 'danger'
                ? 'text-red-800'
                : tone === 'warn'
                  ? 'text-amber-900'
                  : 'text-slate-900'
            }`}
          >
            {title}
          </h2>
          <span className="text-xs font-semibold text-slate-500 tabular-nums">
            {tasks.length}건
          </span>
          {subtitle && (
            <span className="text-xs text-slate-500">
              <span aria-hidden="true" className="mr-1.5">
                ·
              </span>
              {subtitle}
            </span>
          )}
        </div>

        {onViewAllInTasks && (
          <button
            type="button"
            onClick={onViewAllInTasks}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            업무 관리에서 보기
          </button>
        )}
      </div>

      <div className="space-y-2">
        {visibleTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onSelect={onSelectTask}
            onError={onError}
            compact
          />
        ))}
      </div>

      {tasks.length > PREVIEW_LIMIT && (
        <div className="pt-1 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-xs font-semibold text-slate-700 hover:text-teal-700 underline underline-offset-2 cursor-pointer"
          >
            {expanded
              ? '접기'
              : `나머지 ${hiddenCount}건 포함 전체 ${tasks.length}건 보기`}
          </button>
        </div>
      )}
    </section>
  );
}

export function TodayBriefingView({
  now,
  todayKey,
  onOpenTasksView,
  onOpenCalendar,
  focusedTaskId,
  onClearFocusedTask,
}: TodayBriefingViewProps) {
  const { workspace } = useAuth();
  const {
    briefingTasks,
    briefingLoading,
    briefingError,
    hasMoreUndated,
    loadingMoreUndated,
    usedIndexFallback,
    refreshBriefing,
    refreshSingleTask,
    loadMoreUndated,
  } = useTaskData();
  const { events, eventsLoading, refreshEvents } = useEventData();

  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] =
    useState<CalendarEventRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const [unremindedOpen, setUnremindedOpen] = useState(false);

  const imminentDays = workspace?.preferences.imminentDays ?? 3;
  const displayName = workspace?.profile.displayName ?? '선생님';

  useEffect(() => {
    if (!focusedTaskId) return;
    const cached = briefingTasks.find((item) => item.id === focusedTaskId);
    if (cached) {
      setSelectedTask(cached);
      onClearFocusedTask?.();
      return;
    }

    let cancelled = false;
    void refreshSingleTask(focusedTaskId)
      .then((fetched) => {
        if (cancelled) return;
        if (fetched) {
          setSelectedTask(fetched);
        } else {
          setActionError('연결된 업무를 찾을 수 없습니다. 이미 영구 삭제되었을 수 있습니다.');
        }
        onClearFocusedTask?.();
      })
      .catch(() => {
        if (cancelled) return;
        setActionError('연결된 업무를 불러오는 중 오류가 발생했습니다.');
        onClearFocusedTask?.();
      });
    return () => {
      cancelled = true;
    };
  }, [focusedTaskId, briefingTasks, refreshSingleTask, onClearFocusedTask]);

  const summary = useMemo(
    () => classifyTodayBriefing(briefingTasks, { imminentDays, now }),
    [briefingTasks, imminentDays, now],
  );

  const todayEventsSummary = useMemo(
    () => classifyTodayEvents(events, { now, soonMinutes: 120, upcomingDays: 7 }),
    [events, now],
  );

  const hasAnyPriorityFocus =
    summary.overdue.length > 0 ||
    summary.dueToday.length > 0 ||
    summary.remindDue.length > 0 ||
    summary.imminent.length > 0 ||
    summary.doing.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-500">
            {formatKstTodayHeader(now)}
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            <span>Asia/Seoul</span>
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            오늘의 브리핑
          </h1>
          <p className="text-sm text-slate-600">
            {getKstGreeting(displayName, now)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={briefingLoading || eventsLoading}
            onClick={() => {
              setActionError(null);
              void refreshBriefing();
              void refreshEvents();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${briefingLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>새로고침</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenTasksView('active')}
            className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            전체 업무 관리
          </button>
        </div>
      </div>

      {/* Quick Add */}
      <TaskQuickAddBar
        onOpenTask={(taskId) => {
          const matched = briefingTasks.find((t) => t.id === taskId);
          if (matched) {
            setSelectedTask(matched);
          } else {
            void refreshSingleTask(taskId).then((fetched) => {
              if (fetched) setSelectedTask(fetched);
            });
          }
        }}
        onOpenEvent={(eventId) => onOpenCalendar(eventId)}
        onGoToTasksView={() => onOpenTasksView('active')}
        onGoToCalendarView={() => onOpenCalendar()}
      />

      {usedIndexFallback && (
        <div
          role="status"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900"
        >
          Firestore 복합 색인이 아직 배포되지 않아 기본 범위 조회 모드로 동작 중입니다.
          운영 프로젝트에 <code className="font-mono">firestore.indexes.json</code>을
          배포하면 대규모 업무도 더 빠르게 조회됩니다.
        </div>
      )}

      {(briefingError || actionError) && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 flex items-center justify-between gap-3"
        >
          <span>{actionError || briefingError}</span>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              void refreshBriefing();
            }}
            className="px-3 py-1 text-xs font-semibold bg-white border border-red-200 rounded-md hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            다시 불러오기
          </button>
        </div>
      )}

      {/* Clean 4-column Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          className={`p-4 rounded-xl border ${
            summary.overdue.length > 0
              ? 'border-red-200 bg-red-50/40'
              : 'border-slate-200 bg-white'
          }`}
        >
          <p className="text-xs font-medium text-slate-600">기한 초과</p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums ${
              summary.overdue.length > 0 ? 'text-red-700' : 'text-slate-900'
            }`}
          >
            {summary.overdue.length}건
          </p>
        </div>

        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs font-medium text-slate-600">오늘 마감</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {summary.dueToday.length}건
          </p>
        </div>

        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs font-medium text-slate-600">오늘 재확인</p>
          <p className="mt-1 text-2xl font-bold text-amber-800 tabular-nums">
            {summary.remindDue.length}건
          </p>
        </div>

        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs font-medium text-slate-600">
            마감 임박 ({imminentDays}일 이내)
          </p>
          <p className="mt-1 text-2xl font-bold text-teal-800 tabular-nums">
            {summary.imminent.length}건
          </p>
        </div>
      </div>

      {/* Main Layout */}
      {briefingLoading && briefingTasks.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          오늘의 브리핑 데이터를 불러오는 중입니다...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Primary Focus Column */}
          <div className="lg:col-span-8 space-y-5">
            <BriefingSection
              title="기한 초과 업무"
              subtitle="마감일이 지난 미완료 업무입니다"
              tasks={summary.overdue}
              tone="danger"
              onSelectTask={setSelectedTask}
              onError={setActionError}
              onViewAllInTasks={() => onOpenTasksView('active')}
            />

            <BriefingSection
              title="오늘 마감 업무"
              subtitle="오늘(Asia/Seoul)까지 처리할 일입니다"
              tasks={summary.dueToday}
              onSelectTask={setSelectedTask}
              onError={setActionError}
            />

            <BriefingSection
              title="오늘 재확인할 업무"
              subtitle="재확인 시점이 도래했거나 지난 업무입니다"
              tasks={summary.remindDue}
              tone="warn"
              onSelectTask={setSelectedTask}
              onError={setActionError}
            />

            <BriefingSection
              title="마감 임박 업무"
              subtitle={`향후 ${imminentDays}일 이내 마감`}
              tasks={summary.imminent}
              onSelectTask={setSelectedTask}
              onError={setActionError}
            />

            <BriefingSection
              title="진행 중인 업무"
              subtitle="현재 착수하여 진행 중인 항목"
              tasks={summary.doing}
              onSelectTask={setSelectedTask}
              onError={setActionError}
              onViewAllInTasks={() => onOpenTasksView('doing')}
            />

            {!hasAnyPriorityFocus && (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
                <h2 className="text-base font-semibold text-slate-900">
                  {summary.totalActiveCount === 0
                    ? '등록된 미완료 업무가 없습니다'
                    : '오늘 급하게 처리할 마감·재확인 업무가 없습니다'}
                </h2>
                <p className="text-sm text-slate-500">
                  {summary.totalActiveCount === 0
                    ? '위 빠른 등록 창에 오늘 챙겨야 할 업무 제목을 입력해 시작해 보세요.'
                    : '오른쪽 접이식 목록에서 날짜 없는 업무나 재확인 미지정 업무를 살펴보거나 전체 업무 목록으로 이동할 수 있습니다.'}
                </p>
              </div>
            )}
          </div>

          {/* Secondary Column: Today Schedule + Collapsible Undated / Unreminded */}
          <aside className="lg:col-span-4 space-y-5">
            {/* Live Today Schedule */}
            <section
              aria-label="오늘의 일정"
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-teal-700" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-slate-900">오늘의 일정</h2>
                  <span className="text-xs font-semibold text-slate-500 tabular-nums">
                    {todayEventsSummary.totalTodayCount}건
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEvent(null);
                      setEventModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:text-teal-950 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>등록</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenCalendar()}
                    className="text-xs font-medium text-slate-600 hover:text-teal-700 cursor-pointer"
                  >
                    달력 보기
                  </button>
                </div>
              </div>

              {eventsLoading && todayEventsSummary.totalTodayCount === 0 ? (
                <p className="text-xs text-slate-500 py-2">
                  오늘 일정을 불러오는 중입니다...
                </p>
              ) : todayEventsSummary.totalTodayCount === 0 ? (
                <div className="py-2 space-y-2">
                  <p className="text-xs text-slate-500 leading-relaxed">
                    오늘(Asia/Seoul) 예정된 일정이 없습니다. 회의, 연수, 상담 등
                    일정을 등록해 두면 이 영역과 알림에서 바로 확인할 수 있습니다.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {todayEventsSummary.startingSoon.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-amber-900 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-amber-700" aria-hidden="true" />
                        <span>곧 시작 · 진행 중인 일정</span>
                      </p>
                      <div className="space-y-1.5">
                        {todayEventsSummary.startingSoon.map((ev) => {
                          const startDate = timestampToDate(ev.startsAt);
                          const endDate = timestampToDate(ev.endsAt);
                          const mins = getMinutesUntilEventStart(ev, now);
                          const timingHint =
                            mins !== null && mins <= 0
                              ? '진행 중'
                              : mins !== null && mins <= 60
                                ? `${mins}분 후`
                                : '곧 시작';
                          return (
                            <button
                              key={ev.id}
                              type="button"
                              onClick={() => {
                                setSelectedEvent(ev);
                                setEventModalOpen(true);
                              }}
                              className="w-full text-left p-2.5 rounded-lg border border-amber-200 bg-amber-50/60 hover:bg-amber-50 transition-colors space-y-1 cursor-pointer"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-semibold text-slate-900 truncate">
                                  {ev.title}
                                </span>
                                <span className="text-[11px] font-semibold text-amber-900 shrink-0 tabular-nums">
                                  {timingHint}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-600 tabular-nums">
                                {formatKstEventTimeRange(startDate, endDate, ev.allDay)}
                                {ev.location && (
                                  <>
                                    <span aria-hidden="true" className="mx-1.5">
                                      ·
                                    </span>
                                    <span>{ev.location}</span>
                                  </>
                                )}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {todayEventsSummary.otherToday.length > 0 && (
                    <div className="space-y-1.5">
                      {todayEventsSummary.startingSoon.length > 0 && (
                        <p className="text-[11px] font-semibold text-slate-600">
                          오늘의 기타 일정
                        </p>
                      )}
                      <div className="space-y-1.5">
                        {todayEventsSummary.otherToday.map((ev) => {
                          const startDate = timestampToDate(ev.startsAt);
                          const endDate = timestampToDate(ev.endsAt);
                          return (
                            <button
                              key={ev.id}
                              type="button"
                              onClick={() => {
                                setSelectedEvent(ev);
                                setEventModalOpen(true);
                              }}
                              className={`w-full text-left p-2.5 rounded-lg border transition-colors space-y-1 cursor-pointer ${
                                ev.allDay
                                  ? 'border-teal-200 bg-teal-50/40 hover:bg-teal-50'
                                  : 'border-slate-200 bg-white hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-semibold text-slate-900 truncate">
                                  {ev.title}
                                </span>
                                <span
                                  className={`text-[11px] font-medium shrink-0 tabular-nums ${
                                    ev.allDay ? 'text-teal-800' : 'text-slate-600'
                                  }`}
                                >
                                  {formatKstEventTimeRange(
                                    startDate,
                                    endDate,
                                    ev.allDay,
                                  )}
                                </span>
                              </div>
                              {(ev.location || ev.relatedTaskId) && (
                                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-slate-500">
                                  {ev.location && (
                                    <span className="inline-flex items-center gap-1">
                                      <MapPin className="w-3 h-3" aria-hidden="true" />
                                      <span>{ev.location}</span>
                                    </span>
                                  )}
                                  {ev.relatedTaskId && (
                                    <span className="inline-flex items-center gap-1 text-teal-700">
                                      <Link2 className="w-3 h-3" aria-hidden="true" />
                                      <span>업무 연결됨</span>
                                    </span>
                                  )}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Collapsible: Undated Incomplete Tasks */}
            <section
              aria-label="날짜가 지정되지 않은 미완료 업무"
              className="bg-white border border-slate-200 rounded-xl overflow-hidden"
            >
              <button
                type="button"
                aria-expanded={undatedOpen}
                onClick={() => setUndatedOpen((prev) => !prev)}
                className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    날짜 없는 미완료 업무
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                    마감·예정·재확인일 미지정 · {summary.undated.length}건
                    {hasMoreUndated ? '+' : ''}
                  </p>
                </div>
                {undatedOpen ? (
                  <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                )}
              </button>

              {undatedOpen && (
                <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2.5">
                  {summary.undated.length === 0 ? (
                    <p className="text-xs text-slate-500 py-2">
                      날짜가 지정되지 않은 미완료 업무가 없습니다.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-2">
                        {summary.undated.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            onSelect={setSelectedTask}
                            onError={setActionError}
                            compact
                          />
                        ))}
                      </div>
                      {hasMoreUndated && (
                        <button
                          type="button"
                          disabled={loadingMoreUndated}
                          onClick={() => void loadMoreUndated()}
                          className="w-full py-2 text-xs font-semibold text-teal-700 border border-teal-200 rounded-lg hover:bg-teal-50 disabled:opacity-60 cursor-pointer"
                        >
                          {loadingMoreUndated
                            ? '불러오는 중...'
                            : '날짜 없는 업무 더 불러오기'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>

            {/* Collapsible: Unreminded Incomplete Tasks */}
            <section
              aria-label="재확인일이 없는 미완료 업무"
              className="bg-white border border-slate-200 rounded-xl overflow-hidden"
            >
              <button
                type="button"
                aria-expanded={unremindedOpen}
                onClick={() => setUnremindedOpen((prev) => !prev)}
                className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    재확인일 없는 미완료 업무
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                    다시 확인 시점 미설정 · {summary.unreminded.length}건
                  </p>
                </div>
                {unremindedOpen ? (
                  <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                )}
              </button>

              {unremindedOpen && (
                <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2.5">
                  {summary.unreminded.length === 0 ? (
                    <p className="text-xs text-slate-500 py-2">
                      모든 미완료 업무에 재확인일이 설정되어 있습니다.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-2">
                        {summary.unreminded.slice(0, PREVIEW_LIMIT).map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            onSelect={setSelectedTask}
                            onError={setActionError}
                            compact
                          />
                        ))}
                      </div>
                      {summary.unreminded.length > PREVIEW_LIMIT && (
                        <button
                          type="button"
                          onClick={() => onOpenTasksView('unreminded')}
                          className="w-full py-2 text-xs font-semibold text-teal-700 border border-teal-200 rounded-lg hover:bg-teal-50 cursor-pointer"
                        >
                          재확인 미지정 전체 {summary.unreminded.length}건 보기
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}

      <TaskDetailModal
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onOpenEvent={(eventId) => onOpenCalendar(eventId)}
      />

      <EventModal
        isOpen={eventModalOpen}
        event={selectedEvent}
        initialDateKey={todayKey}
        onClose={() => {
          setEventModalOpen(false);
          setSelectedEvent(null);
        }}
        onOpenTask={(taskId) => {
          setEventModalOpen(false);
          setSelectedEvent(null);
          const matched = briefingTasks.find((t) => t.id === taskId);
          if (matched) {
            setSelectedTask(matched);
          } else {
            void refreshSingleTask(taskId).then((fetched) => {
              if (fetched) setSelectedTask(fetched);
            });
          }
        }}
        onOpenEvent={(eventId) => {
          setEventModalOpen(false);
          setSelectedEvent(null);
          onOpenCalendar(eventId);
        }}
      />
    </div>
  );
}
