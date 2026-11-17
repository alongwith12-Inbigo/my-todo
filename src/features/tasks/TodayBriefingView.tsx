import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  GraduationCap,
  Link2,
  MapPin,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import {
  ACADEMIC_CATEGORY_META,
  getAcademicEventsForDateKey,
} from '../../lib/academicCalendar';
import { buildAiPlannerContext } from '../../lib/aiPlanner';
import {
  buildTodaySituationBriefing,
  timestampToDate,
} from '../../lib/briefing';
import {
  classifyTodayEvents,
  detectTodayEventOverlaps,
  getEventsForDateKey,
  getMinutesUntilEventStart,
} from '../../lib/calendar';
import {
  formatKstEventTimeRange,
  formatKstTodayHeader,
  getKstGreeting,
} from '../../lib/dateKst';
import {
  computeDayTimeAvailability,
  formatMinutesKorean,
  resolveTimetableForDate,
  SLOT_KIND_LABELS,
} from '../../lib/timetable';
import type { TaskFilterTab } from '../../repositories/taskRepo';
import type { CalendarEventRecord, TaskRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useEventData } from '../calendar/EventDataContext';
import { EventModal } from '../calendar/EventModal';
import { useAcademicEventData } from '../academic/AcademicEventDataContext';
import { useTimetableData } from '../timetable/TimetableDataContext';
import { AiTodayPlannerCard } from './AiTodayPlannerCard';
import { useAiWorkspace } from './AiWorkspaceContext';
import { useTaskData } from './TaskDataContext';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskQuickAddBar } from './TaskQuickAddBar';
import { TaskRow } from './TaskRow';

