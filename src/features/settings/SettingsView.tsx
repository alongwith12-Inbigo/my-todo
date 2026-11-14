import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import {
  getStoredAiEnabled,
  setStoredAiEnabled,
} from '../../lib/aiPreferences';
import type { AiStatusResponse } from '../../lib/aiTypes';
import {
  updateUserPreferences,
  updateUserProfile,
} from '../../repositories/workspaceRepo';
import { fetchAiServerStatus } from '../../services/aiClient';
import {
  VALIDATION_LIMITS,
  type CalendarViewMode,
} from '../../types/domain';
import { formatFirebaseErrorMessage, useAuth } from '../auth/AuthContext';
import { AdminApprovalPanel } from './AdminApprovalPanel';

export function SettingsView() {
  const { firebaseUser, accessRecord, workspace, setWorkspace } = useAuth();
  const [displayName, setDisplayName] = useState(
    workspace?.profile.displayName || accessRecord?.displayName || '',
  );
  const [schoolName, setSchoolName] = useState(
    workspace?.profile.schoolName || '',
  );
  const [subject, setSubject] = useState(workspace?.profile.subject || '');

  const [imminentDays, setImminentDays] = useState(
    workspace?.preferences.imminentDays ?? 3,
  );
  const [defaultCalendarView, setDefaultCalendarView] = useState<CalendarViewMode>(
    workspace?.preferences.defaultCalendarView ?? 'week',
  );
  const [browserNotifyEnabled, setBrowserNotifyEnabled] = useState(
    workspace?.preferences.browserNotifyEnabled ?? false,
  );

  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [aiEnabled, setAiEnabled] = useState(() =>
    getStoredAiEnabled(firebaseUser?.uid),
  );
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [aiStatusLoading, setAiStatusLoading] = useState(false);
  const [aiStatusError, setAiStatusError] = useState<string | null>(null);

  const loadAiStatus = useCallback(async () => {
    setAiStatusLoading(true);
    setAiStatusError(null);
    try {
      const status = await fetchAiServerStatus();
      setAiStatus(status);
    } catch (err) {
      setAiStatusError(
        err instanceof Error
          ? err.message
          : '서버 AI 연결 상태를 확인하지 못했습니다.',
      );
    } finally {
      setAiStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    setAiEnabled(getStoredAiEnabled(firebaseUser?.uid));
  }, [firebaseUser?.uid]);

  useEffect(() => {
    if (!firebaseUser || accessRecord?.status !== 'active') return;
    void loadAiStatus();
  }, [firebaseUser, accessRecord?.status, loadAiStatus]);

  useEffect(() => {
    if (!workspace) return;
    setDisplayName(workspace.profile.displayName);
    setSchoolName(workspace.profile.schoolName);
    setSubject(workspace.profile.subject);
    setImminentDays(workspace.preferences.imminentDays);
    setDefaultCalendarView(workspace.preferences.defaultCalendarView);
    setBrowserNotifyEnabled(workspace.preferences.browserNotifyEnabled);
  }, [workspace]);

  if (!firebaseUser || !accessRecord || !workspace) {
    return null;
  }

  async function handleProfileSubmit(e: FormEvent) {
    e.preventDefault();
    if (!firebaseUser || !workspace || savingProfile) return;
    setSavingProfile(true);
    setFeedback(null);
    try {
      const updated = await updateUserProfile(firebaseUser.uid, {
        displayName,
        schoolName,
        subject,
      });
      setWorkspace({ ...workspace, profile: updated });
      setFeedback({ type: 'success', message: '개인 프로필을 저장했습니다.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: formatFirebaseErrorMessage(err),
      });
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePrefsSubmit(e: FormEvent) {
    e.preventDefault();
    if (!firebaseUser || !workspace || savingPrefs) return;
    setSavingPrefs(true);
    setFeedback(null);
    try {
      const updated = await updateUserPreferences(firebaseUser.uid, {
        imminentDays,
        defaultCalendarView,
        browserNotifyEnabled,
      });
      setWorkspace({ ...workspace, preferences: updated });
      setFeedback({ type: 'success', message: '환경 설정을 저장했습니다.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: formatFirebaseErrorMessage(err),
      });
    } finally {
      setSavingPrefs(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">설정</h1>
        <p className="mt-1 text-sm text-slate-600">
          내 교사 프로필과 업무 브리핑 기준을 관리합니다.
        </p>
      </div>

      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-sm ${
            feedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleProfileSubmit}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">개인 프로필</h2>
            <p className="mt-1 text-xs text-slate-500">
              이 정보는 본인 계정 경로에만 안전하게 저장됩니다.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="profile-name"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                표시 이름
              </label>
              <input
                id="profile-name"
                type="text"
                required
                minLength={VALIDATION_LIMITS.DISPLAY_NAME_MIN_LEN}
                maxLength={VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor="profile-school"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                소속 학교 (선택)
              </label>
              <input
                id="profile-school"
                type="text"
                maxLength={VALIDATION_LIMITS.SCHOOL_NAME_MAX_LEN}
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                placeholder="예: 한빛고등학교"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor="profile-subject"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                담당 교과 · 업무 (선택)
              </label>
              <input
                id="profile-subject"
                type="text"
                maxLength={VALIDATION_LIMITS.SUBJECT_MAX_LEN}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="예: 통합사회 · 2학년부"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingProfile}
              className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {savingProfile ? '저장 중...' : '프로필 저장'}
            </button>
          </div>
        </form>

        <form
          onSubmit={handlePrefsSubmit}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              브리핑 및 일정 기본 설정
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              시간대는 한국 표준시(Asia/Seoul)로 고정 적용됩니다.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="pref-imminent-days"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                마감 임박 기준 일수 (1~14일)
              </label>
              <input
                id="pref-imminent-days"
                type="number"
                min={VALIDATION_LIMITS.IMMINENT_DAYS_MIN}
                max={VALIDATION_LIMITS.IMMINENT_DAYS_MAX}
                value={imminentDays}
                onChange={(e) => setImminentDays(Number(e.target.value) || 3)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:border-teal-700"
              />
            </div>

            <div>
              <label
                htmlFor="pref-calendar-view"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                기본 일정 보기
              </label>
              <select
                id="pref-calendar-view"
                value={defaultCalendarView}
                onChange={(e) =>
                  setDefaultCalendarView(e.target.value as CalendarViewMode)
                }
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
              >
                <option value="week">주간 보기</option>
                <option value="month">월간 보기</option>
              </select>
            </div>

            <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={browserNotifyEnabled}
                onChange={(e) => setBrowserNotifyEnabled(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
              />
              <span className="text-xs leading-relaxed">
                브라우저 탭 열림 상태 알림 사용 (웹 앱이 닫혀 있을 때는 알림이
                발송되지 않습니다)
              </span>
            </label>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingPrefs}
              className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {savingPrefs ? '저장 중...' : '설정 저장'}
            </button>
          </div>
        </form>
      </div>

      {/* Step 5: AI Smart Assistant Settings */}
      <section
        aria-label="AI 스마트 업무비서 설정"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <h2 className="text-base font-semibold text-slate-900">
                AI 스마트 업무비서 설정
              </h2>
            </div>
            <p className="text-xs text-slate-500">
              AI 기능은 선택 사항이며, 사용자가 직접 버튼을 눌러 확인한 경우에만 실행됩니다.
            </p>
          </div>

          <button
            type="button"
            disabled={aiStatusLoading}
            onClick={() => void loadAiStatus()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${aiStatusLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>연결 상태 확인</span>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <label className="flex items-start gap-3 p-3.5 rounded-lg border border-slate-200 bg-slate-50/60 cursor-pointer">
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  setAiEnabled(next);
                  setStoredAiEnabled(firebaseUser.uid, next);
                  setFeedback({
                    type: 'success',
                    message: next
                      ? 'AI 스마트 업무비서 표시를 켰습니다.'
                      : 'AI 스마트 업무비서 표시를 껐습니다. 기본 분석과 기본 브리핑은 계속 사용할 수 있습니다.',
                  });
                }}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
              />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-slate-900">
                  AI 스마트 업무비서 사용 (쪽지 AI 분석 · AI 브리핑)
                </span>
                <span className="block text-xs text-slate-600 leading-relaxed">
                  켜 두어도 자동으로 호출되지 않으며, 사용자가 &lsquo;AI로 분석&rsquo; 또는 &lsquo;AI 브리핑&rsquo;을 클릭했을 때만 동작합니다. 끄면 화면에서 AI 버튼이 숨겨집니다.
                </span>
              </span>
            </label>

            <div className="p-3.5 rounded-lg border border-slate-200 space-y-2 text-xs">
              <p className="font-semibold text-slate-900">서버 AI 연결 상태</p>
              {aiStatusLoading && !aiStatus ? (
                <p className="text-slate-500">서버 연결 상태를 확인하는 중입니다...</p>
              ) : aiStatusError ? (
                <p className="text-red-700">{aiStatusError}</p>
              ) : aiStatus ? (
                <dl className="space-y-1.5 text-slate-700 tabular-nums">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">Gemini API 연결</dt>
                    <dd
                      className={`font-semibold ${
                        aiStatus.configured ? 'text-teal-800' : 'text-amber-800'
                      }`}
                    >
                      {aiStatus.configured
                        ? '서버 키 설정됨 (사용 가능)'
                        : '서버 키 미설정 (기본 분석만 동작)'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">적용 모델</dt>
                    <dd className="font-mono text-[11px] text-slate-900">
                      {aiStatus.model}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">호출 보호 한도</dt>
                    <dd>
                      {aiStatus.rateLimitWindowSeconds}초당 최대 {aiStatus.rateLimitMaxRequests}회 · 최대 {aiStatus.maxNoticeChars.toLocaleString()}자
                    </dd>
                  </div>
                </dl>
              ) : null}
            </div>
          </div>

          <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2.5 text-xs text-slate-700 leading-relaxed">
            <div className="flex items-center gap-1.5 font-semibold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
              <span>개인정보 보호 및 이용 안내</span>
            </div>
            <ul className="list-disc pl-4 space-y-1.5">
              <li>
                API 키는 서버 환경변수(<code className="font-mono">GEMINI_API_KEY</code>)에만 보관되며 브라우저·Firestore·로컬 저장소에 저장하거나 입력받지 않습니다.
              </li>
              <li>
                쪽지 AI 분석 시 전송 전 개인정보(이름·전화번호·이메일·학번·주민등록번호 등)를 점검하고 가림 처리 및 전송 본문 확인 절차를 거칩니다.
              </li>
              <li>
                AI는 업무·일정·메모를 자동으로 저장하거나 수정하지 않으며, 사용자가 검토 후 등록한 항목만 저장됩니다.
              </li>
              <li>
                서버 할당량 또는 유료 API 요금 정책에 따라 호출 비용이 발생할 수 있으므로 불필요한 반복 호출을 피해 주세요.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {accessRecord.role === 'admin' && <AdminApprovalPanel />}
    </div>
  );
}
