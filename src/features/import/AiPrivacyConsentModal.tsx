import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { PrivacyInspectionResult } from '../../lib/privacyGuard';

interface AiPrivacyConsentModalProps {
  isOpen: boolean;
  inspection: PrivacyInspectionResult | null;
  onCancel: () => void;
  onFallbackToRule: () => void;
  onConfirmSend: (applyMasking: boolean) => void;
}

export function AiPrivacyConsentModal({
  isOpen,
  inspection,
  onCancel,
  onFallbackToRule,
  onConfirmSend,
}: AiPrivacyConsentModalProps) {
  const [applyMasking, setApplyMasking] = useState(true);

  useEffect(() => {
    if (isOpen && inspection) {
      setApplyMasking(inspection.hasPii);
    }
  }, [isOpen, inspection]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || !inspection) return null;

  const payloadPreview = applyMasking
    ? inspection.maskedText
    : inspection.originalText;
  const blockedUnmaskedHighRisk = inspection.hasHighRisk && !applyMasking;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-privacy-modal-title"
        className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden my-auto"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
            <h2
              id="ai-privacy-modal-title"
              className="text-base font-bold text-slate-900"
            >
              AI 분석 전 개인정보 확인 및 전송 동의
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="전송 확인 창 닫기"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Risk / PII Status Banner */}
          {inspection.hasHighRisk ? (
            <div
              role="alert"
              className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-900 space-y-1.5"
            >
              <div className="flex items-center gap-2 font-bold">
                <ShieldAlert className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />
                <span>고위험 민감정보가 감지되었습니다</span>
              </div>
              <p className="leading-relaxed">
                주민등록번호·카드번호·계좌번호 등 고위험 정보가 포함되어 있어{' '}
                <strong>가림 처리 없이는 외부 AI로 전송할 수 없습니다.</strong>{' '}
                아래 자동 가림을 유지하거나 취소 후 원문에서 해당 숫자를 직접 지우고 이용해 주세요.
              </p>
            </div>
          ) : inspection.hasPii ? (
            <div
              role="status"
              className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 space-y-1.5"
            >
              <div className="flex items-center gap-2 font-bold">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                <span>이름·연락처 등 개인정보 포함 가능성이 감지되었습니다</span>
              </div>
              <p className="leading-relaxed">
                전송 전 가림 처리를 적용하는 것을 권장합니다.
              </p>
            </div>
          ) : (
            <div className="p-3.5 rounded-lg border border-teal-200 bg-teal-50/70 text-xs text-teal-950 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
              <span>
                명백한 전화번호·이메일·고유식별번호 패턴은 감지되지 않았습니다. 전송될 내용을 확인한 뒤 진행해 주세요.
              </span>
            </div>
          )}

          {/* Findings List */}
          {inspection.findings.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              <p className="text-xs font-bold text-slate-900">감지된 항목</p>
              <ul className="space-y-1 text-xs text-slate-700">
                {inspection.findings.map((finding) => (
                  <li
                    key={finding.category}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          finding.severity === 'high' ? 'bg-red-600' : 'bg-amber-600'
                        }`}
                        aria-hidden="true"
                      />
                      <span>{finding.label}</span>
                    </span>
                    <span className="font-semibold tabular-nums text-slate-900">
                      {finding.count}건
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Masking Toggle */}
          {inspection.hasPii && (
            <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 bg-white cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyMasking}
                onChange={(e) => setApplyMasking(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
              />
              <span className="text-xs text-slate-800 leading-relaxed">
                <strong className="font-semibold">개인정보 자동 가림 적용 후 전송 (권장)</strong>
                <br />
                <span className="text-slate-500">
                  자동 가림은 규칙 기반 보조 기능이며 모든 개인정보를 100% 가려주지는 못합니다. 아래 실제 전송 본문을 꼭 눈으로 확인해 주세요.
                </span>
              </span>
            </label>
          )}

          {/* Exact External Payload Preview */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-900">
                외부 AI 서버로 실제 전송될 내용
              </span>
              <span className="text-slate-500 tabular-nums">
                {payloadPreview.length.toLocaleString()}자
              </span>
            </div>
            <pre className="p-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-800 whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-sans leading-relaxed">
              {payloadPreview}
            </pre>
          </div>

          {blockedUnmaskedHighRisk && (
            <p className="text-xs font-semibold text-red-700">
              고위험 민감정보가 가려지지 않아 전송이 차단되었습니다. 위 &ldquo;개인정보 자동 가림 적용&rdquo;을 켜거나 취소 후 기본 분석을 이용해 주세요.
            </p>
          )}

          <p className="text-[11px] text-slate-500 leading-relaxed">
            확인 시 위 텍스트만 서버를 통해 Google Gemini API로 전송되며 서버나 DB에 원문을 저장하지 않습니다. AI 분석 결과는 자동 저장되지 않고 사용자가 검토·수정한 후보만 등록됩니다. 외부 전송을 원치 않으시면 서버 전송 없는 <strong>기본 분석</strong>을 바로 사용할 수 있습니다.
          </p>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onFallbackToRule}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            외부 전송 없이 기본 분석 사용
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              취소
            </button>
            <button
              type="button"
              disabled={blockedUnmaskedHighRisk}
              onClick={() => onConfirmSend(applyMasking)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>확인 후 AI 분석 실행</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
