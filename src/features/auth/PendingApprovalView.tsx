import { useState, type FormEvent } from 'react';
import { Check, Copy, LogOut, ShieldAlert } from 'lucide-react';
import { formatKstDateTime } from '../../lib/dateKst';
import { submitAccessRequest } from '../../repositories/accessRepo';
import { VALIDATION_LIMITS } from '../../types/domain';
import { formatFirebaseErrorMessage, useAuth } from './AuthContext';
import firebaseConfig from '../../../firebase-applet-config.json';

export function PendingApprovalView() {
  const { firebaseUser, accessRecord, accessError, signOutUser } = useAuth();
  const [displayName, setDisplayName] = useState(
    firebaseUser?.displayName || firebaseUser?.email?.split('@')[0] || '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copiedUid, setCopiedUid] = useState(false);

  if (!firebaseUser) return null;

  async function handleRequestSubmit(e: FormEvent) {
    e.preventDefault();
    if (!firebaseUser || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitAccessRequest(firebaseUser, displayName);
    } catch (err) {
      setSubmitError(formatFirebaseErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyUid() {
    if (!firebaseUser) return;
    try {
      await navigator.clipboard.writeText(firebaseUser.uid);
      setCopiedUid(true);
      setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Clipboard fallback ignored if blocked
    }
  }

  const status = accessRecord?.status;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            오늘의 학교는?
          </span>
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-500 hidden sm:inline truncate max-w-[220px]">
              {firebaseUser.email}
            </span>
            <button
              type="button"
              onClick={signOutUser}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
              <span>로그아웃</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-12 space-y-6">
        {(accessError || submitError) && (
          <div
            role="alert"
            className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
          >
            {submitError || accessError}
          </div>
        )}

        {!accessRecord ? (
          <section className="bg-white border border-slate-200 rounded-xl p-8 space-y-6">
            <div>
              <p className="text-xs font-semibold text-teal-700">신규 이용 신청</p>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">
                교사 계정 가입 승인 요청
              </h1>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                승인된 교사만 개인 업무·일정 공간을 사용할 수 있습니다. 신청 시 기본
                권한은 <strong className="font-semibold text-slate-900">일반 교사(승인 대기)</strong>로
                등록되며, 관리자 승인 후 바로 시작할 수 있습니다.
              </p>
            </div>

            <form onSubmit={handleRequestSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="signup-email"
                  className="block text-xs font-medium text-slate-600 mb-1.5"
                >
                  인증된 Google 이메일
                </label>
                <input
                  id="signup-email"
                  type="email"
                  value={firebaseUser.email || ''}
                  readOnly
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-600"
                />
              </div>

              <div>
                <label
                  htmlFor="signup-display-name"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  이름 (관리자 승인 목록에 표시)
                </label>
                <input
                  id="signup-display-name"
                  type="text"
                  required
                  minLength={VALIDATION_LIMITS.DISPLAY_NAME_MIN_LEN}
                  maxLength={VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="예: 홍길동 선생님"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>

              <div className="pt-1 flex items-center justify-end gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 rounded-lg bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {submitting ? '신청 등록 중...' : '가입 승인 신청하기'}
                </button>
              </div>
            </form>
          </section>
        ) : (
          <section className="bg-white border border-slate-200 rounded-xl p-8 space-y-6">
            <div className="space-y-2">
              <p
                className={`text-xs font-semibold ${
                  status === 'pending' ? 'text-amber-700' : 'text-red-700'
                }`}
              >
                {status === 'pending' && '승인 대기 중'}
                {status === 'rejected' && '승인 거절됨'}
                {status === 'suspended' && '사용 중지됨'}
              </p>
              <h1 className="text-2xl font-bold text-slate-900">
                {status === 'pending' && '관리자 승인을 기다리고 있습니다'}
                {status === 'rejected' && '가입 신청이 승인되지 않았습니다'}
                {status === 'suspended' && '계정 이용이 일시 중지되었습니다'}
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                {status === 'pending' &&
                  '관리자가 계정을 승인하면 이 화면이 자동으로 개인 업무 공간으로 전환됩니다.'}
                {status === 'rejected' &&
                  '필요한 경우 학교 관리자에게 계정 승인 여부를 문의해 주세요.'}
                {status === 'suspended' &&
                  '서비스 접근이 제한되어 있습니다. 관리자에게 상태 변경을 요청해 주세요.'}
              </p>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4 border-y border-slate-100 text-sm">
              <div>
                <dt className="text-xs text-slate-500">신청자</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {accessRecord.displayName}
                  <span className="text-slate-400 mx-1.5">·</span>
                  <span className="text-slate-600">{accessRecord.email}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">신청 일시 (Asia/Seoul)</dt>
                <dd className="mt-1 font-medium text-slate-900 tabular-nums">
                  {formatKstDateTime(accessRecord.requestedAt?.toDate?.())}
                </dd>
              </div>
              {accessRecord.note && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-slate-500">관리자 안내 메모</dt>
                  <dd className="mt-1 text-slate-800">{accessRecord.note}</dd>
                </div>
              )}
            </dl>

            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-600">내 계정 UID</p>
                <p className="mt-0.5 text-xs font-mono text-slate-800 truncate">
                  {firebaseUser.uid}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopyUid}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedUid ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                    <span>복사됨</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>UID 복사</span>
                  </>
                )}
              </button>
            </div>

            {status === 'pending' && (
              <details className="border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-2">
                <summary className="cursor-pointer font-semibold text-slate-800 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
                  <span>최초 관리자(Bootstrap Admin) 지정 안내 — 초기 1회</span>
                </summary>
                <div className="pt-3 space-y-2 leading-relaxed">
                  <p>
                    보안상 관리자 이메일은 소스 코드에 저장하지 않습니다. 시스템의 첫
                    관리자 계정은 아래 두 가지 신뢰된 방법 중 하나로 지정해 주세요.
                  </p>
                  <p className="font-medium text-slate-800">
                    방법 A. Firebase Console에서 직접 지정 (가장 간편)
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-slate-600">
                    <li>
                      Firebase Console → Firestore Database (데이터베이스 ID:{' '}
                      <code className="font-mono text-slate-800">
                        {firebaseConfig.firestoreDatabaseId}
                      </code>
                      ) 이동
                    </li>
                    <li>
                      <code className="font-mono text-slate-800">
                        access/{firebaseUser.uid}
                      </code>{' '}
                      문서 열기
                    </li>
                    <li>
                      <code className="font-mono text-slate-800">role</code> 값을{' '}
                      <code className="font-mono text-slate-800">&quot;admin&quot;</code>,{' '}
                      <code className="font-mono text-slate-800">status</code> 값을{' '}
                      <code className="font-mono text-slate-800">&quot;active&quot;</code>로 저장
                    </li>
                  </ol>
                  <p className="font-medium text-slate-800 pt-1">
                    방법 B. 신뢰된 초기화 CLI 스크립트 실행
                  </p>
                  <pre className="p-2.5 rounded bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
                    {`GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \\\nnode scripts/bootstrap-admin.mjs --uid ${firebaseUser.uid}`}
                  </pre>
                </div>
              </details>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
