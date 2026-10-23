import { isAxiosError } from 'axios';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, queryPollingInterval } from '@/api';
import { AppText as Text } from '@/components/AppText';
import { PassengerTabBar } from '@/components/PassengerTabBar';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { NotificationBell } from '@/notifications/NotificationProvider';
import { useTripReminders } from '@/notifications/useTripReminders';
import {
  displayPassengerSchedule,
  displayPassengerTime,
  fetchPassengerTrip,
  fetchPassengerTrips,
  type PassengerTrip,
  type PassengerTripPhase,
} from '@/passenger/rides';
import { theme } from '@/theme';

const supportPhone = process.env.EXPO_PUBLIC_SUPPORT_PHONE?.trim() ?? '';
const phaseSteps: { phase: Exclude<PassengerTripPhase, 'requested' | 'missed'>; label: string }[] = [
  { phase: 'scheduled', label: 'Scheduled' },
  { phase: 'driver_on_the_way', label: 'On the way' },
  { phase: 'driver_arrived', label: 'Arrived' },
  { phase: 'on_board', label: 'On board' },
  { phase: 'completed', label: 'Completed' },
];
const incidentTypes = [
  { type: 'emergency', label: 'Emergency' },
  { type: 'vehicle_problem', label: 'Vehicle problem' },
  { type: 'passenger_issue', label: 'Passenger issue' },
  { type: 'driver_issue', label: 'Driver issue' },
  { type: 'other', label: 'Other' },
] as const;

type IncidentType = typeof incidentTypes[number]['type'];

