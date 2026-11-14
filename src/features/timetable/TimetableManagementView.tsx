import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock,
  FileUp,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { formatKstDateKeyLabel } from '../../lib/dateKst';
import {
  createDefaultPeriodTimes,
  createDefaultSlot,
  createEmptyTimetableDraft,
  makeSlotKey,
  SLOT_KIND_LABELS,
  TIMETABLE_WEEKDAYS,
  validateTimetableDraft,
  type TimetableDraft,
} from '../../lib/timetable';
import type { TimetableImportPreview } from '../../lib/timetableExcelParser';
import {
  VALIDATION_LIMITS,
  type TimetableOverrideRecord,
  type TimetableRecord,
  type TimetableSlot,
} from '../../types/domain';
import { useTimetableData } from './TimetableDataContext';
import { TimetableImportModal } from './TimetableImportModal';
import { TimetableOverrideModal } from './TimetableOverrideModal';
import { TimetableSlotEditorModal } from './TimetableSlotEditorModal';

interface TimetableManagementViewProps {
  todayKey: string;
}

function recordToDraft(record: TimetableRecord): TimetableDraft {
  return {
    name: record.name,
    semesterLabel: record.semesterLabel,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    workStart: record.workStart,
    workEnd: record.workEnd,
    lunchStart: record.lunchStart,
    lunchEnd: record.lunchEnd,
    periodCount: record.periodCount,
    periodTimes: { ...record.periodTimes },
    slots: { ...record.slots },
    isActive: record.isActive,
    sourceType: record.sourceType,
  };
}

