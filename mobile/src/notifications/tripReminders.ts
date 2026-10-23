export type ReminderStop = {
  stop_type: 'pickup' | 'dropoff';
  planned_at: string | null;
  sequence?: number;
};

export type ReminderTrip = {
  id: string;
  status: string;
  starts_at?: string | null;
  scheduled_at?: string | null;
  stops?: ReminderStop[];
  own_stops?: ReminderStop[];
};

export type ScheduledReminder = {
  identifier: string;
  fireAt: number | null;
};

export type TripReminder = Omit<ScheduledReminder, 'fireAt'> & {
  fireAt: number;
  tripId: string;
  type: 'driver-60' | 'driver-15' | 'passenger-30';
  title: string;
  body: string;
  screen: 'driver' | 'passenger';
};

export type ReminderPlan = {
  schedule: TripReminder[];
  cancel: string[];
};

const REMINDER_PREFIX = 'globalride-trip-reminder:';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 20;

function localTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function getTripReminders(
  role: 'driver' | 'passenger',
  trip: ReminderTrip,
  now: number
): TripReminder[] {
  if (trip.status !== 'accepted') return [];

  if (role === 'driver') {
    const firstStop = [...(trip.stops ?? [])]
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))[0];
    const start = firstStop?.planned_at ?? trip.starts_at ?? trip.scheduled_at;
    if (!start) return [];
    const startAt = Date.parse(start);
    if (!Number.isFinite(startAt)) return [];
    const time = localTime(start);
    const reminders: TripReminder[] = [
      {
        identifier: `${REMINDER_PREFIX}driver:${trip.id}:60`,
        tripId: trip.id,
        type: 'driver-60' as const,
        fireAt: startAt - 60 * 60_000,
        title: 'Trip reminder',
        body: `Your trip starts at ${time}. Open the app when you're ready to start.`,
        screen: 'driver' as const,
      },
      {
        identifier: `${REMINDER_PREFIX}driver:${trip.id}:15`,
        tripId: trip.id,
        type: 'driver-15' as const,
        fireAt: startAt - 15 * 60_000,
        title: 'Trip reminder',
        body: 'Your trip starts in 15 minutes. Check your vehicle and passengers in the app.',
        screen: 'driver' as const,
      },
    ].filter(({ fireAt }) => fireAt >= now && fireAt <= now + WEEK_MS);
    return reminders;
  }

  const pickup = [...(trip.own_stops ?? [])]
    .filter((stop) => stop.stop_type === 'pickup')
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))[0];
  if (!pickup?.planned_at) return [];
  const pickupAt = Date.parse(pickup.planned_at);
  if (!Number.isFinite(pickupAt)) return [];
  const fireAt = pickupAt - 30 * 60_000;
  if (fireAt < now || fireAt > now + WEEK_MS) return [];
  return [{
    identifier: `${REMINDER_PREFIX}passenger:${trip.id}:30`,
    tripId: trip.id,
    type: 'passenger-30',
    fireAt,
    title: 'Ride reminder',
    body: `Your ride is at ${localTime(pickup.planned_at)}. Be ready at your pick-up point.`,
    screen: 'passenger',
  }];
}

export function planTripReminders(
  role: 'driver' | 'passenger',
  trips: ReminderTrip[],
  now: number,
  existing: ScheduledReminder[]
): ReminderPlan {
  const planned = trips
    .flatMap((trip) => getTripReminders(role, trip, now))
    .sort((left, right) => left.fireAt - right.fireAt)
    .slice(0, MAX_REMINDERS);
  const existingById = new Map(existing.map((reminder) => [reminder.identifier, reminder]));
  const plannedById = new Map(planned.map((reminder) => [reminder.identifier, reminder]));
  const cancel = existing
    .filter((reminder) => {
      const next = plannedById.get(reminder.identifier);
      return !next || next.fireAt !== reminder.fireAt;
    })
    .map(({ identifier }) => identifier);
  const schedule = planned.filter((reminder) => {
    const current = existingById.get(reminder.identifier);
    return !current || current.fireAt !== reminder.fireAt;
  });

  return { schedule, cancel };
}

export function isTripReminderIdentifier(identifier: string): boolean {
  return identifier.startsWith(REMINDER_PREFIX);
}