function errorMessage(error: unknown): string {
  if (isAxiosError<{ error?: { message?: string }; message?: string }>(error)) {
    return error.response?.data?.error?.message
      ?? error.response?.data?.message
      ?? 'Please check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'Please check your connection and try again.';
}

async function shareTripDetails(trip: PassengerTrip) {
  const pickup = trip.own_stops.find(({ stop_type }) => stop_type === 'pickup');
  const dropoff = trip.own_stops.find(({ stop_type }) => stop_type === 'dropoff');
  const phaseLabel: Record<PassengerTripPhase, string> = {
    requested: 'Ride requested',
    scheduled: 'Trip scheduled',
    driver_on_the_way: 'Driver is on the way',
    driver_arrived: 'Driver has arrived',
    on_board: 'You are on board',
    completed: 'Trip completed',
    missed: 'Ride missed',
  };
  const lines = [
    'My ride details',
    `Status: ${phaseLabel[trip.phase ?? 'scheduled']}`,
    `Time: ${displayPassengerSchedule(trip.scheduled_at)}`,
    `Workplace: ${trip.workplace_name ?? 'Not available'}`,
    pickup && `Pick-up: ${pickup.address}${pickup.suburb ? `, ${pickup.suburb}` : ''}`,
    dropoff && `Drop-off: ${dropoff.address}${dropoff.suburb ? `, ${dropoff.suburb}` : ''}`,
    trip.driver_first_name && `Driver: ${trip.driver_first_name}`,
    trip.vehicle_make && `Vehicle: ${trip.vehicle_make}${trip.vehicle_colour ? `, ${trip.vehicle_colour}` : ''}${trip.vehicle_plate ? ` (${trip.vehicle_plate})` : ''}`,
  ].filter((line): line is string => Boolean(line));

  try {
    await Share.share({ title: 'My ride details', message: lines.join('\n') });
  } catch {
    Alert.alert('Unable to share trip', 'Please try again or share your trip details another way.');
  }
}

function IncidentSheet({ visible, tripId, onClose }: {
  visible: boolean; tripId: string | undefined; onClose: () => void;
}) {
  const [type, setType] = useState<IncidentType>('other');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/incidents', {
        ...(tripId ? { trip_id: tripId } : {}),
        type,
        description: description.trim(),
        client_time: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      setError(null);
      setDescription('');
      onClose();
    },
    onError: (requestError: unknown) => setError(errorMessage(requestError)),
  });

  async function callNumber(number: string) {
    try {
      await Linking.openURL(`tel:${number}`);
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.modalKeyboard}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            accessibilityLabel="Close report"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.modalDismissArea}
          />
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheet}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.sheetTitle}>Emergency or problem</Text>
            <View style={styles.chips}>
              {incidentTypes.map(({ type: option, label }) => (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: option === type }}
                  onPress={() => setType(option)}
                  style={[styles.chip, option === type && styles.chipSelected]}
                >
                  <Text singleLine style={[styles.chipText, option === type && styles.chipTextSelected]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              accessibilityLabel="Describe the problem"
              multiline
              onChangeText={setDescription}
              placeholder="Describe the problem"
              style={styles.reasonInput}
              value={description}
            />
            {type === 'emergency' && (
              <View style={styles.buttonRow}>
                <PrimaryButton title="Call 112" variant="secondary" onPress={() => void callNumber('112')} />
                <PrimaryButton
                  title="Call dispatcher"
                  variant="secondary"
                  disabled={!supportPhone}
                  onPress={() => void callNumber(supportPhone)}
                />
              </View>
            )}
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <View style={styles.buttonRow}>
              <PrimaryButton title="Cancel" variant="secondary" onPress={onClose} />
              <PrimaryButton
                title="Send report"
                loading={mutation.isPending}
                disabled={!description.trim()}
                onPress={() => mutation.mutate()}
              />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PhaseProgress({ phase }: { phase: PassengerTripPhase | undefined }) {
  const currentIndex = Math.max(0, phaseSteps.findIndex(({ phase: item }) => item === phase));
  return (
    <View accessibilityRole="progressbar" style={styles.progress}>
      {phaseSteps.map((step, index) => (
        <View key={step.phase} style={styles.progressStep}>
          <View style={[styles.progressDot, index <= currentIndex && styles.progressDotActive]} />
          <Text numberOfLines={1} style={[styles.progressLabel, index === currentIndex && styles.progressLabelActive]}>
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PickupEstimate({ trip }: { trip: PassengerTrip }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (trip.phase !== 'scheduled' && trip.phase !== 'driver_on_the_way') return null;
  const pickup = trip.own_stops.find(({ stop_type }) => stop_type === 'pickup');
  const etaHint = pickup?.eta_phase_hint ?? trip.eta_phase_hint;
  if (etaHint) {
    const message = etaHint === 'little_late'
      ? 'Your driver is a little late'
      : etaHint === 'arriving_at' && pickup?.eta_at
        ? `Your driver expects to arrive at about ${displayPassengerTime(pickup.eta_at)}`
        : 'Your driver is on the way';
    return (
      <View style={styles.pickupEstimate}>
        <Text style={styles.pickupEstimateText}>{message}</Text>
        {etaHint === 'arriving_at' && trip.eta_updated_at && (
          <Text style={styles.helper}>{updatedAgo(trip.eta_updated_at, now)}</Text>
        )}
      </View>
    );
  }
  if (pickup?.projected_at) {
    return (
      <View style={styles.pickupEstimate}>
        <Text style={styles.pickupEstimateText}>
          Expected pick-up at about {displayPassengerTime(pickup.projected_at)}
        </Text>
      </View>
    );
  }
  if (!pickup?.planned_at) return null;

  const minutesUntilPickup = Math.ceil((Date.parse(pickup.planned_at) - now) / 60_000);
  const estimate = minutesUntilPickup > 0 && minutesUntilPickup <= 60
    ? `Scheduled pickup in ${minutesUntilPickup} min`
    : minutesUntilPickup === 0
      ? 'Scheduled pickup is due now'
    : minutesUntilPickup > 60
      ? `Pickup scheduled for ${displayPassengerSchedule(pickup.planned_at)}`
      : 'Scheduled pickup time has passed';

  return (
    <View style={styles.pickupEstimate}>
      <Text style={styles.pickupEstimateText}>{estimate}</Text>
    </View>
  );
}

function updatedAgo(value: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes === 0 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

function TripCard({ trip, expanded, onToggle, onCallDriver }: {
  trip: PassengerTrip;
  expanded: boolean;
  onToggle: () => void;
  onCallDriver: () => void;
}) {
  const pickup = trip.own_stops.find(({ stop_type }) => stop_type === 'pickup');
  const dropoff = trip.own_stops.find(({ stop_type }) => stop_type === 'dropoff');
  const phaseLabel: Record<PassengerTripPhase, string> = {
    requested: 'Ride requested',
    scheduled: 'Trip scheduled',
    driver_on_the_way: 'Driver is on the way',
    driver_arrived: 'Driver has arrived',
    on_board: 'You are on board',
    completed: 'Trip completed',
    missed: 'Ride missed',
  };
  return (
    <View style={styles.tripCard}>
      <View style={styles.tripSummary}>
        <Text style={styles.tripTitle}>{trip.direction === 'home' ? 'Ride home' : 'Ride to work'}</Text>
        <Text style={styles.workplace}>{trip.workplace_name ?? 'Workplace'}</Text>
        <Text singleLine style={styles.statusLine}>{phaseLabel[trip.phase ?? 'scheduled']}</Text>
        <Text style={styles.tripDate}>{displayPassengerSchedule(trip.scheduled_at)}</Text>
        <PickupEstimate trip={trip} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={styles.detailsToggle}
      >
        <Text style={styles.detailsToggleText}>{expanded ? 'Hide trip details' : 'View trip details'}</Text>
        <Text style={styles.detailsToggleIcon}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.tripDetails}>
          {trip.rescheduled_at && (
            <Text style={styles.rescheduledLabel}>
              Updated schedule: {displayPassengerSchedule(trip.rescheduled_at)}
            </Text>
          )}
          {trip.phase !== 'missed' && <PhaseProgress phase={trip.phase} />}
          {(trip.driver_first_name || trip.vehicle_make) && (
            <View style={styles.driverBlock}>
              {trip.driver_first_name && <Text style={styles.driverName}>Driver {trip.driver_first_name}</Text>}
              {trip.vehicle_make && (
                <Text style={styles.detail}>
                  {trip.vehicle_make}{trip.vehicle_colour ? ` · ${trip.vehicle_colour}` : ''}
                  {trip.vehicle_plate ? ` · ${trip.vehicle_plate}` : ''}
                </Text>
              )}
            </View>
          )}
          <PassengerStop label="Pick-up" stop={pickup} />
          <PassengerStop label="Drop-off" stop={dropoff} />
          {trip.delay_minutes > 0 && (
            <Text style={styles.delayText}>Running {trip.delay_minutes} minutes late. Planned times include the delay.</Text>
          )}
          {trip.driver_contact_number ? (
            <PrimaryButton title="Call driver" variant="secondary" onPress={onCallDriver} />
          ) : (
            <Text style={styles.helper}>Driver contact is available closer to pick-up.</Text>
          )}
        </View>
      )}
    </View>
  );
}

function PassengerStop({ label, stop }: {
  label: string; stop: PassengerTrip['own_stops'][number] | undefined;
}) {
  return (
    <View style={styles.stopRow}>
      <Text style={styles.stopLabel}>{label}</Text>
      {stop ? (
        <>
          <Text style={styles.detail}>{stop.address}{stop.suburb ? `, ${stop.suburb}` : ''}</Text>
          <Text style={styles.helper}>
            {stop.planned_at ? displayPassengerSchedule(stop.planned_at) : 'Time to be confirmed'}
          </Text>
        </>
      ) : (
        <Text style={styles.helper}>Stop details are not available.</Text>
      )}
    </View>
  );
}

function RatingCard({ trip, onReport }: { trip: PassengerTrip; onReport: () => void }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (rating < 1 || rating > 5) throw new Error('Choose a rating from 1 to 5 stars.');
      await api.post(`/rides/trips/${trip.id}/rating`, {
        rating,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
    },
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trips'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trip-history'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trip', trip.id] }),
      ]);
    },
    onError: (requestError: unknown) => setError(errorMessage(requestError)),
  });
  return (
    <View style={styles.tripCard}>
      <Text style={styles.tripTitle}>How was your trip?</Text>
      <Text style={styles.helper}>Rate your driver.</Text>
      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
            accessibilityState={{ checked: rating === value }}
            onPress={() => setRating(value)}
            style={styles.starButton}
          >
            <Text style={[styles.star, value <= rating && styles.starSelected]}>★</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Comment (optional)"
        onChangeText={setComment}
        placeholder="Comment (optional)"
        style={styles.commentInput}
        value={comment}
      />
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <PrimaryButton title="Submit rating" loading={mutation.isPending} onPress={() => mutation.mutate()} />
      <Pressable accessibilityRole="button" onPress={onReport} style={styles.reportLink}>
        <Text style={styles.linkText}>Report a problem</Text>
      </Pressable>
    </View>
  );
}

export function PassengerHome() {
  const queryClient = useQueryClient();
  const [focused, setFocused] = useState(false);
  const [incidentVisible, setIncidentVisible] = useState(false);
  const [tripDetailsExpanded, setTripDetailsExpanded] = useState(false);
  const [tripActionsExpanded, setTripActionsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  const tripsQuery = useQuery({
    queryKey: ['passenger', 'trips'],
    queryFn: ({ signal }) => fetchPassengerTrips('upcoming', signal),
    enabled: focused,
    retry: false,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 15) : false,
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  useTripReminders('passenger', tripsQuery.data?.trips, tripsQuery.dataUpdatedAt);
  const historyQuery = useQuery({
    queryKey: ['passenger', 'trip-history', 'summary'],
    queryFn: ({ signal }) => fetchPassengerTrips('history', signal),
    enabled: focused,
    retry: false,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const activeTrip = tripsQuery.data?.trips[0];
  const unratedTrip = historyQuery.data?.trips.find((trip) =>
    trip.status === 'completed' && (trip.passengers_picked_up ?? 0) > 0 && !trip.has_rated
  );
  const detailTripId = activeTrip?.id ?? unratedTrip?.id;
  const detailQuery = useQuery({
    queryKey: ['passenger', 'trip', detailTripId],
    queryFn: ({ signal }) => {
      if (!detailTripId) throw new Error('Trip selection is required.');
      return fetchPassengerTrip(detailTripId, signal);
    },
    enabled: focused && Boolean(detailTripId),
    retry: false,
    refetchInterval: focused && activeTrip
      ? (query) => queryPollingInterval(query, 15)
      : false,
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const trip = detailQuery.data;
  const ratingTrip = !activeTrip && trip?.status === 'completed' && !trip.has_rated ? trip : null;

  const cancelMutation = useMutation({
    mutationFn: async (requestId: string) => {
      await api.post(`/ride-requests/${requestId}/cancel`, { scope: 'this' });
    },
    onSuccess: async () => {
      setError(null);
      setSuccess('Ride cancelled.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trips'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trip-history'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'ride-requests'] }),
      ]);
    },
    onError: (requestError: unknown) => setError(errorMessage(requestError)),
  });

  function confirmCancel(currentTrip: PassengerTrip) {
    if (!currentTrip.ride_request_id) return;
    Alert.alert(
      'Cancel this ride?',
      currentTrip.cancel_may_be_late
        ? 'This cancellation may be considered late. Do you want to continue?'
        : 'Are you sure you want to cancel this ride?',
      [
        { text: 'Keep ride', style: 'cancel' },
        {
          text: 'Cancel ride',
          style: 'destructive',
          onPress: () => cancelMutation.mutate(currentTrip.ride_request_id),
        },
      ]
    );
  }

  async function callDriver(phone: string) {
    try {
      await Linking.openURL(`tel:${phone}`);
    } catch (callError) {
      setError(errorMessage(callError));
    }
  }

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        tripsQuery.refetch(),
        historyQuery.refetch(),
        detailTripId ? detailQuery.refetch() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <Screen
        refreshing={refreshing || tripsQuery.isRefetching || detailQuery.isRefetching}
        onRefresh={() => void refreshDashboard()}
        bottomNavigation={<PassengerTabBar />}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Your rides</Text>
          <NotificationBell />
        </View>
        {tripsQuery.isLoading && <ActivityIndicator color={theme.colors.primary} />}
        {tripsQuery.isError && (
          <View style={styles.messageBox}>
            <Text accessibilityRole="alert" style={styles.error}>Your trip could not be loaded. Pull to refresh or try again.</Text>
            <PrimaryButton title="Try again" variant="secondary" onPress={() => void tripsQuery.refetch()} />
          </View>
        )}
        {detailQuery.isError && <Text accessibilityRole="alert" style={styles.error}>Trip details could not be loaded. Pull to refresh or try again.</Text>}
        {activeTrip && detailQuery.isLoading && <ActivityIndicator color={theme.colors.primary} />}
        {trip && activeTrip && (
          <>
            <TripCard
              trip={trip}
              expanded={tripDetailsExpanded}
              onToggle={() => setTripDetailsExpanded((expanded) => !expanded)}
              onCallDriver={() => {
                if (trip.driver_contact_number) void callDriver(trip.driver_contact_number);
              }}
            />
            <View style={styles.actionsSection}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: tripActionsExpanded }}
                onPress={() => setTripActionsExpanded((expanded) => !expanded)}
                style={styles.actionsToggle}
              >
                <View style={styles.actionsToggleCopy}>
                  <Text style={styles.actionsTitle}>Trip options</Text>
                  <Text style={styles.actionsHint}>Manage this ride or report a problem</Text>
                </View>
                <Text style={styles.detailsToggleIcon}>{tripActionsExpanded ? '−' : '+'}</Text>
              </Pressable>
              {tripActionsExpanded && (
                <View style={styles.actionsPanel}>
                  <PrimaryButton
                    title="Share trip with trusted contact"
                    variant="secondary"
                    onPress={() => void shareTripDetails(trip)}
                  />
                  <Text style={styles.helper}>The share sheet includes your pickup and drop-off addresses.</Text>
                  {trip.can_cancel && trip.ride_request_id && (
                    <PrimaryButton
                      title="Cancel ride"
                      variant="secondary"
                      loading={cancelMutation.isPending}
                      onPress={() => confirmCancel(trip)}
                    />
                  )}
                  <PrimaryButton
                    title="Emergency or problem"
                    variant="secondary"
                    onPress={() => setIncidentVisible(true)}
                  />
                </View>
              )}
            </View>
          </>
        )}
        {!activeTrip && !unratedTrip && !tripsQuery.isLoading && !tripsQuery.isError && !historyQuery.isLoading && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No upcoming trip</Text>
            <Text style={styles.helper}>Your scheduled rides will appear here. Request a ride from the bottom navigation.</Text>
          </View>
        )}
        {ratingTrip && <RatingCard trip={ratingTrip} onReport={() => setIncidentVisible(true)} />}
        {historyQuery.isError && <Text accessibilityRole="alert" style={styles.error}>Trip history could not be loaded.</Text>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {success && <Text style={styles.success}>{success}</Text>}
      </Screen>
      <IncidentSheet
        visible={incidentVisible}
        tripId={trip?.id}
        onClose={() => setIncidentVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  title: { flex: 1, color: theme.colors.navy, fontSize: 25, fontWeight: '800', letterSpacing: -0.5 },
  tripCard: { gap: theme.spacing.md, padding: 18, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 20, backgroundColor: theme.colors.white, shadowColor: theme.colors.navy, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.045, shadowRadius: 14, elevation: 2 },
  tripSummary: { gap: theme.spacing.sm },
  tripTitle: { color: theme.colors.navy, fontSize: 19, fontWeight: '800', letterSpacing: -0.3 },
  workplace: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  tripDate: { color: theme.colors.navySoft, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  statusLine: { alignSelf: 'flex-start', overflow: 'hidden', paddingHorizontal: 11, paddingVertical: 7, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primaryLight, color: theme.colors.primaryDark, fontSize: 12, fontWeight: '800' },
  pickupEstimate: { gap: 3, marginTop: 2, padding: theme.spacing.md, borderRadius: 16, backgroundColor: theme.colors.primaryLight },
  pickupEstimateText: { color: theme.colors.primaryDark, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  detailsToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border },
  detailsToggleText: { color: theme.colors.primary, fontSize: 13, fontWeight: '700' },
  detailsToggleIcon: { width: 26, height: 26, overflow: 'hidden', borderRadius: 13, backgroundColor: theme.colors.primaryLight, color: theme.colors.primary, fontSize: 18, textAlign: 'center', textAlignVertical: 'center' },
  tripDetails: { gap: theme.spacing.sm },
  rescheduledLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  progress: { gap: theme.spacing.xs, marginVertical: theme.spacing.xs },
  progressStep: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  progressDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: theme.colors.border },
  progressDotActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  progressLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  progressLabelActive: { color: theme.colors.primary, fontWeight: '800' },
  driverBlock: { gap: 3, paddingTop: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border },
  driverName: { color: theme.colors.navy, fontSize: 14, fontWeight: '800' },
  stopRow: { gap: 3, paddingTop: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border },
  stopLabel: { color: theme.colors.navy, fontSize: 13, fontWeight: '800' },
  detail: { color: theme.colors.navySoft, fontSize: 13, lineHeight: 18 },
  helper: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
  delayText: { color: theme.colors.error, fontSize: 12, fontWeight: '700' },
  emptyCard: { gap: theme.spacing.md, padding: theme.spacing.lg, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  emptyTitle: { color: theme.colors.navy, fontSize: 18, fontWeight: '800' },
  messageBox: { gap: theme.spacing.sm },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 18 },
  success: { color: theme.colors.success, fontSize: 13, fontWeight: '700' },
  actionsSection: { gap: theme.spacing.sm },
  actionsToggle: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingHorizontal: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 18, backgroundColor: theme.colors.white },
  actionsToggleCopy: { flex: 1, gap: 3 },
  actionsTitle: { color: theme.colors.navy, fontSize: 14, fontWeight: '800' },
  actionsHint: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16 },
  actionsPanel: { gap: theme.spacing.sm, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 18, backgroundColor: theme.colors.white },
  stars: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.spacing.xs },
  starButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  star: { color: theme.colors.border, fontSize: 30 },
  starSelected: { color: '#F5B700' },
  commentInput: { minHeight: 60, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, color: theme.colors.text, fontFamily: 'Manrope_400Regular' },
  reportLink: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  linkText: { color: theme.colors.primary, fontSize: 13, fontWeight: '700' },
  modalKeyboard: { flex: 1 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#102D4670' },
  modalDismissArea: { ...StyleSheet.absoluteFill },
  sheetScroll: { flexGrow: 0, width: '100%', maxHeight: '88%' },
  sheet: { gap: theme.spacing.md, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.colors.white },
  sheetTitle: { color: theme.colors.navy, fontSize: 20, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  chip: { minHeight: 40, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.colors.border },
  chipSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryLight },
  chipText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  chipTextSelected: { color: theme.colors.primary },
  reasonInput: { minHeight: 84, padding: theme.spacing.md, textAlignVertical: 'top', borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, color: theme.colors.text, fontFamily: 'Manrope_400Regular' },
  buttonRow: { gap: theme.spacing.sm },
});
