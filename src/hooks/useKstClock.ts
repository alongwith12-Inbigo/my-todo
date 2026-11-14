import { useEffect, useState } from 'react';
import { getKstDateParts } from '../lib/dateKst';

/**
 * Provides a live Date synced once per minute and on tab visibility changes,
 * so open-app notifications and date-sensitive UI update as time/date advances
 * without polling Firestore.
 */
export function useKstClock(): { now: Date; todayKey: string } {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const tick = () => {
      setNow(new Date());
    };

    const intervalId = window.setInterval(tick, 60_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const todayKey = getKstDateParts(now).dateKey;
  return { now, todayKey };
}
