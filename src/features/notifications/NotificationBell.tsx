import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Calendar, CheckSquare, Clock } from 'lucide-react';
import { buildInAppNotifications } from '../../lib/notifications';
import { useEventData } from '../calendar/EventDataContext';
import { useTaskData } from '../tasks/TaskDataContext';

interface NotificationBellProps {
  now: Date;
  onSelectTask: (taskId: string) => void;
  onSelectEvent: (eventId: string) => void;
}

export function NotificationBell({
  now,
  onSelectTask,
  onSelectEvent,
}: NotificationBellProps) {
  const { briefingTasks } = useTaskData();
  const { events } = useEventData();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(
    () =>
      buildInAppNotifications({
        tasks: briefingTasks,
        events,
        now,
        soonMinutes: 120,
      }),
    [briefingTasks, events, now],
  );

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          summary.totalCount > 0
            ? `알림 ${summary.totalCount}건`
            : '알림 없음'
        }
        className="relative inline-flex items-center justify-center p-2 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
      >
        <Bell className="w-4 h-4" aria-hidden="true" />
        {summary.totalCount > 0 && (
          <span
            className={`ml-1.5 text-[11px] font-bold tabular-nums ${
              summary.urgentCount > 0 ? 'text-red-700' : 'text-teal-800'
            }`}
          >
            {summary.totalCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="오늘의 앱 내 알림"
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white border border-slate-200 rounded-xl shadow-lg z-30 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900">오늘의 알림</h2>
              <p className="text-[11px] text-slate-500 tabular-nums">
                곧 시작할 일정 · 기한 초과 · 재확인 업무 {summary.totalCount}건
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              닫기
            </button>
          </div>

          {summary.items.length === 0 ? (
            <div className="px-4 py-8 text-center space-y-1">
              <p className="text-xs font-semibold text-slate-800">
                지금 바로 확인할 알림이 없습니다
              </p>
              <p className="text-[11px] text-slate-500">
                기한 초과·오늘 재확인 업무나 오늘 예정된 일정이 생기면 여기에 표시됩니다.
              </p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {summary.items.map((item) => {
                const isUrgent = item.severity === 'urgent';
                const isWarn = item.severity === 'warn';
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (item.targetType === 'task') {
                        onSelectTask(item.targetId);
                      } else {
                        onSelectEvent(item.targetId);
                      }
                    }}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-start gap-2.5 cursor-pointer ${
                      isUrgent ? 'bg-red-50/35' : ''
                    }`}
                  >
                    <span className="mt-0.5 shrink-0">
                      {item.kind === 'event_starting_soon' ? (
                        <Clock
                          className="w-4 h-4 text-red-700"
                          aria-hidden="true"
                        />
                      ) : item.targetType === 'event' ? (
                        <Calendar
                          className="w-4 h-4 text-teal-700"
                          aria-hidden="true"
                        />
                      ) : (
                        <CheckSquare
                          className={`w-4 h-4 ${
                            isUrgent
                              ? 'text-red-700'
                              : isWarn
                                ? 'text-amber-700'
                                : 'text-teal-700'
                          }`}
                          aria-hidden="true"
                        />
                      )}
                    </span>

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p
                        className={`text-[11px] font-semibold ${
                          isUrgent
                            ? 'text-red-800'
                            : isWarn
                              ? 'text-amber-800'
                              : 'text-teal-800'
                        }`}
                      >
                        {item.categoryLabel}
                      </p>
                      <p className="text-xs font-semibold text-slate-900 truncate">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-500 tabular-nums truncate">
                        {item.detail}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
