import { deduplicatedGet } from '@/api';

export type TripStop = {
  id: string;
  ride_request_id?: string;
  sequence: number;
  stop_type: 'pickup' | 'dropoff';
  address: string;
  suburb: string | null;
  planned_at: string | null;
  status: 'pending' | 'en_route' | 'arrived' | 'completed' | 'skipped';
  en_route_at?: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  skip_kind?: string | null;
  skip_reason?: string | null;
  wait_seconds?: number;
  allowed_actions?: { no_show?: boolean };
  passenger_name: string;
  passenger_surname: string;
  contact_number: string | null;
};

export type DriverTrip = {
  id: string;
  poll_after_seconds?: number;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  starts_at: string;
  ends_at: string;
  workplace_name: string | null;
  workplace_address: string | null;
  distance_km: number | null;
  status: 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'missed';
  started_at: string | null;
  completed_at: string | null;
  closed_reason?: string | null;
  closed_at?: string | null;
  change_ack_required?: boolean;
  change_acknowledged_at?: string | null;
  vehicle_make: string;
  vehicle_model: string;
  registration_number: string;
  seat_count: number;
  passenger_count: number;
  stops: TripStop[];
  has_issues?: boolean;
  delay_minutes?: number;
  delay_reported_at?: string | null;
  stop_groups?: DriverStopGroup[];
  current_stop_group_id?: string | null;
  eta_quick_options?: number[];
  allowed_next_actions?: {
    start: boolean;
    start_reason: string | null;
    report_not_happened: boolean;
    acknowledge_change: boolean;
    arrive: boolean;
    complete: boolean;
    skip: boolean;
    report_no_show: boolean;
    report_dropoff_exception: boolean;
    delay: boolean;
  };
  events?: DriverTripEvent[];
  passengers_picked_up?: number;
  passengers_dropped_off?: number;
  no_shows?: number;
  exceptions?: number;
  duration_minutes?: number | null;
};

export type DriverHome = {
  poll_after_seconds?: number;
  greeting_name: string;
  driver_status: 'pending' | 'approved' | 'rejected' | 'suspended';
  is_available: boolean;
  can_go_online: boolean;
  expired_documents: string[];
  next_trip: Omit<DriverTrip, 'stops' | 'vehicle_make' | 'vehicle_model' | 'registration_number' | 'seat_count'> | null;
  upcoming_trip_count: number;
  upcoming_count: number;
  pending_offer_count: number;
  pending_offers: number;
  attention: DriverAttentionItem[];
};

type DriverHomeResponse = Omit<DriverHome, 'attention'> & {
  attention?: DriverAttentionItem[];
};

export type DriverAttentionItem =
  | {
    type: 'overdue_trip';
    trip_id: string;
    planned_time: string;
    can_still_be_started: boolean;
  }
  | {
    type: 'change_to_confirm';
    trip_id: string;
    what_changed: string;
  }
  | {
    type: 'in_progress_trip';
    trip_id: string;
    planned_time: string;
  };

export type DriverOfferTrip = {
  trip_id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  starts_at: string;
  workplace_name: string | null;
  distance_km: number | null;
  passenger_count: number;
  suburbs: string[];
};

export type DriverOffer = {
  id: string;
  series_id: string;
  expires_at: string;
  window_minutes: number;
  trips: DriverOfferTrip[];
};

export type DriverOfferPage = {
  offers: DriverOffer[];
  next_cursor: string | null;
  poll_after_seconds?: number;
};

export type DriverTripPage = {
  trips: DriverTrip[];
  reminderTrips?: DriverTrip[];
  pagination?: { page: number; page_size: number; total: number; total_pages: number };
  next_cursor?: string | null;
  poll_after_seconds?: number;
};

export type DriverStopGroup = {
  id: string;
  sequence: number;
  stop_type: TripStop['stop_type'];
  address: string;
  suburb: string | null;
  planned_at: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  wait_seconds?: number;
  eta_at?: string | null;
  eta_updated_at?: string | null;
  eta_is_fresh?: boolean;
  status: TripStop['status'];
  stops: TripStop[];
  allowed_actions?: {
    arrive: boolean;
    complete: boolean;
    skip: boolean;
  };
};

