import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, ChevronLeft, ChevronRight, LoaderCircle, Plus, Route, Search, Siren, SlidersHorizontal, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiRequestError, apiRequest, queryPollingInterval } from '../api';
import type { RideRequest, Trip } from '../types';

type Pagination = { page: number; page_size: number; total: number; total_pages: number };
type RideRequestPage = { ride_requests: RideRequest[]; pagination: Pagination };
type TripPage = { trips: Trip[]; pagination: Pagination; poll_after_seconds?: number };
type TripStop = {
  id: string;
  ride_request_id: string;
  passenger_name: string;
  passenger_surname: string;
  sequence: number;
  stop_type: 'pickup' | 'dropoff';
  address: string;
  suburb: string | null;
  planned_at: string;
  status: string;
  arrived_at: string | null;
  completed_at: string | null;
  eta_at?: string | null;
  eta_updated_at?: string | null;
  eta_age_minutes?: number | null;
  eta_minutes_late?: number | null;
  eta_is_late?: boolean;
  skip_kind: string | null;
  skip_reason: string | null;
};
type TripEvent = {
  id: string;
  stop_id: string | null;
  event_type: string;
  actor_role: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
type TripRating = {
  id: string;
  passenger_user_id: string;
  passenger_name: string;
  passenger_surname: string;
  rating: number;
  comment: string | null;
  created_at: string;
};
type TripWithdrawal = {
  id: string;
  driver_user_id: string;
  driver_name: string;
  driver_surname: string;
  reason_kind: string;
  note: string | null;
  scope: 'this' | 'all_future';
  late: boolean;
  created_at: string;
};
type TripEditor = {
  distance_km: string;
  notes: string;
  stops: { id: string; planned_at: string }[];
};
type TripPassenger = {
  ride_request_id: string;
  passenger_user_id: string;
  passenger_name: string;
  passenger_surname: string;
  contact_number: string;
  employee_number: string;
  booking_source: 'passenger' | 'admin';
  booked_at: string;
  booked_by: string | null;
  booked_by_name: string | null;
  booked_by_surname: string | null;
  request_status: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_late: boolean;
  pickup_address: string;
  pickup_suburb: string | null;
  pickup_planned_at: string;
  pickup_status: string;
  dropoff_address: string;
  dropoff_suburb: string | null;
  dropoff_planned_at: string;
  dropoff_status: string;
};
const emptyRideRequests: RideRequest[] = [];
type SeriesOffer = {
  id: string;
  driver_user_id: string;
  vehicle_id: string;
  position: number;
  status: string;
  offered_at: string | null;
  expires_at: string | null;
  responded_at: string | null;
  window_minutes: number;
  driver_name: string | null;
  driver_surname: string | null;
  registration_number: string | null;
  has_push_device: boolean;
};
type TripDetail = Trip & {
  poll_after_seconds?: number;
  starts_at: string;
  ends_at: string;
  workplace_address: string;
  distance_km: number | null;
  notes: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  seat_count: number | null;
  has_issues: boolean;
  delay_minutes: number;
  started_at: string | null;
  completed_at: string | null;
  original_scheduled_at: string | null;
  rescheduled_at: string | null;
  closed_reason: string | null;
  closed_at: string | null;
  closed_by: string | null;
  change_ack_required: boolean;
  change_acknowledged_at: string | null;
  stops: TripStop[];
  passengers: TripPassenger[];
  offers: SeriesOffer[];
  events: TripEvent[];
  ratings: TripRating[];
  withdrawals: TripWithdrawal[];
};
type LiveTrip = {
  id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  started_at: string | null;
  workplace_name: string;
  delay_minutes: number;
  has_issues: boolean;
  driver_name: string | null;
  driver_surname: string | null;
  registration_number: string | null;
  no_shows: number;
  exceptions: number;
  open_incidents: number;
  last_update_at: string;
  current_stop_group: {
    sequence: number;
    stop_type: 'pickup' | 'dropoff';
    address: string;
    suburb: string | null;
    status: 'en_route' | 'arrived';
    passenger_count: number;
    eta_at: string | null;
    eta_updated_at: string | null;
    eta_age_minutes: number | null;
    eta_minutes_late: number | null;
    eta_is_late: boolean;
  } | null;
};
type EligibleDriver = {
  user_id: string;
  name: string;
  surname: string;
  vehicle_id: string;
  make: string;
  model: string;
  registration_number: string;
  seat_count: number;
  has_push_device: boolean;
};
type TripSeriesResult = {
  series_id: string;
  trips: { id: string; date: string; status: string }[];
  skipped_dates: { date: string; reason: string }[];
};
type TripCreatePayload = {
  direction: RideRequest['direction'];
  dates: string[];
  target_time?: string;
  workplace_name: string;
  workplace_address: string;
  notes?: string;
  stops: {
    ride_request_id: string;
    stop_type: StopDraft['stop_type'];
    sequence: number;
    planned_time: string;
  }[];
};
type TripCreationReview = {
  result: TripSeriesResult;
  direction: RideRequest['direction'];
  passengers: string[];
  stops: {
    stop_type: StopDraft['stop_type'];
    address: string;
    planned_time: string;
    passengers: string[];
  }[];
};
type TripDatePreview = {
  dates: {
    date: string;
    available: boolean;
    matched_request_groups: number;
    required_request_groups: number;
    missing_request_groups: number;
    missing_request_ids: string[];
  }[];
};
type TripCreateVariables = {
  body: TripCreatePayload;
  review: Omit<TripCreationReview, 'result'>;
  signature: string;
};
type RideRequestFilters = {
  from: string;
  to: string;
  direction: string;
  status: string;
  unassigned_only: boolean;
  search: string;
  sort?: 'asc' | 'desc';
};
type StopDraft = {
  ride_request_id: string;
  stop_type: 'pickup' | 'dropoff';
  planned_time: string;
};

function orderRouteStops(stops: StopDraft[]): StopDraft[] {
  return [
    ...stops.filter(({ stop_type }) => stop_type === 'pickup'),
    ...stops.filter(({ stop_type }) => stop_type === 'dropoff'),
  ];
}

function applyDefaultStopTimes(
  stops: StopDraft[],
  direction: string,
  targetTime: string,
  workplaceTravelMinutes: number,
  stopGapMinutes: number,
  requestsById: ReadonlyMap<string, RideRequest>
): StopDraft[] {
  if (direction === 'home') return stops.map((stop) => ({ ...stop }));
  const target = scheduledTimeMinutes(targetTime);
  if (target === null) return stops.map((stop) => ({ ...stop }));

  const result = stops.map((stop) => ({ ...stop }));
  const stopGroups = (stopType: StopDraft['stop_type']) => {
    const groups: number[][] = [];
    let previousGroup: number[] | null = null;
    let previousAddress = '';
    for (const [index, stop] of result.entries()) {
      if (stop.stop_type !== stopType) {
        previousGroup = null;
        previousAddress = '';
        continue;
      }
      const request = requestsById.get(stop.ride_request_id);
      const address = request ? stopLabel(request, stopType) : stop.ride_request_id;
      const key = normalizeStopAddress(address);
      if (previousGroup && normalizeStopAddress(previousAddress) === key) {
        previousGroup.push(index);
      } else {
        previousGroup = [index];
        groups.push(previousGroup);
      }
      previousAddress = address;
    }
    return groups;
  };
  if (direction === 'to_work') {
    const pickups = stopGroups('pickup');
    pickups.forEach((indexes, pickupIndex) => {
      const minute = target - workplaceTravelMinutes - (pickups.length - pickupIndex - 1) * stopGapMinutes;
      const defaultTime = minute >= 0
        ? `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
        : '';
      const groupTime = indexes.map((index) => result[index].planned_time).find(Boolean) ?? defaultTime;
      indexes.forEach((index) => {
        if (!result[index].planned_time) result[index].planned_time = groupTime;
      });
    });
    result.forEach((stop) => {
      if (stop.stop_type === 'dropoff') stop.planned_time = targetTime;
    });
  }
  return result;
}

const defaultRequestFilters: RideRequestFilters = {
  from: '',
  to: '',
  direction: '',
  status: '',
  unassigned_only: true,
  search: '',
};

function formatSchedule(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatClockTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours} hr`;
  return `${hours} hr ${remainder} min`;
}

function scheduledTimeMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function scheduledGap(previous: string, next: string): number | null {
  const previousMinutes = scheduledTimeMinutes(previous);
  const nextMinutes = scheduledTimeMinutes(next);
  if (previousMinutes === null || nextMinutes === null || nextMinutes < previousMinutes) return null;
  return nextMinutes - previousMinutes;
}

function timestampGap(previous: string, next: string): number | null {
  const difference = Math.round((Date.parse(next) - Date.parse(previous)) / 60_000);
  return Number.isFinite(difference) && difference >= 0 ? difference : null;
}

function tripScheduleSummary(stops: TripStop[]): { duration: number; start: string; end: string } | null {
  if (stops.length < 2) return null;
  const duration = timestampGap(stops[0].planned_at, stops[stops.length - 1].planned_at);
  if (duration === null) return null;
  return {
    duration,
    start: formatSchedule(stops[0].planned_at),
    end: formatSchedule(stops[stops.length - 1].planned_at),
  };
}

function localDateTime(value: string): string {
  return `${localDate(value)}T${localTime(value)}`;
}

function localDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return `${parts.find(({ type }) => type === 'year')?.value}-${parts.find(({ type }) => type === 'month')?.value}-${parts.find(({ type }) => type === 'day')?.value}`;
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function dateList(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function requestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) {
    return error instanceof Error ? error.message : fallback;
  }
  return `${error.message}${error.requestId ? ` (Reference: ${error.requestId})` : ''}`;
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function stopLabel(request: RideRequest, type: StopDraft['stop_type']): string {
  const atHome = type === 'pickup'
    ? request.direction === 'to_work'
    : request.direction === 'home';
  return atHome
    ? `${request.home_address}${request.home_suburb ? `, ${request.home_suburb}` : ''}`
    : `${request.workplace_address ?? request.workplace_name}${request.workplace_suburb ? `, ${request.workplace_suburb}` : ''}`;
}

function normalizeStopAddress(address: string, suburb: string | null = null): string {
  return `${address} ${suburb ?? ''}`.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function groupTripStops(stops: TripStop[]) {
  const groups: { key: string; stop_type: TripStop['stop_type']; address: string; suburb: string | null; stops: TripStop[] }[] = [];
  for (const stop of stops) {
    const key = `${stop.stop_type}:${normalizeStopAddress(stop.address, stop.suburb)}`;
    const previous = groups.at(-1);
    if (previous?.key === key) previous.stops.push(stop);
    else groups.push({
      key,
      stop_type: stop.stop_type,
      address: stop.address,
      suburb: stop.suburb,
      stops: [stop],
    });
  }
  return groups;
}

function readRideRequests(filters: RideRequestFilters, page: number, pageSize = 25, signal?: AbortSignal) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort: filters.sort ?? 'desc',
  });
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.status) params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  if (filters.unassigned_only) params.set('unassigned_only', 'true');
  return apiRequest<RideRequestPage>(`/admin/ride-requests?${params.toString()}`, { signal });
}

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function TripPlanner({ onChanged, openTripId, onTripOpened }: {
  onChanged: () => void;
  openTripId: string | null;
  onTripOpened: () => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'requests' | 'planner' | 'trips' | 'live'>(() =>
    openTripId ? 'trips' : 'requests'
  );
  const [draftFilters, setDraftFilters] = useState(defaultRequestFilters);
  const [requestFilters, setRequestFilters] = useState(defaultRequestFilters);
  const [requestFiltersOpen, setRequestFiltersOpen] = useState(false);
  const [requestPage, setRequestPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedRequestMap, setSelectedRequestMap] = useState<Record<string, RideRequest>>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [dates, setDates] = useState('');
  const [targetTime, setTargetTime] = useState('');
  const workplaceTravelMinutes = 20;
  const stopGapMinutes = 10;
  const [plannerDate, setPlannerDate] = useState(localToday);
  const [plannerDirection, setPlannerDirection] = useState('');
  const [plannerPage, setPlannerPage] = useState(1);
  const [tripNotes, setTripNotes] = useState('');
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [pendingTripCreation, setPendingTripCreation] = useState<{
    result: TripDatePreview;
    variables: TripCreateVariables;
  } | null>(null);
  const [createdSeriesId, setCreatedSeriesId] = useState<string | null>(null);
  const [createdReview, setCreatedReview] = useState<TripCreationReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [offerWindow, setOfferWindow] = useState('30');
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([]);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const offerSectionRef = useRef<HTMLElement | null>(null);

  const [tripPage, setTripPage] = useState(1);
  const [liveTripPage, setLiveTripPage] = useState(1);
  const [tripStatus, setTripStatus] = useState('');
  const [tripDirection, setTripDirection] = useState('');
  const [tripFrom, setTripFrom] = useState('');
  const [tripTo, setTripTo] = useState('');
  const [tripFiltersOpen, setTripFiltersOpen] = useState(false);
  const [tripSearchInput, setTripSearchInput] = useState('');
  const [tripSearch, setTripSearch] = useState('');
  const [activeTripId, setActiveTripId] = useState<string | null>(openTripId);
  const [tripEditor, setTripEditor] = useState<TripEditor | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forceCompleteOpen, setForceCompleteOpen] = useState(false);
  const [forceCompleteReason, setForceCompleteReason] = useState('');
  const [releaseRemaining, setReleaseRemaining] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [rescheduleShiftStops, setRescheduleShiftStops] = useState(true);
  const [rescheduleKeepDriver, setRescheduleKeepDriver] = useState(false);
  const [markMissedOpen, setMarkMissedOpen] = useState(false);
  const [markMissedReason, setMarkMissedReason] = useState('');
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyTemplate, setNotifyTemplate] = useState<'delayed' | 'rescheduled' | 'cancelled' | 'custom'>('rescheduled');
  const [notifyMinutes, setNotifyMinutes] = useState('15');
  const [notifyMessage, setNotifyMessage] = useState('');

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const search = tripSearchInput.trim();
      if (search !== tripSearch) {
        setTripPage(1);
        setTripSearch(search);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [tripSearch, tripSearchInput]);

  const requestsQuery = useQuery({
    queryKey: ['admin', 'ride-requests', requestFilters, requestPage],
    queryFn: ({ signal }) => readRideRequests(requestFilters, requestPage, 25, signal),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const plannerRequestFilters: RideRequestFilters = {
    from: plannerDate,
    to: plannerDate,
    direction: plannerDirection,
    status: 'pending',
    unassigned_only: true,
    search: '',
    sort: 'asc',
  };
  const plannerRequestsQuery = useQuery({
    queryKey: ['admin', 'planner-ride-requests', plannerDate, plannerDirection, plannerPage],
    queryFn: ({ signal }) => readRideRequests(plannerRequestFilters, plannerPage, 100, signal),
    enabled: view === 'planner' && Boolean(plannerDirection) && dateIsValid(plannerDate),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const nextDayQuery = useQuery({
    queryKey: ['admin', 'next-ride-request-date', plannerDate, plannerDirection],
    queryFn: ({ signal }) => readRideRequests({
      from: shiftDate(plannerDate, 1),
      to: '',
      direction: plannerDirection,
      status: 'pending',
      unassigned_only: true,
      search: '',
      sort: 'asc',
    }, 1, 1, signal),
    enabled: view === 'planner' && Boolean(plannerDirection) && dateIsValid(plannerDate),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const tripParams = new URLSearchParams({ page: String(tripPage), page_size: '25' });
  if (tripStatus) tripParams.set('status', tripStatus);
  if (tripDirection) tripParams.set('direction', tripDirection);
  if (tripFrom) tripParams.set('from', tripFrom);
  if (tripTo) tripParams.set('to', tripTo);
  if (tripSearch.trim()) tripParams.set('search', tripSearch.trim());
  const tripsQuery = useQuery({
    queryKey: ['admin', 'trips', tripPage, tripStatus, tripDirection, tripFrom, tripTo, tripSearch],
    queryFn: ({ signal }) => apiRequest<TripPage>(`/admin/trips?${tripParams.toString()}`, { signal }),
    refetchInterval: view === 'trips' && document.visibilityState === 'visible'
      ? (query) => queryPollingInterval(query, 60)
      : false,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const tripDetailQuery = useQuery({
    queryKey: ['admin', 'trip', activeTripId],
    queryFn: async ({ signal }) => {
      const response = await apiRequest<{ trip: TripDetail; poll_after_seconds?: number }>(
        `/admin/trips/${activeTripId}`,
        { signal }
      );
      return { ...response.trip, poll_after_seconds: response.poll_after_seconds };
    },
    enabled: Boolean(activeTripId),
    refetchInterval: activeTripId && document.visibilityState === 'visible'
      ? (query) => queryPollingInterval(query, 60)
      : false,
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const liveTripsQuery = useQuery({
    queryKey: ['admin', 'live-trips', liveTripPage],
    queryFn: async ({ signal }) => {
      return apiRequest<{ trips: LiveTrip[]; pagination: Pagination }>(
        `/admin/trips/live?page=${liveTripPage}&page_size=25`,
        { signal }
      );
    },
    enabled: view === 'live',
    refetchInterval: view === 'live' && document.visibilityState === 'visible'
      ? (query) => queryPollingInterval(query, 60)
      : false,
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!openTripId) return;
    onTripOpened();
  }, [openTripId, onTripOpened]);

  const requests = requestsQuery.data?.ride_requests ?? emptyRideRequests;
  const plannerRequests = plannerRequestsQuery.data?.ride_requests ?? emptyRideRequests;
  const plannerRequestGroups = useMemo(() => {
    const groups = new Map<string, { company: string; workplace: string; requests: RideRequest[] }>();
    for (const request of plannerRequests) {
      const company = request.company_name.trim();
      const workplace = request.workplace_name.trim();
      const key = `${company.toLocaleLowerCase()}::${workplace.toLocaleLowerCase()}`;
      const group = groups.get(key) ?? { company, workplace, requests: [] };
      group.requests.push(request);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [plannerRequests]);
  const nextRequestDate = nextDayQuery.data?.ride_requests[0]
    ? localDate(nextDayQuery.data.ride_requests[0].scheduled_at)
    : null;
  const selectedRequests = useMemo(
    () => selectedIds
      .map((id) => selectedRequestMap[id] ?? requests.find((request) => request.id === id))
      .filter((request): request is RideRequest => Boolean(request)),
    [requests, selectedIds, selectedRequestMap]
  );
  const firstSelected = selectedRequests[0];
  const requestById = useMemo(
    () => new Map([
      ...requests.map((request) => [request.id, request] as const),
      ...Object.values(selectedRequestMap).map((request) => [request.id, request] as const),
    ]),
    [requests, selectedRequestMap]
  );
  const plannerStopGroups = useMemo(() => {
    const groups: { key: string; stop_type: StopDraft['stop_type']; address: string; stops: StopDraft[] }[] = [];
    for (const stop of stops) {
      const request = requestById.get(stop.ride_request_id);
      if (!request) continue;
      const address = stopLabel(request, stop.stop_type);
      const key = `${stop.stop_type}:${normalizeStopAddress(address)}`;
      const previous = groups.at(-1);
      if (previous?.key === key) previous.stops.push(stop);
      else groups.push({ key, stop_type: stop.stop_type, address, stops: [stop] });
    }
    return groups;
  }, [requestById, stops]);
  const plannerTimeErrors = new Map<string, string>();
  if (firstSelected) {
    for (const [index, group] of plannerStopGroups.entries()) {
      const times = group.stops.map(({ planned_time }) => planned_time);
      const groupTime = times[0] ?? '';
      if (times.some((time) => time !== groupTime)) {
        plannerTimeErrors.set(group.key, 'Passengers at this stop must share a planned time.');
      } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(groupTime)) {
        plannerTimeErrors.set(group.key, 'Enter a valid planned time.');
      } else if (index > 0
        && plannerStopGroups[index - 1].stops[0].planned_time > groupTime) {
        plannerTimeErrors.set(group.key, 'Schedule this stop no earlier than the previous stop.');
      }
      const workplaceStop = firstSelected.direction === 'to_work' && group.stop_type === 'dropoff';
      if (workplaceStop && groupTime !== targetTime) {
        plannerTimeErrors.set(group.key, 'Set the workplace stop to the target time.');
      } else if (firstSelected.direction === 'to_work'
        && group.stop_type === 'pickup' && groupTime >= targetTime) {
        plannerTimeErrors.set(group.key, 'Schedule this pick-up before the target time.');
      }
    }
    const passengerTimes = new Map<string, { pickup?: { time: string; key: string }; dropoff?: { time: string; key: string } }>();
    for (const group of plannerStopGroups) {
      for (const stop of group.stops) {
        const times = passengerTimes.get(stop.ride_request_id) ?? {};
        times[stop.stop_type] = { time: stop.planned_time, key: group.key };
        passengerTimes.set(stop.ride_request_id, times);
      }
    }
    for (const times of passengerTimes.values()) {
      if (!times.pickup || !times.dropoff || times.pickup.time >= times.dropoff.time) {
        const message = 'Each passenger pick-up must be before their drop-off.';
        if (times.pickup) plannerTimeErrors.set(times.pickup.key, message);
        if (times.dropoff) plannerTimeErrors.set(times.dropoff.key, message);
      }
    }
  }
  const requestPassengers = new Set(selectedRequests.map(({ passenger_user_id }) => passenger_user_id));
  const plannerDraftSignature = JSON.stringify({
    dates,
    selectedIds,
    direction: firstSelected?.direction,
    stops,
    targetTime,
    tripNotes,
  });

  const tripDatePreviewMutation = useMutation({
    mutationFn: (variables: TripCreateVariables) =>
      apiRequest<TripDatePreview>('/admin/trips/preview', {
        method: 'POST',
        body: {
          direction: variables.body.direction,
          dates: variables.body.dates,
          request_ids: [...new Set(variables.body.stops.map(({ ride_request_id }) => ride_request_id))],
        },
      }),
    onMutate: () => {
      setPendingTripCreation(null);
      setPlanError(null);
      setSuccess(null);
    },
    onSuccess: (result, variables) => {
      setPendingTripCreation({ result, variables });
      setPlanError(null);
    },
    onError: (error: unknown) => setPlanError(
      requestErrorMessage(error, 'Trip dates could not be checked.')
    ),
  });
  const createTripMutation = useMutation({
    mutationFn: (variables: TripCreateVariables) =>
      apiRequest<TripSeriesResult>('/admin/trips', { method: 'POST', body: variables.body }),
    onSuccess: async (result, variables) => {
      setCreatedSeriesId(result.series_id);
      setCreatedReview({ ...variables.review, result });
      setReviewConfirmed(false);
      setSelectedDrivers([]);
      setPlanError(null);
      setSuccess(
        result.skipped_dates.length > 0
          ? `Created ${result.trips.length} ${result.trips.length === 1 ? 'trip' : 'trips'}; ${result.skipped_dates.length} ${result.skipped_dates.length === 1 ? 'date was' : 'dates were'} unavailable. Review the details below.`
          : `Successfully created ${result.trips.length} ${result.trips.length === 1 ? 'trip' : 'trips'}.`
      );
      setView('planner');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ride-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'trips'] });
      onChanged();
    },
    onError: (error: unknown) => setPlanError(
      requestErrorMessage(error, 'Trips could not be created.')
    ),
  });
  const eligibleQuery = useQuery({
    queryKey: ['admin', 'eligible-drivers', createdSeriesId],
    queryFn: async () => {
      const firstPage = await apiRequest<{
        drivers: EligibleDriver[];
        pagination: Pagination;
      }>(`/admin/series/${createdSeriesId}/eligible-drivers?page=1&page_size=100`);
      const remainingPages = await Promise.all(
        Array.from({ length: firstPage.pagination.total_pages - 1 }, (_, index) =>
          apiRequest<{ drivers: EligibleDriver[] }>(
            `/admin/series/${createdSeriesId}/eligible-drivers?page=${index + 2}&page_size=100`
          ))
      );
      return [firstPage.drivers, ...remainingPages.map(({ drivers }) => drivers)].flat();
    },
    enabled: Boolean(createdSeriesId),
  });
  const offerMutation = useMutation({
    mutationFn: async () => apiRequest(`/admin/series/${createdSeriesId}/offer`, {
      method: 'POST',
      body: { driver_ids: selectedDrivers, window_minutes: Number(offerWindow) },
    }),
    onSuccess: async () => {
      setSuccess('Trip offer sent to the selected drivers.');
      setCandidateError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'trips'] });
      onChanged();
    },
    onError: (error: unknown) => setCandidateError(
      error instanceof ApiRequestError
        ? `${error.message}${error.requestId ? ` (Reference: ${error.requestId})` : ''}`
        : 'Offers could not be created.'
    ),
  });

  const tripActionMutation = useMutation({
    mutationFn: async (action: { path: string; method: string; body?: object }) => {
      return apiRequest(action.path, {
        method: action.method,
        ...(action.body ? { body: action.body } : {}),
      });
    },
    onMutate: () => {
      setActionError(null);
      setActionMessage(null);
    },
    onSuccess: async () => {
      setActionError(null);
      setActionMessage('Trip updated.');
      setForceCompleteOpen(false);
      setForceCompleteReason('');
      setReleaseRemaining(false);
      setRescheduleOpen(false);
      setMarkMissedOpen(false);
      setNotifyOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'trips'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'live-trips'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'trip', activeTripId] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'ride-requests'] }),
      ]);
      onChanged();
    },
    onError: (error: unknown) => setActionError(error instanceof ApiRequestError ? error.message : 'Trip update could not be saved.'),
  });
  const updateTripMutation = useMutation({
    mutationFn: (body: object) => apiRequest(`/admin/trips/${activeTripId}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      setActionMessage('Trip details updated.');
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'trip', activeTripId] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'trips'] });
      onChanged();
    },
    onError: (error: unknown) => setActionError(error instanceof ApiRequestError ? error.message : 'Trip details could not be saved.'),
  });

  function applyRequestFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestFilters({ ...draftFilters, search: draftFilters.search.trim() });
    setRequestPage(1);
    setSelectedIds([]);
    setSelectedRequestMap({});
  }

  function toggleRequest(request: RideRequest) {
    if (request.status !== 'pending') return;
    if (selectedIds.includes(request.id)) {
      setSelectedIds(selectedIds.filter((id) => id !== request.id));
      setSelectedRequestMap((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setStops((current) => applyDefaultStopTimes(
        current.filter(({ ride_request_id }) => ride_request_id !== request.id),
        firstSelected?.direction ?? plannerDirection,
        targetTime,
        Number(workplaceTravelMinutes),
        Number(stopGapMinutes),
        requestById
      ));
      if (selectedIds.length === 1) {
        setCreatedSeriesId(null);
        setTargetTime('');
        setDates('');
      }
      return;
    }
    if (plannerDirection && plannerDirection !== request.direction) {
      setRequestError('Select requests with the chosen direction.');
      return;
    }
    if (plannerDate !== localDate(request.scheduled_at)) {
      setRequestError('Select requests scheduled for the selected date.');
      return;
    }
    if (firstSelected && firstSelected.direction !== request.direction) {
      setRequestError('Select requests with the same direction.');
      return;
    }
    if (selectedRequests.length >= 40) {
      setRequestError('A trip can include at most 40 passengers.');
      return;
    }
    if (requestPassengers.has(request.passenger_user_id)) {
      setRequestError('Select only one request per passenger for a trip.');
      return;
    }
    setRequestError(null);
    setCreatedSeriesId(null);
    setSelectedIds([...selectedIds, request.id]);
    setSelectedRequestMap({ ...selectedRequestMap, [request.id]: request });
    const initialTime = localTime(request.scheduled_at);
    if (selectedIds.length === 0) {
      setTargetTime(request.direction === 'to_work' ? initialTime : '');
      setDates(localDate(request.scheduled_at));
      setStops(applyDefaultStopTimes([
        { ride_request_id: request.id, stop_type: 'pickup', planned_time: '' },
        { ride_request_id: request.id, stop_type: 'dropoff', planned_time: '' },
      ], request.direction, initialTime, Number(workplaceTravelMinutes), Number(stopGapMinutes),
        new Map([...requestById, [request.id, request]])));
    } else {
      setStops(applyDefaultStopTimes(orderRouteStops([
        ...stops,
        { ride_request_id: request.id, stop_type: 'pickup', planned_time: '' },
        { ride_request_id: request.id, stop_type: 'dropoff', planned_time: '' },
      ]), request.direction, targetTime, Number(workplaceTravelMinutes), Number(stopGapMinutes),
        new Map([...requestById, [request.id, request]])));
    }
  }

  function toggleWorkplaceRequests(groupRequests: RideRequest[]) {
    const available = groupRequests.filter(({ status }) => status === 'pending');
    const allSelected = available.length > 0 && available.every(({ id }) => selectedIds.includes(id));
    if (allSelected) {
      const removeIds = new Set(available.map(({ id }) => id));
      setSelectedIds((current) => current.filter((id) => !removeIds.has(id)));
      setSelectedRequestMap((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !removeIds.has(id))
      ));
      setStops((current) => applyDefaultStopTimes(
        current.filter(({ ride_request_id }) => !removeIds.has(ride_request_id)),
        firstSelected?.direction ?? plannerDirection,
        targetTime,
        Number(workplaceTravelMinutes),
        Number(stopGapMinutes),
        requestById
      ));
      if (selectedIds.length === removeIds.size) {
        setCreatedSeriesId(null);
        setDates('');
        setTargetTime('');
      }
      return;
    }

    const alreadySelectedPassengers = new Set(selectedRequests.map(({ passenger_user_id }) => passenger_user_id));
    const additions = available.filter((request) =>
      !selectedIds.includes(request.id)
      && !alreadySelectedPassengers.has(request.passenger_user_id)
    );
    if (selectedRequests.length + additions.length > 40) {
      setRequestError('A trip can include at most 40 passengers. Select fewer requests from this workplace.');
      return;
    }
    if (firstSelected && additions.some(({ direction }) => direction !== firstSelected.direction)) {
      setRequestError('Select requests with the same direction.');
      return;
    }
    setRequestError(null);
    if (additions.length === 0) return;
    setCreatedSeriesId(null);
    setSelectedIds((current) => [...current, ...additions.map(({ id }) => id)]);
    setSelectedRequestMap((current) => ({
      ...current,
      ...Object.fromEntries(additions.map((request) => [request.id, request])),
    }));
    const updatedRequests = new Map([
      ...requestById,
      ...additions.map((request) => [request.id, request] as const),
    ]);
    const nextStops = orderRouteStops([
      ...stops,
      ...additions.flatMap(({ id }) => [
        { ride_request_id: id, stop_type: 'pickup' as const, planned_time: '' },
        { ride_request_id: id, stop_type: 'dropoff' as const, planned_time: '' },
      ]),
    ]);
    if (selectedIds.length === 0) {
      const initialRequest = additions[0];
      setTargetTime(initialRequest.direction === 'to_work' ? localTime(initialRequest.scheduled_at) : '');
      setDates(plannerDate);
      setStops(applyDefaultStopTimes(
        nextStops,
        initialRequest.direction,
        localTime(initialRequest.scheduled_at),
        Number(workplaceTravelMinutes),
        Number(stopGapMinutes),
        updatedRequests
      ));
    } else {
      setStops(applyDefaultStopTimes(
        nextStops,
        firstSelected?.direction ?? plannerDirection,
        targetTime,
        Number(workplaceTravelMinutes),
        Number(stopGapMinutes),
        updatedRequests
      ));
    }
  }

  function changePlannerScope(date: string, direction: string) {
    setPlannerDate(date);
    setPlannerDirection(direction);
    setPlannerPage(1);
    setSelectedIds([]);
    setSelectedRequestMap({});
    setStops([]);
    setCreatedSeriesId(null);
    setDates('');
    setTargetTime('');
    setRequestError(null);
  }

  function moveStopGroup(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= plannerStopGroups.length) return;
    const updatedGroups = [...plannerStopGroups];
    [updatedGroups[index], updatedGroups[destination]] = [updatedGroups[destination], updatedGroups[index]];
    const updated = updatedGroups.flatMap(({ stops: groupStops }) => groupStops);
    const order = new Map<string, { pickup?: number; dropoff?: number }>();
    updated.forEach((stop, stopIndex) => {
      const pair = order.get(stop.ride_request_id) ?? {};
      pair[stop.stop_type] = stopIndex;
      order.set(stop.ride_request_id, pair);
    });
    if ([...order.values()].some(({ pickup, dropoff }) => pickup === undefined || dropoff === undefined || pickup >= dropoff)) {
      setPlanError('Each passenger pick-up must remain before their drop-off.');
      return;
    }
    setStops(applyDefaultStopTimes(
      updated,
      firstSelected?.direction ?? plannerDirection,
      targetTime,
      Number(workplaceTravelMinutes),
      Number(stopGapMinutes),
      requestById
    ));
    setPlanError(null);
  }

  function createTrips() {
    const tripDates = dateList(dates);
    if (selectedIds.length === 0 || !firstSelected) {
      setPlanError('Select at least one ride request.');
      return;
    }
    if (tripDates.length === 0 || tripDates.length > 31 || tripDates.some((date) => !dateIsValid(date))) {
      setPlanError('Enter 1 to 31 valid dates in YYYY-MM-DD format.');
      return;
    }
    if (firstSelected.direction === 'to_work'
      && !/^([01]\d|2[0-3]):[0-5]\d$/.test(targetTime)) {
      setPlanError('Enter a valid target time in 24-hour HH:MM format.');
      return;
    }
    if (stops.some(({ planned_time }) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(planned_time))) {
      setPlanError('Enter a valid planned time for every stop.');
      return;
    }
    if (stops.some((stop, index) =>
      index > 0 && stops[index - 1].planned_time > stop.planned_time
    )) {
      setPlanError('Set each stop time in the same order as the route.');
      return;
    }
    if (firstSelected.direction === 'to_work'
      && stops.some((stop) => stop.stop_type === 'dropoff' && stop.planned_time !== targetTime)) {
      setPlanError('Set every workplace stop to the target time.');
      return;
    }
    if (firstSelected.direction === 'to_work'
      && stops.some((stop) => stop.stop_type === 'pickup' && stop.planned_time >= targetTime)) {
      setPlanError('Every pick-up must be before the workplace target time.');
      return;
    }
    const passengerTimes = new Map<string, { pickup?: string; dropoff?: string }>();
    for (const stop of stops) {
      const times = passengerTimes.get(stop.ride_request_id) ?? {};
      times[stop.stop_type] = stop.planned_time;
      passengerTimes.set(stop.ride_request_id, times);
    }
    if ([...passengerTimes.values()].some(({ pickup, dropoff }) =>
      !pickup || !dropoff || pickup >= dropoff
    )) {
      setPlanError('Each passenger pick-up time must be before their drop-off time.');
      return;
    }
    if (plannerStopGroups.some((group) =>
      group.stops.some((stop) => stop.planned_time !== group.stops[0].planned_time)
    )) {
      setPlanError('Passengers in the same stop group must share a planned time.');
      return;
    }
    const workplaceLocations = new Map(selectedRequests.map((request) => {
      const address = request.workplace_address ?? request.workplace_name;
      const label = stopLabel(request, request.direction === 'home' ? 'pickup' : 'dropoff');
      return [normalizeStopAddress(label), { name: request.workplace_name, address }] as const;
    }));
    const singleWorkplace = workplaceLocations.size === 1
      ? [...workplaceLocations.values()][0]
      : null;
    tripDatePreviewMutation.mutate({
      signature: plannerDraftSignature,
      body: {
        direction: firstSelected.direction,
        dates: tripDates,
        ...(firstSelected.direction === 'to_work' ? { target_time: targetTime } : {}),
        workplace_name: singleWorkplace?.name ?? 'Multiple workplaces',
        workplace_address: singleWorkplace?.address ?? 'Multiple workplaces',
        ...(tripNotes.trim() ? { notes: tripNotes.trim() } : {}),
        stops: stops.map((stop, index) => ({
          ride_request_id: stop.ride_request_id,
          stop_type: stop.stop_type,
          sequence: index + 1,
          planned_time: stop.planned_time,
        })),
      },
      review: {
        direction: firstSelected.direction,
        passengers: selectedRequests.map(({ passenger_name, passenger_surname }) =>
          `${passenger_name} ${passenger_surname}`),
        stops: plannerStopGroups.map((group) => ({
          stop_type: group.stop_type,
          address: group.address,
          planned_time: group.stops[0].planned_time,
          passengers: group.stops.map((stop) => {
            const request = requestById.get(stop.ride_request_id);
            return request ? `${request.passenger_name} ${request.passenger_surname}` : 'Passenger';
          }),
        })),
      },
    });
  }

  function confirmTripCreation() {
    if (!pendingTripCreation) return;
    const availableDates = pendingTripCreation.result.dates
      .filter(({ available }) => available)
      .map(({ date }) => date);
    if (availableDates.length === 0) return;
    createTripMutation.mutate({
      ...pendingTripCreation.variables,
      body: { ...pendingTripCreation.variables.body, dates: availableDates },
    });
    setPendingTripCreation(null);
  }

  function toggleDriver(driverId: string) {
    setSelectedDrivers((current) => current.includes(driverId)
      ? current.filter((id) => id !== driverId)
      : [...current, driverId]);
  }

  function moveDriver(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= selectedDrivers.length) return;
    setSelectedDrivers((current) => {
      const updated = [...current];
      [updated[index], updated[destination]] = [updated[destination], updated[index]];
      return updated;
    });
  }

  async function cancelRequest(request: RideRequest) {
    if (!window.confirm(`Cancel ${request.passenger_name} ${request.passenger_surname}'s ride request?`)) return;
    const reason = window.prompt('Enter a reason for cancellation:')?.trim();
    if (!reason) return;
    try {
      await apiRequest(`/admin/ride-requests/${request.id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      setActionMessage('Ride request cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ride-requests'] });
      onChanged();
    } catch (error) {
      setActionError(error instanceof ApiRequestError ? error.message : 'Ride request could not be cancelled.');
    }
  }

  function runTripAction(action: { path: string; method: string; body?: object }) {
    tripActionMutation.mutate(action);
  }

  function openTripDetails(tripId: string) {
    setActiveTripId(tripId);
    setTripEditor(null);
    setActionError(null);
    setActionMessage(null);
    setForceCompleteOpen(false);
    setForceCompleteReason('');
    setReleaseRemaining(false);
    setRescheduleOpen(false);
    setMarkMissedOpen(false);
    setNotifyOpen(false);
  }

  function closeTripDetails() {
    setActiveTripId(null);
    setTripEditor(null);
    setForceCompleteOpen(false);
    setForceCompleteReason('');
    setReleaseRemaining(false);
    setRescheduleOpen(false);
    setMarkMissedOpen(false);
    setNotifyOpen(false);
  }

  function submitForceComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTripId || !forceCompleteReason.trim()) {
      setActionError('Enter a reason to force-complete this trip.');
      return;
    }
    runTripAction({
      path: `/admin/trips/${activeTripId}/force-complete`,
      method: 'POST',
      body: { reason: forceCompleteReason.trim(), release_remaining: releaseRemaining },
    });
  }

  function cancelTrip(trip: TripDetail) {
    if (!window.confirm(`Cancel this ${trip.direction === 'home' ? 'home' : 'to-work'} trip?`)) return;
    const reason = window.prompt('Enter a reason for cancellation:')?.trim();
    if (reason) runTripAction({ path: `/admin/trips/${trip.id}/cancel`, method: 'POST', body: { reason } });
  }

  function reassignTrip(trip: TripDetail) {
    if (window.confirm('Return this trip to draft and release its driver?')) {
      runTripAction({ path: `/admin/trips/${trip.id}/reassign`, method: 'POST' });
    }
  }

  function removePassenger(trip: TripDetail, passenger: TripPassenger) {
    if (!window.confirm(`Remove ${passenger.passenger_name} ${passenger.passenger_surname} from this trip?`)) return;
    const reason = window.prompt('Enter a reason:')?.trim();
    if (reason) {
      runTripAction({
        path: `/admin/trips/${trip.id}/remove-passenger`,
        method: 'POST',
        body: { ride_request_id: passenger.ride_request_id, reason, kind: 'cancelled' },
      });
    }
  }

  function cancelSeriesOffers(trip: TripDetail) {
    if (window.confirm('Cancel active driver offers for this trip?')) {
      runTripAction({ path: `/admin/series/${trip.series_id}/offers/cancel`, method: 'POST' });
    }
  }

  function openReschedule(trip: TripDetail) {
    setRescheduleDate(localDate(trip.scheduled_at));
    setRescheduleTime(localTime(trip.scheduled_at));
    setRescheduleShiftStops(true);
    setRescheduleKeepDriver(false);
    setRescheduleOpen(true);
    setActionError(null);
  }

  function submitReschedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTripId || !dateIsValid(rescheduleDate)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rescheduleTime)) {
      setActionError('Enter a valid future date and 24-hour time.');
      return;
    }
    const newScheduledAt = new Date(`${rescheduleDate}T${rescheduleTime}:00+02:00`);
    if (Number.isNaN(newScheduledAt.getTime()) || newScheduledAt.getTime() <= Date.now()) {
      setActionError('Choose a new trip time in the future.');
      return;
    }
    runTripAction({
      path: `/admin/trips/${activeTripId}/reschedule`,
      method: 'POST',
      body: {
        new_scheduled_at: newScheduledAt.toISOString(),
        shift_stops: rescheduleShiftStops,
        keep_driver: rescheduleKeepDriver,
      },
    });
  }

  function submitMarkMissed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTripId || !markMissedReason.trim()) {
      setActionError('Enter a reason to mark this trip missed.');
      return;
    }
    runTripAction({
      path: `/admin/trips/${activeTripId}/mark-missed`,
      method: 'POST',
      body: { reason: markMissedReason.trim() },
    });
  }

  function reinstatePassengers(trip: TripDetail) {
    if (!window.confirm('Return eligible passengers to pending ride requests?')) return;
    runTripAction({ path: `/admin/trips/${trip.id}/reinstate-passengers`, method: 'POST' });
  }

  function submitPassengerNotice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTripId) return;
    const body = notifyTemplate === 'delayed'
      ? { template: notifyTemplate, minutes: Number(notifyMinutes) }
      : notifyTemplate === 'custom'
        ? { template: notifyTemplate, message: notifyMessage.trim() }
        : { template: notifyTemplate };
    runTripAction({
      path: `/admin/trips/${activeTripId}/notify-passengers`,
      method: 'POST',
      body,
    });
  }

  function openTripEditor(trip: TripDetail) {
    setTripEditor({
      distance_km: trip.distance_km === null ? '' : String(trip.distance_km),
      notes: trip.notes ?? '',
      stops: trip.stops.map((stop) => ({ id: stop.id, planned_at: localDateTime(stop.planned_at) })),
    });
  }

  function moveEditStop(index: number, offset: -1 | 1) {
    if (!tripEditor || !currentDetail) return;
    const groups: { key: string; stops: TripEditor['stops'] }[] = [];
    for (const editedStop of tripEditor.stops) {
      const source = currentDetail.stops.find(({ id }) => id === editedStop.id);
      if (!source) continue;
      const key = `${source.stop_type}:${normalizeStopAddress(source.address, source.suburb)}`;
      const previous = groups.at(-1);
      if (previous?.key === key) previous.stops.push(editedStop);
      else groups.push({ key, stops: [editedStop] });
    }
    const destination = index + offset;
    if (destination < 0 || destination >= groups.length) return;
    [groups[index], groups[destination]] = [groups[destination], groups[index]];
    const stopsUpdated = groups.flatMap(({ stops: groupStops }) => groupStops);
    const stopOrder = new Map<string, { pickup?: number; dropoff?: number }>();
    stopsUpdated.forEach(({ id }, stopIndex) => {
      const stop = currentDetail?.stops.find((item) => item.id === id);
      if (!stop) return;
      const pair = stopOrder.get(stop.ride_request_id) ?? {};
      pair[stop.stop_type] = stopIndex;
      stopOrder.set(stop.ride_request_id, pair);
    });
    if ([...stopOrder.values()].some(({ pickup, dropoff }) =>
      pickup === undefined || dropoff === undefined || pickup >= dropoff
    )) {
      setActionError('Each passenger pick-up must remain before their drop-off.');
      return;
    }
    setActionError(null);
    setTripEditor({ ...tripEditor, stops: stopsUpdated });
  }

  function saveTripEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tripEditor || !currentDetail) return;
    if (tripEditor.stops.some(({ planned_at }) => !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(planned_at))) {
      setActionError('Enter a valid date and time for every trip stop.');
      return;
    }
    if (tripEditor.stops.some((stop, index) =>
      index > 0 && tripEditor.stops[index - 1].planned_at > stop.planned_at
    )) {
      setActionError('Set each stop time in the same order as the route.');
      return;
    }
    const scheduledAt = localDateTime(currentDetail.scheduled_at);
    const editedById = new Map(tripEditor.stops.map((stop) => [stop.id, stop]));
    const passengerTimes = new Map<string, { pickup?: string; dropoff?: string }>();
    for (const stop of currentDetail.stops) {
      const edited = editedById.get(stop.id);
      if (!edited) continue;
      const times = passengerTimes.get(stop.ride_request_id) ?? {};
      times[stop.stop_type] = edited.planned_at;
      passengerTimes.set(stop.ride_request_id, times);
      const isWorkplaceStop = currentDetail.direction === 'to_work'
        && stop.stop_type === 'dropoff';
      if (isWorkplaceStop && edited.planned_at !== scheduledAt) {
        setActionError('Every workplace stop must be scheduled at the target time.');
        return;
      }
      if (currentDetail.direction === 'to_work'
        && stop.stop_type === 'pickup' && edited.planned_at >= scheduledAt) {
        setActionError('Every pick-up must be before the workplace target time.');
        return;
      }
    }
    if ([...passengerTimes.values()].some(({ pickup, dropoff }) =>
      !pickup || !dropoff || pickup >= dropoff
    )) {
      setActionError('Each passenger pick-up time must be before their drop-off time.');
      return;
    }
    if (editStopGroups.some((group) =>
      group.stops.some((stop) => stop.planned_at !== group.stops[0].planned_at)
    )) {
      setActionError('Passengers in the same stop group must share a planned time.');
      return;
    }
    updateTripMutation.mutate({
      distance_km: tripEditor.distance_km.trim() ? Number(tripEditor.distance_km) : null,
      notes: tripEditor.notes.trim() || null,
      stops: tripEditor.stops.map((stop, index) => ({
        id: stop.id,
        sequence: index + 1,
        planned_at: `${stop.planned_at}:00+02:00`,
      })),
    });
  }

  const currentDetail = tripDetailQuery.data;
  const listTrips = tripsQuery.data?.trips ?? [];
  const liveTrips = liveTripsQuery.data?.trips ?? [];
  const liveTripPages = liveTripsQuery.data?.pagination;
  const requestPages = requestsQuery.data?.pagination;
  const tripPages = tripsQuery.data?.pagination;
  const plannedRouteDuration = stops.length > 1
    ? scheduledGap(stops[0].planned_time, stops[stops.length - 1].planned_time)
    : null;
  const currentTripSchedule = currentDetail ? tripScheduleSummary(currentDetail.stops) : null;
  const currentRouteGroups = currentDetail ? groupTripStops(currentDetail.stops) : [];
  const editStopGroups = (() => {
    if (!tripEditor || !currentDetail) return [];
    const groups: { key: string; stop_type: TripStop['stop_type']; stops: TripEditor['stops']; source: TripStop }[] = [];
    for (const editedStop of tripEditor.stops) {
      const source = currentDetail.stops.find(({ id }) => id === editedStop.id);
      if (!source) continue;
      const key = `${source.stop_type}:${normalizeStopAddress(source.address, source.suburb)}`;
      const previous = groups.at(-1);
      if (previous?.key === key) previous.stops.push(editedStop);
      else groups.push({ key, stop_type: source.stop_type, stops: [editedStop], source });
    }
    return groups;
  })();
  const editTimeErrors = new Map<string, string>();
  if (currentDetail && tripEditor) {
    const scheduledAt = localDateTime(currentDetail.scheduled_at);
    const editedById = new Map(tripEditor.stops.map((stop) => [stop.id, stop]));
    for (const [index, group] of editStopGroups.entries()) {
      const times = group.stops.map(({ planned_at }) => planned_at);
      const time = times[0] ?? '';
      if (times.some((value) => value !== time)) {
        editTimeErrors.set(group.key, 'Passengers at this stop must share a planned time.');
      } else if (index > 0
        && editStopGroups[index - 1].stops[0].planned_at > time) {
        editTimeErrors.set(group.key, 'Schedule this stop no earlier than the previous stop.');
      }
      const workplaceStop = currentDetail.direction === 'to_work' && group.stop_type === 'dropoff';
      if (workplaceStop && time !== scheduledAt) {
        editTimeErrors.set(group.key, 'Set the workplace stop to the target time.');
      } else if (currentDetail.direction === 'to_work'
        && group.stop_type === 'pickup' && time >= scheduledAt) {
        editTimeErrors.set(group.key, 'Schedule this pick-up before the target time.');
      }
    }
    const passengerTimes = new Map<string, { pickup?: { time: string; key: string }; dropoff?: { time: string; key: string } }>();
    for (const stop of currentDetail.stops) {
      const edited = editedById.get(stop.id);
      if (!edited) continue;
      const times = passengerTimes.get(stop.ride_request_id) ?? {};
      times[stop.stop_type] = { time: edited.planned_at, key: `${stop.stop_type}:${normalizeStopAddress(stop.address, stop.suburb)}` };
      passengerTimes.set(stop.ride_request_id, times);
    }
    for (const times of passengerTimes.values()) {
      if (!times.pickup || !times.dropoff || times.pickup.time >= times.dropoff.time) {
        const message = 'Each passenger pick-up must be before their drop-off.';
        if (times.pickup) editTimeErrors.set(times.pickup.key, message);
        if (times.dropoff) editTimeErrors.set(times.dropoff.key, message);
      }
    }
  }

  useEffect(() => {
    if (createdSeriesId && view === 'planner') {
      offerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [createdSeriesId, view]);

  function openOfferComposer(trip: TripDetail) {
    setSelectedDrivers([]);
    setCandidateError(null);
    setCreatedSeriesId(trip.series_id);
    setCreatedReview(null);
    setReviewConfirmed(false);
    setActiveTripId(null);
    setView('planner');
  }

  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">OPERATIONS</span>
        <h1>Ride requests & trips</h1>
        <p>Select passenger requests, arrange their stops, create a trip and offer it to eligible drivers.</p>
      </div>
      <div className="operations-tabs" role="tablist" aria-label="Ride operations">
        {[
          { id: 'requests' as const, label: 'Ride requests' },
          { id: 'planner' as const, label: 'Trip builder' },
          { id: 'trips' as const, label: 'Trips' },
          { id: 'live' as const, label: 'Live' },
        ].map(({ id, label }) => (
          <button
            key={id}
            aria-selected={view === id}
            className={`application-tab${view === id ? ' is-active' : ''}`}
            onClick={() => setView(id)}
            role="tab"
            type="button"
          >{label}</button>
        ))}
      </div>
      {actionMessage && <div className="alert alert-success" role="status">{actionMessage}<button className="alert-dismiss" type="button" onClick={() => setActionMessage(null)} aria-label="Dismiss"><X size={16} /></button></div>}
      {actionError && <div className="alert alert-error" role="alert">{actionError}<button className="alert-dismiss" type="button" onClick={() => setActionError(null)} aria-label="Dismiss"><X size={16} /></button></div>}

      {view === 'requests' && (
        <>
          <section className="content-section trip-operations-section">
            <div className="application-toolbar">
              <div><h2>Ride requests</h2><p>{requestPages ? `${requestPages.total.toLocaleString()} requests` : 'Passenger requests waiting for trip assignment'}</p></div>
              <div className="ride-request-toolbar-actions">
                <button
                  aria-controls="ride-request-filter-panel"
                  aria-expanded={requestFiltersOpen}
                  className="button button-secondary"
                  type="button"
                  onClick={() => setRequestFiltersOpen((open) => !open)}
                >
                  <SlidersHorizontal size={16} />
                  {requestFiltersOpen ? 'Hide filters' : 'Show filters'}
                </button>
                <button className="button button-primary" type="button" onClick={() => setView('planner')}><Route size={16} /> Build trip{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}</button>
              </div>
            </div>
            {requestFiltersOpen && (
            <form id="ride-request-filter-panel" className="ride-request-filters" onSubmit={applyRequestFilters}>
              <label className="field"><span>From date</span><input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters((filters) => ({ ...filters, from: event.target.value }))} /></label>
              <label className="field"><span>To date</span><input type="date" value={draftFilters.to} onChange={(event) => setDraftFilters((filters) => ({ ...filters, to: event.target.value }))} /></label>
              <label className="field"><span>Direction</span><select value={draftFilters.direction} onChange={(event) => setDraftFilters((filters) => ({ ...filters, direction: event.target.value }))}><option value="">All directions</option><option value="to_work">To work</option><option value="home">Home</option></select></label>
              <label className="field"><span>Status</span><select value={draftFilters.status} onChange={(event) => setDraftFilters((filters) => ({ ...filters, status: event.target.value }))}><option value="">All statuses</option><option value="pending">Pending</option><option value="assigned">Assigned</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="no_show">No show</option><option value="missed">Missed</option><option value="expired">Expired</option></select></label>
              <label className="field"><span>Search</span><input autoComplete="off" placeholder="Passenger, employee no., company or suburb" value={draftFilters.search} onChange={(event) => setDraftFilters((filters) => ({ ...filters, search: event.target.value }))} /></label>
              <label className="filter-check"><input type="checkbox" checked={draftFilters.unassigned_only} onChange={(event) => setDraftFilters((filters) => ({ ...filters, unassigned_only: event.target.checked }))} /><span>Unassigned only</span></label>
              <div className="ride-request-filter-action">
                <button className="button button-primary" type="submit"><Search size={16} /> Apply filters</button>
              </div>
            </form>
            )}
            {requestError && <div className="alert alert-error" role="alert">{requestError}</div>}
            {requestsQuery.error && <div className="alert alert-error" role="alert">{requestsQuery.error instanceof Error ? requestsQuery.error.message : 'Ride requests could not be loaded.'}</div>}
            {requestsQuery.isLoading ? <div className="loading-state"><LoaderCircle className="spin" size={20} /> Loading ride requests…</div> : requests.length === 0 ? (
              <div className="empty-state"><strong>No ride requests match these filters</strong></div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Select</th><th>Passenger</th><th>Workplace</th><th>Suburbs</th><th>Direction</th><th>Scheduled</th><th>Status</th><th>Requested by</th><th /></tr></thead>
                  <tbody>{requests.map((request) => (
                    <tr key={request.id}>
                      <td><input aria-label={`Select ${request.passenger_name} ${request.passenger_surname}, ${formatSchedule(request.scheduled_at)}`} type="checkbox" disabled={request.status !== 'pending'} checked={selectedIds.includes(request.id)} onChange={() => toggleRequest(request)} /></td>
                      <td><strong>{request.passenger_name} {request.passenger_surname}</strong><small className="cell-subtitle">{request.employee_number} · {request.contact_number}</small></td>
                      <td>
                        {request.company_name.toLocaleLowerCase() === request.workplace_name.toLocaleLowerCase()
                          ? request.company_name
                          : <>{request.company_name}<small className="cell-subtitle">{request.workplace_name}</small></>}
                      </td>
                      <td>Home: {request.home_suburb || <span className="suburb-warning">Missing</span>}<small className="cell-subtitle">Work: {request.workplace_suburb || <span className="suburb-warning">Missing</span>}</small></td>
                      <td>{request.direction === 'home' ? 'Home' : 'To work'}</td>
                      <td>{formatSchedule(request.scheduled_at)}</td>
                      <td><span className={`status status-${request.status}`}>{request.status.replaceAll('_', ' ')}</span></td>
                      <td>{request.booking_source === 'admin' ? `Admin · ${request.booked_by_name ?? ''} ${request.booked_by_surname ?? ''}` : 'Passenger'}</td>
                      <td>{['pending', 'assigned'].includes(request.status) && <button className="button button-secondary button-small" type="button" onClick={() => void cancelRequest(request)}>Cancel</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {requestPages && requestPages.total_pages > 1 && (
              <PaginationControls page={requestPages.page} totalPages={requestPages.total_pages} onPage={setRequestPage} />
            )}
          </section>
        </>
      )}

      {view === 'planner' && (
        <>
          <section className="content-section trip-operations-section">
            <div className="application-toolbar"><div><h2>Build trip</h2><p>Select passenger requests, order each pick-up and drop-off, and set the trip schedule.</p></div></div>
            {planError && <div className="alert alert-error" role="alert">{planError}</div>}
            {success && <div className="alert alert-success" role="status">{success}</div>}
            {createdReview && createdReview.result.skipped_dates.length > 0 && (
              <div className="alert alert-warning" role="status">
                <div>
                  <strong>Some dates were not created</strong>
                  <ul className="trip-skipped-date-list">
                    {createdReview.result.skipped_dates.map(({ date, reason }) => (
                      <li key={date}><strong>{date}</strong> — {reason}</li>
                    ))}
                  </ul>
                  <small>Review the requests for these dates before creating replacement trips.</small>
                </div>
              </div>
            )}
            {pendingTripCreation?.variables.signature === plannerDraftSignature && (
              <section className="trip-date-preview" aria-labelledby="trip-date-preview-heading" aria-live="polite">
                <div>
                  <h3 id="trip-date-preview-heading">Date availability</h3>
                  <p>
                    {pendingTripCreation.result.dates.filter(({ available }) => available).length} of{' '}
                    {pendingTripCreation.result.dates.length} selected dates have pending requests for every selected passenger and workplace.
                  </p>
                </div>
                <ul>
                  {pendingTripCreation.result.dates.map((item) => (
                    <li className={item.available ? 'trip-date-available' : 'trip-date-unavailable'} key={item.date}>
                      <strong>{item.date}</strong>
                      <span>{item.available
                        ? 'Ready to create'
                        : `Missing ${item.missing_request_groups} of ${item.required_request_groups} passenger/workplace request groups`}</span>
                      {!item.available && item.missing_request_ids.length > 0 && (
                        <small>
                          Missing requests for: {item.missing_request_ids
                            .map((id) => requestById.get(id))
                            .filter((request): request is RideRequest => Boolean(request))
                            .map((request) => `${request.passenger_name} ${request.passenger_surname} · ${request.workplace_name}`)
                            .join('; ')}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="trip-date-preview-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={createTripMutation.isPending}
                    onClick={() => setPendingTripCreation(null)}
                  >
                    Edit trip
                  </button>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={createTripMutation.isPending
                      || !pendingTripCreation.result.dates.some(({ available }) => available)}
                    onClick={confirmTripCreation}
                  >
                    {createTripMutation.isPending
                      ? <LoaderCircle size={17} className="spin" />
                      : <Plus size={17} />}
                    Create {pendingTripCreation.result.dates.filter(({ available }) => available).length} available {pendingTripCreation.result.dates.filter(({ available }) => available).length === 1 ? 'trip' : 'trips'}
                  </button>
                </div>
                {pendingTripCreation.result.dates.every(({ available }) => !available) && (
                  <p className="trip-date-preview-guidance">
                    No trips can be created yet. Change the selected dates or passenger requests, then check availability again.
                  </p>
                )}
              </section>
            )}
            <div className="planner-layout">
              <div className="planner-request-selection">
                <h3>Ride requests</h3>
                <div className="planner-request-filters">
                  <label className="field">
                    <span>Date</span>
                    <input
                      type="date"
                      value={plannerDate}
                      onChange={(event) => changePlannerScope(event.target.value, plannerDirection)}
                    />
                  </label>
                  <label className="field">
                    <span>Direction</span>
                    <select
                      value={plannerDirection}
                      onChange={(event) => changePlannerScope(plannerDate, event.target.value)}
                    >
                      <option value="">Choose direction</option>
                      <option value="to_work">To work</option>
                      <option value="home">Home</option>
                    </select>
                  </label>
                </div>
                <div className="planner-request-list">
                  {!plannerDirection ? (
                    <div className="empty-state"><strong>Choose a direction to view ride requests</strong></div>
                  ) : plannerRequestsQuery.isLoading ? (
                    <div className="loading-state"><LoaderCircle className="spin" size={18} /> Loading ride requests…</div>
                  ) : plannerRequestsQuery.error ? (
                    <div className="alert alert-error" role="alert">
                      {plannerRequestsQuery.error instanceof Error ? plannerRequestsQuery.error.message : 'Ride requests could not be loaded.'}
                    </div>
                  ) : plannerRequestGroups.length === 0 ? (
                    <div className="empty-state planner-empty-state">
                      <strong>No ride requests for this day</strong>
                      {nextDayQuery.isLoading && <small>Checking the next available day…</small>}
                      {nextRequestDate && (
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => changePlannerScope(nextRequestDate, plannerDirection)}
                        >
                          Go to {nextRequestDate}
                        </button>
                      )}
                    </div>
                  ) : plannerRequestGroups.map((group) => {
                    const groupRequests = group.requests;
                    const allGroupSelected = groupRequests.length > 0
                      && groupRequests.every(({ id }) => selectedIds.includes(id));
                    return (
                      <section className="planner-workplace-group" key={`${group.company}:${group.workplace}`}>
                        <div className="planner-workplace-heading">
                          <div>
                            <strong>{group.company}</strong>
                            {group.workplace.toLocaleLowerCase() !== group.company.toLocaleLowerCase()
                              && <small>{group.workplace}</small>}
                          </div>
                          <label className="planner-select-group">
                            <input
                              type="checkbox"
                              checked={allGroupSelected}
                              aria-label={`Select all requests for ${group.company}, ${group.workplace}`}
                              onChange={() => toggleWorkplaceRequests(groupRequests)}
                            />
                            <span>Select all</span>
                          </label>
                        </div>
                        {groupRequests.map((request) => (
                          <label className="planner-request" key={request.id}>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(request.id)}
                              onChange={() => toggleRequest(request)}
                            />
                            <span>
                              <strong>{request.passenger_name} {request.passenger_surname}</strong>
                              <small>{request.employee_number} · {localTime(request.scheduled_at)}</small>
                              <small>Home: {request.home_suburb || 'Suburb not provided'} · {request.home_address}</small>
                              <small>Work: {request.workplace_address || group.workplace}</small>
                              <small>{request.contact_number}</small>
                            </span>
                          </label>
                        ))}
                      </section>
                    );
                  })}
                </div>
                {plannerRequestsQuery.data?.pagination && plannerRequestsQuery.data.pagination.total_pages > 1 && (
                  <PaginationControls
                    page={plannerRequestsQuery.data.pagination.page}
                    totalPages={plannerRequestsQuery.data.pagination.total_pages}
                    onPage={setPlannerPage}
                  />
                )}
                <div className="planner-selection-bar">
                  <strong>{selectedIds.length} selected</strong>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={selectedIds.length === 0
                      || createTripMutation.isPending
                      || tripDatePreviewMutation.isPending}
                    onClick={createTrips}
                  >
                    {createTripMutation.isPending || tripDatePreviewMutation.isPending
                      ? <LoaderCircle size={16} className="spin" />
                      : <Route size={16} />}
                    {tripDatePreviewMutation.isPending ? 'Checking dates…' : 'Check dates'}
                  </button>
                </div>
              </div>
              <div className="planner-form">
                <h3>Trip schedule</h3>
                <p className="planner-note">{firstSelected?.direction === 'home'
                  ? 'Set the order and planned time for each pick-up and drop-off.'
                  : 'Set when passengers must arrive at the workplace. Review and adjust the planned time for each stop; these are schedule times, not live driving estimates.'}</p>
                <label className="field"><span>Trip dates</span><input placeholder="YYYY-MM-DD, YYYY-MM-DD" value={dates} onChange={(event) => setDates(event.target.value)} /><small>Use one date for a single trip or add dates for recurring requests. Each passenger needs a request for every date.</small></label>
                {firstSelected?.direction === 'to_work' && <>
                  <label className="field"><span>Arrive at workplace by (24-hour)</span><input type="time" value={targetTime} onChange={(event) => {
                  const value = event.target.value;
                  setTargetTime(value);
                  setStops((current) => applyDefaultStopTimes(
                    current,
                    firstSelected?.direction ?? plannerDirection,
                    value,
                    Number(workplaceTravelMinutes),
                    Number(stopGapMinutes),
                    requestById
                  ));
                }} /></label>
                  <p className="planner-note">Suggested times are a starting point. Set each stop time to match the route you choose.</p>
                </>}
                <label className="field"><span>Notes</span><textarea maxLength={2000} rows={3} value={tripNotes} onChange={(event) => setTripNotes(event.target.value)} /></label>
                <h3>Set stop order · {plannerStopGroups.length} stops</h3>
                {stops.length > 0 && <p className="planner-note">Arrange every pick-up and drop-off in the order you want the vehicle to travel. Times below show your schedule, not live driving estimates.</p>}
                {plannedRouteDuration !== null && (
                  <div className="route-schedule-summary">
                    <strong>Planned route span</strong>
                    <span>{stops[0].planned_time} to {stops[stops.length - 1].planned_time} · {formatDuration(plannedRouteDuration)}</span>
                  </div>
                )}
                {plannerStopGroups.map((group, index) => {
                  const groupRequests = group.stops
                    .map(({ ride_request_id }) => requestById.get(ride_request_id))
                    .filter((request): request is RideRequest => Boolean(request));
                  const representative = group.stops[0];
                  const groupTime = representative.planned_time;
                  return (
                    <div className="planner-stop" key={group.key}>
                      <span className="stop-number">{index + 1}</span>
                      <span className="planner-stop-copy">
                        <strong>{group.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'}{groupRequests.length > 1 ? ` ${groupRequests.length} passengers` : ''}</strong>
                        <small>{group.address}</small>
                        <small>{groupRequests.map(({ passenger_name, passenger_surname }) => `${passenger_name} ${passenger_surname}`).join(', ')}</small>
                      </span>
                      <label className="planner-stop-time"><span>Planned time</span><input aria-label={`${group.stop_type} group time`} aria-invalid={Boolean(plannerTimeErrors.get(group.key))} type="time" value={groupTime} onChange={(event) => {
                        const groupRequestIds = new Set(group.stops.map(({ ride_request_id }) => ride_request_id));
                        setStops((current) => current.map((item) => groupRequestIds.has(item.ride_request_id)
                          && item.stop_type === group.stop_type
                          ? { ...item, planned_time: event.target.value }
                          : item));
                      }} /></label>
                      {plannerTimeErrors.get(group.key) && <small className="field-error" role="alert">{plannerTimeErrors.get(group.key)}</small>}
                      {index > 0 && scheduledGap(plannerStopGroups[index - 1].stops[0].planned_time, groupTime) !== null && <small className="stop-gap-label">{formatDuration(scheduledGap(plannerStopGroups[index - 1].stops[0].planned_time, groupTime)!)} scheduled from previous stop</small>}
                      <div className="stop-order-actions">
                        <button className="button button-secondary button-small" type="button" aria-label={`Move ${group.stop_type} stop group earlier`} disabled={index === 0} onClick={() => moveStopGroup(index, -1)}>↑ Up</button>
                        <button className="button button-secondary button-small" type="button" aria-label={`Move ${group.stop_type} stop group later`} disabled={index === plannerStopGroups.length - 1} onClick={() => moveStopGroup(index, 1)}>↓ Down</button>
                      </div>
                    </div>
                  );
                })}
                <button
                  className="button button-primary"
                  disabled={createTripMutation.isPending || tripDatePreviewMutation.isPending}
                  type="button"
                  onClick={createTrips}
                >
                  {tripDatePreviewMutation.isPending
                    ? <LoaderCircle size={17} className="spin" />
                    : <Plus size={17} />}
                  {tripDatePreviewMutation.isPending ? 'Checking dates…' : 'Check dates & review'}
                </button>
              </div>
            </div>
          </section>
          {createdSeriesId && (
            <section ref={offerSectionRef} className="content-section trip-operations-section offer-composer-section">
              <div className="application-toolbar"><div><h2>Send offers to drivers</h2><p>Select drivers and arrange the order in which they receive the offer.</p></div></div>
              <div className="trip-review-panel">
                <h3>Review before sending offers</h3>
                {createdReview ? (
                  <>
                    <p>
                      {createdReview.result.trips.length} {createdReview.result.trips.length === 1 ? 'trip' : 'trips'} created ·
                      {' '}{createdReview.passengers.length} {createdReview.passengers.length === 1 ? 'passenger' : 'passengers'} ·
                      {' '}{createdReview.direction === 'home' ? 'Ride home' : 'Ride to work'}
                    </p>
                    <div className="trip-review-dates">
                      {createdReview.result.trips.map((trip) => (
                        <span key={trip.id}>{trip.date}</span>
                      ))}
                    </div>
                    <ol className="trip-review-stops">
                      {createdReview.stops.map((stop, index) => (
                        <li key={`${stop.stop_type}:${stop.address}:${index}`}>
                          <strong>{index + 1}. {stop.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'} · {stop.planned_time}</strong>
                          <span>{stop.address}</span>
                          <small>{stop.passengers.join(', ')}</small>
                        </li>
                      ))}
                    </ol>
                    <p className="trip-review-passengers">
                      Passengers: {createdReview.passengers.join(', ')}
                    </p>
                  </>
                ) : (
                  <p>Confirm that you have checked the trip route and schedule before sending offers.</p>
                )}
                <label className="trip-review-confirm">
                  <input
                    checked={reviewConfirmed}
                    onChange={(event) => setReviewConfirmed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>I reviewed the route, stop order, and schedule.</span>
                </label>
              </div>
              {eligibleQuery.isLoading && <div className="loading-state"><LoaderCircle className="spin" size={20} /> Checking eligible drivers…</div>}
              {eligibleQuery.error && <div className="alert alert-error" role="alert">{eligibleQuery.error instanceof Error ? eligibleQuery.error.message : 'Eligible drivers could not be loaded.'}</div>}
              {!eligibleQuery.isLoading && eligibleQuery.data?.length === 0 && <div className="empty-state"><strong>No drivers with an approved, available vehicle and enough seats are eligible right now</strong></div>}
              {eligibleQuery.data?.map((driver) => (
                <label className="candidate-row" key={driver.user_id}>
                  <input type="checkbox" checked={selectedDrivers.includes(driver.user_id)} onChange={() => toggleDriver(driver.user_id)} />
                  <span>
                    <strong>{driver.name} {driver.surname}</strong>
                    <small>{driver.make} {driver.model} · {driver.registration_number} · {driver.seat_count} seats</small>
                    {!driver.has_push_device && <small className="push-device-warning">No push device — driver must check the app while available.</small>}
                  </span>
                </label>
              ))}
              {selectedDrivers.length > 0 && (
                <ol className="candidate-order">
                  {selectedDrivers.map((driverId, index) => {
                    const driver = eligibleQuery.data?.find(({ user_id }) => user_id === driverId);
                    return (
                      <li key={driverId}>
                        <span>{index + 1}. {driver?.name} {driver?.surname}</span>
                        <button className="icon-button" disabled={index === 0} aria-label="Move driver up" type="button" onClick={() => moveDriver(index, -1)}>↑</button>
                        <button className="icon-button" disabled={index === selectedDrivers.length - 1} aria-label="Move driver down" type="button" onClick={() => moveDriver(index, 1)}>↓</button>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="offer-toolbar">
                <label className="field"><span>Offer window (minutes)</span><input type="number" min={1} max={1440} value={offerWindow} onChange={(event) => setOfferWindow(event.target.value)} /></label>
                <button className="button button-primary" disabled={!reviewConfirmed || !selectedDrivers.length || offerMutation.isPending} type="button" onClick={() => offerMutation.mutate()}>
                  {offerMutation.isPending ? 'Sending…' : 'Send offers'}
                </button>
              </div>
              {candidateError && <div className="alert alert-error" role="alert">{candidateError}</div>}
            </section>
          )}
        </>
      )}

      {view === 'trips' && (
        <section className="content-section trip-operations-section">
          <div className="application-toolbar">
            <div><h2>Trips</h2><p>{tripPages ? `${tripPages.total.toLocaleString()} trips` : 'Search and manage trips'}</p></div>
            <button
              aria-controls="trip-filter-panel"
              aria-expanded={tripFiltersOpen}
              className="button button-secondary"
              type="button"
              onClick={() => setTripFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal size={16} />
              {tripFiltersOpen ? 'Hide filters' : 'Show filters'}
            </button>
          </div>
          {tripFiltersOpen && <div className="ride-request-filters" id="trip-filter-panel">
            <label className="field"><span>From</span><input type="date" value={tripFrom} onChange={(event) => { setTripFrom(event.target.value); setTripPage(1); }} /></label>
            <label className="field"><span>To</span><input type="date" value={tripTo} onChange={(event) => { setTripTo(event.target.value); setTripPage(1); }} /></label>
            <label className="field"><span>Direction</span><select value={tripDirection} onChange={(event) => { setTripDirection(event.target.value); setTripPage(1); }}><option value="">All directions</option><option value="to_work">To work</option><option value="home">Home</option></select></label>
            <label className="field"><span>Status</span><select value={tripStatus} onChange={(event) => { setTripStatus(event.target.value); setTripPage(1); }}><option value="">All statuses</option><option value="draft">Draft</option><option value="offered">Offered</option><option value="accepted">Accepted</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="unassigned">Unassigned</option><option value="missed">Missed</option></select></label>
            <label className="field"><span>Search</span><input placeholder="Workplace, driver or registration" value={tripSearchInput} onChange={(event) => setTripSearchInput(event.target.value)} /></label>
          </div>}
          {tripsQuery.error && <div className="alert alert-error" role="alert">{tripsQuery.error instanceof Error ? tripsQuery.error.message : 'Trips could not be loaded.'}</div>}
          {tripsQuery.isLoading ? <div className="loading-state"><LoaderCircle className="spin" size={20} /> Loading trips…</div> : listTrips.length === 0 ? (
            <div className="empty-state"><strong>No trips match these filters</strong></div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Direction</th><th>Workplaces</th><th>Arrival / first stop</th><th>Driver</th><th>Passengers</th><th>Status</th><th /></tr></thead>
                <tbody>{listTrips.map((trip) => (
                  <tr key={trip.id}>
                    <td>{trip.direction === 'home' ? 'Home' : 'To work'}</td>
                    <td>{trip.workplace_name}</td>
                    <td>{trip.direction === 'home' ? `First stop · ${formatSchedule(trip.starts_at)}` : formatSchedule(trip.scheduled_at)}</td>
                    <td>{trip.driver_name ? `${trip.driver_name} ${trip.driver_surname}` : 'Unassigned'}{trip.registration_number && <small className="cell-subtitle">{trip.registration_number}</small>}</td>
                    <td>{trip.passenger_count}</td>
                    <td><span className={`status status-${trip.status}`}>{trip.status.replaceAll('_', ' ')}</span></td>
                    <td><button className="button button-secondary button-small" type="button" onClick={() => openTripDetails(trip.id)}>Details</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {tripPages && tripPages.total_pages > 1 && <PaginationControls page={tripPages.page} totalPages={tripPages.total_pages} onPage={setTripPage} />}
        </section>
      )}

      {view === 'live' && (
        <section className="content-section trip-operations-section">
          <div className="application-toolbar">
            <div>
              <h2><Activity size={18} /> Live trips <span className="section-count">{liveTripPages?.total ?? liveTrips.length}</span></h2>
              <p>Trips currently in progress. Updates every 15 seconds.</p>
            </div>
          </div>
          {liveTripsQuery.error && (
            <div className="alert alert-error" role="alert">
              {liveTripsQuery.error instanceof Error ? liveTripsQuery.error.message : 'Live trips could not be loaded.'}
            </div>
          )}
          {liveTripsQuery.isLoading ? (
            <div className="loading-state"><LoaderCircle className="spin" size={20} /> Loading live trips…</div>
          ) : liveTrips.length === 0 ? (
            <div className="empty-state"><strong>No trips in progress</strong></div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Trip</th><th>Workplaces</th><th>Current stop</th><th>ETA</th><th>Delay</th><th>No-shows</th><th>Exceptions</th><th>Incidents</th><th>Last update</th><th /></tr></thead>
                <tbody>{liveTrips.map((trip) => (
                  <tr key={trip.id}>
                    <td>{trip.direction === 'home' ? 'Home' : 'To work'}<small className="cell-subtitle">{trip.direction === 'home' ? 'First stop' : 'Workplace arrival'} · {formatSchedule(trip.scheduled_at)}</small></td>
                    <td><strong>{trip.workplace_name}</strong><small className="cell-subtitle">{trip.driver_name ? `${trip.driver_name} ${trip.driver_surname ?? ''}` : 'Driver not assigned'}{trip.registration_number ? ` · ${trip.registration_number}` : ''}</small></td>
                    <td>
                      {trip.current_stop_group ? (
                        <>
                          <strong>{trip.current_stop_group.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'} · {trip.current_stop_group.status.replaceAll('_', ' ')}</strong>
                          <small className="cell-subtitle">{trip.current_stop_group.address}{trip.current_stop_group.suburb ? `, ${trip.current_stop_group.suburb}` : ''} · {trip.current_stop_group.passenger_count} passenger{trip.current_stop_group.passenger_count === 1 ? '' : 's'}</small>
                        </>
                      ) : 'No active stop'}
                    </td>
                    <td>
                      {trip.current_stop_group?.eta_at ? (
                        <>
                          <strong className={trip.current_stop_group.eta_is_late ? 'eta-late' : undefined}>
                            {formatClockTime(trip.current_stop_group.eta_at)}
                          </strong>
                          {trip.current_stop_group.eta_age_minutes !== null && (
                            <small className="cell-subtitle">Updated {trip.current_stop_group.eta_age_minutes} min ago</small>
                          )}
                          {trip.current_stop_group.eta_is_late && (
                            <span className="status status-late">Late</span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                    <td>{trip.delay_minutes > 0 ? `${trip.delay_minutes} min` : 'On time'}</td>
                    <td>{trip.no_shows}</td>
                    <td>{trip.exceptions}{trip.has_issues && <small className="cell-subtitle">Issues flagged</small>}</td>
                    <td>
                      {trip.open_incidents > 0 ? (
                        <span className="live-incident-count"><Siren size={14} /> {trip.open_incidents}</span>
                      ) : 'None'}
                    </td>
                    <td>{formatSchedule(trip.last_update_at)}</td>
                    <td><button className="button button-secondary button-small" type="button" onClick={() => openTripDetails(trip.id)}>Details</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {liveTripPages && liveTripPages.total_pages > 1 && (
            <PaginationControls
              page={liveTripPages.page}
              totalPages={liveTripPages.total_pages}
              onPage={setLiveTripPage}
            />
          )}
        </section>
      )}

      {activeTripId && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTripDetails(); }}>
          <section className="dialog trip-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="trip-detail-title">
            <div className="trip-detail-heading">
              <div><span className="eyebrow">TRIP DETAILS</span><h2 id="trip-detail-title">{currentDetail ? `${currentDetail.direction === 'home' ? 'Home · first stop' : 'To work · arrival'} · ${formatSchedule(currentDetail.scheduled_at)}` : 'Trip details'}</h2></div>
              <button className="icon-button" type="button" aria-label="Close" onClick={closeTripDetails}><X size={18} /></button>
            </div>
            {tripDetailQuery.isLoading && <div className="loading-state"><LoaderCircle className="spin" size={20} /> Loading trip details…</div>}
            {tripDetailQuery.error && <div className="alert alert-error" role="alert">{tripDetailQuery.error instanceof Error ? tripDetailQuery.error.message : 'Trip details could not be loaded.'}</div>}
            {currentDetail && (
              <>
                <div className="trip-detail-meta">
                  <span><strong>Status</strong>{currentDetail.status.replaceAll('_', ' ')}</span>
                  <span><strong>Issues</strong>{currentDetail.has_issues ? 'Yes' : 'No'}</span>
                  <span><strong>Delay</strong>{currentDetail.delay_minutes > 0 ? `${currentDetail.delay_minutes} min` : 'On time'}</span>
                  <span><strong>Workplaces</strong>{currentDetail.workplace_name}<small>{currentDetail.workplace_address}</small></span>
                  <span><strong>Driver</strong>{currentDetail.driver_name ? `${currentDetail.driver_name} ${currentDetail.driver_surname}` : 'Unassigned'}</span>
                  <span><strong>Vehicle</strong>{currentDetail.registration_number ?? 'Unassigned'}</span>
                  <span><strong>{currentDetail.direction === 'home' ? 'First stop' : 'Workplace arrival'}</strong>{formatSchedule(currentDetail.scheduled_at)}</span>
                </div>
                {currentDetail.rescheduled_at && (
                  <div className="route-schedule-summary">
                    <strong>Rescheduled</strong>
                    <span>
                      Originally {currentDetail.original_scheduled_at ? formatSchedule(currentDetail.original_scheduled_at) : 'scheduled earlier'} · updated {formatSchedule(currentDetail.rescheduled_at)}
                    </span>
                  </div>
                )}
                {currentDetail.change_ack_required && (
                  <div className="alert alert-error" role="status">
                    The driver has not confirmed the latest trip changes.
                  </div>
                )}
                {currentDetail.closed_reason && (
                  <div className="route-schedule-summary">
                    <strong>Closure reason</strong>
                    <span>{currentDetail.closed_reason.replaceAll('_', ' ')}{currentDetail.closed_at ? ` · ${formatSchedule(currentDetail.closed_at)}` : ''}</span>
                  </div>
                )}
                <h3>Route order and schedule</h3>
                {currentTripSchedule && (
                  <div className="route-schedule-summary">
                    <strong>Planned route span</strong>
                    <span>{currentTripSchedule.start} to {currentTripSchedule.end} · {formatDuration(currentTripSchedule.duration)}</span>
                  </div>
                )}
                <ol className="trip-detail-stops">{currentRouteGroups.map((group, index) => {
                  const actualAt = group.stops.find(({ completed_at }) => completed_at)?.completed_at
                    ?? group.stops.find(({ arrived_at }) => arrived_at)?.arrived_at;
                  const etaStop = group.stops.find(({ eta_at }) => eta_at);
                  return (
                    <li key={group.key}>
                      <strong>{index + 1}. {group.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'}{group.stops.length > 1 ? ` ${group.stops.length} passengers` : ''}</strong>
                      <span>{group.address}{group.suburb ? `, ${group.suburb}` : ''}</span>
                      <small>{group.stops.map(({ passenger_name, passenger_surname }) => `${passenger_name} ${passenger_surname}`).join(', ')}</small>
                      <small>{formatSchedule(group.stops[0].planned_at)} · {group.stops.map(({ status }) => status).every((status) => status === group.stops[0].status) ? group.stops[0].status.replaceAll('_', ' ') : 'In progress'}{group.stops.some(({ skip_reason }) => skip_reason) ? ` · ${group.stops.find(({ skip_reason }) => skip_reason)?.skip_reason}` : ''}</small>
                      {actualAt && <small>Actual: {formatSchedule(actualAt)}</small>}
                      {etaStop?.eta_at && <small className={etaStop.eta_is_late ? 'eta-late' : undefined}>ETA {formatClockTime(etaStop.eta_at)} · Updated {etaStop.eta_age_minutes ?? 0} min ago{etaStop.eta_is_late ? ` · Late by ${etaStop.eta_minutes_late ?? 0} min` : ''}</small>}
                      {index > 0 && currentRouteGroups[index - 1] && (
                        <small>
                          {timestampGap(currentRouteGroups[index - 1].stops[0].planned_at, group.stops[0].planned_at) !== null
                            ? `${formatDuration(timestampGap(currentRouteGroups[index - 1].stops[0].planned_at, group.stops[0].planned_at)!)} scheduled from previous stop`
                            : 'Schedule time precedes the previous stop'}
                        </small>
                      )}
                    </li>
                  );
                })}</ol>
                <h3>Passengers</h3>
                <div className="table-scroll"><table><thead><tr><th>Passenger</th><th>Pick-up</th><th>Drop-off</th><th>Request source</th><th>Created by / at</th><th>Cancellation</th><th /></tr></thead>
                  <tbody>{currentDetail.passengers.map((passenger) => (
                    <tr key={passenger.ride_request_id}>
                      <td><strong>{passenger.passenger_name} {passenger.passenger_surname}</strong><small className="cell-subtitle">{passenger.employee_number}</small></td>
                      <td><span className={`status status-${passenger.pickup_status}`}>{passenger.pickup_status.replaceAll('_', ' ')}</span></td>
                      <td><span className={`status status-${passenger.dropoff_status}`}>{passenger.dropoff_status.replaceAll('_', ' ')}</span></td>
                      <td>{passenger.booking_source}</td>
                      <td>{passenger.booked_by_name ? `${passenger.booked_by_name} ${passenger.booked_by_surname}` : 'Passenger'}<small className="cell-subtitle">{formatSchedule(passenger.booked_at)}</small></td>
                      <td>{passenger.cancelled_at ? `${passenger.cancel_reason ?? 'Cancelled'} · ${formatSchedule(passenger.cancelled_at)}${passenger.cancelled_late ? ' · Late' : ''}` : '—'}</td>
                      <td>{['draft', 'offered', 'accepted', 'in_progress', 'unassigned'].includes(currentDetail.status) && passenger.request_status !== 'cancelled' && <button className="button button-secondary button-small" type="button" onClick={() => void removePassenger(currentDetail, passenger)}>Remove</button>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <h3>Event timeline</h3>
                {currentDetail.events.length === 0 ? (
                  <p className="form-hint">No trip events have been recorded.</p>
                ) : (
                  <ol className="trip-event-timeline">
                    {currentDetail.events.map((event) => {
                      const stop = event.stop_id
                        ? currentDetail.stops.find(({ id }) => id === event.stop_id)
                        : undefined;
                      const reason = event.metadata?.reason;
                      const note = event.metadata?.note;
                      const etaMinutes = event.event_type === 'eta_set'
                        && typeof event.metadata?.minutes === 'number'
                        ? event.metadata.minutes
                        : null;
                      return (
                        <li key={event.id}>
                          <strong>{event.event_type.replaceAll('.', ' ').replaceAll('_', ' ')}</strong>
                          <span>{formatSchedule(event.created_at)} · {event.actor_role ?? 'System'}</span>
                          {stop && <small>{stop.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'} · {stop.address}{stop.suburb ? `, ${stop.suburb}` : ''}</small>}
                          {typeof reason === 'string' && <small>{reason}</small>}
                          {typeof note === 'string' && <small>{note}</small>}
                          {etaMinutes !== null && (
                            <small>
                              Arrival time set to about {formatClockTime(
                                new Date(Date.parse(event.created_at) + etaMinutes * 60_000).toISOString()
                              )}
                            </small>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                <h3>Ratings</h3>
                {currentDetail.ratings.length === 0 ? (
                  <p className="form-hint">No ratings have been submitted.</p>
                ) : (
                  <div className="trip-rating-list">
                    {currentDetail.ratings.map((rating) => (
                      <article className="trip-rating-card" key={rating.id}>
                        <div><strong>{rating.passenger_name} {rating.passenger_surname}</strong><span>{rating.rating} / 5</span></div>
                        {rating.comment && <p>{rating.comment}</p>}
                        <small>{formatSchedule(rating.created_at)}</small>
                      </article>
                    ))}
                  </div>
                )}
                <h3>Driver withdrawals</h3>
                {currentDetail.withdrawals.length === 0 ? (
                  <p className="form-hint">No driver withdrawals recorded.</p>
                ) : (
                  <div className="trip-withdrawal-list">
                    {currentDetail.withdrawals.map((withdrawal) => (
                      <article className="trip-withdrawal-card" key={withdrawal.id}>
                        <strong>{withdrawal.driver_name} {withdrawal.driver_surname}{withdrawal.late ? ' · Late withdrawal' : ''}</strong>
                        <span>{withdrawal.reason_kind.replaceAll('_', ' ')} · {withdrawal.scope === 'all_future' ? 'This and all future trips' : 'This trip'}</span>
                        {withdrawal.note && <small>{withdrawal.note}</small>}
                        <small>{formatSchedule(withdrawal.created_at)}</small>
                      </article>
                    ))}
                  </div>
                )}
                <h3>Driver offers</h3>
                {currentDetail.offers.length === 0 ? <p className="form-hint">No driver offers yet.</p> : currentDetail.offers.map((offer) => (
                  <div className="offer-row" key={offer.id}>
                    <strong>{offer.position}. {offer.driver_name ? `${offer.driver_name} ${offer.driver_surname}` : 'Driver'}</strong>
                    <span>{offer.registration_number ?? ''} · {offer.status}</span>
                    {offer.status === 'pending' && !offer.has_push_device && <small className="push-device-warning">No push device — driver must check the app while available.</small>}
                    {offer.expires_at && <small>Expires {formatSchedule(offer.expires_at)}</small>}
                  </div>
                ))}
                {['draft', 'unassigned'].includes(currentDetail.status) && (
                  <div className="trip-editor-shell">
                    {!tripEditor ? (
                      <div className="dialog-actions">
                        <button className="button button-secondary" type="button" onClick={() => openTripEditor(currentDetail)}>Edit trip</button>
                        <button className="button button-primary" type="button" onClick={() => openOfferComposer(currentDetail)}>Send offers to drivers</button>
                      </div>
                    ) : (
                      <form className="trip-edit-form" onSubmit={saveTripEdit}>
                        <label className="field"><span>Distance (km)</span><input inputMode="decimal" value={tripEditor.distance_km} onChange={(event) => setTripEditor({ ...tripEditor, distance_km: event.target.value })} /></label>
                        <label className="field"><span>Notes</span><textarea maxLength={2000} rows={2} value={tripEditor.notes} onChange={(event) => setTripEditor({ ...tripEditor, notes: event.target.value })} /></label>
                        <h3>Stop order and times</h3>
                        <p>Consecutive passengers at the same address are shown as one stop. {currentDetail.direction === 'to_work'
                          ? `Workplace arrivals are set for ${localTime(currentDetail.scheduled_at)}.`
                          : 'Set the planned time for each stop.'}</p>
                        {editStopGroups.map((group, index) => {
                          const groupIds = new Set(group.stops.map(({ id }) => id));
                          const groupTime = group.stops[0]?.planned_at ?? '';
                          const passengers = group.stops.map(({ id }) => currentDetail.stops.find((stop) => stop.id === id))
                            .filter((stop): stop is TripStop => Boolean(stop))
                            .map((stop) => `${stop.passenger_name} ${stop.passenger_surname}`)
                            .join(', ');
                          return (
                          <div className="planner-stop" key={group.key}>
                            <span className="stop-number">{index + 1}</span>
                            <span className="planner-stop-copy"><strong>{group.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'} · {passengers}</strong><small>{group.source.address}{group.source.suburb ? `, ${group.source.suburb}` : ''}</small></span>
                            <input aria-label={`${group.stop_type} group date and time`} aria-invalid={Boolean(editTimeErrors.get(group.key))} type="datetime-local" value={groupTime} onChange={(event) => setTripEditor({ ...tripEditor, stops: tripEditor.stops.map((item) => groupIds.has(item.id) ? { ...item, planned_at: event.target.value } : item) })} />
                            {editTimeErrors.get(group.key) && <small className="field-error" role="alert">{editTimeErrors.get(group.key)}</small>}
                            <div className="stop-order-actions">
                              <button className="button button-secondary button-small" type="button" disabled={index === 0} aria-label={`Move ${group.stop_type} stop group earlier`} onClick={() => moveEditStop(index, -1)}>↑ Up</button>
                              <button className="button button-secondary button-small" type="button" disabled={index === editStopGroups.length - 1} aria-label={`Move ${group.stop_type} stop group later`} onClick={() => moveEditStop(index, 1)}>↓ Down</button>
                            </div>
                          </div>
                          );
                        })}
                        <div className="dialog-actions">
                          <button className="button button-secondary" type="button" onClick={() => setTripEditor(null)}>Cancel edit</button>
                          <button className="button button-primary" disabled={updateTripMutation.isPending} type="submit">{updateTripMutation.isPending ? 'Saving…' : 'Save trip'}</button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
                <div className="dialog-actions trip-actions">
                  {['draft', 'offered', 'accepted', 'unassigned'].includes(currentDetail.status) && <button className="button button-danger" type="button" onClick={() => void cancelTrip(currentDetail)}>Cancel trip</button>}
                  {['accepted', 'offered', 'unassigned'].includes(currentDetail.status) && <button className="button button-secondary" type="button" onClick={() => reassignTrip(currentDetail)}>Reassign</button>}
                  {currentDetail.status === 'offered' && <button className="button button-secondary" type="button" onClick={() => cancelSeriesOffers(currentDetail)}>Cancel offers</button>}
                  {['draft', 'offered', 'accepted', 'unassigned'].includes(currentDetail.status) && (
                    <button className="button button-secondary" type="button" onClick={() => openReschedule(currentDetail)}>Reschedule</button>
                  )}
                  {['draft', 'offered', 'accepted', 'unassigned'].includes(currentDetail.status) && !currentDetail.started_at && (
                    <button className="button button-secondary" type="button" onClick={() => { setMarkMissedReason(''); setMarkMissedOpen(true); }}>Mark missed</button>
                  )}
                  {['missed', 'cancelled', 'unassigned'].includes(currentDetail.status) && (
                    <button className="button button-secondary" type="button" onClick={() => reinstatePassengers(currentDetail)}>Reinstate eligible passengers</button>
                  )}
                  {currentDetail.passengers.length > 0 && (
                    <button className="button button-secondary" type="button" onClick={() => { setNotifyTemplate('rescheduled'); setNotifyOpen(true); }}>Notify passengers</button>
                  )}
                  {currentDetail.status === 'in_progress' && <button className="button button-danger" type="button" onClick={() => { setForceCompleteReason(''); setReleaseRemaining(false); setForceCompleteOpen(true); }}>Force complete</button>}
                </div>
                {rescheduleOpen && (
                  <form className="lifecycle-action-form" onSubmit={submitReschedule}>
                    <h3>Reschedule trip</h3>
                    <div className="planner-schedule-settings">
                      <label className="field"><span>New date</span><input type="date" required value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} /></label>
                      <label className="field"><span>{currentDetail.direction === 'home' ? 'New first stop time (24-hour)' : 'New workplace arrival time (24-hour)'}</span><input type="time" required value={rescheduleTime} onChange={(event) => setRescheduleTime(event.target.value)} /></label>
                    </div>
                    <label className="filter-check">
                      <input checked={rescheduleShiftStops} onChange={(event) => setRescheduleShiftStops(event.target.checked)} type="checkbox" />
                      <span>Shift every planned stop by the same time difference</span>
                    </label>
                    {currentDetail.status === 'accepted' && (
                      <label className="filter-check">
                        <input checked={rescheduleKeepDriver} onChange={(event) => setRescheduleKeepDriver(event.target.checked)} type="checkbox" />
                        <span>Keep the accepted driver and require confirmation</span>
                      </label>
                    )}
                    <div className="dialog-actions">
                      <button className="button button-secondary" disabled={tripActionMutation.isPending} onClick={() => setRescheduleOpen(false)} type="button">Cancel</button>
                      <button className="button button-primary" disabled={tripActionMutation.isPending} type="submit">{tripActionMutation.isPending ? 'Saving…' : 'Confirm reschedule'}</button>
                    </div>
                  </form>
                )}
                {markMissedOpen && (
                  <form className="lifecycle-action-form" onSubmit={submitMarkMissed}>
                    <h3>Mark trip missed</h3>
                    <p className="form-hint">This closes the trip as missed, updates its requests and notifies passengers.</p>
                    <label className="field"><span>Reason</span><textarea maxLength={500} required rows={3} value={markMissedReason} onChange={(event) => setMarkMissedReason(event.target.value)} /></label>
                    <div className="dialog-actions">
                      <button className="button button-secondary" disabled={tripActionMutation.isPending} onClick={() => setMarkMissedOpen(false)} type="button">Cancel</button>
                      <button className="button button-danger" disabled={!markMissedReason.trim() || tripActionMutation.isPending} type="submit">{tripActionMutation.isPending ? 'Saving…' : 'Confirm missed trip'}</button>
                    </div>
                  </form>
                )}
                {notifyOpen && (
                  <form className="lifecycle-action-form" onSubmit={submitPassengerNotice}>
                    <h3>Notify passengers</h3>
                    <label className="field"><span>Message type</span>
                      <select value={notifyTemplate} onChange={(event) => setNotifyTemplate(event.target.value as typeof notifyTemplate)}>
                        <option value="delayed">Delayed</option>
                        <option value="rescheduled">Rescheduled</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="custom">Custom message</option>
                      </select>
                    </label>
                    {notifyTemplate === 'delayed' && (
                      <label className="field"><span>Delay in minutes</span><input type="number" min={1} max={1440} required value={notifyMinutes} onChange={(event) => setNotifyMinutes(event.target.value)} /></label>
                    )}
                    {notifyTemplate === 'custom' && (
                      <>
                        <label className="field"><span>Message (max 160 characters)</span><textarea maxLength={160} required rows={3} value={notifyMessage} onChange={(event) => setNotifyMessage(event.target.value)} /></label>
                        <p className="form-hint">Do not include passenger names, addresses, phone numbers, or identification numbers.</p>
                      </>
                    )}
                    <div className="dialog-actions">
                      <button className="button button-secondary" disabled={tripActionMutation.isPending} onClick={() => setNotifyOpen(false)} type="button">Cancel</button>
                      <button className="button button-primary" disabled={tripActionMutation.isPending || (notifyTemplate === 'custom' && !notifyMessage.trim())} type="submit">{tripActionMutation.isPending ? 'Sending…' : 'Send update'}</button>
                    </div>
                  </form>
                )}
                {forceCompleteOpen && currentDetail.status === 'in_progress' && (
                  <form className="force-complete-form" onSubmit={submitForceComplete}>
                    <h3>Force-complete trip</h3>
                    <p className="form-hint">The trip will be completed with issues. Enter a reason for the trip record.</p>
                    <label className="field">
                      <span>Reason</span>
                      <textarea maxLength={1000} onChange={(event) => setForceCompleteReason(event.target.value)} required rows={3} value={forceCompleteReason} />
                    </label>
                    <label className="filter-check">
                      <input checked={releaseRemaining} onChange={(event) => setReleaseRemaining(event.target.checked)} type="checkbox" />
                      <span>Release passengers not yet dropped off back to pending ride requests</span>
                    </label>
                    <div className="dialog-actions">
                      <button className="button button-secondary" disabled={tripActionMutation.isPending} onClick={() => setForceCompleteOpen(false)} type="button">Keep trip active</button>
                      <button className="button button-danger" disabled={!forceCompleteReason.trim() || tripActionMutation.isPending} type="submit">
                        {tripActionMutation.isPending ? 'Saving…' : 'Confirm force complete'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
            {actionError && <div className="alert alert-error" role="alert">{actionError}</div>}
            {actionMessage && <div className="alert alert-success" role="status">{actionMessage}</div>}
          </section>
        </div>
      )}
    </>
  );
}

function PaginationControls({ page, totalPages, onPage }: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="application-pagination">
      <span>Page {page.toLocaleString()} of {totalPages.toLocaleString()}</span>
      <div>
        <button className="icon-button" aria-label="Previous page" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={17} /></button>
        <button className="icon-button" aria-label="Next page" type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={17} /></button>
      </div>
    </div>
  );
}
