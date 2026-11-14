import { useEffect, useMemo, useState } from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Link2,
  MapPin,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { timestampToDate } from '../../lib/briefing';
import {
  classifyTodayEvents,
  formatEventStartDayLabel,
  getCalendarRangeForMonth,
  getCalendarRangeForWeek,
  getEventsForDateKey,
} from '../../lib/calendar';
import {
  addKstDaysToDateKey,
  formatKstDateKeyLabel,
  formatKstEventTimeRange,
  formatKstMonthLabel,
  formatKstShortDate,
  formatKstTodayHeader,
  getKstDateParts,
  getKstDayRangeMs,
  getKstMonthGridDays,
  getKstWeekDays,
} from '../../lib/dateKst';
import type { CalendarEventRecord } from '../../types/domain';
import { useAuth } from '../auth/AuthContext';
import { useEventData } from './EventDataContext';
import { EventModal } from './EventModal';

type CalendarTabMode = 'month' | 'week' | 'day';

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

interface CalendarViewProps {
  todayKey: string;
  now: Date;
  focusedEventId?: string | null;
  onClearFocusedEvent?: () => void;
  onOpenTask?: (taskId: string) => void;
}

export function CalendarView({
  todayKey,
  now,
  focusedEventId,
  onClearFocusedEvent,
  onOpenTask,
}: CalendarViewProps) {
  const { workspace } = useAuth();
  const {
    events,
    eventsLoading,
    eventsError,
    ensureRangeLoaded,
    refreshEvents,
    refreshSingleEvent,
  } = useEventData();

  const defaultMode: CalendarTabMode =
    workspace?.preferences.defaultCalendarView === 'month' ? 'month' : 'week';

  const [viewMode, setViewMode] = useState<CalendarTabMode>(defaultMode);
  const [selectedDateKey, setSelectedDateKey] = useState<string>(todayKey);
  const [activeMonth, setActiveMonth] = useState<{ year: number; month: number }>(
    () => {
      const parts = getKstDateParts(now);
      return { year: parts.year, month: parts.month };
    },
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEventRecord | null>(null);
  const [draftDateKey, setDraftDateKey] = useState<string>(todayKey);

  // Open focused event if navigated from Notification or Today Briefing or Task
  useEffect(() => {
    if (!focusedEventId) return;
    const found = events.find((item) => item.id === focusedEventId);
    if (found) {
      const startDate = timestampToDate(found.startsAt);
      if (startDate) {
        const parts = getKstDateParts(startDate);
        setSelectedDateKey(parts.dateKey);
        setActiveMonth({ year: parts.year, month: parts.month });
      }
      setEditingEvent(found);
      setModalOpen(true);
      onClearFocusedEvent?.();
      return;
    }

    let cancelled = false;
    void refreshSingleEvent(focusedEventId).then((fetched) => {
      if (cancelled) return;
      if (fetched) {
        const startDate = timestampToDate(fetched.startsAt);
        if (startDate) {
          const parts = getKstDateParts(startDate);
          setSelectedDateKey(parts.dateKey);
          setActiveMonth({ year: parts.year, month: parts.month });
        }
        setEditingEvent(fetched);
        setModalOpen(true);
      }
      onClearFocusedEvent?.();
    });
    return () => {
      cancelled = true;
    };
  }, [focusedEventId, events, onClearFocusedEvent, refreshSingleEvent]);

  // Ensure Firestore range covers currently visible month / week / day
  useEffect(() => {
    if (viewMode === 'month') {
      const range = getCalendarRangeForMonth(activeMonth.year, activeMonth.month);
      void ensureRangeLoaded(range.startMs, range.endMs);
    } else if (viewMode === 'week') {
      const range = getCalendarRangeForWeek(selectedDateKey);
      void ensureRangeLoaded(range.startMs, range.endMs);
    } else {
      const range = getKstDayRangeMs(selectedDateKey);
      void ensureRangeLoaded(range.startMs, range.endMs);
    }
  }, [viewMode, activeMonth.year, activeMonth.month, selectedDateKey, ensureRangeLoaded]);

  const monthGridCells = useMemo(
    () => getKstMonthGridDays(activeMonth.year, activeMonth.month),
    [activeMonth.year, activeMonth.month],
  );

  const weekDays = useMemo(
    () => getKstWeekDays(selectedDateKey),
    [selectedDateKey],
  );

  const selectedDayEvents = useMemo(
    () => getEventsForDateKey(events, selectedDateKey),
    [events, selectedDateKey],
  );

  const todaySummary = useMemo(
    () => classifyTodayEvents(events, { now, soonMinutes: 120, upcomingDays: 7 }),
    [events, now],
  );

  function openCreateForDate(dateKey: string) {
    setEditingEvent(null);
    setDraftDateKey(dateKey);
    setModalOpen(true);
  }

  function openEditEvent(event: CalendarEventRecord) {
    setEditingEvent(event);
    setModalOpen(true);
  }

  function handleNavigate(delta: -1 | 1) {
    if (viewMode === 'month') {
      let nextMonth = activeMonth.month + delta;
      let nextYear = activeMonth.year;
      if (nextMonth < 1) {
        nextMonth = 12;
        nextYear -= 1;
      } else if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
      }
      setActiveMonth({ year: nextYear, month: nextMonth });
      setSelectedDateKey(
        `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
      );
    } else if (viewMode === 'week') {
      const nextKey = addKstDaysToDateKey(selectedDateKey, delta * 7);
      setSelectedDateKey(nextKey);
      const [y, m] = nextKey.split('-').map(Number);
      setActiveMonth({ year: y, month: m });
    } else {
      const nextKey = addKstDaysToDateKey(selectedDateKey, delta);
      setSelectedDateKey(nextKey);
      const [y, m] = nextKey.split('-').map(Number);
      setActiveMonth({ year: y, month: m });
    }
  }

  function handleJumpToday() {
    setSelectedDateKey(todayKey);
    const [y, m] = todayKey.split('-').map(Number);
    setActiveMonth({ year: y, month: m });
  }

  const periodHeading = useMemo(() => {
    if (viewMode === 'month') {
      return formatKstMonthLabel(activeMonth.year, activeMonth.month);
    }
    if (viewMode === 'week') {
      const first = weekDays[0];
      const last = weekDays[6];
      const firstDate = new Date(getKstDayRangeMs(first).startMs);
      const lastDate = new Date(getKstDayRangeMs(last).startMs);
      return `${formatKstShortDate(firstDate, now)} ~ ${formatKstShortDate(lastDate, now)}`;
    }
    return formatKstDateKeyLabel(selectedDateKey);
  }, [viewMode, activeMonth, weekDays, selectedDateKey, now]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            {formatKstTodayHeader(now)}
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            <span>Asia/Seoul</span>
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            일정 관리
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={eventsLoading}
            onClick={() => void refreshEvents()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${eventsLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>새로고침</span>
          </button>

          <button
            type="button"
            onClick={() => openCreateForDate(selectedDateKey)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>새 일정</span>
          </button>
        </div>
      </div>

      {eventsError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 flex items-center justify-between gap-3"
        >
          <span>{eventsError}</span>
          <button
            type="button"
            onClick={() => void refreshEvents()}
            className="px-3 py-1 text-xs font-semibold bg-white border border-red-200 rounded-md hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* Calendar Controls Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleNavigate(-1)}
            aria-label="이전 기간"
            className="p-2 text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          </button>

          <h2 className="text-base font-bold text-slate-900 min-w-[140px] text-center tabular-nums">
            {periodHeading}
          </h2>

          <button
            type="button"
            onClick={() => handleNavigate(1)}
            aria-label="다음 기간"
            className="p-2 text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={handleJumpToday}
            className="ml-1 px-3 py-1.5 text-xs font-medium text-teal-800 border border-teal-200 bg-teal-50/50 rounded-lg hover:bg-teal-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            오늘
          </button>
        </div>

        <div
          role="tablist"
          aria-label="달력 보기 형식"
          className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
        >
          {(
            [
              ['month', '월간'],
              ['week', '주간'],
              ['day', '일간'],
            ] as [CalendarTabMode, string][]
          ).map(([mode, label]) => {
            const active = viewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setViewMode(mode)}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-white text-teal-800 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Primary Calendar Surface */}
        <div className="lg:col-span-8 space-y-4">
          {viewMode === 'month' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {/* Weekday Header */}
              <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                {WEEKDAY_LABELS.map((dayName, idx) => (
                  <div
                    key={dayName}
                    className={`py-2.5 text-center text-xs font-semibold ${
                      idx === 0
                        ? 'text-red-700'
                        : idx === 6
                          ? 'text-sky-700'
                          : 'text-slate-600'
                    }`}
                  >
                    {dayName}
                  </div>
                ))}
              </div>

              {/* Month Grid */}
              <div className="grid grid-cols-7 divide-x divide-y divide-slate-100">
                {monthGridCells.map((cell, idx) => {
                  const cellEvents = getEventsForDateKey(events, cell.dateKey);
                  const isToday = cell.dateKey === todayKey;
                  const isSelected = cell.dateKey === selectedDateKey;
                  const colIdx = idx % 7;

                  return (
                    <div
                      key={cell.dateKey}
                      onClick={() => setSelectedDateKey(cell.dateKey)}
                      className={`min-h-[96px] sm:min-h-[110px] p-1.5 flex flex-col gap-1 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-teal-50/50 ring-1 ring-inset ring-teal-600'
                          : cell.inMonth
                            ? 'bg-white hover:bg-slate-50/70'
                            : 'bg-slate-50/60 text-slate-400 hover:bg-slate-100/60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDateKey(cell.dateKey);
                          }}
                          aria-label={`${cell.dateKey} 날짜 선택`}
                          className={`w-6 h-6 text-xs font-semibold rounded-md flex items-center justify-center tabular-nums cursor-pointer ${
                            isToday
                              ? 'bg-teal-700 text-white'
                              : !cell.inMonth
                                ? 'text-slate-400'
                                : colIdx === 0
                                  ? 'text-red-700'
                                  : colIdx === 6
                                    ? 'text-sky-700'
                                    : 'text-slate-800'
                          }`}
                        >
                          {cell.day}
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDateKey(cell.dateKey);
                            openCreateForDate(cell.dateKey);
                          }}
                          aria-label={`${cell.dateKey} 일정 추가`}
                          className="opacity-70 hover:opacity-100 p-1 text-slate-400 hover:text-teal-700 rounded cursor-pointer"
                        >
                          <Plus className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>

                      <div className="space-y-1 flex-1 min-w-0">
                        {cellEvents.slice(0, 3).map((ev) => {
                          const startDate = timestampToDate(ev.startsAt);
                          return (
                            <button
                              key={ev.id}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDateKey(cell.dateKey);
                                openEditEvent(ev);
                              }}
                              className={`w-full text-left px-1.5 py-0.5 rounded text-[11px] leading-tight truncate cursor-pointer ${
                                ev.allDay
                                  ? 'bg-teal-700 text-white font-medium'
                                  : 'bg-teal-50 text-teal-900 border border-teal-200/80 hover:bg-teal-100'
                              }`}
                            >
                              {!ev.allDay && startDate && (
                                <span className="font-mono text-[10px] mr-1 opacity-80">
                                  {getKstDateParts(startDate).dateKey === cell.dateKey
                                    ? `${String(
                                        (new Date(
                                          startDate.getTime() + 9 * 60 * 60 * 1000,
                                        )).getUTCHours(),
                                      ).padStart(2, '0')}:${String(
                                        (new Date(
                                          startDate.getTime() + 9 * 60 * 60 * 1000,
                                        )).getUTCMinutes(),
                                      ).padStart(2, '0')}`
                                    : '계속'}
                                </span>
                              )}
                              <span>{ev.title}</span>
                            </button>
                          );
                        })}
                        {cellEvents.length > 3 && (
                          <p className="text-[10px] font-medium text-slate-500 px-1 tabular-nums">
                            +{cellEvents.length - 3}건 더
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {viewMode === 'week' && (
            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
              {weekDays.map((dayKey, idx) => {
                const dayEvents = getEventsForDateKey(events, dayKey);
                const isToday = dayKey === todayKey;
                const isSelected = dayKey === selectedDateKey;
                const dayDate = new Date(getKstDayRangeMs(dayKey).startMs);

                return (
                  <div
                    key={dayKey}
                    onClick={() => setSelectedDateKey(dayKey)}
                    className={`p-4 flex flex-col sm:flex-row gap-3 sm:gap-5 transition-colors cursor-pointer ${
                      isSelected ? 'bg-teal-50/35' : 'hover:bg-slate-50/70'
                    }`}
                  >
                    <div className="sm:w-36 shrink-0 flex sm:flex-col items-center sm:items-start justify-between gap-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-bold tabular-nums ${
                            isToday
                              ? 'text-teal-700'
                              : idx === 0
                                ? 'text-red-700'
                                : idx === 6
                                  ? 'text-sky-700'
                                  : 'text-slate-900'
                          }`}
                        >
                          {formatKstShortDate(dayDate, now)}
                        </span>
                        {isToday && (
                          <span className="text-xs font-semibold text-teal-700">
                            오늘
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDateKey(dayKey);
                          openCreateForDate(dayKey);
                        }}
                        className="text-xs font-medium text-teal-700 hover:text-teal-800 cursor-pointer"
                      >
                        + 일정 추가
                      </button>
                    </div>

                    <div className="flex-1 min-w-0 space-y-2">
                      {dayEvents.length === 0 ? (
                        <p className="text-xs text-slate-400 py-1">
                          등록된 일정이 없습니다.
                        </p>
                      ) : (
                        dayEvents.map((ev) => (
                          <EventCardRow
                            key={ev.id}
                            event={ev}
                            onSelect={() => openEditEvent(ev)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {viewMode === 'day' && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    {formatKstDateKeyLabel(selectedDateKey)}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                    일정 {selectedDayEvents.length}건
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openCreateForDate(selectedDateKey)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>이 날짜에 일정 등록</span>
                </button>
              </div>

              {selectedDayEvents.length === 0 ? (
                <div className="py-10 text-center space-y-2">
                  <CalendarIcon
                    className="w-7 h-7 text-slate-300 mx-auto"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-semibold text-slate-800">
                    선택한 날짜에 일정이 없습니다
                  </p>
                  <p className="text-xs text-slate-500">
                    회의, 연수, 상담 등 시간 지정 일정이나 종일 일정을 등록해 보세요.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {selectedDayEvents.map((ev) => (
                    <EventCardRow
                      key={ev.id}
                      event={ev}
                      onSelect={() => openEditEvent(ev)}
                      showDescription
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Selected Date Agenda + Upcoming Events */}
        <aside className="lg:col-span-4 space-y-5">
          {/* Selected Date Agenda */}
          <section
            aria-label="선택한 날짜 일정"
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  {selectedDateKey === todayKey
                    ? '오늘의 일정'
                    : `${formatKstShortDate(new Date(getKstDayRangeMs(selectedDateKey).startMs), now)} 일정`}
                </h2>
                <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                  {selectedDayEvents.length}건
                </p>
              </div>

              <button
                type="button"
                onClick={() => openCreateForDate(selectedDateKey)}
                className="px-2.5 py-1.5 text-xs font-semibold text-teal-800 border border-teal-200 rounded-lg hover:bg-teal-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                + 추가
              </button>
            </div>

            {selectedDayEvents.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                이 날짜에 예정된 일정이 없습니다.
              </p>
            ) : (
              <div className="space-y-2">
                {selectedDayEvents.map((ev) => (
                  <EventCardRow
                    key={ev.id}
                    event={ev}
                    onSelect={() => openEditEvent(ev)}
                    compact
                  />
                ))}
              </div>
            )}
          </section>

          {/* Upcoming Events (Next 7 days, excluding today) */}
          <section
            aria-label="다가오는 일정"
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900">다가오는 일정</h2>
              <span className="text-xs text-slate-500 tabular-nums">
                향후 7일 · {todaySummary.upcoming.length}건
              </span>
            </div>

            {todaySummary.upcoming.length === 0 ? (
              <p className="text-xs text-slate-500 py-1">
                향후 7일 이내 예정된 다른 일정이 없습니다.
              </p>
            ) : (
              <div className="space-y-2">
                {todaySummary.upcoming.slice(0, 6).map((ev) => {
                  const startDate = timestampToDate(ev.startsAt);
                  const endDate = timestampToDate(ev.endsAt);
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => openEditEvent(ev)}
                      className="w-full text-left p-2.5 rounded-lg border border-slate-200 hover:border-teal-300 hover:bg-slate-50/70 transition-colors space-y-1 cursor-pointer"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900 truncate">
                          {ev.title}
                        </span>
                        <span className="text-[11px] font-medium text-teal-800 shrink-0 tabular-nums">
                          {formatEventStartDayLabel(ev, now)}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 tabular-nums">
                        {formatKstShortDate(startDate, now)}
                        <span aria-hidden="true" className="mx-1">
                          ·
                        </span>
                        {formatKstEventTimeRange(startDate, endDate, ev.allDay)}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </aside>
      </div>

      <EventModal
        isOpen={modalOpen}
        event={editingEvent}
        initialDateKey={draftDateKey}
        onClose={() => {
          setModalOpen(false);
          setEditingEvent(null);
        }}
        onOpenTask={(taskId) => {
          setModalOpen(false);
          onOpenTask?.(taskId);
        }}
        onOpenEvent={(eventId) => {
          const found = events.find((item) => item.id === eventId);
          if (found) {
            const startDate = timestampToDate(found.startsAt);
            if (startDate) {
              const parts = getKstDateParts(startDate);
              setSelectedDateKey(parts.dateKey);
              setActiveMonth({ year: parts.year, month: parts.month });
            }
            setEditingEvent(found);
            setModalOpen(true);
          } else {
            setModalOpen(false);
            setEditingEvent(null);
          }
        }}
      />
    </div>
  );
}

interface EventCardRowProps {
  event: CalendarEventRecord;
  onSelect: () => void;
  compact?: boolean;
  showDescription?: boolean;
}

function EventCardRow({
  event,
  onSelect,
  compact = false,
  showDescription = false,
}: EventCardRowProps) {
  const startDate = timestampToDate(event.startsAt);
  const endDate = timestampToDate(event.endsAt);
  const rangeText = formatKstEventTimeRange(startDate, endDate, event.allDay);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border transition-colors cursor-pointer ${
        compact ? 'p-2.5' : 'p-3'
      } ${
        event.allDay
          ? 'border-teal-200 bg-teal-50/40 hover:bg-teal-50'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-900">
          {event.title}
        </span>
        <span
          className={`text-xs font-medium tabular-nums shrink-0 ${
            event.allDay ? 'text-teal-800' : 'text-slate-600'
          }`}
        >
          {rangeText}
        </span>
      </div>

      {(event.location || event.relatedTaskId) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
          {event.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="w-3 h-3 text-slate-400" aria-hidden="true" />
              <span>{event.location}</span>
            </span>
          )}
          {event.relatedTaskId && (
            <span className="inline-flex items-center gap-1 text-teal-700">
              <Link2 className="w-3 h-3" aria-hidden="true" />
              <span>업무 연결됨</span>
            </span>
          )}
        </div>
      )}

      {showDescription && event.description && (
        <p className="mt-1.5 text-xs text-slate-600 whitespace-pre-line line-clamp-3">
          {event.description}
        </p>
      )}
    </button>
  );
}
