import { useEffect, useState, type FormEvent } from 'react';
import {
  updateUserPreferences,
  updateUserProfile,
} from '../../repositories/workspaceRepo';
import {
  VALIDATION_LIMITS,
  type CalendarViewMode,
} from '../../types/domain';
import { formatFirebaseErrorMessage, useAuth } from '../auth/AuthContext';
import { AdminApprovalPanel } from './AdminApprovalPanel';
import { AiByokSettingsSection } from './AiByokSettingsSection';

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
          내 교사 프로필, 업무 브리핑 기준, 개인 Gemini API 키를 관리합니다.
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

      <AiByokSettingsSection uid={firebaseUser.uid} />

      {accessRecord.role === 'admin' && <AdminApprovalPanel />}
    </div>
  );
}
