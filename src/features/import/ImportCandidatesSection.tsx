import { useMemo } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { ImportCandidate, ImportSourceMode } from '../../lib/importParser';
import {
  ImportCandidateCard,
  type CandidateSaveState,
} from './ImportCandidateCard';
import type { BatchSaveSummary } from './useNoticeImport';

interface ImportCandidatesSectionProps {
  candidates: ImportCandidate[];
  unparsedLines: string[];
  parseError: string | null;
  saveStates: Record<string, CandidateSaveState>;
  isSubmitting: boolean;
  batchSummary: BatchSaveSummary | null;
  analysisMode?: ImportSourceMode | null;
  aiRunning?: boolean;
  aiError?: string | null;
  aiModelUsed?: string | null;
  canFallbackToRule?: boolean;
  onCancelAi?: () => void;
  onFallbackToRule?: () => void;
  onDismissAiError?: () => void;
  onChangeCandidate: (
    id: string,
    updater: (prev: ImportCandidate) => ImportCandidate,
  ) => void;
  onDeleteCandidate: (id: string) => void;
  onSelectAllPending: (selected: boolean) => void;
  onCancelAnalysis: () => void;
  onRegisterSelected: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenEvent: (eventId: string) => void;
  onGoToTasksView?: () => void;
  onGoToCalendarView?: () => void;
}

