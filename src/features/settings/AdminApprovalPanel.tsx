import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { formatKstDateTime } from '../../lib/dateKst';
import {
  listAccessRequests,
  reviewAccessRequest,
} from '../../repositories/accessRepo';
import {
  VALIDATION_LIMITS,
  type AccessRecord,
  type AccountRole,
  type AccountStatus,
} from '../../types/domain';
import { formatFirebaseErrorMessage, useAuth } from '../auth/AuthContext';

type FilterOption = AccountStatus | 'all';

const STATUS_LABELS: Record<AccountStatus, string> = {
  pending: '승인 대기',
  active: '이용 중',
  suspended: '사용 중지',
  rejected: '승인 거절',
};

const ROLE_LABELS: Record<AccountRole, string> = {
  teacher: '일반 교사',
  admin: '관리자',
};

export function AdminApprovalPanel() {
  const { accessRecord } = useAuth();
  const [filter, setFilter] = useState<FilterOption>('pending');
  const [rows, setRows] = useState<AccessRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<AccountStatus>('active');
  const [draftRole, setDraftRole] = useState<AccountRole>('teacher');
  const [draftNote, setDraftNote] = useState('');
  const [savingUid, setSavingUid] = useState<string | null>(null);

  const fetchRows = useCallback(async (activeFilter: FilterOption) => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAccessRequests(activeFilter, 50);
      setRows(list);
    } catch (err) {
      setError(formatFirebaseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows(filter);
  }, [filter, fetchRows]);

  if (!accessRecord || accessRecord.role !== 'admin' || accessRecord.status !== 'active') {
    return null;
  }

  function startEdit(row: AccessRecord) {
    setEditingUid(row.uid);
    setDraftStatus(row.status);
    setDraftRole(row.role);
    setDraftNote(row.note || '');
  }

  async function handleSave(targetUid: string) {
    if (!accessRecord || savingUid) return;
    setSavingUid(targetUid);
    setError(null);
    try {
      await reviewAccessRequest({
        targetUid,
        adminUid: accessRecord.uid,
        status: draftStatus,
        role: draftRole,
        note: draftNote,
      });
      setEditingUid(null);
      await fetchRows(filter);
    } catch (err) {
      setError(formatFirebaseErrorMessage(err));
    } finally {
      setSavingUid(null);
    }
  }

  async function handleQuickApprove(row: AccessRecord) {
    if (!accessRecord || savingUid) return;
    setSavingUid(row.uid);
    setError(null);
    try {
      await reviewAccessRequest({
        targetUid: row.uid,
        adminUid: accessRecord.uid,
        status: 'active',
        role: row.role,
        note: row.note || '관리자 승인',
      });
      await fetchRows(filter);
    } catch (err) {
      setError(formatFirebaseErrorMessage(err));
    } finally {
      setSavingUid(null);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900">
              교사 가입 승인 및 권한 관리
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            관리자는 계정 상태와 역할만 관리하며, 다른 교사의 개인 업무·일정·메모는
            열람할 수 없습니다.
          </p>
        </div>

        <button
          type="button"
          onClick={() => fetchRows(filter)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>새로고침</span>
        </button>
      </div>

      <div
        role="tablist"
        aria-label="가입 상태 필터"
        className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
      >
        {(
          [
            ['pending', '승인 대기'],
            ['active', '이용 중'],
            ['suspended', '사용 중지'],
            ['rejected', '거절됨'],
            ['all', '전체'],
          ] as [FilterOption, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              filter === key
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
        >
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          가입 요청 목록을 불러오는 중입니다...
        </div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
          해당 상태의 사용자 내역이 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                <th className="py-2.5 pr-4">이름 · 이메일</th>
                <th className="py-2.5 pr-4 whitespace-nowrap">신청 일시</th>
                <th className="py-2.5 pr-4 whitespace-nowrap">상태</th>
                <th className="py-2.5 pr-4 whitespace-nowrap">역할</th>
                <th className="py-2.5 pr-4">메모</th>
                <th className="py-2.5 text-right whitespace-nowrap">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const isSelf = row.uid === accessRecord.uid;
                const isEditing = editingUid === row.uid;
                const isBusy = savingUid === row.uid;

                return (
                  <tr key={row.uid} className="align-top hover:bg-slate-50/70">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-slate-900">
                        {row.displayName}
                        {isSelf && (
                          <span className="ml-1.5 text-xs font-normal text-teal-700">
                            (본인)
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">{row.email}</div>
                    </td>
                    <td className="py-3 pr-4 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatKstDateTime(row.requestedAt?.toDate?.())}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      {isEditing ? (
                        <select
                          aria-label={`${row.displayName} 상태`}
                          value={draftStatus}
                          disabled={isSelf}
                          onChange={(e) => setDraftStatus(e.target.value as AccountStatus)}
                          className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                        >
                          <option value="pending">승인 대기</option>
                          <option value="active">이용 중</option>
                          <option value="suspended">사용 중지</option>
                          <option value="rejected">승인 거절</option>
                        </select>
                      ) : (
                        <span
                          className={`text-xs font-medium ${
                            row.status === 'active'
                              ? 'text-green-700'
                              : row.status === 'pending'
                                ? 'text-amber-700'
                                : 'text-red-700'
                          }`}
                        >
                          {STATUS_LABELS[row.status]}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      {isEditing ? (
                        <select
                          aria-label={`${row.displayName} 역할`}
                          value={draftRole}
                          disabled={isSelf}
                          onChange={(e) => setDraftRole(e.target.value as AccountRole)}
                          className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                        >
                          <option value="teacher">일반 교사</option>
                          <option value="admin">관리자</option>
                        </select>
                      ) : (
                        <span className="text-xs text-slate-700">
                          {ROLE_LABELS[row.role]}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-xs text-slate-600 max-w-[220px]">
                      {isEditing ? (
                        <input
                          type="text"
                          aria-label={`${row.displayName} 관리 메모`}
                          maxLength={VALIDATION_LIMITS.ADMIN_NOTE_MAX_LEN}
                          value={draftNote}
                          onChange={(e) => setDraftNote(e.target.value)}
                          placeholder="승인/중지 사유"
                          className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                        />
                      ) : (
                        <span className="line-clamp-2">{row.note || '-'}</span>
                      )}
                    </td>
                    <td className="py-3 text-right whitespace-nowrap space-x-2">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleSave(row.uid)}
                            disabled={isBusy}
                            className="px-2.5 py-1 text-xs font-medium bg-teal-700 text-white rounded hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                          >
                            {isBusy ? '저장 중' : '저장'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingUid(null)}
                            disabled={isBusy}
                            className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                          >
                            취소
                          </button>
                        </>
                      ) : (
                        <>
                          {row.status === 'pending' && (
                            <button
                              type="button"
                              onClick={() => handleQuickApprove(row)}
                              disabled={isBusy}
                              className="px-2.5 py-1 text-xs font-medium bg-teal-700 text-white rounded hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                            >
                              승인
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => startEdit(row)}
                            disabled={isSelf}
                            title={
                              isSelf
                                ? '본인 계정의 관리자 권한은 변경할 수 없습니다'
                                : '상태 및 역할 변경'
                            }
                            className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                          >
                            변경
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
