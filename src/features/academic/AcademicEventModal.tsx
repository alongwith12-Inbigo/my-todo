import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  GraduationCap,
  Trash2,
  X,
} from 'lucide-react';
import {
  ACADEMIC_CATEGORY_OPTIONS,
  getKoreanSchoolYearForDateKey,
  suggestTimetableImpactForCategory,
  TIMETABLE_IMPACT_LABELS,
  validateAcademicEventDraft,
  type AcademicEventDraft,
} from '../../lib/academicCalendar';
import { isValidDateInputString } from '../../lib/dateKst';
import {
  VALIDATION_LIMITS,
  type AcademicEventCategory,
  type AcademicEventRecord,
  type AcademicTimetableImpact,
} from '../../types/domain';
import { useAcademicEventData } from './AcademicEventDataContext';

interface AcademicEventModalProps {
  isOpen: boolean;
  event: AcademicEventRecord | null;
  initialDateKey: string;
  initialSchoolYear?: number;
  onClose: () => void;
  onOpenTimetableOverride?: (params: {
    academicEventId?: string;
    dateKey: string;
    reason: string;
  }) => void;
}

export function AcademicEventModal({
  isOpen,
  event,
  initialDateKey,
  initialSchoolYear,
  onClose,
  onOpenTimetableOverride,
}: AcademicEventModalProps) {
  const { createOne, updateOne, removeOne } = useAcademicEventData();
  const isEditing = Boolean(event);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<AcademicEventCategory>('school_event');
  const [startDate, setStartDate] = useState(initialDateKey);
  const [endDate, setEndDate] = useState(initialDateKey);
  const [hasTime, setHasTime] = useState(false);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('12:00');
  const [location, setLocation] = useState('');
  const [schoolYear, setSchoolYear] = useState<number>(
    initialSchoolYear ?? getKoreanSchoolYearForDateKey(initialDateKey),
  );
  const [timetableImpact, setTimetableImpact] =
    useState<AcademicTimetableImpact>('needs_check');
  const [overrideDateKey, setOverrideDateKey] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setConfirmDelete(false);

    if (event) {
      setTitle(event.title);
      setCategory(event.category);
      setStartDate(event.startDate);
      setEndDate(event.endDate);
      setHasTime(Boolean(event.startTime));
      setStartTime(event.startTime ?? '09:00');
      setEndTime(event.endTime ?? '12:00');
      setLocation(event.location);
      setSchoolYear(event.schoolYear);
      setTimetableImpact(event.timetableImpact);
      setOverrideDateKey(event.overrideDateKey);
    } else {
      const safeDate = isValidDateInputString(initialDateKey)
        ? initialDateKey
        : '2026-03-02';
      setTitle('');
      setCategory('school_event');
      setStartDate(safeDate);
      setEndDate(safeDate);
      setHasTime(false);
      setStartTime('09:00');
      setEndTime('12:00');
      setLocation('');
      setSchoolYear(
        initialSchoolYear ?? getKoreanSchoolYearForDateKey(safeDate),
      );
      setTimetableImpact(suggestTimetableImpactForCategory('school_event'));
      setOverrideDateKey(null);
    }
  }, [isOpen, event, initialDateKey, initialSchoolYear]);

  if (!isOpen) return null;

  function buildDraft(): AcademicEventDraft {
    return {
      title: title.trim(),
      category,
      startDate,
      endDate,
      startTime: hasTime ? startTime : null,
      endTime: hasTime && endTime ? endTime : null,
      location: location.trim(),
      schoolYear,
      sourceType: event?.sourceType ?? 'manual',
      sourceLabel: event?.sourceLabel ?? '직접 입력',
      sourceText: event?.sourceText ?? '',
      timetableImpact,
      overrideDateKey:
        timetableImpact === 'override_applied'
          ? overrideDateKey ?? startDate
          : timetableImpact === 'none'
            ? null
            : overrideDateKey,
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const draft = buildDraft();
    const validationErr = validateAcademicEventDraft(draft);
    if (validationErr) {
      setError(validationErr);
      return;
    }

    setSaving(true);
    try {
      if (event) {
        await updateOne(event.id, event.version, draft);
      } else {
        await createOne(draft);
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '학사일정을 저장하지 못했습니다.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!event) return;
    setDeleting(true);
    setError(null);
    try {
      await removeOne(event.id);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '학사일정을 삭제하지 못했습니다.',
      );
    } finally {
      setDeleting(false);
    }
  }

  function handleLaunchOverride() {
    if (!isValidDateInputString(startDate)) {
      setError('임시 시간표 변경을 적용하려면 시작일을 먼저 입력해 주세요.');
      return;
    }
    const targetDate = overrideDateKey ?? startDate;
    onOpenTimetableOverride?.({
      academicEventId: event?.id,
      dateKey: targetDate,
      reason: title.trim() || '학교 학사일정',
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="academic-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl max-h-[90vh] flex flex-col shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GraduationCap className="w-4 h-4 text-indigo-700" aria-hidden="true" />
            <h2
              id="academic-modal-title"
              className="text-base font-bold text-slate-900"
            >
              {isEditing ? '학교 학사일정 수정' : '학교 학사일정 추가'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="acad-title"
              className="block text-xs font-semibold text-slate-700"
            >
              학사일정명
            </label>
            <input
              id="acad-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
              placeholder="예: 1학기 중간고사, 체육대회, 여름방학"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="acad-category"
                className="block text-xs font-semibold text-slate-700"
              >
                일정 유형
              </label>
              <select
                id="acad-category"
                value={category}
                onChange={(e) => {
                  const next = e.target.value as AcademicEventCategory;
                  setCategory(next);
                  if (!isEditing && timetableImpact !== 'override_applied') {
                    setTimetableImpact(suggestTimetableImpactForCategory(next));
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              >
                {ACADEMIC_CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="acad-school-year"
                className="block text-xs font-semibold text-slate-700"
              >
                학년도
              </label>
              <input
                id="acad-school-year"
                type="number"
                min={2000}
                max={2100}
                value={schoolYear}
                onChange={(e) => setSchoolYear(Number(e.target.value) || 2026)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="acad-start-date"
                className="block text-xs font-semibold text-slate-700"
              >
                시작일
              </label>
              <input
                id="acad-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  const next = e.target.value;
                  setStartDate(next);
                  if (next && (!endDate || endDate < next)) {
                    setEndDate(next);
                  }
                  if (isValidDateInputString(next)) {
                    setSchoolYear(getKoreanSchoolYearForDateKey(next));
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="acad-end-date"
                className="block text-xs font-semibold text-slate-700"
              >
                종료일
              </label>
              <input
                id="acad-end-date"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={hasTime}
                onChange={(e) => setHasTime(e.target.checked)}
                className="rounded border-slate-300 text-indigo-700"
              />
              <span>구체적인 시작·종료 시각이 있습니다</span>
            </label>

            {hasTime && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="acad-start-time"
                    className="block text-[11px] text-slate-500"
                  >
                    시작 시각
                  </label>
                  <input
                    id="acad-start-time"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="acad-end-time"
                    className="block text-[11px] text-slate-500"
                  >
                    종료 시각
                  </label>
                  <input
                    id="acad-end-time"
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="acad-location"
              className="block text-xs font-semibold text-slate-700"
            >
              장소 (선택)
            </label>
            <input
              id="acad-location"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={VALIDATION_LIMITS.LOCATION_MAX_LEN}
              placeholder="예: 대강당, 운동장, 각 교실"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="acad-impact"
                className="text-xs font-semibold text-slate-800"
              >
                수업 시간표 영향 설정
              </label>
              {onOpenTimetableOverride && (
                <button
                  type="button"
                  onClick={handleLaunchOverride}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-indigo-800 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <CalendarClock className="w-3 h-3" aria-hidden="true" />
                  <span>이 날짜 시간표 임시 변경 설정</span>
                </button>
              )}
            </div>

            <select
              id="acad-impact"
              value={timetableImpact}
              onChange={(e) =>
                setTimetableImpact(e.target.value as AcademicTimetableImpact)
              }
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
            >
              {(['none', 'needs_check', 'override_applied'] as AcademicTimetableImpact[]).map(
                (val) => (
                  <option key={val} value={val}>
                    {TIMETABLE_IMPACT_LABELS[val]}
                  </option>
                ),
              )}
            </select>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              방학이나 재량휴업일도 교사 근무 여부나 시간표 변경을 자동으로 확정하지 않으며,
              실제 수업 변경이 필요한 날만 &lsquo;시간표 임시 변경&rsquo;으로 안전하게 적용합니다.
            </p>
          </div>

          {event?.sourceLabel && (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 space-y-1">
              <p>
                <span className="font-semibold text-slate-700">등록 출처:</span>{' '}
                {event.sourceLabel}
              </p>
              {event.sourceText && (
                <p className="truncate">
                  <span className="font-semibold text-slate-700">원문 발췌:</span>{' '}
                  {event.sourceText}
                </p>
              )}
            </div>
          )}

          {confirmDelete && event && (
            <div className="p-3 rounded-lg border border-red-200 bg-red-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-red-900">
                <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                <span>이 학교 학사일정을 삭제할까요? (개인 일정·시간표는 유지됩니다)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md cursor-pointer"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                  className="px-3 py-1 text-xs font-semibold bg-red-700 text-white rounded-md hover:bg-red-800 cursor-pointer"
                >
                  {deleting ? '삭제 중...' : '삭제 확인'}
                </button>
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-2">
            <div>
              {isEditing && !confirmDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>삭제</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
              >
                {saving ? '저장 중...' : isEditing ? '수정 저장' : '학사일정 등록'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
