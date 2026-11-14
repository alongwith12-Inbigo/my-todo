import {
  AlertTriangle,
  ArrowLeftRight,
  Calendar,
  CheckCircle2,
  CheckSquare,
  ExternalLink,
  Trash2,
} from 'lucide-react';
import { type ImportCandidate, type ImportCandidateKind } from '../../lib/importParser';
import { VALIDATION_LIMITS, type TaskPriority } from '../../types/domain';

export interface CandidateSaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  createdId?: string;
  error?: string;
}

interface ImportCandidateCardProps {
  candidate: ImportCandidate;
  saveState: CandidateSaveState;
  disabled: boolean;
  onChange: (id: string, updater: (prev: ImportCandidate) => ImportCandidate) => void;
  onDelete: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenEvent: (eventId: string) => void;
}

export function ImportCandidateCard({
  candidate,
  saveState,
  disabled,
  onChange,
  onDelete,
  onOpenTask,
  onOpenEvent,
}: ImportCandidateCardProps) {
  const isSaved = saveState.status === 'saved';
  const isLocked = disabled || isSaved || saveState.status === 'saving';

  function handleKindChange(nextKind: ImportCandidateKind) {
    if (isLocked || candidate.kind === nextKind) return;
    onChange(candidate.id, (prev) => ({
      ...prev,
      kind: nextKind,
      dueDateStr:
        nextKind === 'task' ? prev.dueDateStr || prev.eventDateStr : prev.dueDateStr,
      eventDateStr:
        nextKind === 'event' ? prev.eventDateStr || prev.dueDateStr : prev.eventDateStr,
      eventEndDateStr:
        nextKind === 'event'
          ? prev.eventEndDateStr || prev.eventDateStr || prev.dueDateStr
          : prev.eventEndDateStr,
      confirmationReasons: prev.confirmationReasons.filter(
        (reason) => !reason.includes('유형'),
      ),
    }));
  }

  function handleAcknowledgeConfirmation() {
    if (isLocked) return;
    onChange(candidate.id, (prev) => ({
      ...prev,
      needsConfirmation: false,
      confirmationReasons: [],
    }));
  }

  return (
    <article
      className={`rounded-xl border p-4 space-y-3.5 transition-colors ${
        isSaved
          ? 'border-teal-200 bg-teal-50/40'
          : saveState.status === 'error'
            ? 'border-red-200 bg-red-50/30'
            : candidate.selected
              ? 'border-slate-200 bg-white'
              : 'border-slate-200 bg-slate-50/70 opacity-80'
      }`}
    >
      {/* Top Row: Selection + Kind + Delete */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={candidate.selected}
              disabled={isLocked}
              onChange={(e) =>
                onChange(candidate.id, (prev) => ({
                  ...prev,
                  selected: e.target.checked,
                }))
              }
              aria-label={`${candidate.title} 등록 선택`}
              className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer disabled:cursor-default"
            />
            <span>{isSaved ? '등록 완료' : '등록 대상'}</span>
          </label>

          <div
            role="group"
            aria-label={`${candidate.title} 유형 선택`}
            className="inline-flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg"
          >
            <button
              type="button"
              disabled={isLocked}
              onClick={() => handleKindChange('task')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-default ${
                candidate.kind === 'task'
                  ? 'bg-white text-teal-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
              <span>업무</span>
            </button>
            <button
              type="button"
              disabled={isLocked}
              onClick={() => handleKindChange('event')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-default ${
                candidate.kind === 'event'
                  ? 'bg-white text-teal-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
              <span>일정</span>
            </button>
          </div>

          {candidate.matchedDateHint && (
            <span className="text-xs text-slate-500">
              원문 날짜·시각: {candidate.matchedDateHint}
            </span>
          )}

          {candidate.origin === 'ai' && (
            <span className="text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
              AI 추출
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isSaved && (
            <button
              type="button"
              disabled={isLocked}
              onClick={() =>
                handleKindChange(candidate.kind === 'task' ? 'event' : 'task')
              }
              title="업무 ↔ 일정 유형 전환"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeftRight className="w-3 h-3" aria-hidden="true" />
              <span>유형 변경</span>
            </button>
          )}

          <button
            type="button"
            disabled={disabled || saveState.status === 'saving'}
            onClick={() => onDelete(candidate.id)}
            aria-label={`${candidate.title} 후보 삭제`}
            title="후보 목록에서 제거"
            className="p-1.5 text-slate-400 hover:text-red-700 rounded-md hover:bg-red-50 disabled:opacity-40 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {candidate.aiRationale && (
        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <strong className="text-slate-800">AI 판단 근거:</strong> {candidate.aiRationale}
        </p>
      )}

      {/* Confirmation & Duplicate Warnings */}
      {!isSaved &&
        (candidate.needsConfirmation ||
          candidate.confirmationReasons.length > 0 ||
          candidate.duplicateWarnings.length > 0) && (
          <div className="space-y-2">
            {(candidate.needsConfirmation ||
              candidate.confirmationReasons.length > 0) && (
              <div
                role="status"
                className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/70 text-xs text-amber-950 flex flex-wrap items-start justify-between gap-2"
              >
                <div className="flex items-start gap-2 min-w-0">
                  <AlertTriangle
                    className="w-4 h-4 text-amber-700 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <div className="space-y-0.5">
                    <p className="font-semibold text-amber-900">확인 필요</p>
                    <ul className="list-disc pl-4 space-y-0.5 text-amber-900">
                      {candidate.confirmationReasons.map((reason, idx) => (
                        <li key={idx}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={handleAcknowledgeConfirmation}
                  className="px-2.5 py-1 text-xs font-semibold bg-white border border-amber-300 text-amber-900 rounded-md hover:bg-amber-100 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  확인 완료
                </button>
              </div>
            )}

            {candidate.duplicateWarnings.length > 0 && (
              <div
                role="status"
                className="p-2.5 rounded-lg border border-slate-300 bg-slate-100/80 text-xs text-slate-800 flex items-start gap-2"
              >
                <AlertTriangle
                  className="w-4 h-4 text-slate-600 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-0.5">
                  <p className="font-semibold text-slate-900">중복 후보 확인</p>
                  {candidate.duplicateWarnings.map((warn, idx) => (
                    <p key={idx}>{warn}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      {/* Editable Fields */}
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label
            htmlFor={`cand-title-${candidate.id}`}
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            {candidate.kind === 'task' ? '업무 제목' : '일정 제목'}
          </label>
          <input
            id={`cand-title-${candidate.id}`}
            type="text"
            disabled={isLocked}
            maxLength={VALIDATION_LIMITS.TITLE_MAX_LEN}
            value={candidate.title}
            onChange={(e) =>
              onChange(candidate.id, (prev) => ({
                ...prev,
                title: e.target.value,
              }))
            }
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
          />
        </div>

        {candidate.kind === 'task' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor={`cand-due-${candidate.id}`}
                  className="text-xs font-medium text-slate-700"
                >
                  마감일 (Asia/Seoul)
                </label>
                {candidate.dueDateStr && !isLocked && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange(candidate.id, (prev) => ({
                        ...prev,
                        dueDateStr: '',
                      }))
                    }
                    className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    해제
                  </button>
                )}
              </div>
              <input
                id={`cand-due-${candidate.id}`}
                type="date"
                disabled={isLocked}
                value={candidate.dueDateStr}
                onChange={(e) =>
                  onChange(candidate.id, (prev) => ({
                    ...prev,
                    dueDateStr: e.target.value,
                  }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor={`cand-priority-${candidate.id}`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                우선순위
              </label>
              <select
                id={`cand-priority-${candidate.id}`}
                disabled={isLocked}
                value={candidate.priority}
                onChange={(e) =>
                  onChange(candidate.id, (prev) => ({
                    ...prev,
                    priority: e.target.value as TaskPriority,
                  }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
              >
                <option value="urgent">긴급</option>
                <option value="high">높음</option>
                <option value="normal">보통</option>
                <option value="low">낮음</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">
                일정 일시 (Asia/Seoul)
              </span>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  disabled={isLocked}
                  checked={candidate.allDay}
                  onChange={(e) =>
                    onChange(candidate.id, (prev) => ({
                      ...prev,
                      allDay: e.target.checked,
                    }))
                  }
                  className="w-3.5 h-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
                />
                <span>종일 일정</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label
                  htmlFor={`cand-ev-start-date-${candidate.id}`}
                  className="block text-xs text-slate-600 mb-1"
                >
                  시작 날짜
                </label>
                <input
                  id={`cand-ev-start-date-${candidate.id}`}
                  type="date"
                  disabled={isLocked}
                  value={candidate.eventDateStr}
                  onChange={(e) =>
                    onChange(candidate.id, (prev) => ({
                      ...prev,
                      eventDateStr: e.target.value,
                      eventEndDateStr:
                        prev.eventEndDateStr < e.target.value
                          ? e.target.value
                          : prev.eventEndDateStr,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
                />
              </div>

              {candidate.allDay ? (
                <div>
                  <label
                    htmlFor={`cand-ev-end-date-${candidate.id}`}
                    className="block text-xs text-slate-600 mb-1"
                  >
                    종료 날짜
                  </label>
                  <input
                    id={`cand-ev-end-date-${candidate.id}`}
                    type="date"
                    disabled={isLocked}
                    value={candidate.eventEndDateStr || candidate.eventDateStr}
                    min={candidate.eventDateStr}
                    onChange={(e) =>
                      onChange(candidate.id, (prev) => ({
                        ...prev,
                        eventEndDateStr: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label
                      htmlFor={`cand-ev-start-time-${candidate.id}`}
                      className="block text-xs text-slate-600 mb-1"
                    >
                      시작 시각
                    </label>
                    <input
                      id={`cand-ev-start-time-${candidate.id}`}
                      type="time"
                      disabled={isLocked}
                      value={candidate.startTimeStr}
                      onChange={(e) =>
                        onChange(candidate.id, (prev) => ({
                          ...prev,
                          startTimeStr: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`cand-ev-end-time-${candidate.id}`}
                      className="block text-xs text-slate-600 mb-1"
                    >
                      종료 시각
                    </label>
                    <input
                      id={`cand-ev-end-time-${candidate.id}`}
                      type="time"
                      disabled={isLocked}
                      value={candidate.endTimeStr}
                      onChange={(e) =>
                        onChange(candidate.id, (prev) => ({
                          ...prev,
                          endTimeStr: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
                    />
                  </div>
                </>
              )}

              <div>
                <label
                  htmlFor={`cand-ev-location-${candidate.id}`}
                  className="block text-xs text-slate-600 mb-1"
                >
                  장소
                </label>
                <input
                  id={`cand-ev-location-${candidate.id}`}
                  type="text"
                  disabled={isLocked}
                  maxLength={VALIDATION_LIMITS.LOCATION_MAX_LEN}
                  value={candidate.location}
                  onChange={(e) =>
                    onChange(candidate.id, (prev) => ({
                      ...prev,
                      location: e.target.value,
                    }))
                  }
                  placeholder="예: 본관 2층 대회의실"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>
          </div>
        )}

        <div>
          <label
            htmlFor={`cand-desc-${candidate.id}`}
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            상세 설명
          </label>
          <textarea
            id={`cand-desc-${candidate.id}`}
            rows={2}
            disabled={isLocked}
            maxLength={VALIDATION_LIMITS.DESCRIPTION_MAX_LEN}
            value={candidate.description}
            onChange={(e) =>
              onChange(candidate.id, (prev) => ({
                ...prev,
                description: e.target.value,
              }))
            }
            className="w-full px-3 py-2 text-xs leading-relaxed border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 focus:outline-none focus:border-teal-700"
          />
        </div>
      </div>

      {/* Save Status Footer */}
      {isSaved && saveState.createdId && (
        <div className="pt-2 border-t border-teal-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-teal-800">
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
            <span>
              {candidate.kind === 'task'
                ? '업무 목록에 저장되었습니다 (중복 등록 잠금)'
                : '일정 달력에 저장되었습니다 (중복 등록 잠금)'}
            </span>
          </span>
          <button
            type="button"
            onClick={() =>
              candidate.kind === 'task'
                ? onOpenTask(saveState.createdId!)
                : onOpenEvent(saveState.createdId!)
            }
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-white border border-teal-300 text-teal-900 rounded-lg hover:bg-teal-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>
              {candidate.kind === 'task' ? '등록된 업무 보기' : '등록된 일정 보기'}
            </span>
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {saveState.status === 'error' && saveState.error && (
        <div
          role="alert"
          className="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
        >
          저장 실패: {saveState.error}
        </div>
      )}
    </article>
  );
}
