import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SLOT_KIND_LABELS, TIMETABLE_WEEKDAYS } from '../../lib/timetable';
import {
  VALIDATION_LIMITS,
  type TimetableSlot,
  type TimetableSlotKind,
} from '../../types/domain';

interface TimetableSlotEditorModalProps {
  isOpen: boolean;
  slot: TimetableSlot | null;
  periodLabel: string;
  periodTimeRange: string;
  onClose: () => void;
  onSave: (updated: TimetableSlot) => void;
}

const KIND_OPTIONS: TimetableSlotKind[] = [
  'class',
  'free',
  'fixed_duty',
  'other',
];

export function TimetableSlotEditorModal({
  isOpen,
  slot,
  periodLabel,
  periodTimeRange,
  onClose,
  onSave,
}: TimetableSlotEditorModalProps) {
  const [kind, setKind] = useState<TimetableSlotKind>('class');
  const [subject, setSubject] = useState('');
  const [className, setClassName] = useState('');
  const [classroom, setClassroom] = useState('');
  const [note, setNote] = useState('');
  const [workAvailable, setWorkAvailable] = useState(false);

  useEffect(() => {
    if (!isOpen || !slot) return;
    setKind(slot.kind);
    setSubject(slot.subject);
    setClassName(slot.className);
    setClassroom(slot.classroom);
    setNote(slot.note);
    setWorkAvailable(slot.workAvailable);
  }, [isOpen, slot]);

  if (!isOpen || !slot) return null;

  const weekdayLabel =
    TIMETABLE_WEEKDAYS.find((w) => w.day === slot.day)?.label ?? '';

  function handleKindChange(nextKind: TimetableSlotKind) {
    setKind(nextKind);
    if (nextKind === 'class' || nextKind === 'fixed_duty') {
      setWorkAvailable(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slot) return;
    onSave({
      day: slot.day,
      period: slot.period,
      kind,
      subject: subject.trim().slice(0, VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN),
      className: className.trim().slice(0, VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN),
      classroom: classroom.trim().slice(0, VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN),
      note: note.trim().slice(0, VALIDATION_LIMITS.TIMETABLE_NOTE_MAX_LEN),
      workAvailable:
        kind === 'class' || kind === 'fixed_duty' ? false : workAvailable,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="slot-editor-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2 id="slot-editor-title" className="text-base font-bold text-slate-900">
              {weekdayLabel} {periodLabel} 편집
            </h2>
            <p className="text-xs text-slate-500 tabular-nums mt-0.5">
              {periodTimeRange}
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

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700">
              구분
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {KIND_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleKindChange(option)}
                  className={`px-2.5 py-2 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                    kind === option
                      ? 'bg-teal-700 text-white border-teal-700'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {SLOT_KIND_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="slot-subject"
              className="block text-xs font-semibold text-slate-700"
            >
              {kind === 'class'
                ? '수업명'
                : kind === 'free'
                  ? '표시 이름 (선택)'
                  : '일정 · 업무명'}
            </label>
            <input
              id="slot-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={VALIDATION_LIMITS.TIMETABLE_SUBJECT_MAX_LEN}
              placeholder={
                kind === 'class'
                  ? '예: 국어, 수학, 통합사회'
                  : kind === 'free'
                    ? '비워두면 공강으로 표시'
                    : '예: 동아리 지도, 학년 협의'
              }
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="slot-class"
                className="block text-xs font-semibold text-slate-700"
              >
                학급
              </label>
              <input
                id="slot-class"
                type="text"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                maxLength={VALIDATION_LIMITS.TIMETABLE_CLASS_MAX_LEN}
                placeholder="예: 3-2, 2학년 4반"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="slot-room"
                className="block text-xs font-semibold text-slate-700"
              >
                교실 · 장소
              </label>
              <input
                id="slot-room"
                type="text"
                value={classroom}
                onChange={(e) => setClassroom(e.target.value)}
                maxLength={VALIDATION_LIMITS.TIMETABLE_ROOM_MAX_LEN}
                placeholder="예: 본관 302호, 과학실"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          {(kind === 'free' || kind === 'other') && (
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={workAvailable}
                  onChange={(e) => setWorkAvailable(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <span className="text-xs font-semibold text-slate-800">
                  이 시간을 업무 처리 가능 시간으로 포함
                </span>
              </label>
              <p className="text-[11px] text-slate-500 pl-6 leading-relaxed">
                공강은 자동으로 업무 가능 시간으로 확정되지 않습니다. 직접 체크한 시간만
                일정 가용 시간 계산에 포함됩니다.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="slot-note"
              className="block text-xs font-semibold text-slate-700"
            >
              메모 (선택)
            </label>
            <input
              id="slot-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={VALIDATION_LIMITS.TIMETABLE_NOTE_MAX_LEN}
              placeholder="준비물이나 특이사항"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="pt-2 flex items-center justify-between gap-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => {
                setKind('free');
                setSubject('');
                setClassName('');
                setClassroom('');
                setNote('');
                setWorkAvailable(false);
              }}
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              공강으로 비우기
            </button>

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
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 cursor-pointer"
              >
                적용
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
