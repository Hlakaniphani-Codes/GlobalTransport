import { deduplicatedGet } from '@/api';

export type PassengerTripPhase =
  | 'requested'
  | 'scheduled'
  | 'driver_on_the_way'
  | 'driver_arrived'
  | 'on_board'
  | 'completed'
  | 'missed';

export type PassengerTripStop = {
  id: string;
  ride_request_id?: string;
  sequence: number;
  stop_type: 'pickup' | 'dropoff';
  address: string;
  suburb: string | null;
  planned_at: string | null;
  status: 'pending' | 'en_route' | 'arrived' | 'completed' | 'skipped';
  eta_at?: string | null;
  eta_updated_at?: string | null;
  eta_phase_hint?: 'on_the_way' | 'little_late' | 'arriving_at' | null;
  projected_at?: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  skip_kind?: string | null;
};

export type PassengerTrip = {
  id: string;
  poll_after_seconds?: number;
  ride_request_id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  starts_at: string;
  rescheduled_at?: string | null;
  completed_at: string | null;
  workplace_name: string | null;
  workplace_address: string | null;
  distance_km: number | null;
  status: 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'missed';
  phase?: PassengerTripPhase;
  eta_phase_hint?: 'on_the_way' | 'little_late' | 'arriving_at' | null;
  eta_updated_at?: string | null;
  delay_minutes: number;
  driver_first_name: string | null;
  driver_contact_number?: string | null;
  vehicle_make: string | null;
  vehicle_colour: string | null;
  vehicle_plate: string | null;
  own_stops: PassengerTripStop[];
  stops_before_pickup?: number;
  stops_before_dropoff?: number;
  cancel_may_be_late?: boolean;
  can_cancel?: boolean;
  has_issues?: boolean;
  passengers_picked_up?: number;
  passengers_dropped_off?: number;
  no_shows?: number;
  exceptions?: number;
  has_rated?: boolean;
  rating?: number | null;
};

export type PassengerRideRequest = {
  id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  status: 'pending' | 'cancelled' | 'assigned' | 'completed' | 'no_show' | 'missed' | 'expired';
  series_id: string | null;
  closed_reason: string | null;
  outcome_reason: string | null;
  request_again: {
    direction: 'to_work' | 'home';
    date: string;
    time_of_day: string;
    repeat_pattern: { weekdays: number[] } | null;
  } | null;
  cancelled_at: string | null;
  cancelled_late: boolean;
  cancel_reason: string | null;
  workplace_name: string;
  company_name: string;
};

export type PassengerRideRequestPage = {
  ride_requests: PassengerRideRequest[];
  next_cursor: string | null;
  poll_after_seconds?: number;
};

export type PassengerTripHistoryPage = {
  trips: PassengerTrip[];
  next_cursor: string | null;
  poll_after_seconds?: number;
};

export type PassengerTripList = {
  trips: PassengerTrip[];
  poll_after_seconds?: number;
};

export async function fetchPassengerTrips(
  scope: 'upcoming' | 'history' = 'upcoming',
  signal?: AbortSignal
): Promise<PassengerTripList> {
  if (scope === 'history') {
    const page = await fetchPassengerTripHistory(undefined, signal);
    return { trips: page.trips, poll_after_seconds: page.poll_after_seconds };
  }
  const response = await deduplicatedGet<PassengerTripList>(
    '/rides/trips',
    { params: { scope }, signal }
  );
  return response.data;
}

export async function fetchPassengerTripHistory(cursor?: string, signal?: AbortSignal): Promise<PassengerTripHistoryPage> {
  const response = await deduplicatedGet<PassengerTripHistoryPage>('/rides/trips', {
    params: { scope: 'history', ...(cursor ? { cursor } : {}) },
    signal,
  });
  return response.data;
}

export async function fetchPassengerTrip(tripId: string, signal?: AbortSignal): Promise<PassengerTrip> {
  const response = await deduplicatedGet<{ trip: PassengerTrip; poll_after_seconds?: number }>(
    `/rides/trips/${tripId}`,
    { signal }
  );
  return { ...response.data.trip, poll_after_seconds: response.data.poll_after_seconds };
}

export async function fetchPassengerRequests(cursor?: string, signal?: AbortSignal): Promise<PassengerRideRequestPage> {
  const response = await deduplicatedGet<PassengerRideRequestPage>('/ride-requests', {
    params: cursor ? { cursor } : undefined,
    signal,
  });
  return response.data;
}

export function displayPassengerSchedule(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function displayPassengerTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}