export function TimetableManagementView({
  todayKey,
}: TimetableManagementViewProps) {
  const {
    timetables,
    overrides,
    timetablesLoading,
    timetablesError,
    createNewTimetable,
    saveTimetable,
    removeTimetable,
  } = useTimetableData();

  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<TimetableDraft>(() =>
    createEmptyTimetableDraft(todayKey),
  );
  const [dirty, setDirty] = useState(false);
  const [periodTimesOpen, setPeriodTimesOpen] = useState(false);

  const [editingSlot, setEditingSlot] = useState<TimetableSlot | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideDateKey, setOverrideDateKey] = useState(todayKey);
  const [editingOverride, setEditingOverride] =
    useState<TimetableOverrideRecord | null>(null);

  const [saving, setSaving] = useState(false);
  const [confirmSaveOverwrite, setConfirmSaveOverwrite] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Sync initial selection once timetables load
  useEffect(() => {
    if (selectedId !== null) return;
    if (timetables.length > 0) {
      const active =
        timetables.find((t) => t.isActive) ?? timetables[0];
      setSelectedId(active.id);
      setDraft(recordToDraft(active));
      setDirty(false);
    } else if (!timetablesLoading) {
      setSelectedId('new');
      setDraft(createEmptyTimetableDraft(todayKey));
      setDirty(false);
    }
  }, [selectedId, timetables, timetablesLoading, todayKey]);

  const currentRecord = useMemo(
    () =>
      selectedId && selectedId !== 'new'
        ? timetables.find((t) => t.id === selectedId) ?? null
        : null,
    [selectedId, timetables],
  );

  function handleSelectTimetable(targetId: string | 'new') {
    setFeedback(null);
    setConfirmSaveOverwrite(false);
    setConfirmDelete(false);
    if (targetId === 'new') {
      setSelectedId('new');
      setDraft(createEmptyTimetableDraft(todayKey));
      setDirty(false);
      return;
    }
    const found = timetables.find((t) => t.id === targetId);
    if (found) {
      setSelectedId(found.id);
      setDraft(recordToDraft(found));
      setDirty(false);
    }
  }

  function updateDraft(patch: Partial<TimetableDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
    setConfirmSaveOverwrite(false);
  }

  function handlePeriodCountChange(nextCount: number) {
    const safeCount = Math.max(
      1,
      Math.min(VALIDATION_LIMITS.TIMETABLE_PERIOD_MAX, nextCount),
    );
    setDraft((prev) => {
      const defaults = createDefaultPeriodTimes(safeCount);
      const nextPeriodTimes = { ...prev.periodTimes };
      for (let p = 1; p <= safeCount; p++) {
        if (!nextPeriodTimes[String(p)]) {
          nextPeriodTimes[String(p)] = defaults[String(p)];
        }
      }
      const nextSlots = { ...prev.slots };
      for (const w of TIMETABLE_WEEKDAYS) {
        for (let p = 1; p <= safeCount; p++) {
          const key = makeSlotKey(w.day, p);
          if (!nextSlots[key]) {
            nextSlots[key] = createDefaultSlot(w.day, p);
          }
        }
      }
      return {
        ...prev,
        periodCount: safeCount,
        periodTimes: nextPeriodTimes,
        slots: nextSlots,
      };
    });
    setDirty(true);
  }

  function handleSlotUpdate(updated: TimetableSlot) {
    const key = makeSlotKey(updated.day, updated.period);
    setDraft((prev) => ({
      ...prev,
      slots: {
        ...prev.slots,
        [key]: updated,
      },
    }));
    setDirty(true);
    setConfirmSaveOverwrite(false);
  }

  function handleQuickToggleWorkAvailable(slot: TimetableSlot) {
    if (slot.kind !== 'free' && slot.kind !== 'other') return;
    handleSlotUpdate({
      ...slot,
      workAvailable: !slot.workAvailable,
    });
  }

  function handleApplyImportPreview(
    preview: TimetableImportPreview,
    mode: 'overwrite_current' | 'create_new',
  ) {
    setFeedback(null);
    setConfirmSaveOverwrite(false);
    setConfirmDelete(false);

    if (mode === 'create_new' || !currentRecord) {
      const base = createEmptyTimetableDraft(todayKey);
      setSelectedId('new');
      setDraft({
        ...base,
        periodCount: preview.periodCount,
        periodTimes: preview.periodTimes,
        slots: preview.slots,
        sourceType: preview.sourceType,
      });
    } else {
      setDraft((prev) => ({
        ...prev,
        periodCount: preview.periodCount,
        periodTimes: preview.periodTimes,
        slots: preview.slots,
        sourceType: preview.sourceType,
      }));
    }
    setDirty(true);
    setFeedback({
      type: 'success',
      message:
        '가져온 시간표를 편집기에 반영했습니다. 각 칸을 확인한 뒤 [시간표 저장]을 눌러 확정해 주세요.',
    });
  }

  async function handleSave(skipOverwriteConfirm = false) {
    setFeedback(null);
    const errMsg = validateTimetableDraft(draft);
    if (errMsg) {
      setFeedback({ type: 'error', message: errMsg });
      return;
    }

    if (currentRecord && !skipOverwriteConfirm && !confirmSaveOverwrite) {
      setConfirmSaveOverwrite(true);
      return;
    }

    setSaving(true);
    try {
      if (currentRecord) {
        const updated = await saveTimetable(
          currentRecord.id,
          currentRecord.version,
          draft,
        );
        if (updated) {
          setDraft(recordToDraft(updated));
        }
        setConfirmSaveOverwrite(false);
        setDirty(false);
        setFeedback({
          type: 'success',
          message: '기존 시간표 변경 내용을 저장했습니다.',
        });
      } else {
        const created = await createNewTimetable(draft);
        setSelectedId(created.id);
        setDraft(recordToDraft(created));
        setDirty(false);
        setFeedback({
          type: 'success',
          message: `'${created.name}' 시간표를 새로 저장했습니다.`,
        });
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : '시간표를 저장하는 중 오류가 발생했습니다.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCurrent() {
    if (!currentRecord) return;
    setSaving(true);
    setFeedback(null);
    try {
      const remaining = timetables.filter((t) => t.id !== currentRecord.id);
      await removeTimetable(currentRecord.id);
      setConfirmDelete(false);
      if (remaining.length > 0) {
        setSelectedId(remaining[0].id);
        setDraft(recordToDraft(remaining[0]));
      } else {
        setSelectedId('new');
        setDraft(createEmptyTimetableDraft(todayKey));
      }
      setDirty(false);
      setFeedback({
        type: 'success',
        message: '선택한 시간표를 삭제했습니다.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : '시간표를 삭제하는 중 오류가 발생했습니다.',
      });
    } finally {
      setSaving(false);
    }
  }

  const slotStats = useMemo(() => {
    let classCount = 0;
    let freeCount = 0;
    let freeWorkableCount = 0;
    let fixedCount = 0;
    for (const w of TIMETABLE_WEEKDAYS) {
      for (let p = 1; p <= draft.periodCount; p++) {
        const slot = draft.slots[makeSlotKey(w.day, p)];
        if (!slot || slot.kind === 'free') {
          freeCount += 1;
          if (slot?.workAvailable) freeWorkableCount += 1;
        } else if (slot.kind === 'class') {
          classCount += 1;
        } else {
          fixedCount += 1;
        }
      }
    }
    return { classCount, freeCount, freeWorkableCount, fixedCount };
  }, [draft.periodCount, draft.slots]);

  return (
    <div className="space-y-5">
      {/* Top Control Strip: Saved Semesters + Quick Actions */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="timetable-select"
            className="text-xs font-semibold text-slate-700"
          >
            학기별 시간표:
          </label>
          <select
            id="timetable-select"
            value={selectedId ?? 'new'}
            onChange={(e) => handleSelectTimetable(e.target.value)}
            className="px-3 py-1.5 text-xs font-semibold text-slate-900 border border-slate-200 rounded-lg bg-white"
          >
            {timetables.map((tt) => (
              <option key={tt.id} value={tt.id}>
                {tt.name} ({tt.effectiveFrom} ~ {tt.effectiveTo})
                {tt.isActive ? ' · 사용 중' : ''}
              </option>
            ))}
            <option value="new">+ 새 학기 시간표 만들기</option>
          </select>

          <button
            type="button"
            onClick={() => handleSelectTimetable('new')}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>새 시간표</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 cursor-pointer"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>엑셀 · 이미지 가져오기</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setEditingOverride(null);
              setOverrideDateKey(todayKey);
              setOverrideModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <CalendarClock className="w-3.5 h-3.5 text-slate-500" />
            <span>특정 날짜 임시 변경</span>
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave(false)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>
              {saving
                ? '저장 중...'
                : currentRecord
                  ? '시간표 저장'
                  : '새 시간표로 저장'}
            </span>
          </button>
        </div>
      </div>

      {(timetablesError || feedback) && (
        <div
          role={
            timetablesError || feedback?.type === 'error' ? 'alert' : 'status'
          }
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between gap-3 ${
            timetablesError || feedback?.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          <span>{timetablesError || feedback?.message}</span>
          {dirty && (
            <span className="font-semibold shrink-0">저장 전 변경 사항 있음</span>
          )}
        </div>
      )}

      {confirmSaveOverwrite && currentRecord && (
        <div className="p-4 rounded-xl border border-amber-300 bg-amber-50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-bold">
                저장된 &apos;{currentRecord.name}&apos; 시간표를 수정 내용으로
                덮어쓰시겠습니까?
              </p>
              <p className="text-amber-800">
                확인하면 기존 주간 시간표가 업데이트되며, 날짜별 임시 변경은 그대로
                유지됩니다.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmSaveOverwrite(false)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md cursor-pointer"
            >
              취소
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave(true)}
              className="px-3.5 py-1.5 text-xs font-semibold bg-amber-700 text-white rounded-md hover:bg-amber-800 cursor-pointer"
            >
              덮어쓰고 저장
            </button>
          </div>
        </div>
      )}

      {/* Semester Metadata & Work/Lunch Schedule */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              학기 · 근무시간 기본 설정
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              주간 수업 {slotStats.classCount}시간 · 공강 {slotStats.freeCount}시간
              (업무 가능 지정 {slotStats.freeWorkableCount}시간) · 고정 업무·기타{' '}
              {slotStats.fixedCount}시간
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => updateDraft({ isActive: e.target.checked })}
                className="rounded border-slate-300 text-teal-700"
              />
              <span>현재 적용 시간표로 사용</span>
            </label>

            {currentRecord && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-900 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>삭제</span>
              </button>
            )}
          </div>
        </div>

        {confirmDelete && currentRecord && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-red-900 font-medium">
              &apos;{currentRecord.name}&apos; 시간표를 완전히 삭제하시겠습니까?
            </span>
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
                disabled={saving}
                onClick={() => void handleDeleteCurrent()}
                className="px-3 py-1 text-xs font-semibold bg-red-700 text-white rounded-md hover:bg-red-800 cursor-pointer"
              >
                삭제 확인
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label
              htmlFor="tt-name"
              className="block text-xs font-semibold text-slate-700"
            >
              시간표 이름
            </label>
            <input
              id="tt-name"
              type="text"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              maxLength={VALIDATION_LIMITS.TIMETABLE_NAME_MAX_LEN}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="tt-semester"
              className="block text-xs font-semibold text-slate-700"
            >
              학기 구분
            </label>
            <input
              id="tt-semester"
              type="text"
              value={draft.semesterLabel}
              onChange={(e) => updateDraft({ semesterLabel: e.target.value })}
              maxLength={VALIDATION_LIMITS.TIMETABLE_SEMESTER_MAX_LEN}
              placeholder="예: 2026-2학기"
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="tt-from"
              className="block text-xs font-semibold text-slate-700"
            >
              적용 시작일
            </label>
            <input
              id="tt-from"
              type="date"
              value={draft.effectiveFrom}
              onChange={(e) => updateDraft({ effectiveFrom: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg tabular-nums"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="tt-to"
              className="block text-xs font-semibold text-slate-700"
            >
              적용 종료일
            </label>
            <input
              id="tt-to"
              type="date"
              value={draft.effectiveTo}
              onChange={(e) => updateDraft({ effectiveTo: e.target.value })}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg tabular-nums"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-semibold text-slate-700">
              근무시간
            </label>
            <div className="flex items-center gap-1.5">
              <input
                aria-label="근무 시작 시각"
                type="time"
                value={draft.workStart}
                onChange={(e) => updateDraft({ workStart: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg tabular-nums"
              />
              <span className="text-xs text-slate-400">~</span>
              <input
                aria-label="근무 종료 시각"
                type="time"
                value={draft.workEnd}
                onChange={(e) => updateDraft({ workEnd: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-semibold text-slate-700">
              점심시간
            </label>
            <div className="flex items-center gap-1.5">
              <input
                aria-label="점심 시작 시각"
                type="time"
                value={draft.lunchStart}
                onChange={(e) => updateDraft({ lunchStart: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg tabular-nums"
              />
              <span className="text-xs text-slate-400">~</span>
              <input
                aria-label="점심 종료 시각"
                type="time"
                value={draft.lunchEnd}
                onChange={(e) => updateDraft({ lunchEnd: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="tt-period-count"
              className="block text-xs font-semibold text-slate-700"
            >
              하루 교시 수
            </label>
            <select
              id="tt-period-count"
              value={draft.periodCount}
              onChange={(e) => handlePeriodCountChange(Number(e.target.value))}
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white tabular-nums"
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
                <option key={num} value={num}>
                  {num}교시까지
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="button"
              onClick={() => setPeriodTimesOpen((prev) => !prev)}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              <span>
                {periodTimesOpen ? '교시 시각 설정 접기' : '교시별 시작·종료 시각 설정'}
              </span>
            </button>
          </div>
        </div>

        {periodTimesOpen && (
          <div className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {Array.from({ length: draft.periodCount }, (_, i) => i + 1).map(
              (p) => {
                const pt = draft.periodTimes[String(p)];
                if (!pt) return null;
                return (
                  <div
                    key={p}
                    className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1.5"
                  >
                    <p className="text-xs font-bold text-slate-800">{p}교시</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        aria-label={`${p}교시 시작 시각`}
                        type="time"
                        value={pt.startTime}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          setDraft((prev) => ({
                            ...prev,
                            periodTimes: {
                              ...prev.periodTimes,
                              [String(p)]: {
                                ...prev.periodTimes[String(p)],
                                startTime: nextVal,
                              },
                            },
                          }));
                          setDirty(true);
                        }}
                        className="w-full px-2 py-1 text-xs border border-slate-200 rounded bg-white tabular-nums"
                      />
                      <span className="text-xs text-slate-400">~</span>
                      <input
                        aria-label={`${p}교시 종료 시각`}
                        type="time"
                        value={pt.endTime}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          setDraft((prev) => ({
                            ...prev,
                            periodTimes: {
                              ...prev.periodTimes,
                              [String(p)]: {
                                ...prev.periodTimes[String(p)],
                                endTime: nextVal,
                              },
                            },
                          }));
                          setDirty(true);
                        }}
                        className="w-full px-2 py-1 text-xs border border-slate-200 rounded bg-white tabular-nums"
                      />
                    </div>
                  </div>
                );
              },
            )}
          </div>
        )}
      </section>

      {/* Weekly Mon-Fri Grid */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/60">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              주간 시간표 (월~금)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              각 칸을 누르면 수업명·학급·교실과 공강의 업무 가능 여부를 설정할 수
              있습니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-teal-600 inline-block" />
              수업
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" />
              공강(업무 가능)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-slate-400 inline-block" />
              고정 업무·기타
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[740px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
                <th className="py-2.5 px-3 w-28 border-r border-slate-200">
                  교시 · 시각
                </th>
                {TIMETABLE_WEEKDAYS.map((w) => (
                  <th
                    key={w.day}
                    className="py-2.5 px-3 text-center border-r last:border-r-0 border-slate-200"
                  >
                    {w.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {Array.from({ length: draft.periodCount }, (_, i) => i + 1).map(
                (period) => {
                  const pt = draft.periodTimes[String(period)];
                  return (
                    <tr key={period}>
                      <td className="p-2.5 bg-slate-50/70 border-r border-slate-200 align-top">
                        <p className="font-bold text-slate-900">
                          {pt?.label ?? `${period}교시`}
                        </p>
                        {pt && (
                          <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            {pt.startTime} ~ {pt.endTime}
                          </p>
                        )}
                      </td>

                      {TIMETABLE_WEEKDAYS.map((w) => {
                        const key = makeSlotKey(w.day, period);
                        const slot =
                          draft.slots[key] ?? createDefaultSlot(w.day, period);
                        const isFree = slot.kind === 'free';
                        const isWorkable =
                          (slot.kind === 'free' || slot.kind === 'other') &&
                          slot.workAvailable;

                        return (
                          <td
                            key={key}
                            className="p-1.5 border-r last:border-r-0 border-slate-200 align-top"
                          >
                            <div
                              className={`rounded-lg border p-2 min-h-[72px] flex flex-col justify-between gap-1.5 transition-colors ${
                                slot.kind === 'class'
                                  ? 'border-teal-200 bg-teal-50/45'
                                  : isWorkable
                                    ? 'border-emerald-200 bg-emerald-50/45'
                                    : slot.kind === 'fixed_duty'
                                      ? 'border-slate-300 bg-slate-100/75'
                                      : 'border-slate-200 bg-white'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => setEditingSlot(slot)}
                                className="w-full text-left space-y-0.5 cursor-pointer"
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span
                                    className={`font-semibold truncate ${
                                      isFree && !slot.subject
                                        ? 'text-slate-400'
                                        : 'text-slate-900'
                                    }`}
                                  >
                                    {slot.subject ||
                                      (isFree ? '공강' : SLOT_KIND_LABELS[slot.kind])}
                                  </span>
                                  <span className="text-[10px] font-medium text-slate-500 shrink-0">
                                    {SLOT_KIND_LABELS[slot.kind]}
                                  </span>
                                </div>

                                {(slot.className || slot.classroom) && (
                                  <p className="text-[11px] text-slate-600 truncate">
                                    {[slot.className, slot.classroom]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </p>
                                )}
                              </button>

                              {(slot.kind === 'free' || slot.kind === 'other') && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleQuickToggleWorkAvailable(slot)
                                  }
                                  className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-1 cursor-pointer ${
                                    slot.workAvailable
                                      ? 'text-emerald-800 bg-emerald-100/70 hover:bg-emerald-100'
                                      : 'text-slate-500 bg-slate-100 hover:bg-slate-200/70'
                                  }`}
                                >
                                  {slot.workAvailable && (
                                    <Check className="w-2.5 h-2.5 shrink-0" />
                                  )}
                                  <span>
                                    {slot.workAvailable
                                      ? '업무 가능 지정됨'
                                      : '업무 가능 미지정'}
                                  </span>
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Date-specific Temporary Overrides List */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              날짜별 임시 시간표 변경 ({overrides.length}건)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              보강·단축수업·출장 등으로 특정 날짜만 다르게 운영되는 시간표를
              관리합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingOverride(null);
              setOverrideDateKey(todayKey);
              setOverrideModalOpen(true);
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-teal-800 border border-teal-200 rounded-lg hover:bg-teal-50 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>날짜 임시 변경 추가</span>
          </button>
        </div>

        {overrides.length === 0 ? (
          <p className="text-xs text-slate-500 py-1">
            등록된 임시 시간표 변경이 없습니다.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {overrides.map((ov) => {
              const changedCount = Object.keys(ov.slots ?? {}).length;
              return (
                <button
                  key={ov.id}
                  type="button"
                  onClick={() => {
                    setEditingOverride(ov);
                    setOverrideDateKey(ov.dateKey);
                    setOverrideModalOpen(true);
                  }}
                  className="text-left p-3 rounded-lg border border-amber-200 bg-amber-50/40 hover:bg-amber-50 transition-colors space-y-1 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900 tabular-nums">
                      {formatKstDateKeyLabel(ov.dateKey)}
                    </span>
                    <span className="text-[11px] font-semibold text-amber-900 tabular-nums">
                      {changedCount}개 교시 변경
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 truncate">
                    {ov.reason || '사유 미입력'}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <TimetableSlotEditorModal
        isOpen={Boolean(editingSlot)}
        slot={editingSlot}
        periodLabel={
          editingSlot
            ? draft.periodTimes[String(editingSlot.period)]?.label ??
              `${editingSlot.period}교시`
            : ''
        }
        periodTimeRange={
          editingSlot && draft.periodTimes[String(editingSlot.period)]
            ? `${draft.periodTimes[String(editingSlot.period)].startTime} ~ ${
                draft.periodTimes[String(editingSlot.period)].endTime
              }`
            : ''
        }
        onClose={() => setEditingSlot(null)}
        onSave={handleSlotUpdate}
      />

      <TimetableImportModal
        isOpen={importModalOpen}
        hasExistingTimetable={Boolean(currentRecord)}
        existingTimetableName={currentRecord?.name}
        onClose={() => setImportModalOpen(false)}
        onApplyPreview={handleApplyImportPreview}
      />

      <TimetableOverrideModal
        isOpen={overrideModalOpen}
        initialDateKey={overrideDateKey}
        timetables={timetables}
        existingOverride={editingOverride}
        onClose={() => {
          setOverrideModalOpen(false);
          setEditingOverride(null);
        }}
      />
    </div>
  );
}
