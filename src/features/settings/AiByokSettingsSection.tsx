import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { setStoredAiEnabled } from '../../lib/aiPreferences';
import {
  normalizeGeminiApiKeyInput,
  validateGeminiApiKeyFormat,
} from '../../lib/byokKeyFormat';
import {
  AI_LIMITS,
  type AiByokTestResponse,
  type AiStatusResponse,
} from '../../lib/aiTypes';
import {
  deleteByokApiKey,
  fetchAiServerStatus,
  saveByokApiKey,
  testByokApiKey,
  updateAiServerPreferences,
} from '../../services/aiClient';

interface AiByokSettingsSectionProps {
  uid: string;
}

const TOKEN_NUM_FMT = new Intl.NumberFormat('ko-KR');

export function AiByokSettingsSection({ uid }: AiByokSettingsSectionProps) {
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [deletingKey, setDeletingKey] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const [dailyPlanLimitInput, setDailyPlanLimitInput] = useState<number>(
    AI_LIMITS.DEFAULT_DAILY_PLAN_LIMIT,
  );
  const [dailyTotalLimitInput, setDailyTotalLimitInput] = useState<number>(
    AI_LIMITS.DEFAULT_DAILY_TOTAL_LIMIT,
  );
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [testResult, setTestResult] = useState<AiByokTestResponse | null>(null);
  const [sectionFeedback, setSectionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  async function loadStatus() {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const next = await fetchAiServerStatus();
      setAiStatus(next);
      setDailyPlanLimitInput(next.dailyPlanLimit);
      setDailyTotalLimitInput(next.dailyTotalLimit);
      setStoredAiEnabled(uid, next.aiEnabled);
    } catch (err) {
      setStatusError(
        err instanceof Error
          ? err.message
          : 'AI 설정 및 사용량 상태를 불러오지 못했습니다.',
      );
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    if (savingKey || testingKey) return;
    const validation = validateGeminiApiKeyFormat(apiKeyInput);
    if (!validation.valid || !validation.apiKey) {
      setSectionFeedback({
        type: 'error',
        message: validation.message || '올바른 Gemini API 키를 입력해 주세요.',
      });
      return;
    }

    setSavingKey(true);
    setSectionFeedback(null);
    setTestResult(null);
    try {
      const res = await saveByokApiKey({
        apiKey: validation.apiKey,
        testBeforeSave: true,
      });
      // Immediately clear key from component state after submission
      setApiKeyInput('');
      setShowKeyInput(false);
      setSectionFeedback({
        type: 'success',
        message: res.message,
      });
      await loadStatus();
    } catch (err) {
      setSectionFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : '개인 API 키 검증 및 등록에 실패했습니다.',
      });
    } finally {
      setSavingKey(false);
    }
  }

  async function handleTestKey() {
    if (testingKey || savingKey) return;
    setTestingKey(true);
    setSectionFeedback(null);
    setTestResult(null);
    try {
      const cleaned = normalizeGeminiApiKeyInput(apiKeyInput);
      if (cleaned) {
        const validation = validateGeminiApiKeyFormat(cleaned);
        if (!validation.valid || !validation.apiKey) {
          setSectionFeedback({
            type: 'error',
            message: validation.message || '올바른 Gemini API 키를 입력해 주세요.',
          });
          setTestingKey(false);
          return;
        }
        const res = await testByokApiKey({ apiKey: validation.apiKey });
        setTestResult(res);
        setSectionFeedback({
          type: 'success',
          message: res.message,
        });
        return;
      }
      const res = await testByokApiKey({});
      setTestResult(res);
      setSectionFeedback({
        type: 'success',
        message: res.message,
      });
    } catch (err) {
      setSectionFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'API 키 연결 테스트에 실패했습니다.',
      });
    } finally {
      setTestingKey(false);
    }
  }

  async function handleDeleteKey() {
    if (deletingKey) return;
    setDeletingKey(true);
    setSectionFeedback(null);
    setTestResult(null);
    try {
      const res = await deleteByokApiKey();
      setConfirmDeleteOpen(false);
      setApiKeyInput('');
      setSectionFeedback({
        type: 'success',
        message: res.message,
      });
      await loadStatus();
    } catch (err) {
      setSectionFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : '등록된 API 키 삭제 중 오류가 발생했습니다.',
      });
    } finally {
      setDeletingKey(false);
    }
  }

  async function handleToggleAiEnabled(nextEnabled: boolean) {
    if (savingPrefs) return;
    setSavingPrefs(true);
    setSectionFeedback(null);
    setStoredAiEnabled(uid, nextEnabled);
    try {
      const res = await updateAiServerPreferences({ aiEnabled: nextEnabled });
      setAiStatus((prev) =>
        prev
          ? {
              ...prev,
              aiEnabled: res.aiEnabled,
              dailyPlanLimit: res.dailyPlanLimit,
              dailyTotalLimit: res.dailyTotalLimit,
              usage: res.usage,
            }
          : prev,
      );
      setSectionFeedback({
        type: 'success',
        message: nextEnabled
          ? 'AI 스마트 업무비서 기능을 켰습니다. 직접 버튼을 눌렀을 때만 동작합니다.'
          : 'AI 스마트 업무비서 기능을 껐습니다. 기본 분석과 기본 우선순위 계획은 계속 이용할 수 있습니다.',
      });
    } catch (err) {
      setSectionFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'AI 사용 설정을 저장하지 못했습니다.',
      });
    } finally {
      setSavingPrefs(false);
    }
  }

  async function handleSaveLimits(e: FormEvent) {
    e.preventDefault();
    if (savingPrefs) return;
    setSavingPrefs(true);
    setSectionFeedback(null);
    try {
      const safePlan = Math.max(
        1,
        Math.min(AI_LIMITS.MAX_DAILY_PLAN_LIMIT, Math.round(dailyPlanLimitInput)),
      );
      const safeTotal = Math.max(
        safePlan,
        Math.min(AI_LIMITS.MAX_DAILY_TOTAL_LIMIT, Math.round(dailyTotalLimitInput)),
      );
      const res = await updateAiServerPreferences({
        dailyPlanLimit: safePlan,
        dailyTotalLimit: safeTotal,
      });
      setDailyPlanLimitInput(res.dailyPlanLimit);
      setDailyTotalLimitInput(res.dailyTotalLimit);
      setAiStatus((prev) =>
        prev
          ? {
              ...prev,
              dailyPlanLimit: res.dailyPlanLimit,
              dailyTotalLimit: res.dailyTotalLimit,
              usage: res.usage,
            }
          : prev,
      );
      setSectionFeedback({
        type: 'success',
        message: `개인 일일 보호 한도를 저장했습니다. (업무 계획 ${res.dailyPlanLimit}회 / 전체 ${res.dailyTotalLimit}회)`,
      });
    } catch (err) {
      setSectionFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : '일일 한도 설정 저장에 실패했습니다.',
      });
    } finally {
      setSavingPrefs(false);
    }
  }

  const aiEnabled = aiStatus?.aiEnabled ?? true;
  const hasPersonalKey = aiStatus?.hasPersonalKey ?? false;

  return (
    <section
      aria-label="AI 스마트 업무비서 및 개인 Gemini API 키 설정"
      className="bg-white border border-slate-200 rounded-xl p-6 space-y-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900">
              AI 스마트 업무비서 · 개인 Gemini API 키(BYOK)
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            운영자 공용 키를 사용하지 않으며, AI 기능을 원하는 교사만 본인 Google AI Studio API 키를 등록해 사용합니다.
          </p>
        </div>

        <button
          type="button"
          disabled={statusLoading}
          onClick={() => void loadStatus()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>상태 새로고침</span>
        </button>
      </div>

      {sectionFeedback && (
        <div
          role={sectionFeedback.type === 'error' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-xs font-medium ${
            sectionFeedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          {sectionFeedback.message}
        </div>
      )}

      {statusError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900"
        >
          {statusError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Key Registration + Toggle + Limits */}
        <div className="space-y-5">
          {/* Personal Key Box */}
          <div className="p-4 rounded-xl border border-slate-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-teal-700" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">
                  개인 Gemini API 키 관리
                </h3>
              </div>
              <span
                className={`px-2 py-0.5 text-[11px] font-semibold rounded-md border whitespace-nowrap ${
                  hasPersonalKey
                    ? 'border-teal-200 bg-teal-50 text-teal-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                {hasPersonalKey
                  ? `등록됨 (${aiStatus?.keyHint ?? '****'})`
                  : '미등록'}
              </span>
            </div>

            {aiStatus && (
              <p className="text-xs text-slate-600 leading-relaxed">
                보관 방식:{' '}
                <strong className="font-semibold text-slate-800">
                  {aiStatus.persistenceMode === 'encrypted_vault'
                    ? '서버 AES-256-GCM 암호화 보관소 + HttpOnly 보안 쿠키'
                    : '서버 세션 암호화 쿠키·메모리 임시 보관'}
                </strong>
                {aiStatus.persistenceMode === 'session_memory_only' &&
                  ' (서버 환경변수에 암호화 비밀키가 설정되지 않아 Firestore에 저장하지 않고 현재 세션에서만 안전하게 유지됩니다. 서버가 재시작되면 다시 입력해 주세요.)'}
              </p>
            )}

            <form onSubmit={handleSaveKey} className="space-y-3">
              <div>
                <label
                  htmlFor="byok-api-key-input"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  {hasPersonalKey ? '새 Gemini API 키로 변경' : 'Gemini API 키 입력'}
                </label>
                <div className="relative flex items-center">
                  <input
                    id="byok-api-key-input"
                    type={showKeyInput ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onPaste={(e) => {
                      const pasted = e.clipboardData?.getData('text');
                      const el = e.currentTarget;
                      const replacesAll =
                        el.selectionStart === 0 &&
                        el.selectionEnd === apiKeyInput.length;
                      if (typeof pasted === 'string' && (!apiKeyInput || replacesAll)) {
                        e.preventDefault();
                        setApiKeyInput(normalizeGeminiApiKeyInput(pasted));
                      }
                    }}
                    placeholder="AIza... 형태의 본인 API 키 입력"
                    className="w-full pr-10 pl-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyInput((prev) => !prev)}
                    aria-label={showKeyInput ? 'API 키 숨기기' : 'API 키 보기'}
                    className="absolute right-2.5 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    {showKeyInput ? (
                      <EyeOff className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <Eye className="w-4 h-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  입력한 키는 검증 후 브라우저 localStorage·sessionStorage에 남기지 않고 즉시 비워집니다. 앞뒤 공백·줄바꿈은 자동 제거됩니다.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={
                    savingKey ||
                    testingKey ||
                    !normalizeGeminiApiKeyInput(apiKeyInput)
                  }
                  className="px-3.5 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {savingKey ? '검증 및 저장 중...' : hasPersonalKey ? '검증 후 키 변경' : '검증 후 저장'}
                </button>

                <button
                  type="button"
                  disabled={
                    testingKey ||
                    savingKey ||
                    (!normalizeGeminiApiKeyInput(apiKeyInput) && !hasPersonalKey)
                  }
                  onClick={() => void handleTestKey()}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {testingKey
                    ? '연결 확인 중...'
                    : normalizeGeminiApiKeyInput(apiKeyInput)
                      ? '입력 키 테스트'
                      : '등록된 키 테스트'}
                </button>

                {hasPersonalKey && !confirmDeleteOpen && (
                  <button
                    type="button"
                    disabled={deletingKey}
                    onClick={() => setConfirmDeleteOpen(true)}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>키 삭제</span>
                  </button>
                )}

                {hasPersonalKey && confirmDeleteOpen && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={deletingKey}
                      onClick={() => void handleDeleteKey()}
                      className="px-3 py-2 text-xs font-semibold bg-red-700 text-white rounded-lg hover:bg-red-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {deletingKey ? '삭제 중...' : '삭제 확인'}
                    </button>
                    <button
                      type="button"
                      disabled={deletingKey}
                      onClick={() => setConfirmDeleteOpen(false)}
                      className="px-2.5 py-2 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      취소
                    </button>
                  </div>
                )}
              </div>
            </form>

            {testResult && testResult.ok && (
              <div className="p-3 rounded-lg bg-teal-50/70 border border-teal-200 text-xs text-teal-900 flex items-center gap-2 tabular-nums">
                <CheckCircle2 className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
                <span>
                  연결 정상 · 모델 {testResult.model} · 응답 {testResult.latencyMs}ms
                  {testResult.usage
                    ? ` (토큰 ${testResult.usage.totalTokens})`
                    : ''}
                </span>
              </div>
            )}
          </div>

          {/* Toggle & Daily Limits */}
          <div className="p-4 rounded-xl border border-slate-200 space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={aiEnabled}
                disabled={savingPrefs}
                onChange={(e) => void handleToggleAiEnabled(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
              />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-slate-900">
                  AI 스마트 업무비서 기능 활성화
                </span>
                <span className="block text-xs text-slate-600 leading-relaxed">
                  끄면 오늘의 업무 플래너·AI 브리핑·쪽지 AI 분석 버튼이 비활성화되며, 기본 브리핑과 기본 우선순위 계획만 사용할 수 있습니다.
                </span>
              </span>
            </label>

            <form
              onSubmit={handleSaveLimits}
              className="pt-3 border-t border-slate-100 space-y-3"
            >
              <p className="text-xs font-semibold text-slate-900">
                개인 일일 AI 호출 보호 한도 (한국시간 자정 초기화)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="ai-daily-plan-limit"
                    className="block text-[11px] font-medium text-slate-600 mb-1"
                  >
                    오늘 업무 계획 생성 (1~{AI_LIMITS.MAX_DAILY_PLAN_LIMIT}회/일)
                  </label>
                  <input
                    id="ai-daily-plan-limit"
                    type="number"
                    min={1}
                    max={AI_LIMITS.MAX_DAILY_PLAN_LIMIT}
                    value={dailyPlanLimitInput}
                    onChange={(e) =>
                      setDailyPlanLimitInput(Number(e.target.value) || 1)
                    }
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                  />
                </div>
                <div>
                  <label
                    htmlFor="ai-daily-total-limit"
                    className="block text-[11px] font-medium text-slate-600 mb-1"
                  >
                    전체 AI 호출 합계 (1~{AI_LIMITS.MAX_DAILY_TOTAL_LIMIT}회/일)
                  </label>
                  <input
                    id="ai-daily-total-limit"
                    type="number"
                    min={1}
                    max={AI_LIMITS.MAX_DAILY_TOTAL_LIMIT}
                    value={dailyTotalLimitInput}
                    onChange={(e) =>
                      setDailyTotalLimitInput(Number(e.target.value) || 1)
                    }
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={savingPrefs}
                  className="px-3.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  {savingPrefs ? '저장 중...' : '일일 한도 저장'}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Live Usage / Tokens + Quota & Privacy Notices */}
        <div className="space-y-5">
          <div className="p-4 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                내 AI 사용량 및 토큰 현황
              </h3>
              <span className="font-mono text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                {aiStatus?.model ?? 'gemini-4-hydrogen'}
              </span>
            </div>

            {statusLoading && !aiStatus ? (
              <p className="text-xs text-slate-500">사용량을 불러오는 중입니다...</p>
            ) : aiStatus ? (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2.5 text-center tabular-nums">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">오늘 계획 생성</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {aiStatus.usage.todayPlanCount} / {aiStatus.dailyPlanLimit}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">오늘 전체 호출</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {aiStatus.usage.todayTotalCount} / {aiStatus.dailyTotalLimit}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">이번 달 누적</p>
                    <p className="mt-1 text-base font-bold text-teal-800">
                      {aiStatus.usage.monthTotalCount}회
                    </p>
                  </div>
                </div>

                <dl className="text-xs text-slate-700 space-y-1.5 pt-2 border-t border-slate-100 tabular-nums">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">누적 입력 · 출력 · 사고 토큰</dt>
                    <dd className="font-medium text-slate-900">
                      {TOKEN_NUM_FMT.format(aiStatus.usage.totalInputTokens)} /{' '}
                      {TOKEN_NUM_FMT.format(aiStatus.usage.totalOutputTokens)} /{' '}
                      {TOKEN_NUM_FMT.format(aiStatus.usage.totalThoughtTokens)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">분당 호출 보호 한도</dt>
                    <dd>
                      {aiStatus.rateLimitWindowSeconds}초당 최대{' '}
                      {aiStatus.rateLimitMaxRequests}회
                    </dd>
                  </div>
                  {aiStatus.usage.lastUsedAtIso && (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">마지막 AI 실행</dt>
                      <dd className="text-slate-600">
                        {new Date(aiStatus.usage.lastUsedAtIso).toLocaleString('ko-KR', {
                          timeZone: 'Asia/Seoul',
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : null}
          </div>

          <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2.5 text-xs text-slate-700 leading-relaxed">
            <div className="flex items-center gap-1.5 font-semibold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
              <span>일일 한도 초기화 · 과금 · 개인정보 보호 안내</span>
            </div>
            <ul className="list-disc pl-4 space-y-1.5">
              <li>
                <strong>Google AI Studio 일일 한도(RPD):</strong> 무료 등급의 일일 요청 한도는{' '}
                <strong>미국 태평양 표준시(PT) 자정</strong>에 초기화됩니다. 한국시간(KST) 기준{' '}
                <strong>오후 4시(서머타임 적용 시) 또는 오후 5시(표준시)</strong>입니다.
              </li>
              <li>
                <strong>앱 내 일일 보호 한도:</strong> 위에서 설정한 계획 생성·전체 호출 한도는{' '}
                <strong>한국시간(Asia/Seoul) 자정</strong>에 초기화됩니다.
              </li>
              <li>
                <strong>과금 및 키 보안:</strong> 유료 결제가 연결된 Google Cloud 프로젝트의 API 키를 등록한 경우 사용량에 따라 본인 계정에 비용이 청구될 수 있습니다. 키는 Firestore 평문·브라우저 저장소에 절대 보관하지 않으며, 서버에서도 등록자 본인 UID로만 격리 복호화됩니다.
              </li>
              <li>
                <strong>자동 변경 금지:</strong> AI 업무 플래너는 업무 제목·기한·우선순위·예상 소요·시간표 가용 구간 요약만 참고하며, 상세 메모·원문 문서는 전송하지 않고 어떤 데이터도 자동 저장·수정·삭제하지 않습니다.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
