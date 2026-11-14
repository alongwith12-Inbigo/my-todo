import { useState } from 'react';
import { CalendarCheck2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from './AuthContext';

export function LoginView() {
  const { signInWithGoogle, accessError } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  async function handleLogin() {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch {
      // Error state is handled in AuthContext
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            오늘의 학교는?
          </span>
          <span className="text-xs font-medium text-slate-500 whitespace-nowrap shrink-0">
            고등학교 교사 전용 업무·일정 파트너
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-5xl mx-auto w-full px-6 py-12 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <section className="lg:col-span-7 flex flex-col justify-center space-y-6">
            <p className="text-xs font-semibold tracking-wide text-teal-700">
              나의 하루를 챙기는 업무파트너
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 leading-tight [text-wrap:balance]">
              마감 업무와 자잘한 학교 일을 놓치지 않게 먼저 챙겨드립니다
            </h1>
            <p className="text-base text-slate-600 leading-relaxed max-w-xl">
              수업과 학급 운영, 공문 처리로 바쁜 하루 속에서 오늘 꼭 확인해야 할
              일정과 업무만 차분하게 정리합니다. 교사별 개인 데이터는 본인 계정으로만
              격리 보관됩니다.
            </p>

            {accessError && (
              <div
                role="alert"
                className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
              >
                {accessError}
              </div>
            )}

            <div className="pt-2 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={handleLogin}
                disabled={signingIn}
                className="inline-flex items-center justify-center gap-3 px-6 py-3 rounded-lg bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>
                  {signingIn ? 'Google 로그인 연결 중...' : 'Google 계정으로 시작하기'}
                </span>
              </button>
              <span className="text-xs text-slate-500">
                최초 로그인 후 관리자 승인을 거쳐 이용할 수 있습니다
              </span>
            </div>
          </section>

          <aside className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-7 flex flex-col justify-between space-y-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                이용 안내 및 보안 원칙
              </h2>
              <p className="mt-1.5 text-sm text-slate-500">
                안전한 학교 업무 관리를 위한 3단계 접근 제어
              </p>
            </div>

            <ol className="space-y-5 divide-y divide-slate-100">
              <li className="pt-1 flex items-start gap-3.5">
                <ShieldCheck
                  className="w-5 h-5 text-teal-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    1. 승인제 교사 계정 보호
                  </h3>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                    Google 로그인 후 가입 신청이 접수되며, 관리자가 승인한 교사만
                    업무 공간을 활성화할 수 있습니다.
                  </p>
                </div>
              </li>

              <li className="pt-4 flex items-start gap-3.5">
                <LockKeyhole
                  className="w-5 h-5 text-teal-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    2. 교사 개인 데이터 완전 격리
                  </h3>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                    업무, 일정, 메모는 사용자 UID 경로 아래에만 저장되며, 관리자라도
                    다른 교사의 개인 내용을 열람할 수 없습니다.
                  </p>
                </div>
              </li>

              <li className="pt-4 flex items-start gap-3.5">
                <CalendarCheck2
                  className="w-5 h-5 text-teal-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    3. Asia/Seoul 기준 오늘 브리핑
                  </h3>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                    마감일·처리예정일·재확인일을 구분해 관리하고, 불필요한 DB
                    읽기·쓰기 없이 무료 운영에 맞게 최적화했습니다.
                  </p>
                </div>
              </li>
            </ol>
          </aside>
        </div>
      </main>
    </div>
  );
}