export type DriverTripEvent = {
  id: string;
  stop_id: string | null;
  event_type: string;
  actor_role: string | null;
  client_time: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function normalizeStopAddress(address: string, suburb: string | null): string {
  return `${address} ${suburb ?? ''}`
    .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function formatPlaceParts(...parts: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => {
      if (!part) return false;
      const normalized = part.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(' · ');
}

export function groupDriverStops(stops: TripStop[]): DriverStopGroup[] {
  const groups: DriverStopGroup[] = [];
  for (const stop of stops) {
    const addressKey = normalizeStopAddress(stop.address, stop.suburb);
    const key = `${stop.stop_type}:${addressKey}`;
    const previous = groups.at(-1);
    if (previous && `${previous.stop_type}:${normalizeStopAddress(previous.address, previous.suburb)}` === key) {
      previous.stops.push(stop);
      const active = previous.stops.filter(({ status }) => !['completed', 'skipped'].includes(status));
      previous.status = active.length === 0
        ? previous.stops.every(({ status }) => status === 'completed') ? 'completed' : 'skipped'
        : active.some(({ status }) => status === 'arrived') ? 'arrived'
          : active.some(({ status }) => status === 'en_route') ? 'en_route' : 'pending';
      previous.arrived_at = previous.stops.map(({ arrived_at }) => arrived_at).filter(Boolean).sort()[0] ?? null;
      previous.completed_at = previous.stops.map(({ completed_at }) => completed_at).filter(Boolean).sort().at(-1) ?? null;
    } else {
      groups.push({
        id: stop.id,
        sequence: stop.sequence,
        stop_type: stop.stop_type,
        address: stop.address,
        suburb: stop.suburb,
        planned_at: stop.planned_at,
        arrived_at: stop.arrived_at,
        completed_at: stop.completed_at,
        wait_seconds: stop.wait_seconds,
        status: stop.status,
        stops: [stop],
      });
    }
  }
  return groups;
}

export function formatTripTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export function formatPlannedDuration(minutes: number): string {
  const totalMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (hours === 0) return `${remainingMinutes} min`;
  if (remainingMinutes === 0) return `${hours} hr`;
  return `${hours} hr ${remainingMinutes} min`;
}

export function plannedStopGap(previous: string | null, next: string | null): number | null {
  if (!previous || !next) return null;
  const gap = Math.round((Date.parse(next) - Date.parse(previous)) / 60_000);
  return Number.isFinite(gap) && gap >= 0 ? gap : null;
}

export function formatTripDate(value: string): { month: string; day: string; weekday: string; full: string } {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    month: 'short',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(date);
  return {
    month: parts.find(({ type }) => type === 'month')?.value ?? '',
    day: parts.find(({ type }) => type === 'day')?.value ?? '',
    weekday: parts.find(({ type }) => type === 'weekday')?.value ?? '',
    full: new Intl.DateTimeFormat('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      dateStyle: 'medium',
    }).format(date),
  };
}

export function tripHeadline(trip: Pick<DriverTrip, 'direction' | 'scheduled_at' | 'starts_at' | 'workplace_name'>): string {
  if (trip.direction === 'to_work') {
    return `${formatTripTime(trip.starts_at)} for ${formatTripTime(trip.scheduled_at)}`;
  }
  return `Starts ${formatTripTime(trip.starts_at)} · Ride home`;
}

export async function fetchDriverHome(signal?: AbortSignal): Promise<DriverHome> {
  const response = await deduplicatedGet<DriverHomeResponse>('/driver/home', { signal });
  const { attention } = response.data;
  if (attention !== undefined && !Array.isArray(attention)) {
    throw new Error('Trip attention details could not be loaded. Please refresh and try again.');
  }
  return { ...response.data, attention: attention ?? [] };
}

export async function fetchDriverTrips(
  scope: 'upcoming' | 'history' = 'upcoming',
  pageOrCursor: number | string = 1,
  signal?: AbortSignal
): Promise<DriverTripPage> {
  const params = scope === 'history' && typeof pageOrCursor === 'string'
    ? { scope, cursor: pageOrCursor, page_size: 25 }
    : { scope, page: typeof pageOrCursor === 'number' ? pageOrCursor : 1, page_size: 25 };
  const response = await deduplicatedGet<DriverTripPage>('/driver/trips', { params, signal });
  return response.data;
}

export async function fetchUpcomingDriverTrips(signal?: AbortSignal): Promise<DriverTripPage> {
  const firstPage = await fetchDriverTrips('upcoming', 1, signal);
  const reminderTrips = [...firstPage.trips];
  const reminderWindowEnd = Date.now() + 7 * 24 * 60 * 60_000;

  const pagination = firstPage.pagination;
  for (let page = (pagination?.page ?? 1) + 1; page <= (pagination?.total_pages ?? 1); page += 1) {
    const nextPage = await fetchDriverTrips('upcoming', page, signal);
    reminderTrips.push(...nextPage.trips);
    const lastTrip = nextPage.trips.at(-1);
    const lastTripStart = lastTrip && Date.parse(lastTrip.starts_at || lastTrip.scheduled_at);
    if (lastTripStart && lastTripStart > reminderWindowEnd) break;
  }

  return { ...firstPage, reminderTrips };
}

export async function fetchDriverTrip(tripId: string, signal?: AbortSignal): Promise<DriverTrip> {
  const response = await deduplicatedGet<{ trip: DriverTrip; poll_after_seconds?: number }>(
    `/driver/trips/${tripId}`,
    { signal }
  );
  return { ...response.data.trip, poll_after_seconds: response.data.poll_after_seconds };
}

export async function fetchDriverOffers(cursor?: string, signal?: AbortSignal): Promise<DriverOfferPage> {
  const response = await deduplicatedGet<DriverOfferPage>('/driver/offers', {
    params: cursor ? { cursor } : undefined,
    signal,
  });
  return response.data;
}
