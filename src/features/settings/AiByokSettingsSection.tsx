import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  normalizeGeminiApiKeyInput,
  validateGeminiApiKeyFormat,
} from '../../lib/byokKeyFormat';
import {
  getStoredPreferredPlannerModel,
  setStoredPreferredPlannerModel,
  subscribePreferredPlannerModelChange,
} from '../../lib/aiPreferences';
import {
  AI_LIMITS,
  type AiByokTestResponse,
  type AiErrorCategory,
  type AiTimeoutSource,
  type GeminiDiagnosticErrorCategory,
} from '../../lib/aiTypes';
import {
  AiClientError,
  deleteByokApiKey,
  saveByokApiKey,
  testByokApiKey,
  updateAiServerPreferences,
} from '../../services/aiClient';
import { useAiWorkspace } from '../tasks/AiWorkspaceContext';

interface AiByokSettingsSectionProps {
  uid: string;
}

const TOKEN_NUM_FMT = new Intl.NumberFormat('ko-KR');

export function AiByokSettingsSection({ uid }: AiByokSettingsSectionProps) {
  const {
    aiStatus,
    aiStatusLoaded,
    aiStatusLoading: statusLoading,
    aiStatusError: statusError,
    refreshAiStatus,
    patchAiStatus,
    setLocalAiEnabled,
    plannerError,
    plannerErrorCode,
    plannerErrorDetail,
    activePlannerModel,
  } = useAiWorkspace();

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [testingCandidate, setTestingCandidate] = useState(false);
  const [candidateModelInput, setCandidateModelInput] = useState('');
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
  const [preferredPlannerModel, setPreferredPlannerModel] = useState<string | null>(() =>
    getStoredPreferredPlannerModel(uid),
  );
  const [sectionFeedback, setSectionFeedback] = useState<{
    type: 'success' | 'error';
    categoryLabel?: string;
    message: string;
    warning?: string;
  } | null>(null);

  function getCategoryLabel(category?: AiErrorCategory): string {
    switch (category) {
      case 'input_format':
        return '입력 형식 오류';
      case 'request_format':
        return '요청 형식 오류';
      case 'auth':
        return '로그인·계정 승인 오류';
      case 'encryption_config':
        return '서버 암호화·보관소 설정 오류';
      case 'gemini_api':
        return 'Gemini API 연결 오류';
      case 'network':
        return '네트워크 통신 오류';
      case 'server_internal':
        return '서버 내부 오류';
      default:
        return '요청 오류';
    }
  }

  function getDiagnosticErrorLabel(
    diag?: GeminiDiagnosticErrorCategory,
    timeoutSource?: AiTimeoutSource,
  ): string {
    switch (diag) {
      case 'auth_failed':
        return 'API 키 인증 오류';
      case 'auth_header_error':
        return 'API 인증 헤더 오류';
      case 'model_permission_denied':
        return '모델 접근 권한 오류';
      case 'model_not_supported':
        return '모델 미지원 / 찾을 수 없음';
      case 'model_generate_unsupported':
        return 'generateContent 미지원 모델';
      case 'invalid_request_format':
        return '요청 형식 / 파라미터 오류';
      case 'quota_exceeded':
        return 'API 호출 한도 초과';
      case 'timeout':
        if (timeoutSource === 'local') return '앱 로컬 제한 시간 초과';
        if (timeoutSource === 'upstream') return 'Google API 응답 시간 초과';
        return '응답 시간 초과';
      case 'network':
        return '네트워크 통신 오류';
      case 'aborted':
        return '요청 취소';
      case 'server_error':
        return 'Gemini 서버 오류';
      default:
        return '모델 호출 오류';
    }
  }

  function toErrorFeedback(err: unknown, fallbackMessage: string) {
    if (err instanceof AiClientError) {
      return {
        type: 'error' as const,
        categoryLabel: err.diagnostic?.diagnosticCategory
          ? getDiagnosticErrorLabel(
              err.diagnostic.diagnosticCategory,
              err.diagnostic.timeoutSource,
            )
          : getCategoryLabel(err.category),
        message: err.message,
      };
    }
    return {
      type: 'error' as const,
      categoryLabel: '요청 오류',
      message: err instanceof Error ? err.message : fallbackMessage,
    };
  }

  useEffect(() => {
    if (!aiStatus) return;
    setDailyPlanLimitInput(aiStatus.dailyPlanLimit);
    setDailyTotalLimitInput(aiStatus.dailyTotalLimit);
  }, [aiStatus]);

  async function loadStatus() {
    await refreshAiStatus(true);
  }

  useEffect(() => {
    if (!aiStatusLoaded) {
      void refreshAiStatus(false);
    }
  }, [uid, aiStatusLoaded, refreshAiStatus]);

  useEffect(() => {
    setPreferredPlannerModel(getStoredPreferredPlannerModel(uid));
    return subscribePreferredPlannerModelChange(uid, setPreferredPlannerModel);
  }, [uid]);

  function handleApplyModelForPlanner(modelId: string) {
    setStoredPreferredPlannerModel(uid, modelId);
    setPreferredPlannerModel(modelId);
    setSectionFeedback({
      type: 'success',
      message: `업무 계획(planner) 모델을 ${modelId}로 적용했습니다. 이제 「오늘의 브리핑 > AI로 오늘 업무 계획 세우기」에서 해당 모델이 우선 사용됩니다. (업무 등록 AI 분석 모델은 기존 서버 설정 유지)`,
    });
  }

  function handleResetPlannerModelOverride() {
    setStoredPreferredPlannerModel(uid, null);
    setPreferredPlannerModel(null);
    setSectionFeedback({
      type: 'success',
      message: '업무 계획(planner) 모델을 서버 기본 설정으로 되돌렸습니다.',
    });
  }

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    if (savingKey || testingKey) return;
    const validation = validateGeminiApiKeyFormat(apiKeyInput);
    if (!validation.valid || !validation.apiKey) {
      setSectionFeedback({
        type: 'error',
        categoryLabel: getCategoryLabel(validation.category ?? 'input_format'),
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
        verifyAuthBeforeSave: true,
      });
      // Immediately clear key from component state after submission
      setApiKeyInput('');
      setShowKeyInput(false);
      setSectionFeedback({
        type: 'success',
        message: res.message,
        warning: res.warning,
      });
      await loadStatus();
    } catch (err) {
      setSectionFeedback(
        toErrorFeedback(err, '개인 API 키 검증 및 등록에 실패했습니다.'),
      );
    } finally {
      setSavingKey(false);
    }
  }

  function applyTestResponse(res: AiByokTestResponse) {
    setTestResult(res);
    if (!res.isCandidateTest) {
      const nextCandidate =
        res.recommendedModel ||
        res.availableGenerateModels?.find((m) => m !== res.configuredModel) ||
        res.availableGenerateModels?.[0] ||
        '';
      if (nextCandidate) {
        setCandidateModelInput(nextCandidate);
      }
    }
    if (res.ok && res.apiKeyAuthOk && res.generateContentOk) {
      setSectionFeedback({
        type: 'success',
        message: res.message,
        warning: res.warning,
      });
      return;
    }
    setSectionFeedback({
      type: 'error',
      categoryLabel: res.diagnosticCategory
        ? getDiagnosticErrorLabel(res.diagnosticCategory, res.timeoutSource)
        : 'Gemini 모델 호출 오류',
      message: res.message,
      warning: res.warning,
    });
  }

  async function runSingleKeyTest(candidateModel?: string) {
    const cleaned = normalizeGeminiApiKeyInput(apiKeyInput);
    if (cleaned) {
      const validation = validateGeminiApiKeyFormat(cleaned);
      if (!validation.valid || !validation.apiKey) {
        setSectionFeedback({
          type: 'error',
          categoryLabel: getCategoryLabel(validation.category ?? 'input_format'),
          message: validation.message || '올바른 Gemini API 키를 입력해 주세요.',
        });
        return;
      }
      const res = await testByokApiKey({
        apiKey: validation.apiKey,
        ...(candidateModel ? { candidateModel } : {}),
      });
      applyTestResponse(res);
      return;
    }
    const res = await testByokApiKey(
      candidateModel ? { candidateModel } : {},
    );
    applyTestResponse(res);
  }

  async function handleTestKey() {
    if (testingKey || testingCandidate || savingKey) return;
    setTestingKey(true);
    setSectionFeedback(null);
    setTestResult(null);
    try {
      await runSingleKeyTest();
    } catch (err) {
      if (err instanceof AiClientError && err.diagnostic) {
        setTestResult(err.diagnostic);
      }
      setSectionFeedback(
        toErrorFeedback(err, 'API 키 연결 테스트에 실패했습니다.'),
      );
    } finally {
      setTestingKey(false);
    }
  }

  async function handleTestCandidateModel() {
    const trimmedModel = candidateModelInput.trim();
    if (!trimmedModel || testingCandidate || testingKey || savingKey) return;
    setTestingCandidate(true);
    setSectionFeedback(null);
    try {
      await runSingleKeyTest(trimmedModel);
    } catch (err) {
      if (err instanceof AiClientError && err.diagnostic) {
        setTestResult(err.diagnostic);
      }
      setSectionFeedback(
        toErrorFeedback(err, `후보 모델(${trimmedModel}) 검증에 실패했습니다.`),
      );
    } finally {
      setTestingCandidate(false);
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
    setLocalAiEnabled(nextEnabled);
    try {
      const res = await updateAiServerPreferences({ aiEnabled: nextEnabled });
      patchAiStatus((prev) =>
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
      patchAiStatus((prev) =>
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
          className={`p-3.5 rounded-lg border text-xs font-medium space-y-1 ${
            sectionFeedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          {sectionFeedback.type === 'error' && sectionFeedback.categoryLabel && (
            <p className="text-[11px] font-bold uppercase tracking-wide text-red-700">
              [{sectionFeedback.categoryLabel}]
            </p>
          )}
          <p>{sectionFeedback.message}</p>
          {sectionFeedback.warning && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 mt-1 font-normal">
              {sectionFeedback.warning}
            </p>
          )}
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

      {aiStatus?.serverlessRuntime && aiStatus.encryptionConfigured === false && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-amber-300 bg-amber-50 text-xs text-amber-950 space-y-1"
        >
          <p className="font-semibold">[서버 암호화 설정 안내] BYOK_ENCRYPTION_SECRET 미설정</p>
          <p>
            현재 Vercel 서버리스 환경에 <code className="font-mono bg-amber-100 px-1 rounded">BYOK_ENCRYPTION_SECRET</code> 환경변수가 설정되지 않아 개인 키를 영구 암호화 저장할 수 없습니다. 아래 「입력 키 테스트」로 연결 확인은 가능하지만, 저장·사용하려면 Vercel 프로젝트 환경변수에 32자 이상의 비밀키를 등록하고 재배포해 주세요.
          </p>
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
                className={`px-2.5 py-0.5 text-[11px] font-semibold rounded-md border whitespace-nowrap ${
                  hasPersonalKey
                    ? 'border-teal-200 bg-teal-50 text-teal-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                {hasPersonalKey
                  ? `등록 완료 · 개인 API 키${
                      aiStatus?.keyType === 'auth_aq'
                        ? ' (신규 인증 키)'
                        : aiStatus?.keyType === 'standard_aiza'
                          ? ' (기존 표준 키)'
                          : ''
                    }`
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

            {hasPersonalKey &&
              plannerError &&
              (plannerErrorCode === 'ai_upstream_error' ||
                plannerErrorCode === 'ai_timeout' ||
                plannerErrorCode === 'ai_empty_response' ||
                plannerErrorCode === 'ai_invalid_json' ||
                plannerErrorCode === 'ai_response_truncated' ||
                plannerErrorCode === 'model_not_found') &&
              (!activePlannerModel ||
                !plannerErrorDetail?.model ||
                activePlannerModel === plannerErrorDetail.model) && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950 space-y-1 leading-relaxed">
                  <p className="font-semibold text-amber-900">
                    최근 AI 업무 계획(
                    <span className="font-mono">
                      {plannerErrorDetail?.model ?? activePlannerModel ?? '현재 모델'}
                    </span>
                    ) 호출 오류 안내
                    {typeof plannerErrorDetail?.upstreamHttpStatus === 'number'
                      ? ` · HTTP ${plannerErrorDetail.upstreamHttpStatus}`
                      : ''}
                  </p>
                  <p>
                    단순 연결 테스트는 통과하더라도 특정 모델이 업무 계획(JSON) 요청에서 오류나 지연을 반환할 수 있습니다. 아래 <strong>「등록된 키 테스트」</strong>를 누른 뒤 나타나는 모델 목록에서 다른 모델(예:{' '}
                    <span className="font-mono">gemini-4-hydrogen</span>,{' '}
                    <span className="font-mono">gemini-3.1-flash-lite</span>,{' '}
                    <span className="font-mono">gemini-2.5-flash</span>)을 1회 검증하고 <strong>「이 모델을 AI 업무 계획에 적용」</strong>을 눌러 보세요.
                  </p>
                </div>
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
                    name="gemini-api-key-byok"
                    type={showKeyInput ? 'text' : 'password'}
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                    spellCheck={false}
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      if (sectionFeedback?.type === 'error') {
                        setSectionFeedback(null);
                      }
                    }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData?.getData('text');
                      const el = e.currentTarget;
                      const currentClean = normalizeGeminiApiKeyInput(apiKeyInput);
                      const replacesAll =
                        el.selectionStart === 0 &&
                        el.selectionEnd === apiKeyInput.length;
                      if (typeof pasted === 'string' && (!currentClean || replacesAll)) {
                        e.preventDefault();
                        setApiKeyInput(normalizeGeminiApiKeyInput(pasted));
                        if (sectionFeedback?.type === 'error') {
                          setSectionFeedback(null);
                        }
                      }
                    }}
                    placeholder="AQ.... 또는 AIza... 형태의 본인 Gemini API 키 입력"
                    className={`w-full ${apiKeyInput ? 'pr-20' : 'pr-10'} pl-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700`}
                  />
                  <div className="absolute right-2 flex items-center gap-1">
                    {apiKeyInput.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setApiKeyInput('');
                          setSectionFeedback(null);
                        }}
                        className="px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:text-slate-800 bg-slate-100 rounded cursor-pointer"
                      >
                        지우기
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowKeyInput((prev) => !prev)}
                      aria-label={showKeyInput ? 'API 키 숨기기' : 'API 키 보기'}
                      className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showKeyInput ? (
                        <EyeOff className="w-4 h-4" aria-hidden="true" />
                      ) : (
                        <Eye className="w-4 h-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Google AI Studio의 신규 인증 키(AQ....)와 기존 표준 키(AIza...)를 모두 지원합니다. 입력한 키는 검증 후 브라우저 저장소에 남기지 않고 즉시 비워지며, 앞뒤 공백·줄바꿈·제어 문자는 자동 제거됩니다.
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
              <p className="text-[11px] text-slate-500 leading-relaxed">
                「저장」은 토큰을 소모하지 않는 인증 확인만 수행하며, 「테스트」 버튼을 직접 누를 때만 최소 토큰으로 실제 <code className="font-mono bg-slate-100 px-1 rounded">generateContent</code> 호출을 확인합니다(소량의 API 사용량이 발생할 수 있음).
              </p>
            </form>

            {testResult && (
              <div
                className={`p-3.5 rounded-lg border text-xs space-y-2.5 tabular-nums ${
                  testResult.ok
                    ? 'bg-teal-50/70 border-teal-200 text-teal-950'
                    : 'bg-red-50/70 border-red-200 text-red-950'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    {testResult.ok ? (
                      <CheckCircle2 className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {testResult.isCandidateTest
                        ? `후보 모델 검증(${testResult.model}) · ${testResult.ok ? '성공' : '실패'}`
                        : testResult.ok
                          ? '모델 연결 진단 · 정상'
                          : '모델 연결 진단 · 확인 필요'}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-600">
                    호출 {testResult.latencyMs}ms
                    {typeof testResult.timeoutMs === 'number'
                      ? ` / 제한 ${testResult.timeoutMs}ms`
                      : ''}
                    {typeof (testResult.httpStatus ?? testResult.upstreamHttpStatus) === 'number'
                      ? ` · HTTP ${testResult.httpStatus ?? testResult.upstreamHttpStatus}`
                      : ''}
                    {testResult.usage && testResult.usage.totalTokens > 0
                      ? ` · 토큰 ${testResult.usage.totalTokens}`
                      : ''}
                  </span>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 pt-2 border-t border-slate-200/70 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-600">1. API 키 인증</dt>
                    <dd
                      className={`font-semibold ${
                        testResult.apiKeyAuthOk ? 'text-teal-800' : 'text-red-700'
                      }`}
                    >
                      {testResult.apiKeyAuthOk ? '정상' : '실패'}
                      {testResult.keyType === 'auth_aq'
                        ? ' (신규 인증 키)'
                        : testResult.keyType === 'standard_aiza'
                          ? ' (기존 표준 키)'
                          : ''}
                    </dd>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-600">
                      {testResult.isCandidateTest ? '2. 검증 요청 모델' : '2. 현재 설정 모델'}
                    </dt>
                    <dd className="font-mono font-semibold text-slate-900">
                      {testResult.model}
                      {testResult.isCandidateTest && (
                        <span className="ml-1 font-sans font-normal text-slate-500">
                          (서버 설정: {testResult.configuredModel})
                        </span>
                      )}
                    </dd>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-600">3. 모델 접근 가능 여부</dt>
                    <dd
                      className={`font-semibold ${
                        testResult.modelAccessible ? 'text-teal-800' : 'text-red-700'
                      }`}
                    >
                      {testResult.modelAccessible ? '가능 (generateContent 지원)' : '불가'}
                    </dd>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-600">4. generateContent 호출</dt>
                    <dd
                      className={`font-semibold ${
                        testResult.generateContentOk ? 'text-teal-800' : 'text-red-700'
                      }`}
                    >
                      {testResult.generateContentOk ? '성공' : '실패'}
                      {testResult.finishReason ? ` (${testResult.finishReason})` : ''}
                    </dd>
                  </div>

                  <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200/60">
                    <dt className="text-slate-600">5. 오류 유형</dt>
                    <dd className="font-semibold text-slate-900">
                      {testResult.ok
                        ? '오류 없음'
                        : `${getDiagnosticErrorLabel(testResult.diagnosticCategory, testResult.timeoutSource)}${
                            testResult.diagnosticCategory === 'timeout' && testResult.timeoutSource
                              ? testResult.timeoutSource === 'local'
                                ? ' (앱 로컬 제한 초과 · Google API 응답 아님)'
                                : ' (Google API 서버 반환)'
                              : ''
                          }${
                            typeof testResult.upstreamHttpStatus === 'number'
                              ? ` (HTTP ${testResult.upstreamHttpStatus}${
                                  testResult.upstreamApiStatus
                                    ? ` · ${testResult.upstreamApiStatus}`
                                    : ''
                                })`
                              : ''
                          }`}
                    </dd>
                  </div>

                  <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <dt className="text-slate-500">호출 시간 / 제한 시간</dt>
                    <dd className="font-mono text-slate-800">
                      실제 {testResult.latencyMs}ms
                      {typeof testResult.timeoutMs === 'number'
                        ? ` / 제한 ${testResult.timeoutMs}ms`
                        : ''}
                      {testResult.diagnosticCategory === 'timeout' &&
                        testResult.timeoutSource && (
                          <span className="ml-1.5 font-sans font-semibold text-red-700">
                            [
                            {testResult.timeoutSource === 'local'
                              ? '로컬 타임아웃'
                              : 'Google API 타임아웃'}
                            ]
                          </span>
                        )}
                    </dd>
                  </div>

                  {testResult.usage && testResult.usage.totalTokens > 0 && (
                    <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <dt className="text-slate-500">토큰 사용량 (입력/출력/사고/합계)</dt>
                      <dd className="font-mono text-slate-800">
                        {testResult.usage.inputTokens} / {testResult.usage.outputTokens} /{' '}
                        {testResult.usage.thoughtTokens} / {testResult.usage.totalTokens}
                      </dd>
                    </div>
                  )}

                  {testResult.requestEndpoint && (
                    <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <dt className="text-slate-500">요청 엔드포인트</dt>
                      <dd className="font-mono text-slate-700 break-all">
                        {testResult.requestApiVersion ?? 'v1'} · {testResult.requestEndpoint}
                        {testResult.modelListCached ? ' (목록 캐시)' : ''}
                      </dd>
                    </div>
                  )}

                  {testResult.compatibility && (
                    <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 text-[11px] pt-1 border-t border-slate-200/60">
                      <dt className="text-slate-500">앱 설정 호환성</dt>
                      <dd className="text-slate-700">
                        <span className="font-mono">
                          {testResult.compatibility.noticeThinkingSummary}
                        </span>
                        {' · '}JSON 스키마{' '}
                        {testResult.compatibility.structuredJsonSupported ? '지원' : '미지원'}
                        {' · '}출력한도 {testResult.compatibility.plannerMaxOutputTokens}
                      </dd>
                    </div>
                  )}
                </dl>

                {!testResult.ok &&
                  testResult.diagnosticCategory === 'timeout' &&
                  testResult.timeoutSource === 'local' && (
                    <p className="text-[11px] text-amber-950 bg-white/90 border border-amber-300 rounded px-2.5 py-1.5 leading-relaxed break-words">
                      <strong className="font-semibold">로컬 타임아웃 상세:</strong>{' '}
                      Google API가 오류를 반환한 것이 아니라 앱 서버의 제한 시간(
                      <span className="font-mono">{testResult.timeoutMs ?? 8000}ms</span>
                      ) 내에 응답이 도착하지 않아 요청을 중단했습니다(호출 시간:{' '}
                      <span className="font-mono">{testResult.latencyMs}ms</span>).
                    </p>
                  )}

                {!testResult.ok && testResult.upstreamErrorMessage && (
                  <p className="text-[11px] text-red-900 bg-white/90 border border-red-200 rounded px-2.5 py-1.5 leading-relaxed break-words">
                    <strong className="font-semibold">Google API 응답 상세:</strong>{' '}
                    <span className="font-mono">{testResult.upstreamErrorMessage}</span>
                  </p>
                )}

                {testResult.availableGenerateModels &&
                  testResult.availableGenerateModels.length > 0 && (
                    <div className="text-[11px] text-slate-700 bg-white/90 border border-slate-200 rounded px-2.5 py-2 space-y-2">
                      <p className="leading-relaxed">
                        <strong className="font-semibold">
                          계정에서 조회된 generateContent 지원 모델:
                        </strong>{' '}
                        <span className="font-mono">
                          {testResult.availableGenerateModels.join(', ')}
                        </span>
                      </p>

                      <div className="pt-1.5 border-t border-slate-200/80 space-y-1.5">
                        <p className="font-semibold text-slate-800">
                          다른 모델 1회 호환성 검증 및 AI 업무 계획 모델 전환 (GEMINI_MODEL 변경 없이 테스트)
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label="검증할 후보 모델 선택"
                            value={candidateModelInput}
                            onChange={(e) => setCandidateModelInput(e.target.value)}
                            className="px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-teal-700"
                          >
                            {Array.from(
                              new Set([
                                ...(testResult.recommendedModel
                                  ? [testResult.recommendedModel]
                                  : []),
                                ...testResult.availableGenerateModels,
                              ]),
                            ).map((modelId) => (
                              <option key={modelId} value={modelId}>
                                {modelId}
                                {modelId === testResult.recommendedModel ? ' (추천)' : ''}
                                {modelId === testResult.configuredModel ? ' (서버 기본)' : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={
                              testingCandidate ||
                              testingKey ||
                              savingKey ||
                              !candidateModelInput
                            }
                            onClick={() => void handleTestCandidateModel()}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                          >
                            {testingCandidate
                              ? '1회 검증 중...'
                              : '선택 모델 1회 테스트'}
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          짧은 비개인정보 문장 1회(최소 토큰·JSON 스키마 없음·재시도 없음)만 호출해 실제 동작과 토큰 사용량을 확인한 뒤 AI 업무 계획에 바로 적용할 수 있습니다.
                        </p>
                      </div>
                    </div>
                  )}

                {testResult.ok && testResult.generateContentOk && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-teal-200/70">
                    <span className="text-[11px] text-teal-900">
                      {preferredPlannerModel === testResult.model
                        ? `현재 이 모델(${testResult.model})이 AI 업무 계획에 적용되어 있습니다.`
                        : `검증에 성공한 ${testResult.model} 모델을 서버 재배포 없이 AI 업무 계획에 바로 적용할 수 있습니다.`}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {preferredPlannerModel === testResult.model ? (
                        <button
                          type="button"
                          onClick={handleResetPlannerModelOverride}
                          className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
                        >
                          서버 기본으로 복원
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleApplyModelForPlanner(testResult.model)}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-md hover:bg-teal-800 whitespace-nowrap cursor-pointer"
                        >
                          이 모델을 AI 업무 계획에 적용
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {testResult.warning && (
                  <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 leading-relaxed">
                    {testResult.warning}
                  </p>
                )}
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                내 AI 사용량 및 토큰 현황
              </h3>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                  서버: {aiStatus?.model ?? 'gemini-4-hydrogen'}
                </span>
                <span
                  className={`font-mono text-[11px] px-2 py-0.5 rounded border ${
                    preferredPlannerModel
                      ? 'text-teal-800 bg-teal-50 border-teal-200 font-semibold'
                      : 'text-slate-600 bg-slate-50 border-slate-200'
                  }`}
                >
                  계획:{' '}
                  {preferredPlannerModel ??
                    aiStatus?.plannerModel ??
                    aiStatus?.model ??
                    'gemini-4-hydrogen'}
                </span>
                {preferredPlannerModel && (
                  <button
                    type="button"
                    onClick={handleResetPlannerModelOverride}
                    className="text-[11px] font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 cursor-pointer"
                  >
                    기본 복원
                  </button>
                )}
              </div>
            </div>

            {statusLoading && !aiStatus ? (
              <p className="text-xs text-slate-500">사용량을 불러오는 중입니다...</p>
            ) : aiStatus ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center tabular-nums">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">오늘 AI 업무 계획</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {aiStatus.usage.todayPlanCount} / {aiStatus.dailyPlanLimit}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">오늘 업무 등록 AI 분석</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {aiStatus.usage.todayNoticeCount ??
                        Math.max(
                          0,
                          aiStatus.usage.todayTotalCount - aiStatus.usage.todayPlanCount,
                        )}
                      회
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

                <p className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 leading-relaxed">
                  <strong>사용량 집계 기준:</strong> 정상 응답을 완료한 요청만 「AI 업무 계획」과 「업무 등록 AI 분석」 합계에 차감됩니다. 시간 초과·파싱 오류·취소 등 실패한 요청은 앱 내 호출 횟수에 차감되지 않습니다.
                </p>

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
                <strong>앱 내 일일 보호 한도 및 실패 요청 처리:</strong> 계획 생성·업무 등록 AI 분석을 합산한 전체 호출 한도는{' '}
                <strong>한국시간(Asia/Seoul) 자정</strong>에 초기화되며, 오류·시간 초과로 실패한 요청은 앱 한도에 차감되지 않습니다. (단, Gemini 서버까지 도달한 시간 초과·응답 잘림 요청은 Google AI Studio 계정 측 사용량에는 일부 반영될 수 있습니다.)
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
