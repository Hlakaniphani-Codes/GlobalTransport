import { isAxiosError } from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { api, apiGetAllPages } from '@/api';
import { AppTextInput } from '@/components/AppTextInput';
import { AuthError } from '@/components/AuthError';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

type Direction = 'to_work' | 'home';
type StopType = 'pickup' | 'dropoff';

type RideRequest = {
  id: string;
  direction: Direction;
  scheduled_at: string;
  passenger_name: string;
  passenger_surname: string;
  contact_number: string;
  home_address: string;
  home_suburb: string | null;
  home_latitude: number | null;
  home_longitude: number | null;
  employee_number: string;
  workplace_name: string;
  workplace_address: string;
  workplace_suburb: string;
  workplace_latitude: number | null;
  workplace_longitude: number | null;
  company_name: string;
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
};

type Candidate = EligibleDriver;

type Trip = {
  id: string;
  direction: Direction;
  scheduled_at: string;
  ends_at: string;
  status: string;
  driver_name: string | null;
  driver_surname: string | null;
  registration_number: string | null;
  passenger_count: number;
};

type StopRef = {
  ride_request_id: string;
  stop_type: StopType;
};

function getErrorMessage(error: unknown) {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

function localDateTime(value: string) {
  const date = new Date(value);
  const part = (number: number) => String(number).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`,
    time: `${part(date.getHours())}:${part(date.getMinutes())}`,
  };
}

function makeLocalDateTime(dateValue: string, timeValue: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeValue.trim());
  if (!dateMatch || !timeMatch) return null;
  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const date = new Date(
    Number(yearText),
    Number(monthText) - 1,
    Number(dayText),
    Number(hourText),
    Number(minuteText)
  );
  if (
    date.getFullYear() !== Number(yearText) ||
    date.getMonth() !== Number(monthText) - 1 ||
    date.getDate() !== Number(dayText) ||
    date.getHours() !== Number(hourText) ||
    date.getMinutes() !== Number(minuteText)
  ) return null;
  return date;
}

function showSchedule(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function stopLocation(request: RideRequest, direction: Direction, stopType: StopType) {
  const home = stopType === 'pickup' ? direction === 'to_work' : direction === 'home';
  return home
    ? `${request.home_address}${request.home_suburb ? `, ${request.home_suburb}` : ''}`
    : `${request.workplace_address}, ${request.workplace_suburb}`;
}

export function AdminTripBuilder() {
  const [requests, setRequests] = useState<RideRequest[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [stopOrder, setStopOrder] = useState<StopRef[]>([]);
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [drivers, setDrivers] = useState<EligibleDriver[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [lookingUpDrivers, setLookingUpDrivers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeTrip, setActiveTrip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const requestById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests]
  );
  const selectedRequests = selectedIds
    .map((id) => requestById.get(id))
    .filter((request): request is RideRequest => Boolean(request));
  const tripStart = selectedRequests.length > 0
    ? new Date(Math.min(...selectedRequests.map((request) => Date.parse(request.scheduled_at))))
    : null;
  const direction = selectedRequests[0]?.direction;

  async function refresh() {
    const [requestResponse, tripResponse] = await Promise.all([
      apiGetAllPages<RideRequest>('/admin/trip-requests', 'ride_requests'),
      apiGetAllPages<Trip>('/admin/trips', 'trips'),
    ]);
    setRequests(requestResponse);
    setTrips(tripResponse);
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGetAllPages<RideRequest>('/admin/trip-requests', 'ride_requests'),
      apiGetAllPages<Trip>('/admin/trips', 'trips'),
    ])
      .then(([allRequests, allTrips]) => {
        if (active) {
          setRequests(allRequests);
          setTrips(allTrips);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const refreshTimer = setInterval(() => {
      Promise.all([
        apiGetAllPages<RideRequest>('/admin/trip-requests', 'ride_requests'),
        apiGetAllPages<Trip>('/admin/trips', 'trips'),
      ])
        .then(([allRequests, allTrips]) => {
          if (active) {
            setRequests(allRequests);
            setTrips(allTrips);
          }
        })
        .catch((refreshError: unknown) => {
          if (active) setError(getErrorMessage(refreshError));
        });
    }, 15_000);
    return () => {
      active = false;
      clearInterval(refreshTimer);
    };
  }, []);

  function toggleRequest(request: RideRequest) {
    setError(null);
    setSuccess(null);
    if (selectedIds.includes(request.id)) {
      setSelectedIds((current) => current.filter((id) => id !== request.id));
      setStopOrder((current) => current.filter((stop) => stop.ride_request_id !== request.id));
      setDrivers([]);
      setCandidates([]);
      return;
    }
    if (selectedRequests.length > 0) {
      const sameDirection = request.direction === selectedRequests[0].direction;
      const sameDate = new Date(request.scheduled_at).toDateString()
        === new Date(selectedRequests[0].scheduled_at).toDateString();
      if (!sameDirection || !sameDate) {
        setError('A trip can only combine requests for the same direction and date.');
        return;
      }
    }
    setSelectedIds((current) => [...current, request.id]);
    setStopOrder((current) => [
      ...current,
      { ride_request_id: request.id, stop_type: 'pickup' },
      { ride_request_id: request.id, stop_type: 'dropoff' },
    ]);
    const start = new Date(request.scheduled_at);
    const currentStart = selectedRequests.length
      ? new Date(Math.min(...selectedRequests.map((item) => Date.parse(item.scheduled_at))))
      : null;
    const earliest = currentStart && currentStart < start ? currentStart : start;
    const defaultEnd = new Date(earliest.getTime() + 2 * 60 * 60 * 1000);
    const formatted = localDateTime(defaultEnd.toISOString());
    setEndDate(formatted.date);
    setEndTime(formatted.time);
    setDrivers([]);
    setCandidates([]);
  }

  function moveStop(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= stopOrder.length) return;
    setStopOrder((current) => {
      const updated = [...current];
      [updated[index], updated[destination]] = [updated[destination], updated[index]];
      return updated;
    });
  }

  async function findDrivers() {
    if (!tripStart) return;
    const endsAt = makeLocalDateTime(endDate, endTime);
    if (!endsAt || endsAt <= tripStart) {
      setError('Enter a valid trip end date and time after the first requested pickup.');
      return;
    }
    if (selectedRequests.some((request) => Date.parse(request.scheduled_at) > endsAt.getTime())) {
      setError('Trip end must be after every selected passenger’s requested time.');
      return;
    }

    setLookingUpDrivers(true);
    setError(null);
    setSuccess(null);
    setCandidates([]);
    try {
      const response = await api.get<{ drivers: EligibleDriver[] }>('/admin/eligible-drivers', {
        params: {
          scheduled_at: tripStart.toISOString(),
          ends_at: endsAt.toISOString(),
          passenger_count: selectedRequests.length,
        },
      });
      const firstVehicleByDriver = new Map<string, EligibleDriver>();
      for (const driver of response.data.drivers) {
        if (!firstVehicleByDriver.has(driver.user_id)) {
          firstVehicleByDriver.set(driver.user_id, driver);
        }
      }
      setDrivers([...firstVehicleByDriver.values()]);
      if (firstVehicleByDriver.size === 0) {
        setError('No online, approved driver with an available vehicle can take this trip.');
      }
    } catch (lookupError) {
      setError(getErrorMessage(lookupError));
    } finally {
      setLookingUpDrivers(false);
    }
  }

  function toggleCandidate(driver: EligibleDriver) {
    setCandidates((current) => {
      const existing = current.findIndex((candidate) => candidate.user_id === driver.user_id);
      return existing >= 0
        ? current.filter((candidate) => candidate.user_id !== driver.user_id)
        : [...current, driver];
    });
  }

  function moveCandidate(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= candidates.length) return;
    setCandidates((current) => {
      const updated = [...current];
      [updated[index], updated[destination]] = [updated[destination], updated[index]];
      return updated;
    });
  }

  async function createTrip() {
    if (!tripStart || !direction || selectedRequests.length === 0 || candidates.length === 0) {
      setError('Select ride requests and order at least one eligible driver.');
      return;
    }
    const endsAt = makeLocalDateTime(endDate, endTime);
    if (!endsAt || endsAt <= tripStart) {
      setError('Enter a valid trip end date and time.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.post<{ trip: Trip }>('/admin/trips', {
        direction,
        scheduled_at: tripStart.toISOString(),
        ends_at: endsAt.toISOString(),
        ride_request_ids: selectedIds,
        stop_order: stopOrder,
        candidate_drivers: candidates.map((candidate) => ({
          driver_user_id: candidate.user_id,
          vehicle_id: candidate.vehicle_id,
        })),
      });
      setSuccess(
        response.data.trip.status === 'offering'
          ? 'Trip created. The first driver has two minutes to respond.'
          : 'Trip was created, but every selected driver became unavailable.'
      );
      setSelectedIds([]);
      setStopOrder([]);
      setDrivers([]);
      setCandidates([]);
      await refresh();
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelTrip(tripId: string) {
    setActiveTrip(tripId);
    setError(null);
    setSuccess(null);
    try {
      await api.patch(`/admin/trips/${tripId}/cancel`);
      await refresh();
      setSuccess('Trip cancelled and its ride requests returned to the planning queue.');
    } catch (cancelError) {
      setError(getErrorMessage(cancelError));
    } finally {
      setActiveTrip(null);
    }
  }

  const selectableRequests = selectedRequests.length > 0
    ? requests.filter((request) =>
      request.direction === selectedRequests[0].direction
      && new Date(request.scheduled_at).toDateString()
        === new Date(selectedRequests[0].scheduled_at).toDateString()
    )
    : requests;

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text style={styles.title}>Trip planning</Text>
        <Text style={styles.helper}>
          Group requests for the same direction and date, arrange every stop, then order drivers
          for automatic offers. Address pins are unavailable until a location provider is chosen.
        </Text>
      </View>
      {error && <AuthError message={error} />}
      {success && <Text style={styles.success}>{success}</Text>}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>1. Select ride requests</Text>
        {loading ? <Text style={styles.helper}>Loading requests…</Text> : null}
        {!loading && requests.length === 0 && (
          <Text style={styles.helper}>No unassigned ride requests are waiting.</Text>
        )}
        {selectableRequests.map((request) => {
          const selected = selectedIds.includes(request.id);
          return (
            <Pressable
              key={request.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              onPress={() => toggleRequest(request)}
              style={[styles.requestCard, selected && styles.selectedCard]}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>
                  {request.passenger_name} {request.passenger_surname}
                </Text>
                <Text style={styles.selection}>{selected ? 'Selected' : 'Select'}</Text>
              </View>
              <Text style={styles.helper}>
                {request.direction === 'home' ? 'Ride home' : 'To work'} · {showSchedule(request.scheduled_at)}
              </Text>
              <Text style={styles.detail}>
                Home: {request.home_address}{request.home_suburb ? `, ${request.home_suburb}` : ''}
              </Text>
              <Text style={styles.detail}>
                Work: {request.workplace_name}, {request.workplace_address}, {request.workplace_suburb}
              </Text>
              <Text style={styles.detail}>
                {request.company_name} · {request.employee_number} · {request.contact_number}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {selectedRequests.length > 0 && (
        <>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Arrange the stops</Text>
            <Text style={styles.helper}>
              Trip starts at the earliest selected request. Move stops to set the route order.
            </Text>
            {stopOrder.map((stop, index) => {
              const request = requestById.get(stop.ride_request_id);
              if (!request) return null;
              return (
                <View key={`${stop.ride_request_id}:${stop.stop_type}`} style={styles.stopCard}>
                  <View style={styles.stopCopy}>
                    <Text style={styles.selection}>
                      {index + 1}. {stop.stop_type === 'pickup' ? 'Pickup' : 'Drop-off'}
                    </Text>
                    <Text style={styles.cardTitle}>
                      {request.passenger_name} {request.passenger_surname}
                    </Text>
                    <Text style={styles.detail}>
                      {stopLocation(request, request.direction, stop.stop_type)}
                    </Text>
                  </View>
                  <View style={styles.stopActions}>
                    <PrimaryButton
                      title="Up"
                      variant="secondary"
                      disabled={index === 0}
                      onPress={() => moveStop(index, -1)}
                      style={styles.moveButton}
                    />
                    <PrimaryButton
                      title="Down"
                      variant="secondary"
                      disabled={index === stopOrder.length - 1}
                      onPress={() => moveStop(index, 1)}
                      style={styles.moveButton}
                    />
                  </View>
                </View>
              );
            })}
            <AppTextInput
              label="Planned trip end date (YYYY-MM-DD)"
              value={endDate}
              onChangeText={setEndDate}
              placeholder="2026-10-16"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              returnKeyType="next"
            />
            <AppTextInput
              label="Planned trip end time (24-hour)"
              value={endTime}
              onChangeText={setEndTime}
              placeholder="19:00"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              maxLength={5}
              returnKeyType="done"
            />
            <PrimaryButton
              title="Find eligible drivers"
              loading={lookingUpDrivers}
              onPress={() => void findDrivers()}
            />
          </View>

          {drivers.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>3. Order driver offers</Text>
              <Text style={styles.helper}>
                Each driver receives the offer in this order and has two minutes to respond.
              </Text>
              {drivers.map((driver) => {
                const selected = candidates.some((item) => item.user_id === driver.user_id);
                return (
                  <Pressable
                    key={driver.user_id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    onPress={() => toggleCandidate(driver)}
                    style={[styles.driverCard, selected && styles.selectedCard]}
                  >
                    <Text style={styles.cardTitle}>{driver.name} {driver.surname}</Text>
                    <Text style={styles.detail}>
                      {driver.make} {driver.model} · {driver.registration_number} · {driver.seat_count} seats
                    </Text>
                    <Text style={styles.selection}>{selected ? 'In offer order' : 'Add as candidate'}</Text>
                  </Pressable>
                );
              })}
              {candidates.map((candidate, index) => (
                <View key={candidate.user_id} style={styles.candidateRow}>
                  <Text style={styles.detail}>
                    {index + 1}. {candidate.name} {candidate.surname}
                  </Text>
                  <View style={styles.stopActions}>
                    <PrimaryButton
                      title="Up"
                      variant="secondary"
                      disabled={index === 0}
                      onPress={() => moveCandidate(index, -1)}
                      style={styles.moveButton}
                    />
                    <PrimaryButton
                      title="Down"
                      variant="secondary"
                      disabled={index === candidates.length - 1}
                      onPress={() => moveCandidate(index, 1)}
                      style={styles.moveButton}
                    />
                  </View>
                </View>
              ))}
              <PrimaryButton
                title="Create trip and send first offer"
                loading={submitting}
                onPress={() => void createTrip()}
              />
            </View>
          )}
        </>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent trips</Text>
        {trips.some((trip) => trip.status === 'unassigned') && (
          <Text style={styles.attention}>
            Action needed: at least one trip has no remaining eligible drivers.
          </Text>
        )}
        {trips.length === 0 && <Text style={styles.helper}>Created trips will appear here.</Text>}
        {trips.map((trip) => (
          <View key={trip.id} style={styles.tripCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>
                {trip.direction === 'home' ? 'Ride home' : 'To work'} · {trip.passenger_count} passenger(s)
              </Text>
              <Text style={styles.selection}>{trip.status}</Text>
            </View>
            <Text style={styles.detail}>{showSchedule(trip.scheduled_at)} – {showSchedule(trip.ends_at)}</Text>
            <Text style={styles.detail}>
              {trip.driver_name
                ? `${trip.driver_name} ${trip.driver_surname} · ${trip.registration_number ?? ''}`
                : 'No driver assigned yet'}
            </Text>
            {!['cancelled', 'completed'].includes(trip.status) && (
              <PrimaryButton
                title="Cancel trip"
                variant="secondary"
                loading={activeTrip === trip.id}
                disabled={activeTrip !== null}
                onPress={() => void cancelTrip(trip.id)}
                style={styles.cancelButton}
              />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.lg,
  },
  heading: {
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.navy,
    fontSize: 20,
    fontWeight: '800',
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.navy,
    fontSize: 16,
    fontWeight: '800',
  },
  helper: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  requestCard: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  selectedCard: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryLight,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  cardTitle: {
    color: theme.colors.navy,
    fontSize: 14,
    fontWeight: '800',
  },
  detail: {
    color: theme.colors.navySoft,
    fontSize: 12,
    lineHeight: 18,
  },
  selection: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  stopCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.white,
  },
  stopCopy: {
    flex: 1,
    gap: 3,
  },
  stopActions: {
    gap: theme.spacing.xs,
  },
  moveButton: {
    minHeight: 34,
    paddingHorizontal: theme.spacing.sm,
  },
  driverCard: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primaryLight,
  },
  tripCard: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  cancelButton: {
    minHeight: 40,
    marginTop: theme.spacing.xs,
  },
  success: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
  attention: {
    color: theme.colors.error,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
});
