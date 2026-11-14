import { useEffect, useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { formatKstDateKeyLabel, isValidDateInputString } from '../../lib/dateKst';
import {
  resolveTimetableForDate,
  SLOT_KIND_LABELS,
} from '../../lib/timetable';
import {
  VALIDATION_LIMITS,
  type TimetableOverrideRecord,
  type TimetableOverrideSlot,
  type TimetableRecord,
  type TimetableSlotKind,
} from '../../types/domain';
import { useTimetableData } from './TimetableDataContext';

interface TimetableOverrideModalProps {
  isOpen: boolean;
  initialDateKey: string;
  timetables: TimetableRecord[];
  existingOverride: TimetableOverrideRecord | null;
  onClose: () => void;
}

const KIND_OPTIONS: TimetableSlotKind[] = [
  'class',
  'free',
  'fixed_duty',
  'other',
];

export function TimetableOverrideModal({
  isOpen,
  initialDateKey,
  timetables,
  existingOverride,
  onClose,
}: TimetableOverrideModalProps) {
  const { saveDateOverride, removeDateOverride, overridesByDate } =
    useTimetableData();

  const [dateKey, setDateKey] = useState(initialDateKey);
  const [reason, setReason] = useState('');
  const [slots, setSlots] = useState<Record<string, TimetableOverrideSlot>>({});
  const [changedPeriods, setChangedPeriods] = useState<Set<number>>(
    () => new Set(),
  );
  const [baseTimetableId, setBaseTimetableId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeOverrideForDate = overridesByDate[dateKey] ?? existingOverride;

  useEffect(() => {
    if (!isOpen) return;
    setDateKey(initialDateKey);
    setConfirmDelete(false);
    setError(null);
  }, [isOpen, initialDateKey]);

  useEffect(() => {
    if (!isOpen || !isValidDateInputString(dateKey)) return;
    const ov = overridesByDate[dateKey] ?? null;
    const resolvedBase = resolveTimetableForDate(dateKey, timetables, null);
    setBaseTimetableId(resolvedBase.timetableId);
    setReason(ov?.reason ?? '');

    const nextSlots: Record<string, TimetableOverrideSlot> = {};
    const changed = new Set<number>();

    const periodCount = Math.max(
      resolvedBase.periods.length,
      Object.keys(ov?.slots ?? {}).length > 0
        ? Math.max(...Object.keys(ov?.slots ?? {}).map(Number))
        : 0,
      7,
    );

    for (let p = 1; p <= Math.min(12, periodCount); p++) {
      const pKey = String(p);
      const ovSlot = ov?.slots?.[pKey];
      const baseSlot = resolvedBase.periods.find((item) => item.period === p);
      if (ovSlot) {
        changed.add(p);
        nextSlots[pKey] = { ...ovSlot };
      } else if (baseSlot) {
        nextSlots[pKey] = {
          period: p,
          kind: baseSlot.kind,
          subject: baseSlot.subject,
          className: baseSlot.className,
          classroom: baseSlot.classroom,
          note: baseSlot.note,
          workAvailable: baseSlot.workAvailable,
        };
      } else {
        nextSlots[pKey] = {
          period: p,
          kind: 'free',
          subject: '',
          className: '',
          classroom: '',
          note: '',
          workAvailable: false,
        };
      }
    }

    setSlots(nextSlots);
    setChangedPeriods(changed);
  }, [isOpen, dateKey, timetables, overridesByDate]);

  if (!isOpen) return null;

  function updateSlot(
    period: number,
    patch: Partial<TimetableOverrideSlot>,
  ) {
    const key = String(period);
    setSlots((prev) => {
      const curr = prev[key];
      if (!curr) return prev;
      const nextKind = patch.kind ?? curr.kind;
      const nextWorkAvailable =
        nextKind === 'class' || nextKind === 'fixed_duty'
          ? false
          : patch.workAvailable !== undefined
            ? patch.workAvailable
            : curr.workAvailable;
      return {
        ...prev,
        [key]: {
          ...curr,
          ...patch,
          kind: nextKind,
          workAvailable: nextWorkAvailable,
        },
      };
    });
    setChangedPeriods((prev) => {
      const next = new Set(prev);
      next.add(period);
      return next;
    });
  }

  function resetSlotChange(period: number) {
    const resolvedBase = resolveTimetableForDate(dateKey, timetables, null);
    const baseSlot = resolvedBase.periods.find((item) => item.period === period);
    setSlots((prev) => ({
      ...prev,
      [String(period)]: baseSlot
        ? {
            period,
            kind: baseSlot.kind,
            subject: baseSlot.subject,
            className: baseSlot.className,
            classroom: baseSlot.classroom,
            note: baseSlot.note,
            workAvailable: baseSlot.workAvailable,
          }
        : {
            period,
            kind: 'free',
            subject: '',
            className: '',
            classroom: '',
            note: '',
            workAvailable: false,
          },
    }));
    setChangedPeriods((prev) => {
      const next = new Set(prev);
      next.delete(period);
      return next;
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidDateInputString(dateKey)) {
      setError('올바른 날짜(YYYY-MM-DD)를 선택해 주세요.');
      return;
    }

    const overrideSlots: Record<string, TimetableOverrideSlot> = {};
    for (const p of changedPeriods) {
      const slot = slots[String(p)];
      if (slot) overrideSlots[String(p)] = slot;
    }

    if (Object.keys(overrideSlots).length === 0 && !reason.trim()) {
      setError('변경할 교시 또는 변경 사유를 1개 이상 입력해 주세요.');
      return;
    }

    setSaving(true);
    try {
      await saveDateOverride(
        {
          dateKey,
          baseTimetableId,
          reason: reason.trim(),
          slots: overrideSlots,
        },
        activeOverrideForDate?.version,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '임시 시간표 변경을 저장하지 못했습니다.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setError(null);
    try {
      await removeDateOverride(dateKey);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '임시 변경을 삭제하지 못했습니다.',
      );
    } finally {
      setSaving(false);
    }
  }

  const orderedPeriods = Object.keys(slots)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="override-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2
              id="override-modal-title"
              className="text-base font-bold text-slate-900"
            >
              특정 날짜 임시 시간표 변경
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              기본 주간 시간표는 유지되며, 선택한 날짜에만 임시 변경이 적용됩니다.
            </p>
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

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="override-date"
                className="block text-xs font-semibold text-slate-700"
              >
                적용 날짜
              </label>
              <input
                id="override-date"
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {isValidDateInputString(dateKey) && (
                <p className="text-[11px] text-slate-500">
                  {formatKstDateKeyLabel(dateKey)}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="override-reason"
                className="block text-xs font-semibold text-slate-700"
              >
                임시 변경 사유
              </label>
              <input
                id="override-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={VALIDATION_LIMITS.TIMETABLE_REASON_MAX_LEN}
                placeholder="예: 보강 수업, 단축 수업, 교외 출장"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-700">
                교시별 임시 변경 ({changedPeriods.size}개 교시 수정됨)
              </p>
              <p className="text-[11px] text-slate-500">
                수정한 교시만 기본 시간표를 대체합니다.
              </p>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {orderedPeriods.map((p) => {
                const slot = slots[String(p)];
                const isModified = changedPeriods.has(p);
                return (
                  <div
                    key={p}
                    className={`p-3 space-y-2 ${
                      isModified ? 'bg-amber-50/40' : 'bg-white'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-900 tabular-nums w-12">
                          {p}교시
                        </span>
                        {isModified && (
                          <span className="text-[11px] font-semibold text-amber-800">
                            임시 변경됨
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={`${p}교시 구분`}
                          value={slot.kind}
                          onChange={(e) =>
                            updateSlot(p, {
                              kind: e.target.value as TimetableSlotKind,
                            })
                          }
                          className="px-2 py-1 text-xs border border-slate-200 rounded-md bg-white"
                        >
                          {KIND_OPTIONS.map((k) => (
                            <option key={k} value={k}>
                              {SLOT_KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>

                        {isModified && (
                          <button
                            type="button"
                            onClick={() => resetSlotChange(p)}
                            className="text-[11px] text-slate-500 hover:text-slate-800 underline cursor-pointer"
                          >
                            원래대로
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="text"
                        value={slot.subject}
                        onChange={(e) =>
                          updateSlot(p, { subject: e.target.value })
                        }
                        placeholder="수업·업무명"
                        className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
                      />
                      <input
                        type="text"
                        value={slot.className}
                        onChange={(e) =>
                          updateSlot(p, { className: e.target.value })
                        }
                        placeholder="학급 (예: 3-2)"
                        className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
                      />
                      <input
                        type="text"
                        value={slot.classroom}
                        onChange={(e) =>
                          updateSlot(p, { classroom: e.target.value })
                        }
                        placeholder="교실 · 장소"
                        className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
                      />
                    </div>

                    {(slot.kind === 'free' || slot.kind === 'other') && (
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={slot.workAvailable}
                          onChange={(e) =>
                            updateSlot(p, { workAvailable: e.target.checked })
                          }
                          className="rounded border-slate-300 text-teal-700"
                        />
                        <span>이 시간 업무 처리 가능</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {confirmDelete && activeOverrideForDate && (
            <div className="p-3 rounded-lg border border-red-200 bg-red-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-red-900">
                <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                <span>
                  {dateKey} 날짜의 임시 변경을 삭제하고 원래 주간 시간표로 되돌릴까요?
                </span>
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
                  disabled={saving}
                  onClick={() => void handleDelete()}
                  className="px-3 py-1 text-xs font-semibold bg-red-700 text-white rounded-md hover:bg-red-800 cursor-pointer"
                >
                  삭제 확인
                </button>
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              {activeOverrideForDate && !confirmDelete && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>임시 변경 삭제</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                닫기
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
              >
                {saving ? '저장 중...' : '이 날짜에 임시 적용'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