export function ImportCandidatesSection({
  candidates,
  unparsedLines,
  parseError,
  saveStates,
  isSubmitting,
  batchSummary,
  analysisMode,
  aiRunning = false,
  aiError = null,
  aiModelUsed = null,
  canFallbackToRule = false,
  onCancelAi,
  onFallbackToRule,
  onDismissAiError,
  onChangeCandidate,
  onDeleteCandidate,
  onSelectAllPending,
  onCancelAnalysis,
  onRegisterSelected,
  onOpenTask,
  onOpenEvent,
  onGoToTasksView,
  onGoToCalendarView,
}: ImportCandidatesSectionProps) {
  const taskCandidates = useMemo(
    () => candidates.filter((c) => c.kind === 'task'),
    [candidates],
  );
  const eventCandidates = useMemo(
    () => candidates.filter((c) => c.kind === 'event'),
    [candidates],
  );
  const pendingCandidates = useMemo(
    () => candidates.filter((c) => saveStates[c.id]?.status !== 'saved'),
    [candidates, saveStates],
  );
  const selectedPendingCount = useMemo(
    () => pendingCandidates.filter((c) => c.selected).length,
    [pendingCandidates],
  );
  const confirmationNeededCount = useMemo(
    () =>
      pendingCandidates.filter(
        (c) =>
          c.selected &&
          (c.needsConfirmation || c.confirmationReasons.length > 0),
      ).length,
    [pendingCandidates],
  );

  if (!aiRunning && !aiError && !parseError && candidates.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="내용 분석 결과 검토"
      className="pt-4 border-t border-slate-200 space-y-4"
    >
      {aiRunning && (
        <div
          role="status"
          className="p-3.5 rounded-lg border border-teal-200 bg-teal-50/70 text-xs text-teal-950 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="w-4 h-4 text-teal-700 animate-spin shrink-0" aria-hidden="true" />
            <span>Gemini AI가 학교 쪽지·공지를 분석해 업무와 일정 후보를 정리하는 중입니다...</span>
          </div>
          {onCancelAi && (
            <button
              type="button"
              onClick={onCancelAi}
              className="px-2.5 py-1 text-xs font-semibold bg-white border border-teal-300 text-teal-900 rounded-md hover:bg-teal-100 whitespace-nowrap shrink-0 cursor-pointer"
            >
              요청 취소
            </button>
          )}
        </div>
      )}

      {aiError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2 min-w-0 flex-1">
            <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5">
              <p className="font-semibold text-amber-900">AI 분석을 완료하지 못했습니다</p>
              <p>{aiError}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canFallbackToRule && onFallbackToRule && (
              <button
                type="button"
                onClick={onFallbackToRule}
                className="px-3 py-1.5 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 whitespace-nowrap cursor-pointer"
              >
                대신 기본 분석 실행
              </button>
            )}
            {onDismissAiError && (
              <button
                type="button"
                onClick={onDismissAiError}
                className="px-2.5 py-1.5 text-xs font-medium bg-white border border-amber-300 rounded-md hover:bg-amber-100 whitespace-nowrap cursor-pointer"
              >
                닫기
              </button>
            )}
          </div>
        </div>
      )}

      {parseError && (
        <div
          role="alert"
          className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{parseError}</span>
          </div>
          <button
            type="button"
            onClick={onCancelAnalysis}
            className="px-2.5 py-1 text-xs font-medium bg-white border border-red-200 rounded-md hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            닫기
          </button>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="space-y-4">
          {/* Review Toolbar */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900">
                  분석된 업무·일정 후보 검토 및 선택 등록
                </h3>
                {analysisMode === 'ai' && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                    <Sparkles className="w-3 h-3" aria-hidden="true" />
                    <span>Gemini AI 분석{aiModelUsed ? ` (${aiModelUsed})` : ''}</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 tabular-nums">
                업무 후보 {taskCandidates.length}건 · 일정 후보{' '}
                {eventCandidates.length}건 · 선택됨{' '}
                <strong className="text-teal-800">{selectedPendingCount}건</strong>
                {confirmationNeededCount > 0 && (
                  <span className="text-amber-800 font-semibold">
                    {' '}
                    · 확인 필요 {confirmationNeededCount}건
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onSelectAllPending(true)}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                전체 선택
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onSelectAllPending(false)}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                선택 해제
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={onCancelAnalysis}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>분석 취소</span>
              </button>
              <button
                type="button"
                disabled={isSubmitting || selectedPendingCount === 0}
                onClick={onRegisterSelected}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {isSubmitting
                    ? '등록 중...'
                    : `선택한 ${selectedPendingCount}건 등록하기`}
                </span>
              </button>
            </div>
          </div>

          {/* Batch Result Banner */}
          {batchSummary && (
            <div
              role="status"
              className={`p-3.5 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-3 ${
                batchSummary.failedCount > 0
                  ? 'border-amber-200 bg-amber-50 text-amber-950'
                  : 'border-teal-200 bg-teal-50/70 text-teal-950'
              }`}
            >
              <div className="space-y-0.5 tabular-nums">
                <p className="font-semibold">
                  등록 처리 결과: 업무 {batchSummary.succeededTasks}건, 일정{' '}
                  {batchSummary.succeededEvents}건 저장 완료
                  {batchSummary.failedCount > 0
                    ? ` · ${batchSummary.failedCount}건 저장 실패`
                    : ''}
                </p>
                {batchSummary.failedCount > 0 && (
                  <p>
                    저장 완료된 항목은 중복 등록되지 않도록 잠겼습니다. 실패한 항목만 수정한 뒤 다시 등록해 주세요.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {batchSummary.succeededTasks > 0 && onGoToTasksView && (
                  <button
                    type="button"
                    onClick={onGoToTasksView}
                    className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                  >
                    업무 목록 보기
                  </button>
                )}
                {batchSummary.succeededEvents > 0 && onGoToCalendarView && (
                  <button
                    type="button"
                    onClick={onGoToCalendarView}
                    className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                  >
                    일정 달력 보기
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Task Candidates */}
          {taskCandidates.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h4 className="text-xs font-bold text-slate-900">업무 후보</h4>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {taskCandidates.length}건
                </span>
              </div>
              <div className="space-y-2.5">
                {taskCandidates.map((cand) => (
                  <ImportCandidateCard
                    key={cand.id}
                    candidate={cand}
                    saveState={saveStates[cand.id] ?? { status: 'idle' }}
                    disabled={isSubmitting}
                    onChange={onChangeCandidate}
                    onDelete={onDeleteCandidate}
                    onOpenTask={onOpenTask}
                    onOpenEvent={onOpenEvent}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Event Candidates */}
          {eventCandidates.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h4 className="text-xs font-bold text-slate-900">일정 후보</h4>
                <span className="text-xs font-semibold text-slate-500 tabular-nums">
                  {eventCandidates.length}건
                </span>
              </div>
              <div className="space-y-2.5">
                {eventCandidates.map((cand) => (
                  <ImportCandidateCard
                    key={cand.id}
                    candidate={cand}
                    saveState={saveStates[cand.id] ?? { status: 'idle' }}
                    disabled={isSubmitting}
                    onChange={onChangeCandidate}
                    onDelete={onDeleteCandidate}
                    onOpenTask={onOpenTask}
                    onOpenEvent={onOpenEvent}
                  />
                ))}
              </div>
            </div>
          )}

          {unparsedLines.length > 0 && (
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-600 space-y-1">
              <p className="font-semibold text-slate-800">
                후보로 분류되지 않은 짧은 줄 ({unparsedLines.length}줄)
              </p>
              <p className="whitespace-pre-wrap break-words">
                {unparsedLines.join('\n')}
              </p>
            </div>
          )}

          <p className="text-[11px] text-slate-500">
            원문 텍스트와 첨부 이미지는 자동 저장되지 않으며, 사용자가 선택한 후보만 Firestore에 저장됩니다.
          </p>
        </div>
      )}
    </div>
  );
}