interface TodayBriefingViewProps {
  now: Date;
  todayKey: string;
  onOpenTasksView: (initialFilter?: TaskFilterTab) => void;
  onOpenCalendar: (eventId?: string) => void;
  onOpenTimetable?: () => void;
  onOpenAcademicCalendar?: () => void;
  onOpenSettings?: () => void;
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
  onOpenTimetable,
  onOpenAcademicCalendar,
  onOpenSettings,
  focusedTaskId,
  onClearFocusedTask,
}: TodayBriefingViewProps) {
  const { firebaseUser, workspace } = useAuth();
  const {
    briefingTasks,
    cachedDoneTasks,
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
  const { timetables, overridesByDate, extendTimetableToPeriodCount } =
    useTimetableData();
  const { academicEvents } = useAcademicEventData();

  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] =
    useState<CalendarEventRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extendingTimetable, setExtendingTimetable] = useState(false);
  const [onHoldOpen, setOnHoldOpen] = useState(false);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const [unremindedOpen, setUnremindedOpen] = useState(false);

  const {
    aiEnabled,
    hasPersonalKey,
    plannerVisible,
    plannerLoading,
    plannerError,
    plannerErrorCode,
    plannerPlan,
    plannerFilter,
    generatedDataFingerprint,
    ensureTodayKeySynced,
    runAiPlanner,
    runDeterministicPlan,
    cancelAiPlanner,
    closeAiPlanner,
    applyQuickFilter,
    movePlanItem,
    excludePlanItem,
    reassignPlanSlot,
    resetLocalAdjustments,
  } = useAiWorkspace();

  useEffect(() => {
    ensureTodayKeySynced(todayKey);
  }, [todayKey, ensureTodayKeySynced]);

  const imminentDays = workspace?.preferences.imminentDays ?? 3;
  const displayName = workspace?.profile.displayName ?? '선생님';

  const plannerInputs = useMemo(
    () => ({
      todayKey,
      now,
      imminentDays,
      tasks: briefingTasks,
      events,
      timetables,
      overridesByDate,
      academicEvents,
    }),
    [
      todayKey,
      now,
      imminentDays,
      briefingTasks,
      events,
      timetables,
      overridesByDate,
      academicEvents,
    ],
  );

  const plannerContext = useMemo(
    () =>
      buildAiPlannerContext({
        uid: firebaseUser?.uid ?? 'anonymous',
        ...plannerInputs,
        filter: plannerFilter,
      }),
    [firebaseUser?.uid, plannerInputs, plannerFilter],
  );

  const isPlanStale = Boolean(
    plannerPlan?.mode === 'ai' &&
      generatedDataFingerprint &&
      plannerContext.dataFingerprint !== generatedDataFingerprint,
  );

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

  const todayEventsSummary = useMemo(
    () => classifyTodayEvents(events, { now, soonMinutes: 120, upcomingDays: 7 }),
    [events, now],
  );

  const todayChronologicalEvents = useMemo(
    () => getEventsForDateKey(events, todayKey),
    [events, todayKey],
  );

  const todayEventOverlaps = useMemo(
    () => detectTodayEventOverlaps(todayChronologicalEvents),
    [todayChronologicalEvents],
  );

  const todaySchedule = useMemo(
    () =>
      resolveTimetableForDate(
        todayKey,
        timetables,
        overridesByDate[todayKey] ?? null,
      ),
    [todayKey, timetables, overridesByDate],
  );

  const todayAvailability = useMemo(
    () =>
      computeDayTimeAvailability({
        resolvedDay: todaySchedule,
        events,
      }),
    [todaySchedule, events],
  );

  const todayAcademicEvents = useMemo(
    () => getAcademicEventsForDateKey(academicEvents, todayKey),
    [academicEvents, todayKey],
  );

  const situation = useMemo(
    () =>
      buildTodaySituationBriefing({
        tasks: briefingTasks,
        completedTasks: cachedDoneTasks,
        todayEventsCount: todayEventsSummary.totalTodayCount,
        scheduleConflictCount: todayAvailability.conflicts.length,
        eventOverlapCount: todayEventOverlaps.length,
        now,
        imminentDays,
      }),
    [
      briefingTasks,
      cachedDoneTasks,
      todayEventsSummary.totalTodayCount,
      todayAvailability.conflicts.length,
      todayEventOverlaps.length,
      now,
      imminentDays,
    ],
  );

  const summary = situation.summary;
  const totalScheduleConflicts =
    todayAvailability.conflicts.length + todayEventOverlaps.length;

  const hasAnyPriorityFocus =
    summary.overdue.length > 0 ||
    summary.dueToday.length > 0 ||
    situation.dueTomorrow.length > 0 ||
    summary.remindDue.length > 0 ||
    situation.laterImminent.length > 0 ||
    summary.doing.length > 0;

  return (
    <div className="space-y-6">
      {/* Header: Pure Zero-AI Today Briefing */}
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

        <div className="flex flex-wrap items-center gap-2 shrink-0">
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
            className="px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
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

      {/* Separated Top Section: AI Work Planner (explicit click only) */}
      <section
        aria-label="AI 업무 계획"
        className="rounded-2xl border-2 border-teal-200 bg-gradient-to-br from-teal-50/50 via-white to-slate-50 p-4 sm:px-5 sm:py-4 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <h2 className="text-base font-bold text-slate-900">AI 업무 계획</h2>
            </div>
            <p className="text-xs text-slate-600">
              오늘의 일정과 업무를 종합하여 우선순위와 실행 전략을 추천합니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={plannerLoading}
              onClick={() => void runAiPlanner(plannerInputs, { forceRefresh: false })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {plannerLoading
                  ? '업무 계획 정리 중...'
                  : plannerPlan?.mode === 'ai' && !plannerVisible
                    ? '저장된 AI 업무 계획 열기'
                    : 'AI로 오늘 업무 계획 세우기'}
              </span>
            </button>

            {!plannerVisible && !plannerLoading && (
              <button
                type="button"
                onClick={() => runDeterministicPlan(plannerInputs)}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                기본 우선순위 계획 보기 (AI 미사용)
              </button>
            )}
          </div>
        </div>

        <AiTodayPlannerCard
          visible={plannerVisible}
          loading={plannerLoading}
          error={plannerError}
          errorCode={plannerErrorCode}
          plan={plannerPlan}
          hasPersonalKey={hasPersonalKey}
          aiEnabled={aiEnabled}
          availableIntervals={plannerContext.remainingWorkableIntervals}
          activeFilter={plannerFilter}
          isStaleInputs={isPlanStale}
          availabilityReason={plannerContext.availabilityReason}
          availabilityReasonDetail={plannerContext.availabilityReasonDetail}
          onCancel={cancelAiPlanner}
          onClose={closeAiPlanner}
          onRunAiPlan={(force, constraint) =>
            void runAiPlanner(plannerInputs, {
              forceRefresh: force,
              constraintText: constraint,
            })
          }
          onRunDeterministicPlan={() => runDeterministicPlan(plannerInputs)}
          onOpenSettings={onOpenSettings}
          onOpenTimetable={onOpenTimetable}
          onOpenAcademicCalendar={onOpenAcademicCalendar}
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
          onMoveItemOrder={(taskId, direction) =>
            movePlanItem(taskId, direction, plannerContext.remainingWorkableIntervals)
          }
          onExcludeItem={(taskId) =>
            excludePlanItem(taskId, plannerContext.remainingWorkableIntervals)
          }
          onReassignItemSlot={(taskId, intervalIndex) =>
            reassignPlanSlot(
              taskId,
              intervalIndex,
              plannerContext.remainingWorkableIntervals,
            )
          }
          onApplyQuickFilter={(nextFilter) =>
            applyQuickFilter(nextFilter, plannerInputs)
          }
          onResetLocalAdjustments={() => resetLocalAdjustments(plannerInputs)}
        />
      </section>

      {/* Zero-AI Auto Situation Summary Banner */}
      <section
        aria-label="오늘의 요약"
        className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-900">오늘의 요약</span>
            <span className="text-[11px] text-slate-500">
              자동 집계 · AI 미사용
            </span>
          </div>
          <p className="text-sm text-slate-800 leading-relaxed">
            {situation.headlineSummary}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 tabular-nums shrink-0">
          <span>미착수 {situation.todoCount}건</span>
          <span>진행 중 {situation.doingCount}건</span>
          <span>보류 {situation.onHoldCount}건</span>
          <span>
            완료 {situation.completedCount}건
            {situation.completedTodayCount > 0
              ? ` (오늘 ${situation.completedTodayCount})`
              : ''}
          </span>
        </div>
      </section>

      {/* Clean 4-column Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          className={`p-4 rounded-xl border ${
            totalScheduleConflicts > 0
              ? 'border-amber-200 bg-amber-50/40'
              : 'border-slate-200 bg-white'
          }`}
        >
          <p className="text-xs font-medium text-slate-600">오늘의 주요 일정</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {todayEventsSummary.totalTodayCount}건
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
            {totalScheduleConflicts > 0
              ? `시간 중복·충돌 ${totalScheduleConflicts}건`
              : todayAvailability.hasTimetable
                ? `가용 ${formatMinutesKorean(todayAvailability.netAvailableMinutes)}`
                : '시간 중복 없음'}
          </p>
        </div>

        <div
          className={`p-4 rounded-xl border ${
            summary.overdue.length > 0
              ? 'border-red-200 bg-red-50/40'
              : 'border-slate-200 bg-white'
          }`}
        >
          <p className="text-xs font-medium text-slate-600">오늘 · 내일 마감</p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums ${
              summary.overdue.length > 0 ? 'text-red-700' : 'text-slate-900'
            }`}
          >
            {summary.dueToday.length + summary.overdue.length}건
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
            오늘 {summary.dueToday.length} · 초과 {summary.overdue.length} · 내일{' '}
            {situation.dueTomorrow.length}
          </p>
        </div>

        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs font-medium text-slate-600">업무 현황 (미완료)</p>
          <p className="mt-1 text-2xl font-bold text-teal-800 tabular-nums">
            {situation.incompleteCount}건
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
            오늘 처리 {situation.todayActionableCount} · 보류 {situation.onHoldCount} · 완료{' '}
            {situation.completedCount}
          </p>
        </div>

        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs font-medium text-slate-600">주의 · 확인 필요</p>
          <p className="mt-1 text-2xl font-bold text-amber-800 tabular-nums">
            {situation.importantTasks.length + summary.imminent.length + totalScheduleConflicts}
            건
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
            중요 {situation.importantTasks.length} · 임박 {summary.imminent.length} · 충돌{' '}
            {totalScheduleConflicts}
          </p>
        </div>
      </div>

      {/* Attention & Verification Panel (Only if real attention items exist) */}
      {(situation.attentionReasons.length > 0 ||
        situation.importantTasks.length > 0 ||
        situation.officialTasks.length > 0) && (
        <section
          aria-label="주의 및 확인 사항"
          className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-amber-950 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-700" aria-hidden="true" />
              <span>주의 및 확인 사항</span>
            </h2>
            {situation.officialTasks.length > 0 && (
              <span className="text-[11px] font-semibold text-amber-900">
                공문·제출 확인 {situation.officialTasks.length}건
              </span>
            )}
          </div>

          {situation.attentionReasons.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-950">
              {situation.attentionReasons.map((reason, idx) => (
                <li key={idx} className="inline-flex items-center gap-1">
                  <span aria-hidden="true">·</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}

          {situation.importantTasks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] font-semibold text-amber-900 mr-1">
                중요 표시 업무:
              </span>
              {situation.importantTasks.slice(0, 5).map((task) => (
                <button
                  key={`imp-${task.id}`}
                  type="button"
                  onClick={() => setSelectedTask(task)}
                  className="px-2 py-1 text-xs font-medium bg-white border border-amber-200 text-slate-800 rounded-md hover:border-teal-600 hover:text-teal-800 transition-colors cursor-pointer"
                >
                  {task.priority === 'urgent' ? '[긴급] ' : '[높음] '}
                  {task.title}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

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
              title="내일 마감 예정 업무"
              subtitle={`내일(${situation.tomorrowKey}) 마감 예정입니다`}
              tasks={situation.dueTomorrow}
              tone="warn"
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
              tasks={situation.laterImminent}
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

            {situation.onHoldTasks.length > 0 && (
              <section
                aria-label="보류 중인 업무"
                className="bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                <button
                  type="button"
                  aria-expanded={onHoldOpen}
                  onClick={() => setOnHoldOpen((prev) => !prev)}
                  className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-bold text-slate-900">
                      보류 중인 업무
                    </h2>
                    <span className="text-xs font-semibold text-slate-500 tabular-nums">
                      {situation.onHoldTasks.length}건
                    </span>
                  </div>
                  {onHoldOpen ? (
                    <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                  )}
                </button>
                {onHoldOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2">
                    {situation.onHoldTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onSelect={setSelectedTask}
                        onError={setActionError}
                        compact
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

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

                  {(todayEventOverlaps.length > 0 ||
                    todayAvailability.conflicts.length > 0) && (
                    <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/70 space-y-1 text-[11px] text-amber-950">
                      <p className="font-semibold flex items-center gap-1">
                        <AlertTriangle
                          className="w-3.5 h-3.5 text-amber-700 shrink-0"
                          aria-hidden="true"
                        />
                        <span>일정 시간 중복 · 충돌 확인</span>
                      </p>
                      {todayEventOverlaps.map((ov, idx) => (
                        <p key={`ov-${idx}`} className="leading-relaxed">
                          · 일정 겹침 ({ov.overlapLabel}): {ov.eventATitle} /{' '}
                          {ov.eventBTitle}
                        </p>
                      ))}
                      {todayAvailability.conflicts.map((cf, idx) => (
                        <p key={`cf-${idx}`} className="leading-relaxed">
                          · 수업·일과 충돌: {cf.eventTitle} ({cf.startTime}~{cf.endTime})
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Today's School Academic Schedule (Separate from Personal Events) */}
            {todayAcademicEvents.length > 0 && (
              <section
                aria-label="오늘의 학교 학사일정"
                className="bg-white border border-indigo-200 rounded-xl p-4 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <GraduationCap
                      className="w-4 h-4 text-indigo-700"
                      aria-hidden="true"
                    />
                    <h2 className="text-sm font-bold text-indigo-950">
                      오늘의 학교 학사일정
                    </h2>
                  </div>
                  {onOpenAcademicCalendar && (
                    <button
                      type="button"
                      onClick={onOpenAcademicCalendar}
                      className="text-xs font-medium text-indigo-700 hover:text-indigo-900 shrink-0 cursor-pointer"
                    >
                      학사일정 관리
                    </button>
                  )}
                </div>

                <div className="space-y-1.5">
                  {todayAcademicEvents.map((aev) => {
                    const meta = ACADEMIC_CATEGORY_META[aev.category];
                    return (
                      <div
                        key={`today-acad-${aev.id}`}
                        className="p-2.5 rounded-lg border border-indigo-100 bg-indigo-50/40 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-900 truncate">
                            {aev.title}
                          </p>
                          {aev.timetableImpact === 'needs_check' &&
                            !overridesByDate[todayKey] && (
                              <p className="text-[11px] text-amber-800 mt-0.5">
                                수업 시간표 임시 변경이 필요한지 확인해 주세요.
                              </p>
                            )}
                        </div>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${meta.badgeClass}`}
                        >
                          {meta.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Today's Class Timetable & Workable Time */}
            <section
              aria-label="오늘의 수업 · 업무 가능 시간"
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-teal-700" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-slate-900">
                    오늘의 수업 · 가용 시간
                  </h2>
                  {todaySchedule.hasOverride && (
                    <span className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                      임시 변경
                    </span>
                  )}
                </div>

                {onOpenTimetable && (
                  <button
                    type="button"
                    onClick={onOpenTimetable}
                    className="text-xs font-medium text-teal-700 hover:text-teal-900 shrink-0 cursor-pointer"
                  >
                    시간표 관리
                  </button>
                )}
              </div>

              {todaySchedule.periods.length === 0 ? (
                <div className="space-y-2 py-1">
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {todaySchedule.isWeekday
                      ? '오늘 적용되는 주간 시간표가 없습니다. 엑셀·한글(HWPX)·PDF·이미지 또는 직접 입력으로 시간표를 등록하면 수업과 업무 가능 시간이 함께 정리됩니다.'
                      : '주말·휴일에는 주간 수업 시간표가 적용되지 않으며 임의 근무시간을 생성하지 않습니다.'}
                  </p>
                  {onOpenTimetable && (
                    <button
                      type="button"
                      onClick={onOpenTimetable}
                      className="text-xs font-semibold text-teal-700 hover:text-teal-900 cursor-pointer"
                    >
                      {todaySchedule.isWeekday
                        ? '주간 시간표 등록하기 →'
                        : '오늘 임시 근무시간 등록하기 →'}
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                    {todaySchedule.periods.map((slot) => (
                      <div
                        key={slot.period}
                        className={`px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs ${
                          slot.isOverridden ? 'bg-amber-50/40' : ''
                        }`}
                      >
                        <div className="min-w-0 truncate">
                          <span className="font-bold text-slate-800 mr-1.5 tabular-nums">
                            {slot.label}
                          </span>
                          <span
                            className={
                              slot.kind === 'free'
                                ? slot.workAvailable
                                  ? 'font-medium text-emerald-800'
                                  : 'text-slate-500'
                                : 'font-medium text-slate-900'
                            }
                          >
                            {slot.subject ||
                              (slot.kind === 'class' && slot.className
                                ? slot.className
                                : slot.kind === 'free'
                                  ? slot.workAvailable
                                    ? '업무 가능 시간'
                                    : '수업 없음'
                                  : SLOT_KIND_LABELS[slot.kind])}
                          </span>
                          {((slot.subject && slot.className) || slot.classroom) && (
                            <span className="text-[11px] text-slate-500 ml-1">
                              (
                              {[
                                slot.subject ? slot.className : '',
                                slot.classroom,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                              )
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                          {slot.startTime}~{slot.endTime}
                        </span>
                      </div>
                    ))}
                  </div>

                  {todaySchedule.isWeekday &&
                    todaySchedule.timetableId &&
                    todaySchedule.periods.length < 7 && (
                      <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/70 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-amber-950 font-medium">
                          현재 시간표가 {todaySchedule.periods.length}교시까지로 설정되어 있습니다.
                        </span>
                        <button
                          type="button"
                          disabled={extendingTimetable}
                          onClick={() => {
                            if (!todaySchedule.timetableId) return;
                            setExtendingTimetable(true);
                            setActionError(null);
                            void extendTimetableToPeriodCount(
                              todaySchedule.timetableId,
                              7,
                            )
                              .catch((err) => {
                                setActionError(
                                  err instanceof Error
                                    ? err.message
                                    : '시간표를 7교시까지로 확장하는 중 오류가 발생했습니다.',
                                );
                              })
                              .finally(() => {
                                setExtendingTimetable(false);
                              });
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 disabled:opacity-60 shrink-0 cursor-pointer"
                        >
                          {extendingTimetable ? '확장 중...' : '7교시까지로 확장하기'}
                        </button>
                      </div>
                    )}

                  {todayAvailability.hasTimetable && (
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600">오늘 수업</span>
                        <span className="font-semibold text-slate-900 tabular-nums">
                          {formatMinutesKorean(todayAvailability.classMinutes)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600">
                          실제 업무 가능 시간
                        </span>
                        <span className="font-bold text-teal-800 tabular-nums">
                          {formatMinutesKorean(todayAvailability.netAvailableMinutes)}
                        </span>
                      </div>
                      {todayAvailability.netAvailableIntervals.length > 0 && (
                        <p className="text-[11px] text-slate-500 tabular-nums leading-relaxed">
                          가용 시간대:{' '}
                          {todayAvailability.netAvailableIntervals
                            .map((seg) => `${seg.startTime}~${seg.endTime}`)
                            .join(', ')}
                        </p>
                      )}
                      {todayAvailability.conflicts.length > 0 && (
                        <p className="text-[11px] text-amber-800 leading-relaxed">
                          일정 겹침 {todayAvailability.conflicts.length}건 (
                          {todayAvailability.conflicts
                            .map((c) => c.eventTitle)
                            .join(', ')}
                          )
                        </p>
                      )}
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
