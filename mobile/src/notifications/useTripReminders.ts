import { useCallback, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';

import type { ReminderTrip } from '@/notifications/tripReminders';
import { rescheduleTripReminders } from '@/notifications/tripReminderScheduler';

export function useTripReminders(
  role: 'driver' | 'passenger',
  trips: ReminderTrip[] | undefined,
  refreshKey: number
): void {
  const reschedule = useCallback(() => {
    if (trips) void rescheduleTripReminders(role, trips);
  }, [role, trips]);

  useEffect(() => {
    reschedule();
  }, [refreshKey, reschedule]);

  useFocusEffect(useCallback(() => {
    reschedule();
  }, [reschedule]));
}
