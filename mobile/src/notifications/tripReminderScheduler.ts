import { Platform } from 'react-native';
import { getAllScheduledNotificationsAsync } from 'expo-notifications/build/getAllScheduledNotificationsAsync';
import { scheduleNotificationAsync } from 'expo-notifications/build/scheduleNotificationAsync';
import { cancelScheduledNotificationAsync } from 'expo-notifications/build/cancelScheduledNotificationAsync';
import { SchedulableTriggerInputTypes } from 'expo-notifications/build/Notifications.types';

import type { ReminderTrip, ScheduledReminder } from '@/notifications/tripReminders';
import { isTripReminderIdentifier, planTripReminders } from '@/notifications/tripReminders';

let schedulerQueue: Promise<void> = Promise.resolve();

function scheduledFireTime(trigger: unknown): number | null {
  if (trigger && typeof trigger === 'object' && 'date' in trigger) {
    const date = trigger.date;
    const timestamp = typeof date === 'number' ? date : Date.parse(String(date));
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

async function reconcileTripReminders(
  role: 'driver' | 'passenger',
  trips: ReminderTrip[]
): Promise<void> {
  if (Platform.OS === 'web') return;
  const allScheduled = await getAllScheduledNotificationsAsync();
  const reminders = allScheduled.filter(({ identifier }) => isTripReminderIdentifier(identifier));
  const existing: ScheduledReminder[] = reminders.map((request) => ({
    identifier: request.identifier,
    fireAt: scheduledFireTime(request.trigger),
  }));
  const plan = planTripReminders(role, trips, Date.now(), existing);
  const cancelSet = new Set(plan.cancel);
  for (const reminder of reminders) {
    if (cancelSet.has(reminder.identifier)) {
      await cancelScheduledNotificationAsync(reminder.identifier);
    }
  }
  for (const reminder of plan.schedule) {
    await scheduleNotificationAsync({
      identifier: reminder.identifier,
      content: {
        title: reminder.title,
        body: reminder.body,
        sound: 'default',
        data: {
          reminder_id: reminder.identifier,
          trip_id: reminder.tripId,
          screen: reminder.screen,
        },
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: reminder.fireAt,
      },
    });
  }
}

export function rescheduleTripReminders(
  role: 'driver' | 'passenger',
  trips: ReminderTrip[]
): Promise<void> {
  const task = schedulerQueue.then(() => reconcileTripReminders(role, trips));
  schedulerQueue = task.catch((error: unknown) => {
    console.error('Trip reminders could not be synchronized.', error);
  });
  return schedulerQueue;
}

export async function cancelTripReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  const scheduled = await getAllScheduledNotificationsAsync();
  for (const request of scheduled) {
    if (isTripReminderIdentifier(request.identifier)) {
      await cancelScheduledNotificationAsync(request.identifier);
    }
  }
}

export async function cancelTripRemindersForTrip(tripId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  const scheduled = await getAllScheduledNotificationsAsync();
  for (const request of scheduled) {
    if (request.content.data?.trip_id === tripId
      && isTripReminderIdentifier(request.identifier)) {
      await cancelScheduledNotificationAsync(request.identifier);
    }
  }
}
