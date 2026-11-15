import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Edit3,
  GraduationCap,
  List,
  LayoutGrid,
  MapPin,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import {
  ACADEMIC_CATEGORY_META,
  ACADEMIC_CATEGORY_OPTIONS,
  formatAcademicDateSpan,
  formatAcademicTimeRange,
  getKoreanSchoolYearForDateKey,
  getSchoolYearAcademicBounds,
  TIMETABLE_IMPACT_SHORT_LABELS,
} from '../../lib/academicCalendar';
import type { AcademicEventCategory, AcademicEventRecord } from '../../types/domain';
import { useTimetableData } from '../timetable/TimetableDataContext';
import { useAcademicEventData } from './AcademicEventDataContext';
import { AcademicEventModal } from './AcademicEventModal';
import { AcademicImportModal } from './AcademicImportModal';

interface AcademicCalendarViewProps {
  todayKey: string;
  onRequestTimetableOverride: (params: {
    academicEventId?: string;
    dateKey: string;
    reason: string;
  }) => void;
}

type AcademicDisplayMode = 'list' | 'monthly';

export function AcademicCalendarView({
  todayKey,
  onRequestTimetableOverride,
}: AcademicCalendarViewProps) {
  const {
    academicEvents,
    academicLoading,
    academicError,
    ensureSchoolYearLoaded,
    refreshSchoolYear,
  } = useAcademicEventData();
  const { overridesByDate } = useTimetableData();

  const [schoolYear, setSchoolYear] = useState<number>(() =>
    getKoreanSchoolYearForDateKey(todayKey),
  );
  const [displayMode, setDisplayMode] = useState<AcademicDisplayMode>('list');
  const [categoryFilter, setCategoryFilter] = useState<
    AcademicEventCategory | 'all'
  >('all');

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<AcademicEventRecord | null>(
    null,
  );
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(
    null,
  );

  useEffect(() => {
    void ensureSchoolYearLoaded(schoolYear);
  }, [schoolYear, ensureSchoolYearLoaded]);

  const schoolYearEvents = useMemo(() => {
    const bounds = getSchoolYearAcademicBounds(schoolYear);
    return academicEvents.filter(
      (ev) =>
        ev.schoolYear === schoolYear ||
        (ev.endDate >= bounds.fromKey && ev.startDate <= bounds.toKey),
    );
  }, [academicEvents, schoolYear]);

  const filteredEvents = useMemo(() => {
    if (categoryFilter === 'all') return schoolYearEvents;
    return schoolYearEvents.filter((ev) => ev.category === categoryFilter);
  }, [schoolYearEvents, categoryFilter]);

  const summaryCounts = useMemo(() => {
    let examCount = 0;
    let checkNeededCount = 0;
    let overrideAppliedCount = 0;

    for (const ev of schoolYearEvents) {
      if (ev.category === 'exam') examCount += 1;
      const targetDate = ev.overrideDateKey ?? ev.startDate;
      if (
        ev.timetableImpact === 'override_applied' ||
        Boolean(overridesByDate[targetDate])
      ) {
        overrideAppliedCount += 1;
      } else if (ev.timetableImpact === 'needs_check') {
        checkNeededCount += 1;
      }
    }

    return {
      total: schoolYearEvents.length,
      examCount,
      checkNeededCount,
      overrideAppliedCount,
    };
  }, [schoolYearEvents, overridesByDate]);

  // Order months from March of schoolYear .. Feb of schoolYear + 1
  const orderedSchoolMonths = useMemo(() => {
    const months: { year: number; month: number; ymKey: string; label: string }[] =
      [];
    for (let m = 3; m <= 12; m++) {
      months.push({
        year: schoolYear,
        month: m,
        ymKey: `${schoolYear}-${String(m).padStart(2, '0')}`,
        label: `${schoolYear}년 ${m}월`,
      });
    }
    for (let m = 1; m <= 2; m++) {
      const nextY = schoolYear + 1;
      months.push({
        year: nextY,
        month: m,
        ymKey: `${nextY}-${String(m).padStart(2, '0')}`,
        label: `${nextY}년 ${m}월`,
      });
    }
    return months;
  }, [schoolYear]);

  const eventsByMonth = useMemo(() => {
    const map = new Map<string, AcademicEventRecord[]>();
    for (const m of orderedSchoolMonths) {
      map.set(m.ymKey, []);
    }
    for (const ev of filteredEvents) {
      const ym = ev.startDate.slice(0, 7);
      const bucket = map.get(ym);
      if (bucket) {
        bucket.push(ev);
      }
    }
    return map;
  }, [filteredEvents, orderedSchoolMonths]);

  return (
    <div className="space-y-5">
      {/* Control Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="이전 학년도"
            onClick={() => setSchoolYear((y) => Math.max(2020, y - 1))}
            className="p-2 text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="px-2 text-center min-w-[165px]">
            <p className="text-sm font-bold text-slate-900 tabular-nums">
              {schoolYear}학년도 학사일정
            </p>
            <p className="text-[11px] text-slate-500 tabular-nums">
              {schoolYear}.03 ~ {schoolYear + 1}.02
            </p>
          </div>

          <button
            type="button"
            aria-label="다음 학년도"
            onClick={() => setSchoolYear((y) => Math.min(2099, y + 1))}
            className="p-2 text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="학사일정 보기 형식"
            className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            <button
              type="button"
              role="tab"
              aria-selected={displayMode === 'list'}
              onClick={() => setDisplayMode('list')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                displayMode === 'list'
                  ? 'bg-white text-indigo-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" aria-hidden="true" />
              <span>목록 보기</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={displayMode === 'monthly'}
              onClick={() => setDisplayMode('monthly')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                displayMode === 'monthly'
                  ? 'bg-white text-indigo-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
              <span>월별 보기</span>
            </button>
          </div>

          <button
            type="button"
            disabled={academicLoading}
            onClick={() => void refreshSchoolYear(schoolYear)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${academicLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>새로고침</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setImportSuccessMessage(null);
              setImportModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>학사일정 파일 업로드</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setEditingEvent(null);
              setEditModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>직접 추가</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <p className="text-xs text-slate-500">전체 학사일정</p>
          <p className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
            {summaryCounts.total}건
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <p className="text-xs text-slate-500">시험 · 평가</p>
          <p className="mt-1 text-xl font-bold text-rose-800 tabular-nums">
            {summaryCounts.examCount}건
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <p className="text-xs text-slate-500">시간표 확인 필요</p>
          <p className="mt-1 text-xl font-bold text-amber-800 tabular-nums">
            {summaryCounts.checkNeededCount}건
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <p className="text-xs text-slate-500">시간표 임시 변경 적용</p>
          <p className="mt-1 text-xl font-bold text-teal-800 tabular-nums">
            {summaryCounts.overrideAppliedCount}건
          </p>
        </div>
      </div>

      {academicError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex items-center justify-between gap-2"
        >
          <span>{academicError}</span>
          <button
            type="button"
            onClick={() => void refreshSchoolYear(schoolYear)}
            className="px-2.5 py-1 text-xs font-semibold bg-white border border-red-200 rounded cursor-pointer"
          >
            다시 시도
          </button>
        </div>
      )}

      {importSuccessMessage && (
        <div className="p-3.5 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900 flex items-center justify-between gap-2">
          <span>{importSuccessMessage}</span>
          <button
            type="button"
            onClick={() => setImportSuccessMessage(null)}
            className="text-xs font-semibold underline cursor-pointer"
          >
            닫기
          </button>
        </div>
      )}

      {/* Category Filter Bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCategoryFilter('all')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
            categoryFilter === 'all'
              ? 'bg-indigo-700 text-white border-indigo-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          전체 ({schoolYearEvents.length})
        </button>

        {ACADEMIC_CATEGORY_OPTIONS.map((opt) => {
          const count = schoolYearEvents.filter(
            (ev) => ev.category === opt.value,
          ).length;
          const active = categoryFilter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setCategoryFilter(opt.value)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer tabular-nums ${
                active
                  ? 'bg-indigo-700 text-white border-indigo-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {opt.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Main Academic Schedule Content */}
      {filteredEvents.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 px-6 text-center space-y-3">
          <GraduationCap
            className="w-8 h-8 text-indigo-300 mx-auto"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-bold text-slate-900">
              {schoolYear}학년도에 등록된 학교 학사일정이 없습니다
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              학교에서 받은 연간·월간 학사일정 파일(PDF, 엑셀, 한글 HWPX, 이미지)을 업로드하거나 직접 일정을 추가해 보세요. 등록한 학사일정은 개인 일정과 분리되어 달력에 함께 표시됩니다.
            </p>
          </div>
          <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>학사일정 파일 업로드</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingEvent(null);
                setEditModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>직접 추가</span>
            </button>
          </div>
        </div>
      ) : displayMode === 'list' ? (
        <div className="space-y-4">
          {orderedSchoolMonths.map((m) => {
            const items = eventsByMonth.get(m.ymKey) ?? [];
            if (items.length === 0) return null;
            return (
              <section
                key={m.ymKey}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-800 tabular-nums">
                    {m.label}
                  </h3>
                  <span className="text-[11px] font-medium text-slate-500 tabular-nums">
                    {items.length}건
                  </span>
                </div>

                <div className="divide-y divide-slate-100">
                  {items.map((ev) => {
                    const meta = ACADEMIC_CATEGORY_META[ev.category];
                    const targetDateKey = ev.overrideDateKey ?? ev.startDate;
                    const hasOverride =
                      ev.timetableImpact === 'override_applied' ||
                      Boolean(overridesByDate[targetDateKey]);

                    return (
                      <div
                        key={ev.id}
                        className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/70"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-slate-700 tabular-nums">
                              {formatAcademicDateSpan(ev.startDate, ev.endDate)}
                            </span>
                            {ev.startTime && (
                              <span className="text-[11px] text-slate-500 tabular-nums">
                                {formatAcademicTimeRange(
                                  ev.startTime,
                                  ev.endTime,
                                )}
                              </span>
                            )}
                            <span
                              className={`px-2 py-0.5 text-[11px] font-semibold rounded border ${meta.badgeClass}`}
                            >
                              {meta.label}
                            </span>

                            {hasOverride ? (
                              <span className="px-2 py-0.5 text-[11px] font-semibold rounded border bg-teal-50 text-teal-800 border-teal-200">
                                {TIMETABLE_IMPACT_SHORT_LABELS.override_applied}
                              </span>
                            ) : ev.timetableImpact === 'needs_check' ? (
                              <span className="px-2 py-0.5 text-[11px] font-semibold rounded border bg-amber-50 text-amber-900 border-amber-200">
                                시간표 확인 필요
                              </span>
                            ) : null}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-900">
                              {ev.title}
                            </p>
                            {ev.location && (
                              <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                                <MapPin className="w-3 h-3 text-slate-400" />
                                <span>{ev.location}</span>
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              onRequestTimetableOverride({
                                academicEventId: ev.id,
                                dateKey: targetDateKey,
                                reason: ev.title,
                              })
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            <CalendarClock className="w-3 h-3" />
                            <span>
                              {hasOverride
                                ? '임시 시간표 보기'
                                : '시간표 임시 변경'}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setEditingEvent(ev);
                              setEditModalOpen(true);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-800 bg-indigo-50/70 border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>수정</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        /* Monthly 12-Month Overview Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {orderedSchoolMonths.map((m) => {
            const items = eventsByMonth.get(m.ymKey) ?? [];
            return (
              <section
                key={m.ymKey}
                className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden"
              >
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-900 tabular-nums">
                    {m.label}
                  </h3>
                  <span className="text-[11px] text-slate-500 tabular-nums">
                    {items.length}건
                  </span>
                </div>

                <div className="p-3 flex-1 space-y-2">
                  {items.length === 0 ? (
                    <p className="text-xs text-slate-400 py-4 text-center">
                      일정 없음
                    </p>
                  ) : (
                    items.map((ev) => {
                      const meta = ACADEMIC_CATEGORY_META[ev.category];
                      const targetDate = ev.overrideDateKey ?? ev.startDate;
                      const hasOverride =
                        ev.timetableImpact === 'override_applied' ||
                        Boolean(overridesByDate[targetDate]);
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => {
                            setEditingEvent(ev);
                            setEditModalOpen(true);
                          }}
                          className="w-full text-left p-2 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors space-y-1 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-slate-600 tabular-nums">
                              {ev.startDate.slice(5)}
                              {ev.endDate !== ev.startDate
                                ? `~${ev.endDate.slice(5)}`
                                : ''}
                            </span>
                            <div className="flex items-center gap-1">
                              {hasOverride && (
                                <span className="text-[10px] font-semibold text-teal-800">
                                  임시변경
                                </span>
                              )}
                              <span
                                className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${meta.badgeClass}`}
                              >
                                {meta.shortLabel}
                              </span>
                            </div>
                          </div>
                          <p className="text-xs font-semibold text-slate-900 truncate">
                            {ev.title}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <AcademicEventModal
        isOpen={editModalOpen}
        event={editingEvent}
        initialDateKey={todayKey}
        initialSchoolYear={schoolYear}
        onClose={() => {
          setEditModalOpen(false);
          setEditingEvent(null);
        }}
        onOpenTimetableOverride={(params) => {
          setEditModalOpen(false);
          setEditingEvent(null);
          onRequestTimetableOverride(params);
        }}
      />

      <AcademicImportModal
        isOpen={importModalOpen}
        defaultSchoolYear={schoolYear}
        existingEvents={schoolYearEvents}
        onClose={(importedCount) => {
          setImportModalOpen(false);
          if (importedCount && importedCount > 0) {
            setImportSuccessMessage(
              `학사일정 ${importedCount}건을 저장했습니다. 달력과 시간표 관리에서 바로 확인할 수 있습니다.`,
            );
          }
        }}
      />
    </div>
  );
}
