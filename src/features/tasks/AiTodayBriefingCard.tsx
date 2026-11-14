import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import type { AiBriefingResponse } from '../../lib/aiTypes';

interface AiTodayBriefingCardProps {
  loading: boolean;
  error: string | null;
  data: AiBriefingResponse | null;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
  onOpenTask: (taskId: string) => void;
}

export function AiTodayBriefingCard({
  loading,
  error,
  data,
  onCancel,
  onClose,
  onRetry,
  onOpenTask,
}: AiTodayBriefingCardProps) {
  if (!loading && !error && !data) {
    return null;
  }

  return (
    <section
      aria-label="AI 오늘의 브리핑"
      className="bg-white border border-teal-200 rounded-xl p-5 space-y-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-bold text-slate-900">AI 오늘의 브리핑</h2>
          {data?.model && (
            <span className="text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
              {data.model}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {loading ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
            >
              요청 취소
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onRetry}
                className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 cursor-pointer"
              >
                다시 생성
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="AI 브리핑 닫기"
                className="p-1 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2.5 py-2 text-xs text-slate-700">
          <Loader2 className="w-4 h-4 text-teal-700 animate-spin shrink-0" aria-hidden="true" />
          <span>
            오늘의 미완료 업무와 다가오는 일정을 바탕으로 AI가 우선순위와 주의사항을 정리하는 중입니다...
          </span>
        </div>
      )}

      {error && !loading && (
        <div
          role="alert"
          className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 space-y-1.5"
        >
          <p className="font-semibold text-amber-900">
            AI 브리핑을 생성하지 못했습니다
          </p>
          <p>{error}</p>
          <p className="text-amber-800">
            아래 기본 오늘의 브리핑과 일정 목록은 정상적으로 계속 이용하실 수 있습니다.
          </p>
        </div>
      )}

      {data && !loading && (
        <div className="space-y-4">
          <p className="text-sm text-slate-800 leading-relaxed bg-teal-50/40 border border-teal-100 rounded-lg p-3.5">
            {data.briefing.summary}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Priority Focus */}
            <div className="rounded-lg border border-slate-200 p-3.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                <CheckCircle2 className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <span>오늘 우선 확인 제안</span>
              </div>
              {data.briefing.priorityFocus.length === 0 ? (
                <p className="text-xs text-slate-500">
                  특별히 시급하게 강조할 업무가 없습니다.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.briefing.priorityFocus.map((item, idx) => (
                    <li
                      key={idx}
                      className="text-xs border-b last:border-b-0 border-slate-100 pb-2 last:pb-0 space-y-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">
                          {item.title}
                        </span>
                        {item.linkedTaskId && (
                          <button
                            type="button"
                            onClick={() => onOpenTask(item.linkedTaskId!)}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:text-teal-900 shrink-0 cursor-pointer"
                          >
                            <span>업무 열기</span>
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <p className="text-slate-600 leading-relaxed">{item.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Imminent + Conflict + Missed Checks */}
            <div className="space-y-3">
              {data.briefing.imminentAlerts.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3.5 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-950">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />
                    <span>마감 임박 · 기한 초과 주의</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-amber-950">
                    {data.briefing.imminentAlerts.map((item, idx) => (
                      <li key={idx}>
                        <strong className="font-semibold">{item.title}:</strong>{' '}
                        {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.briefing.conflictAlerts.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                    <CalendarClock className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                    <span>일정·업무 겹침 주의</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {data.briefing.conflictAlerts.map((item, idx) => (
                      <li key={idx}>
                        <strong className="font-semibold text-slate-900">{item.title}:</strong>{' '}
                        {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.briefing.missedChecks.length > 0 && (
                <div className="rounded-lg border border-slate-200 p-3.5 space-y-1.5">
                  <p className="text-xs font-bold text-slate-900">
                    놓치기 쉬운 확인 사항
                  </p>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {data.briefing.missedChecks.map((item, idx) => (
                      <li key={idx}>
                        <strong className="font-semibold text-slate-900">{item.title}:</strong>{' '}
                        {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <p className="text-[11px] text-slate-500">
            현재 로그인한 교사의 최소 요약 필드만 AI에 전송하여 생성한 참고용 브리핑이며, 실제 업무의 우선순위·마감일·일정 데이터는 자동으로 수정되지 않습니다.
          </p>
        </div>
      )}
    </section>
  );
}
