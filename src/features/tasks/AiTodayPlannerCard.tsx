import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  getAvailabilityReasonShortLabel,
  type AvailabilityStatusReason,
  type PlanAdjustmentFilter,
  type ValidatedDayPlan,
} from '../../lib/aiPlanner';
import { AI_LIMITS, type AiPlannerErrorDetail } from '../../lib/aiTypes';
import { PRIORITY_LABEL } from '../../lib/briefing';
import { formatMinutesKorean, type MinuteInterval } from '../../lib/timetable';

interface AiTodayPlannerCardProps {
  visible: boolean;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  errorDetail?: AiPlannerErrorDetail | null;
  activePlannerModel?: string | null;
  plan: ValidatedDayPlan | null;
  hasPersonalKey: boolean;
  aiEnabled: boolean;
  availableIntervals: MinuteInterval[];
  activeFilter: PlanAdjustmentFilter;
  isStaleInputs?: boolean;
  availabilityReason?: AvailabilityStatusReason;
  availabilityReasonDetail?: string;
  onCancel: () => void;
  onClose: () => void;
  onRunAiPlan: (forceRefresh?: boolean, constraintText?: string) => void;
  onRunDeterministicPlan: () => void;
  onOpenSettings?: () => void;
  onOpenTimetable?: () => void;
  onOpenAcademicCalendar?: () => void;
  onOpenTask: (taskId: string) => void;
  onMoveItemOrder: (taskId: string, direction: 'up' | 'down') => void;
  onExcludeItem: (taskId: string) => void;
  onReassignItemSlot: (taskId: string, intervalIndex: number) => void;
  onApplyQuickFilter: (nextFilter: PlanAdjustmentFilter) => void;
  onResetLocalAdjustments: () => void;
}

const TOKEN_NUM_FMT = new Intl.NumberFormat('ko-KR');

