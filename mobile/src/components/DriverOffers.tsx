import { isAxiosError } from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { api } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { AuthError } from '@/components/AuthError';
import { PrimaryButton } from '@/components/PrimaryButton';
import { formatPlaceParts } from '@/driver/trips';
import { theme } from '@/theme';

type OfferStop = {
  id?: string;
  stop_order: number;
  stop_type: 'pickup' | 'dropoff';
  passenger_name: string;
  passenger_surname: string;
  address: string;
  suburb: string | null;
  planned_at: string | null;
  status?: 'pending' | 'arrived' | 'completed';
  arrived_at?: string | null;
  completed_at?: string | null;
};

type DriverOffer = {
  id: string;
  expires_at: string;
  trip_id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  ends_at: string;
  make: string;
  model: string;
  registration_number: string;
  seat_count: number;
  passenger_count: number;
  stops: OfferStop[];
};

type DriverTrip = Omit<DriverOffer, 'expires_at' | 'trip_id'> & {
  id: string;
  status: 'accepted' | 'in_progress';
  started_at: string | null;
  completed_at: string | null;
};

function getErrorMessage(error: unknown) {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

function showTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function DriverOffers() {
  const { user } = useAuth();
  const [available, setAvailable] = useState(false);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [trips, setTrips] = useState<DriverTrip[]>([]);
  const [clock, setClock] = useState(0);
  const [loading, setLoading] = useState(true);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [activeOffer, setActiveOffer] = useState<string | null>(null);
  const [activeProgress, setActiveProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refreshDriverData = useCallback(async () => {
    const [offerResponse, tripResponse] = await Promise.all([
      api.get<{ offers: DriverOffer[] }>('/driver/offers'),
      api.get<{ trips: DriverTrip[] }>('/driver/trips'),
    ]);
    setOffers(offerResponse.data.offers);
    setTrips(tripResponse.data.trips);
  }, []);

  useEffect(() => {
    if (user?.status !== 'approved') {
      return;
    }
    let active = true;
    Promise.all([
      api.get<{ is_available: boolean }>('/driver/availability'),
    ])
      .then(async ([availabilityResponse]) => {
        await refreshDriverData();
        if (active) {
          setAvailable(availabilityResponse.data.is_available);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const refreshTimer = setInterval(() => {
      if (active) {
        refreshDriverData().catch((loadError: unknown) => {
          if (active) setError(getErrorMessage(loadError));
        });
      }
    }, 10_000);
    const clockTimer = setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      active = false;
      clearInterval(refreshTimer);
      clearInterval(clockTimer);
    };
  }, [refreshDriverData, user?.status]);

  async function toggleAvailability() {
    const nextValue = !available;
    setAvailabilityBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.patch<{ is_available: boolean }>('/driver/availability', {
        is_available: nextValue,
      });
      setAvailable(response.data.is_available);
      if (!nextValue) {
        setOffers([]);
        setMessage('You are offline. Any pending offer was passed to the next driver.');
      } else {
        setMessage('You are online and can receive trip offers.');
      }
    } catch (toggleError) {
      setError(getErrorMessage(toggleError));
    } finally {
      setAvailabilityBusy(false);
    }
  }

  async function respond(offerId: string, decision: 'accept' | 'decline') {
    setActiveOffer(offerId);
    setError(null);
    setMessage(null);
    try {
      await api.post(`/driver/offers/${offerId}/respond`, { decision });
      setOffers((current) => current.filter((offer) => offer.id !== offerId));
      setMessage(decision === 'accept' ? 'Trip offer accepted.' : 'Trip offer declined.');
      await refreshDriverData();
    } catch (respondError) {
      setError(getErrorMessage(respondError));
      await refreshDriverData().catch((refreshError: unknown) => {
        setError(getErrorMessage(refreshError));
      });
    } finally {
      setActiveOffer(null);
    }
  }

  async function startTrip(tripId: string) {
    setActiveProgress(`${tripId}:start`);
    setError(null);
    setMessage(null);
    try {
      await api.patch(`/driver/trips/${tripId}/start`);
      await refreshDriverData();
      setMessage('Trip started. Update each stop as you arrive and complete it.');
    } catch (startError) {
      setError(getErrorMessage(startError));
    } finally {
      setActiveProgress(null);
    }
  }

  async function updateStop(tripId: string, stop: OfferStop, status: 'arrived' | 'completed') {
    if (!stop.id) return;
    const progressId = `${tripId}:${stop.id}`;
    setActiveProgress(progressId);
    setError(null);
    setMessage(null);
    try {
      const response = await api.patch<{ stop: OfferStop; trip_completed: boolean }>(
        `/driver/trips/${tripId}/stops/${stop.id}/status`,
        { status }
      );
      await refreshDriverData();
      setMessage(response.data.trip_completed
        ? 'Trip completed.'
        : status === 'arrived' ? 'Arrival recorded.' : 'Stop completed.');
    } catch (progressError) {
      setError(getErrorMessage(progressError));
    } finally {
      setActiveProgress(null);
    }
  }

  if (user?.status !== 'approved') {
    return (
      <View style={styles.section}>
        <Text style={styles.title}>Trip offers</Text>
        <Text style={styles.helper}>Trip offers become available after your driver account and vehicle are approved.</Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.rowBetween}>
        <View style={styles.copy}>
          <Text style={styles.title}>Driver availability</Text>
          <Text style={styles.helper}>
            {available ? 'Online — eligible trips can be offered to you.' : 'Offline — you will not receive offers.'}
          </Text>
        </View>
        <PrimaryButton
          title={available ? 'Go offline' : 'Go online'}
          variant={available ? 'secondary' : 'primary'}
          loading={availabilityBusy}
          onPress={() => void toggleAvailability()}
          style={styles.availabilityButton}
        />
      </View>
      {error && <AuthError message={error} />}
      {message && <Text style={styles.success}>{message}</Text>}
      {loading ? (
        <Text style={styles.helper}>Loading trip offers…</Text>
      ) : null}
      {trips.length > 0 && (
        <View style={styles.tripList}>
          <Text style={styles.sectionTitle}>Assigned trips</Text>
          {trips.map((trip) => (
            <View key={trip.id} style={styles.offerCard}>
              <Text style={styles.title}>
                {trip.direction === 'home' ? 'Ride home' : 'Trip to work'}
              </Text>
              <Text style={styles.helper}>
                {showTime(trip.scheduled_at)} – {showTime(trip.ends_at)}
              </Text>
              <Text style={styles.detail}>
                {trip.passenger_count} passenger(s) · {trip.make} {trip.model} · {trip.registration_number}
              </Text>
              <OfferStops stops={trip.stops} />
              {trip.status === 'accepted' && (
                <PrimaryButton
                  title="Start trip"
                  loading={activeProgress === `${trip.id}:start`}
                  disabled={activeProgress !== null}
                  onPress={() => void startTrip(trip.id)}
                />
              )}
              {trip.status === 'in_progress' && trip.stops.map((stop, index) => {
                const previousStopsCompleted = trip.stops
                  .slice(0, index)
                  .every((previous) => previous.status === 'completed');
                const progressId = `${trip.id}:${stop.id}`;
                const nextStatus = stop.status === 'pending' ? 'arrived' : 'completed';
                return (
                  <View key={`${stop.stop_order}:${stop.stop_type}`} style={styles.progressRow}>
                    <Text style={styles.progressLabel}>
                      {stop.stop_order}. {stop.stop_type === 'pickup' ? 'Pickup' : 'Drop-off'} · {stop.passenger_name} {stop.passenger_surname}
                    </Text>
                    <PrimaryButton
                      title={stop.status === 'completed' ? 'Completed' : stop.status === 'arrived' ? 'Complete stop' : 'Mark arrived'}
                      variant={stop.status === 'completed' ? 'secondary' : 'primary'}
                      loading={activeProgress === progressId}
                      disabled={
                        activeProgress !== null || stop.status === 'completed'
                        || !previousStopsCompleted
                      }
                      onPress={() => void updateStop(trip.id, stop, nextStatus)}
                      style={styles.progressButton}
                    />
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      )}
      {!loading && offers.length === 0 ? (
        <Text style={styles.helper}>No active trip offers. This screen checks for offers every 10 seconds.</Text>
      ) : offers.map((offer) => {
        const secondsRemaining = clock === 0
          ? 0
          : Math.max(0, Math.ceil((Date.parse(offer.expires_at) - clock) / 1_000));
        const countdown = `${String(Math.floor(secondsRemaining / 60)).padStart(2, '0')}:${String(secondsRemaining % 60).padStart(2, '0')}`;
        return (
          <View key={offer.id} style={styles.offerCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.title}>
                {offer.direction === 'home' ? 'Ride home' : 'Trip to work'}
              </Text>
              <Text style={styles.countdown}>{secondsRemaining > 0 ? countdown : 'Expiring'}</Text>
            </View>
            <Text style={styles.helper}>
              {showTime(offer.scheduled_at)} – {showTime(offer.ends_at)}
            </Text>
            <Text style={styles.detail}>
              {offer.passenger_count} passenger(s) · {offer.make} {offer.model} · {offer.registration_number}
              {' · '}{offer.seat_count} seats
            </Text>
            <OfferStops stops={offer.stops} />
            <View style={styles.actions}>
              <PrimaryButton
                title="Decline"
                variant="secondary"
                loading={activeOffer === offer.id}
                disabled={activeOffer !== null || secondsRemaining === 0}
                onPress={() => void respond(offer.id, 'decline')}
                style={styles.actionButton}
              />
              <PrimaryButton
                title="Accept trip"
                loading={activeOffer === offer.id}
                disabled={activeOffer !== null || secondsRemaining === 0}
                onPress={() => void respond(offer.id, 'accept')}
                style={styles.actionButton}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function OfferStops({ stops }: { stops: OfferStop[] }) {
  return (
    <View style={styles.stops}>
      {stops.map((stop) => (
        <View key={`${stop.stop_order}:${stop.stop_type}`} style={styles.stop}>
          <Text style={styles.stopLabel}>
            {stop.stop_order}. {stop.stop_type === 'pickup' ? 'Pickup' : 'Drop-off'} ·{' '}
            {stop.passenger_name} {stop.passenger_surname}
          </Text>
          <Text style={styles.detail}>
            {formatPlaceParts(stop.address, stop.suburb)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: theme.spacing.md,
  },
  copy: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  title: {
    color: theme.colors.navy,
    fontSize: 17,
    fontWeight: '800',
  },
  helper: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  detail: {
    color: theme.colors.navySoft,
    fontSize: 12,
    lineHeight: 18,
  },
  availabilityButton: {
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
  },
  offerCard: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryLight,
  },
  countdown: {
    color: theme.colors.error,
    fontSize: 15,
    fontWeight: '900',
  },
  stops: {
    gap: theme.spacing.xs,
  },
  tripList: {
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.navy,
    fontSize: 15,
    fontWeight: '800',
  },
  stop: {
    gap: 2,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.white,
  },
  stopLabel: {
    color: theme.colors.navy,
    fontSize: 12,
    fontWeight: '800',
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  actionButton: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: theme.spacing.sm,
  },
  success: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
  progressRow: {
    gap: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  progressLabel: {
    color: theme.colors.navy,
    fontSize: 12,
    fontWeight: '700',
  },
  progressButton: {
    minHeight: 44,
  },
});