export function AiTodayPlannerCard({
  visible,
  loading,
  error,
  errorCode,
  errorDetail,
  activePlannerModel,
  plan,
  hasPersonalKey,
  aiEnabled,
  availableIntervals,
  activeFilter,
  isStaleInputs = false,
  availabilityReason,
  availabilityReasonDetail,
  onCancel,
  onClose,
  onRunAiPlan,
  onRunDeterministicPlan,
  onOpenSettings,
  onOpenTimetable,
  onOpenAcademicCalendar,
  onOpenTask,
  onMoveItemOrder,
  onExcludeItem,
  onReassignItemSlot,
  onApplyQuickFilter,
  onResetLocalAdjustments,
}: AiTodayPlannerCardProps) {
  const [constraintInput, setConstraintInput] = useState('');

  if (!visible && !loading) {
    return null;
  }

  const effectiveAvailabilityReason =
    plan?.availabilityReason ?? availabilityReason;
  const effectiveAvailabilityDetail =
    plan?.availabilityReasonDetail ?? availabilityReasonDetail ?? '';

  function handleConstraintSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = constraintInput.trim();
    if (!trimmed || loading) return;
    onRunAiPlan(true, trimmed);
  }

  const showKeySetupPrompt =
    !loading &&
    !plan &&
    (!aiEnabled ||
      !hasPersonalKey ||
      errorCode === 'personal_key_required' ||
      errorCode === 'ai_disabled_by_user' ||
      errorCode === 'invalid_api_key');

  return (
    <section
      aria-label="AI 오늘의 업무 플래너"
      className="bg-white border border-teal-200 rounded-xl p-5 space-y-4 shadow-xs"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-bold text-slate-900">
            오늘의 업무 실행 계획
          </h2>
          {plan?.mode === 'ai' && plan.model && (
            <span className="text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
              AI 제안 · {plan.model}
            </span>
          )}
          {plan?.mode === 'deterministic' && (
            <span className="text-[11px] font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">
              기본 우선순위 계획 · AI 호출 없음
            </span>
          )}
          {plan?.fromCache && (
            <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
              저장된 계획 재사용 (추가 호출 0회)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {loading ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
            >
              요청 취소
            </button>
          ) : (
            <>
              {hasPersonalKey && aiEnabled && (
                <button
                  type="button"
                  onClick={() => onRunAiPlan(true, constraintInput.trim() || undefined)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" />
                  <span>{plan?.mode === 'ai' ? 'AI 다시 분석' : 'AI로 계획 세우기'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="업무 플래너 닫기"
                className="p-1 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2.5 py-3 text-xs text-slate-700">
          <Loader2
            className="w-4 h-4 text-teal-700 animate-spin shrink-0"
            aria-hidden="true"
          />
          <span>
            오늘 남은 수업 외 가용 시간, 개인 일정, 학사일정, 업무 기한·중요도를 종합하여 실행 순서를 정리하는 중입니다...
            {activePlannerModel ? (
              <span className="ml-1.5 font-mono text-[11px] text-slate-500">
                ({activePlannerModel})
              </span>
            ) : null}
          </span>
        </div>
      )}

      {/* Non-intrusive Personal Key / Setup Prompt + Deterministic Fallback */}
      {showKeySetupPrompt && (
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
          <div className="flex items-start gap-2.5">
            <KeyRound
              className="w-4 h-4 text-teal-700 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1 text-xs text-slate-700 leading-relaxed">
              <p className="font-semibold text-slate-900">
                {!aiEnabled
                  ? '설정에서 AI 스마트 업무비서 사용이 꺼져 있습니다'
                  : !hasPersonalKey || errorCode === 'personal_key_required'
                    ? 'AI 업무 플래너를 사용하려면 본인 Gemini API 키를 등록해 주세요'
                    : '등록된 개인 Gemini API 키를 확인해 주세요'}
              </p>
              <p>
                이 앱은 공용 AI 키를 사용하지 않고 개인별 API 키(BYOK) 방식으로 동작합니다. 설정에서 본인의 Google AI Studio API 키를 등록하거나, 아래 버튼으로 AI 호출 없이 기본 우선순위 계획을 바로 확인할 수 있습니다.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="px-3.5 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 whitespace-nowrap cursor-pointer"
              >
                설정에서 개인 API 키 등록하기
              </button>
            )}
            <button
              type="button"
              onClick={onRunDeterministicPlan}
              className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              기본 우선순위 계획 보기 (AI 호출 없음)
            </button>
          </div>
        </div>
      )}

      {/* General Error (with automatic deterministic fallback) */}
      {error && !loading && !showKeySetupPrompt && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 space-y-2.5"
        >
          <div className="space-y-1.5">
            <p className="font-semibold text-amber-900">
              {plan
                ? 'AI 조언을 불러오지 못해 아래에 기본 우선순위 계획을 먼저 표시했습니다'
                : 'AI 업무 계획을 생성하지 못했습니다'}
            </p>
            <p className="leading-relaxed">{error}</p>
            {(errorDetail || activePlannerModel) && (
              <div className="space-y-1">
                <p className="text-[11px] text-amber-900/90 bg-white/75 border border-amber-200/80 rounded px-2.5 py-1.5 font-mono tabular-nums break-words">
                  모델: {errorDetail?.model ?? activePlannerModel ?? '미확인'}
                  {typeof errorDetail?.upstreamHttpStatus === 'number'
                    ? ` · HTTP ${errorDetail.upstreamHttpStatus}${
                        errorDetail.upstreamApiStatus
                          ? ` (${errorDetail.upstreamApiStatus})`
                          : ''
                      }`
                    : errorDetail?.upstreamApiStatus
                      ? ` · ${errorDetail.upstreamApiStatus}`
                      : ''}
                  {typeof errorDetail?.latencyMs === 'number' ||
                  typeof errorDetail?.timeoutMs === 'number'
                    ? ` · 경과 ${
                        typeof errorDetail?.latencyMs === 'number'
                          ? `${errorDetail.latencyMs}ms`
                          : '-'
                      }${
                        typeof errorDetail?.timeoutMs === 'number'
                          ? ` / 제한 ${errorDetail.timeoutMs}ms`
                          : ''
                      }`
                    : ''}
                  {errorDetail?.timeoutSource
                    ? ` (${errorDetail.timeoutSource === 'local' ? '앱 로컬 제한' : 'Google API 시간 초과'})`
                    : ''}
                  {errorDetail?.streamed
                    ? ` · 스트리밍 청크 ${errorDetail.chunkCount ?? 0}건${
                        typeof errorDetail.firstChunkLatencyMs === 'number'
                          ? ` (첫 응답 ${errorDetail.firstChunkLatencyMs}ms)`
                          : ' (첫 응답 미도착)'
                      }`
                    : ''}
                  {errorDetail?.requestEndpoint
                    ? ` · ${errorDetail.requestApiVersion ? `${errorDetail.requestApiVersion} ` : ''}${errorDetail.requestEndpoint}`
                    : ''}
                </p>
                {errorDetail?.upstreamErrorMessage && (
                  <p className="text-[11px] text-amber-950 bg-white/85 border border-amber-200/80 rounded px-2.5 py-1.5 break-words">
                    <span className="font-semibold">Google API 응답 상세:</span>{' '}
                    <span className="font-mono">{errorDetail.upstreamErrorMessage}</span>
                  </p>
                )}
              </div>
            )}
            {activePlannerModel &&
              errorDetail?.model &&
              activePlannerModel !== errorDetail.model && (
                <p className="text-[11px] font-medium text-teal-900 bg-teal-50 border border-teal-200 rounded px-2.5 py-1.5 leading-relaxed">
                  업무 계획 모델이 <span className="font-mono font-semibold">{activePlannerModel}</span>(으)로 변경되었습니다. 위 <strong>「AI로 계획 세우기」</strong> 버튼을 눌러 새 모델로 다시 실행해 보세요.
                </p>
              )}
            {(errorCode === 'ai_timeout' ||
              errorCode === 'ai_upstream_error' ||
              errorCode === 'ai_empty_response' ||
              errorCode === 'ai_invalid_json' ||
              errorCode === 'ai_response_truncated' ||
              errorCode === 'model_not_found' ||
              errorCode === 'invalid_request_format') && (
              <p className="text-[11px] text-amber-900 leading-relaxed">
                {errorCode === 'ai_upstream_error'
                  ? '현재 모델이 Google 서버 내부 오류(5xx)를 반환했습니다. '
                  : errorCode === 'ai_timeout'
                    ? '현재 모델의 응답이 길어 제한 시간 내에 도착하지 않았습니다. '
                    : '현재 모델에서 정상적인 계획 응답을 받지 못했습니다. '}
                <strong>[설정에서 모델 테스트·전환]</strong>으로 이동해 <strong>「등록된 키 테스트」</strong>를 누른 뒤, 다른 모델
                {errorDetail?.availableGenerateModels &&
                errorDetail.availableGenerateModels.length > 0 ? (
                  <>
                    (확인된 모델:{' '}
                    <span className="font-mono">
                      {errorDetail.availableGenerateModels.slice(0, 3).join(', ')}
                    </span>
                    )
                  </>
                ) : (
                  <>
                    (예: <span className="font-mono">gemini-4-hydrogen</span>,{' '}
                    <span className="font-mono">gemini-3.1-flash-lite</span>,{' '}
                    <span className="font-mono">gemini-2.5-flash</span>)
                  </>
                )}
                을 1회 테스트하고 <strong>「이 모델을 AI 업무 계획에 적용」</strong>하면 서버 재배포 없이 바로 전환할 수 있습니다.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!plan && (
              <button
                type="button"
                onClick={onRunDeterministicPlan}
                className="px-3 py-1.5 text-xs font-semibold bg-white border border-amber-300 text-amber-950 rounded-md hover:bg-amber-100 whitespace-nowrap cursor-pointer"
              >
                기본 우선순위 계획으로 보기 (AI 호출 없음)
              </button>
            )}
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="px-3 py-1.5 text-xs font-semibold text-amber-950 bg-white border border-amber-300 rounded-md hover:bg-amber-100 whitespace-nowrap cursor-pointer"
              >
                설정에서 모델 테스트·전환
              </button>
            )}
          </div>
        </div>
      )}

      {/* Plan Body */}
      {plan && !loading && (
        <div className="space-y-4">
          {/* KPI Strip */}
          <div className="grid grid-cols-3 gap-2.5 tabular-nums">
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70">
              <p className="text-[11px] font-medium text-slate-500">
                오늘 남은 가용 시간
              </p>
              <p className="mt-0.5 text-base font-bold text-slate-900">
                {plan.remainingWorkableMinutes > 0
                  ? formatMinutesKorean(plan.remainingWorkableMinutes)
                  : getAvailabilityReasonShortLabel(effectiveAvailabilityReason)}
              </p>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70">
              <p className="text-[11px] font-medium text-slate-500">
                추천 업무 예상 합계
              </p>
              <p className="mt-0.5 text-base font-bold text-teal-800">
                {formatMinutesKorean(plan.totalPlannedMinutes)}
              </p>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70">
              <p className="text-[11px] font-medium text-slate-500">여유 시간</p>
              <p className="mt-0.5 text-base font-bold text-slate-800">
                {plan.remainingWorkableMinutes > 0
                  ? formatMinutesKorean(plan.remainingSpareMinutes)
                  : '-'}
              </p>
            </div>
          </div>

          {/* Exact reason why no workable slots exist (never fabricating weekend/holiday hours) */}
          {plan.remainingWorkableMinutes === 0 && effectiveAvailabilityDetail && (
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <Clock className="w-3.5 h-3.5 text-slate-500 mt-0.5 shrink-0" aria-hidden="true" />
                <div className="space-y-0.5">
                  <p className="font-semibold text-slate-900">
                    시간대 미배정 사유 · {getAvailabilityReasonShortLabel(effectiveAvailabilityReason)}
                  </p>
                  <p className="leading-relaxed text-slate-600">
                    {effectiveAvailabilityDetail}
                  </p>
                </div>
              </div>
              {onOpenTimetable &&
                (effectiveAvailabilityReason === 'weekend_or_holiday' ||
                  effectiveAvailabilityReason === 'no_timetable' ||
                  effectiveAvailabilityReason === 'no_workable_free_periods') && (
                  <button
                    type="button"
                    onClick={onOpenTimetable}
                    className="px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-white border border-teal-200 rounded-md hover:bg-teal-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {effectiveAvailabilityReason === 'weekend_or_holiday'
                      ? '오늘 임시 변경 등록'
                      : effectiveAvailabilityReason === 'no_timetable'
                        ? '주간 시간표 등록'
                        : '공강 업무시간 설정'}
                  </button>
                )}
            </div>
          )}

          {/* Stale inputs notice (never auto-calls Gemini until user clicks re-analyze) */}
          {isStaleInputs && plan.mode === 'ai' && (
            <div className="p-3 rounded-lg border border-teal-200 bg-teal-50/60 text-xs text-teal-950 flex flex-wrap items-center justify-between gap-2">
              <span>
                계획 생성 이후 업무·일정 또는 시간표가 변경되었습니다. 추가 비용 방지를 위해 자동으로 다시 호출하지 않았습니다.
              </span>
              {hasPersonalKey && aiEnabled && (
                <button
                  type="button"
                  onClick={() => onRunAiPlan(true, constraintInput.trim() || undefined)}
                  className="px-2.5 py-1 text-[11px] font-semibold text-teal-900 bg-white border border-teal-300 rounded-md hover:bg-teal-100 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  변경 사항 반영해 다시 분석
                </button>
              )}
            </div>
          )}

          {/* Academic Calendar / Timetable Unconfirmed Warnings */}
          {plan.academicWarnings.length > 0 && (
            <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/70 text-xs text-amber-950 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle
                    className="w-3.5 h-3.5 text-amber-700 shrink-0"
                    aria-hidden="true"
                  />
                  <span>시간표 · 학사일정 확인 필요</span>
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {onOpenTimetable && (
                    <button
                      type="button"
                      onClick={onOpenTimetable}
                      className="text-[11px] font-semibold text-amber-900 underline underline-offset-2 cursor-pointer"
                    >
                      시간표 임시 변경
                    </button>
                  )}
                  {onOpenAcademicCalendar && (
                    <button
                      type="button"
                      onClick={onOpenAcademicCalendar}
                      className="text-[11px] font-semibold text-amber-900 underline underline-offset-2 cursor-pointer"
                    >
                      학사일정
                    </button>
                  )}
                </div>
              </div>
              <ul className="list-disc pl-4 space-y-0.5">
                {plan.academicWarnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Overload Warning */}
          {plan.overloadWarning && (
            <div className="p-3 rounded-lg border border-red-200 bg-red-50/70 text-xs text-red-900 flex items-start gap-2">
              <AlertTriangle
                className="w-3.5 h-3.5 text-red-700 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>{plan.overloadWarning}</span>
            </div>
          )}

          {/* Core Advice */}
          <p className="text-sm text-slate-800 leading-relaxed bg-teal-50/40 border border-teal-100 rounded-lg p-3.5">
            {plan.coreAdvice}
          </p>

          {/* Zero-AI Quick Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-slate-500 font-medium mr-1">빠른 조정(무료):</span>
              <button
                type="button"
                onClick={() =>
                  onApplyQuickFilter({
                    ...activeFilter,
                    maxTaskMinutes:
                      activeFilter.maxTaskMinutes === 30 ? null : 30,
                  })
                }
                aria-pressed={activeFilter.maxTaskMinutes === 30}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium whitespace-nowrap cursor-pointer ${
                  activeFilter.maxTaskMinutes === 30
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                30분 이내만
              </button>
              <button
                type="button"
                onClick={() =>
                  onApplyQuickFilter({
                    ...activeFilter,
                    maxTotalMinutes:
                      activeFilter.maxTotalMinutes === 120 ? null : 120,
                  })
                }
                aria-pressed={activeFilter.maxTotalMinutes === 120}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium whitespace-nowrap cursor-pointer ${
                  activeFilter.maxTotalMinutes === 120
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                최대 2시간만
              </button>
              {(activeFilter.maxTaskMinutes ||
                activeFilter.maxTotalMinutes ||
                (activeFilter.excludedTaskIds?.length ?? 0) > 0) && (
                <button
                  type="button"
                  onClick={onResetLocalAdjustments}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-xs font-medium whitespace-nowrap cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  <span>조정 초기화</span>
                </button>
              )}
            </div>
          </div>

          {/* Recommendations */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
              <span>오늘 처리 추천 순서 ({plan.recommendations.length}건)</span>
            </h3>

            {plan.recommendations.length === 0 ? (
              <p className="text-xs text-slate-500 p-3 rounded-lg border border-slate-200">
                현재 조건에 맞는 추천 업무가 없습니다. 필터를 초기화하거나 아래 업무 목록을 확인해 주세요.
              </p>
            ) : (
              (() => {
                const indexed = plan.recommendations.map((item, idx) => ({
                  item,
                  idx,
                }));
                const mustGroup = indexed.filter((x) => x.item.tier !== 'optional');
                const optionalGroup = indexed.filter((x) => x.item.tier === 'optional');

                const renderItem = (
                  entry: { item: (typeof plan.recommendations)[number]; idx: number },
                ) => {
                  const { item, idx } = entry;
                  return (
                    <li
                      key={item.taskId}
                      className="p-3.5 rounded-lg border border-slate-200 bg-white space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0 flex-1">
                          <span
                            className={`w-5 h-5 rounded-md text-white text-[11px] font-bold flex items-center justify-center shrink-0 tabular-nums mt-0.5 ${
                              item.tier === 'optional' ? 'bg-slate-600' : 'bg-teal-700'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => onOpenTask(item.taskId)}
                                className="text-sm font-semibold text-slate-900 hover:text-teal-700 text-left inline-flex items-center gap-1 cursor-pointer"
                              >
                                <span>{item.title}</span>
                                <ExternalLink
                                  className="w-3 h-3 text-slate-400 shrink-0"
                                  aria-hidden="true"
                                />
                              </button>
                              <span
                                className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${
                                  item.tier === 'optional'
                                    ? 'border-slate-200 bg-slate-50 text-slate-700'
                                    : 'border-teal-200 bg-teal-50 text-teal-800'
                                }`}
                              >
                                {item.tier === 'optional' ? '여유 시 처리' : '오늘 필수'}
                              </span>
                              {(item.priority === 'urgent' ||
                                item.priority === 'high') && (
                                <span
                                  className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${
                                    item.priority === 'urgent'
                                      ? 'border-red-200 bg-red-50 text-red-700'
                                      : 'border-amber-200 bg-amber-50 text-amber-800'
                                  }`}
                                >
                                  {PRIORITY_LABEL[item.priority]}
                                </span>
                              )}
                              {item.isOverdue && (
                                <span className="text-[11px] font-semibold text-red-700">
                                  기한 초과
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600 tabular-nums">
                              <span className="inline-flex items-center gap-1 font-medium text-teal-800">
                                <Clock className="w-3 h-3" aria-hidden="true" />
                                {item.slotStart && item.slotEnd
                                  ? `${item.slotStart}~${item.slotEnd}`
                                  : '시간대 미배정'}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                약 {formatMinutesKorean(item.estimatedMinutes)}{' '}
                                <span className="text-[11px] text-slate-500">
                                  (
                                  {item.durationSource === 'user'
                                    ? '직접 지정'
                                    : '추정'}
                                  )
                                </span>
                              </span>
                              {item.dueDateKey && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>마감 {item.dueDateKey}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Zero-AI Per-Item Local Controls */}
                        <div className="flex flex-wrap items-center gap-1 shrink-0">
                          {availableIntervals.length > 1 && (
                            <select
                              aria-label={`${item.title} 시간대 변경`}
                              value=""
                              onChange={(e) => {
                                const nextIdx = Number(e.target.value);
                                if (!Number.isNaN(nextIdx)) {
                                  onReassignItemSlot(item.taskId, nextIdx);
                                }
                              }}
                              className="px-2 py-1 text-[11px] border border-slate-200 rounded bg-white text-slate-700 cursor-pointer"
                            >
                              <option value="">시간대 이동</option>
                              {availableIntervals.map((seg, segIdx) => (
                                <option key={segIdx} value={segIdx}>
                                  {seg.startTime}~{seg.endTime} ({seg.minutes}분)
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => onMoveItemOrder(item.taskId, 'up')}
                            aria-label={`${item.title} 순서 위로`}
                            className="p-1 text-slate-600 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === plan.recommendations.length - 1}
                            onClick={() => onMoveItemOrder(item.taskId, 'down')}
                            aria-label={`${item.title} 순서 아래로`}
                            className="p-1 text-slate-600 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onExcludeItem(item.taskId)}
                            title="오늘 계획에서 제외 (실제 업무는 삭제되지 않습니다)"
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                          >
                            <Ban className="w-3 h-3" aria-hidden="true" />
                            <span>오늘 제외</span>
                          </button>
                        </div>
                      </div>

                      <p className="text-xs text-slate-700 leading-relaxed pl-7">
                        {item.reason}
                      </p>
                      {item.strategy && (
                        <p className="text-xs text-teal-900 bg-teal-50/60 border border-teal-100 rounded-md px-2.5 py-1.5 ml-7 leading-relaxed">
                          <span className="font-semibold">실행 전략:</span> {item.strategy}
                        </p>
                      )}
                      {item.validationNote && (
                        <p className="text-[11px] text-amber-800 pl-7">
                          참고: {item.validationNote}
                        </p>
                      )}
                    </li>
                  );
                };

                return (
                  <div className="space-y-3">
                    {mustGroup.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-bold text-teal-900">
                          오늘 반드시 할 업무 ({mustGroup.length}건)
                        </p>
                        <ol className="space-y-2">{mustGroup.map(renderItem)}</ol>
                      </div>
                    )}
                    {optionalGroup.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-bold text-slate-700">
                          시간이 남으면 할 업무 ({optionalGroup.length}건)
                        </p>
                        <ol className="space-y-2">{optionalGroup.map(renderItem)}</ol>
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </div>

          {/* Attention & Deferred Tasks */}
          {(plan.attentionTasks.length > 0 || plan.deferredTasks.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {plan.attentionTasks.length > 0 && (
                <div className="p-3.5 rounded-lg border border-amber-200 bg-amber-50/40 space-y-1.5">
                  <p className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-amber-700"
                      aria-hidden="true"
                    />
                    <span>기한·주의 확인 항목</span>
                  </p>
                  <ul className="space-y-1.5 text-xs text-amber-950">
                    {plan.attentionTasks.map((t) => (
                      <li key={t.taskId}>
                        <button
                          type="button"
                          onClick={() => onOpenTask(t.taskId)}
                          className="font-semibold underline underline-offset-2 hover:text-teal-800 cursor-pointer"
                        >
                          {t.title}
                        </button>
                        <span className="text-amber-900">: {t.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.deferredTasks.length > 0 && (
                <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1.5">
                  <p className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <CalendarClock
                      className="w-3.5 h-3.5 text-slate-600"
                      aria-hidden="true"
                    />
                    <span>다음 일정으로 미룰 수 있는 업무</span>
                  </p>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {plan.deferredTasks.map((t) => (
                      <li key={t.taskId}>
                        <button
                          type="button"
                          onClick={() => onOpenTask(t.taskId)}
                          className="font-semibold text-slate-900 underline underline-offset-2 hover:text-teal-700 cursor-pointer"
                        >
                          {t.title}
                        </button>
                        <span>: {t.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Validation Repairs Notice */}
          {plan.validationRepairs.length > 0 && (
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 text-[11px] text-slate-600 space-y-0.5">
              <p className="font-semibold text-slate-800">시간표 자동 충돌 보정</p>
              {plan.validationRepairs.map((msg, idx) => (
                <p key={idx}>· {msg}</p>
              ))}
            </div>
          )}

          {/* Strategic AI Re-adjust Input (only when user has personal key & AI enabled) */}
          {hasPersonalKey && aiEnabled && (
            <form
              onSubmit={handleConstraintSubmit}
              className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
            >
              <label htmlFor="planner-constraint-input" className="sr-only">
                오늘 업무 계획 재조정 조건 입력
              </label>
              <input
                id="planner-constraint-input"
                type="text"
                maxLength={AI_LIMITS.MAX_ADJUST_CONSTRAINT_CHARS}
                value={constraintInput}
                onChange={(e) => setConstraintInput(e.target.value)}
                placeholder="조건으로 AI 재조정 (예: 오후에는 가벼운 업무만, 공문 제출을 최우선으로)"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
              <button
                type="submit"
                disabled={loading || !constraintInput.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>조건 반영해 AI 재조정</span>
              </button>
            </form>
          )}

          {/* Footer: Privacy + Actual Token Usage */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 pt-1">
            <span>
              AI 제안은 참고용이며 실제 업무·일정·시간표는 자동으로 수정되지 않습니다. (제목·기한·우선순위·예상 소요·가용 시간만 사용)
            </span>
            {plan.usage && (
              <span className="tabular-nums font-medium text-slate-600">
                사용 토큰: 입력 {TOKEN_NUM_FMT.format(plan.usage.inputTokens)} · 출력{' '}
                {TOKEN_NUM_FMT.format(plan.usage.outputTokens)}
                {plan.usage.thoughtTokens > 0
                  ? ` · 사고 ${TOKEN_NUM_FMT.format(plan.usage.thoughtTokens)}`
                  : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
