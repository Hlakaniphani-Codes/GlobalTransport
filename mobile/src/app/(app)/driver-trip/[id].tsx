import { useCallback, useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, queryPollingInterval } from '@/api';
import { AppText as Text } from '@/components/AppText';
import { AppButton } from '@/components/ui/AppButton';
import { ActionStack } from '@/components/ui/ActionStack';
import { cancelTripRemindersForTrip } from '@/notifications/tripReminderScheduler';
import { DriverTabBar } from '@/components/DriverTabBar';
import { Screen } from '@/components/Screen';
import {
  fetchDriverTrip,
  formatPlannedDuration,
  formatPlaceParts,
  formatTripDate,
  formatTripTime,
  groupDriverStops,
  tripHeadline,
  type DriverStopGroup,
  type DriverTrip,
  type TripStop,
} from '@/driver/trips';
import { openMapsDirections } from '@/utils/maps';
import { theme } from '@/theme';

const supportPhone = process.env.EXPO_PUBLIC_SUPPORT_PHONE?.trim() ?? '';

type StopSkipKind = 'no_show' | 'unreachable' | 'address_problem' | 'passenger_declined' | 'other';
type IncidentType = 'emergency' | 'vehicle_problem' | 'passenger_issue' | 'driver_issue' | 'other';
type RecoveryAction = 'withdraw' | 'not_happened' | 'end_early';
type ActionRequest = { path: string; body?: Record<string, unknown>; retryNetwork?: boolean };

const exceptionReasons: { kind: Exclude<StopSkipKind, 'no_show'>; label: string }[] = [
  { kind: 'unreachable', label: 'Passenger unreachable' },
  { kind: 'address_problem', label: 'Address problem' },
  { kind: 'passenger_declined', label: 'Passenger declined' },
  { kind: 'other', label: 'Other' },
];
const noShowReasons = ['No answer', 'Could not reach passenger', 'Other'];
const withdrawalReasons = [
  { kind: 'vehicle_problem', label: 'Vehicle problem' },
  { kind: 'illness_or_emergency', label: 'Illness or emergency' },
  { kind: 'personal', label: 'Personal' },
  { kind: 'schedule_conflict', label: 'Schedule conflict' },
  { kind: 'other', label: 'Other' },
] as const;
const missedTripReasons = [
  { kind: 'could_not_start', label: 'Could not start' },
  { kind: 'vehicle_problem', label: 'Vehicle problem' },
  { kind: 'passengers_unavailable', label: 'Passengers unavailable' },
  { kind: 'cancelled_by_company', label: 'Cancelled by company' },
  { kind: 'other', label: 'Other' },
] as const;
const incidentTypes: { type: IncidentType; label: string }[] = [
  { type: 'emergency', label: 'Emergency' },
  { type: 'vehicle_problem', label: 'Vehicle problem' },
  { type: 'passenger_issue', label: 'Passenger issue' },
  { type: 'driver_issue', label: 'Driver issue' },
  { type: 'other', label: 'Other' },
];

function requestErrorMessage(error: unknown): string {
  if (isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message ?? error.message;
  }
  return error instanceof Error ? error.message : 'Trip update could not be saved.';
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsedLabel(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function updatedAgo(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  return minutes === 0 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

function ModalSheet({ visible, onClose, children }: {
  visible: boolean; onClose: () => void; children: React.ReactNode;
}) {
  if (!visible) return null;
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.modalKeyboard}
      >
        <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.modalBackdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.modalSheet}>
            <ScrollView
              contentContainerStyle={styles.modalSheetContent}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.sheetHandle} />
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ActionButton({ title, onPress, primary = false, disabled = false, loading = false }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean; loading?: boolean;
}) {
  return <AppButton label={title} onPress={onPress} disabled={disabled} loading={loading} variant={primary ? 'primary' : 'secondary'} />;
}

function ReasonChip({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.reasonChip, selected && styles.reasonChipSelected]}
    >
      <Text singleLine style={[styles.reasonChipText, selected && styles.reasonChipTextSelected]}>{title}</Text>
    </Pressable>
  );
}

function displayedGroups(trip: DriverTrip): DriverStopGroup[] {
  return trip.stop_groups ?? groupDriverStops(trip.stops);
}

function isFinal(status: TripStop['status']): boolean {
  return status === 'completed' || status === 'skipped';
}

function uniqueRequestCount(stops: TripStop[]): number {
  return new Set(stops.map(({ ride_request_id, id }) => ride_request_id ?? id)).size;
}

function DriverTripSummary({ trip }: { trip: DriverTrip }) {
  const pickedUp = uniqueRequestCount(trip.stops.filter(({ stop_type, status }) =>
    stop_type === 'pickup' && status === 'completed'
  ));
  const droppedOff = uniqueRequestCount(trip.stops.filter(({ stop_type, status }) =>
    stop_type === 'dropoff' && status === 'completed'
  ));
  const noShows = uniqueRequestCount(trip.stops.filter(({ skip_kind }) => skip_kind === 'no_show'));
  const exceptions = uniqueRequestCount(trip.stops.filter(({ skip_kind }) =>
    skip_kind && skip_kind !== 'no_show'
  ));
  const durationMinutes = trip.started_at && trip.completed_at
    ? Math.max(0, Math.round((Date.parse(trip.completed_at) - Date.parse(trip.started_at)) / 60_000))
    : null;

  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryTitle}>Trip complete</Text>
      <Text style={styles.summaryTime}>
        {trip.completed_at ? `Completed at ${formatTripTime(trip.completed_at)}` : 'Trip completed'}
        {durationMinutes !== null ? ` · ${formatPlannedDuration(durationMinutes)}` : ''}
      </Text>
      <View style={styles.summaryStats}>
        <SummaryStat label="Picked up" value={pickedUp} />
        <SummaryStat label="Dropped off" value={droppedOff} />
        <SummaryStat label="No-shows" value={noShows} />
        <SummaryStat label="Exceptions" value={exceptions} />
      </View>
      {(trip.has_issues || exceptions > 0) && (
        <Text style={styles.issueMessage}>This trip was completed with issues.</Text>
      )}
    </View>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.summaryStat}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text singleLine style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

export default function DriverTripDetailScreen() {
  const { id, history } = useLocalSearchParams<{ id: string; history?: string }>();
  const readOnlyHistory = history === 'true';
  const router = useRouter();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [skipStop, setSkipStop] = useState<TripStop | null>(null);
  const [skipKind, setSkipKind] = useState<StopSkipKind>('no_show');
  const [skipReason, setSkipReason] = useState('');
  const [delayVisible, setDelayVisible] = useState(false);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction>('withdraw');
  const [recoveryReason, setRecoveryReason] = useState<string>('vehicle_problem');
  const [recoveryNote, setRecoveryNote] = useState('');
  const [withdrawScope, setWithdrawScope] = useState<'this' | 'all_future'>('this');
  const [incidentVisible, setIncidentVisible] = useState(false);
  const [incidentType, setIncidentType] = useState<IncidentType>('other');
  const [incidentDescription, setIncidentDescription] = useState('');
  const [etaEditing, setEtaEditing] = useState(false);
  const [etaSheetVisible, setEtaSheetVisible] = useState(false);
  const [etaMinutes, setEtaMinutes] = useState('');
  const [focused, setFocused] = useState(false);
  const tripQuery = useQuery({
    queryKey: ['driver', 'trip', id],
    queryFn: ({ signal }) => fetchDriverTrip(id, signal),
    enabled: Boolean(id) && focused,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const trip = tripQuery.data;
  const stopGroups = trip ? displayedGroups(trip) : [];
  const currentGroup = stopGroups.find(({ id: groupId }) => groupId === trip?.current_stop_group_id)
    ?? stopGroups.find(({ status }) => !isFinal(status));
  const currentIndex = currentGroup ? stopGroups.indexOf(currentGroup) : -1;

  useFocusEffect(useCallback(() => {
    setFocused(true);
    if (id) void queryClient.invalidateQueries({ queryKey: ['driver', 'trip', id] });
    return () => setFocused(false);
  }, [id, queryClient]));

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const initial = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 1_000);
    }, 0);
    return () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  }, []);

  const updateMutation = useMutation({
    mutationFn: async ({ path, body = {}, retryNetwork = true }: ActionRequest) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.post(path, {
            ...body,
            client_time: body.client_time ?? new Date().toISOString(),
          });
          return;
        } catch (requestError) {
          const canRetry = retryNetwork && isAxiosError(requestError)
            && !requestError.response && attempt < 3;
          if (!canRetry) throw requestError;
          setError("No connection. We'll try again");
          await wait(500 * (attempt + 1));
        }
      }
    },
    onSuccess: async (_data, variables) => {
      setError(null);
      if (variables.path.endsWith('/eta')) {
        setEtaEditing(false);
        setEtaSheetVisible(false);
        setEtaMinutes('');
        setFeedback('Arrival time updated.');
      }
      if (variables.path.endsWith('/start') || variables.path.endsWith('/report-not-happened')) {
        try {
          await cancelTripRemindersForTrip(id);
        } catch {
          setError('The trip reminder could not be cancelled on this device. Refresh and try again.');
        }
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['driver', 'trip', id] }),
        queryClient.invalidateQueries({ queryKey: ['driver', 'trips'] }),
        queryClient.invalidateQueries({ queryKey: ['driver', 'home'] }),
      ]);
    },
    onError: (requestError: unknown) => {
      setError(isAxiosError(requestError) && !requestError.response
        ? 'No connection. Please check your connection and try again.'
        : requestErrorMessage(requestError));
    },
  });
  const incidentMutation = useMutation({
    mutationFn: async () => {
      await api.post('/incidents', {
        trip_id: id,
        type: incidentType,
        description: incidentDescription.trim(),
        client_time: new Date().toISOString(),
      });
    },
    onSuccess: async () => {
      setError(null);
      setFeedback('Report sent.');
      setIncidentVisible(false);
      setIncidentDescription('');
      await queryClient.invalidateQueries({ queryKey: ['driver', 'trip', id] });
    },
    onError: (requestError: unknown) => setError(requestErrorMessage(requestError)),
  });

  const noShowStop = currentGroup?.stops.find((stop) =>
    stop.status === 'arrived' && stop.allowed_actions?.no_show
  );
  const noShowVisible = currentGroup?.stop_type === 'pickup'
    && currentGroup.status === 'arrived'
    && Boolean(noShowStop);
  const exceptionVisible = currentGroup?.stop_type === 'dropoff'
    && currentGroup.status === 'arrived'
    && Boolean(currentGroup.allowed_actions?.skip);
  const waitSeconds = currentGroup?.stops.reduce((maximum, stop) => {
    if (!stop.arrived_at) return maximum;
    return Math.max(maximum, Math.floor((now - Date.parse(stop.arrived_at)) / 1_000));
  }, currentGroup?.wait_seconds ?? 0) ?? 0;
  const currentEtaIsFresh = Boolean(currentGroup?.eta_is_fresh && currentGroup.eta_at);
  const fallbackStopLabel = trip?.workplace_name && trip.workplace_name !== 'Multiple workplaces'
    ? trip.workplace_name
    : 'your stop';
  const etaStopLabel = currentGroup
    ? (currentGroup.stop_type === 'pickup' && trip?.direction === 'home')
      || (currentGroup.stop_type === 'dropoff' && trip?.direction === 'to_work')
      ? currentGroup.suburb ?? (trip?.workplace_name === 'Multiple workplaces'
        ? 'the workplace'
        : trip?.workplace_name ?? 'the workplace')
      : currentGroup.suburb ?? fallbackStopLabel
    : 'your stop';
  const primaryAction = (() => {
    if (!trip) return null;
    if (trip.status === 'accepted') {
      const enabled = trip.allowed_next_actions?.start ?? false;
      return {
        title: 'Start trip',
        enabled,
        reason: enabled ? null : trip.allowed_next_actions?.start_reason ?? 'Start is available shortly before the first stop.',
        action: () => updateMutation.mutate({ path: `/driver/trips/${id}/start` }),
      };
    }
    if (trip.status === 'in_progress' && currentGroup) {
      if (currentGroup.status === 'en_route') {
        return {
          title: 'Arrived',
          enabled: currentGroup.allowed_actions?.arrive ?? trip.allowed_next_actions?.arrive ?? false,
          reason: null,
          action: () => updateMutation.mutate({
            path: `/driver/trips/${id}/stops/${currentGroup.id}/arrive`,
          }),
        };
      }
      if (currentGroup.status === 'arrived') {
        const title = currentGroup.stop_type === 'pickup' ? 'Picked up' : 'Dropped off';
        return {
          title,
          enabled: currentGroup.allowed_actions?.complete ?? trip.allowed_next_actions?.complete ?? false,
          reason: null,
          action: () => updateMutation.mutate({
            path: `/driver/trips/${id}/stops/${currentGroup.id}/complete`,
          }),
        };
      }
    }
    return null;
  })();
  const tripMissedStart = trip?.status === 'accepted'
    && trip.allowed_next_actions?.report_not_happened === true;

  async function openCurrentStopMap() {
    if (!currentGroup) return;
    const address = [currentGroup.address, currentGroup.suburb].filter(Boolean).join(', ');
    try {
      await openMapsDirections([{ address }]);
    } catch (mapError) {
      setError(requestErrorMessage(mapError));
    }
  }

  function saveEta(minutes: number) {
    if (!currentGroup || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      setError('Enter a number from 1 to 120.');
      return;
    }
    updateMutation.mutate({
      path: `/driver/trips/${id}/stops/${currentGroup.id}/eta`,
      body: { minutes },
    });
  }

  function submitManualEta() {
    const minutes = Number(etaMinutes);
    if (!etaMinutes.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      setError('Enter a number from 1 to 120.');
      return;
    }
    saveEta(minutes);
  }

  async function contactPassenger(phone: string, method: 'tel' | 'sms') {
    try {
      await Linking.openURL(`${method}:${phone}`);
    } catch (contactError) {
      setError(requestErrorMessage(contactError));
    }
  }

  function openNoShow(stop: TripStop) {
    setSkipStop(stop);
    setSkipKind('no_show');
    setSkipReason('');
    setFeedback(null);
  }

  function openDropoffException() {
    if (!currentGroup) return;
    setSkipStop(currentGroup.stops.find(({ status }) => status === 'arrived') ?? currentGroup.stops[0]);
    setSkipKind('unreachable');
    setSkipReason('');
    setFeedback(null);
  }

  async function saveSkip() {
    if (!skipStop || !skipReason.trim()) {
      setError('Enter a reason before continuing.');
      return;
    }
    await updateMutation.mutateAsync({
      path: `/driver/trips/${id}/stops/${skipStop.id}/skip`,
      body: { kind: skipKind, reason: skipReason.trim() },
    });
    setSkipStop(null);
  }

  function reportDelay(minutes: 5 | 10 | 15 | 20 | 30) {
    setDelayVisible(false);
    setFeedback(null);
    updateMutation.mutate({ path: `/driver/trips/${id}/delay`, body: { minutes } });
  }

  function createIncident() {
    if (!incidentDescription.trim()) {
      setError('Describe the problem before sending the report.');
      return;
    }
    setError(null);
    incidentMutation.mutate();
  }

  function openRecovery(action: RecoveryAction) {
    setRecoveryAction(action);
    setRecoveryReason(action === 'withdraw' ? 'vehicle_problem'
      : action === 'not_happened' ? 'could_not_start' : 'vehicle_problem');
    setRecoveryNote('');
    setWithdrawScope('this');
    setError(null);
    setFeedback(null);
    setRecoveryVisible(true);
  }

  async function saveRecovery() {
    const isOther = recoveryReason === 'other';
    if (isOther && recoveryNote.trim().length < 5) {
      setError('Add a note of at least five characters for Other.');
      return;
    }
    const path = recoveryAction === 'withdraw'
      ? `/driver/trips/${id}/withdraw`
      : recoveryAction === 'not_happened'
        ? `/driver/trips/${id}/report-not-happened`
        : `/driver/trips/${id}/end-early`;
    const body = recoveryAction === 'withdraw'
      ? { reason_kind: recoveryReason, note: recoveryNote.trim() || undefined, scope: withdrawScope }
      : recoveryAction === 'not_happened'
        ? { reason_kind: recoveryReason, note: recoveryNote.trim() || undefined }
        : { reason: recoveryReason, note: recoveryNote.trim() || undefined };
    try {
      await updateMutation.mutateAsync({ path, body });
      setRecoveryVisible(false);
      setFeedback(recoveryAction === 'withdraw' ? 'Trip returned to dispatch.'
        : recoveryAction === 'not_happened' ? 'Trip reported as not completed.'
          : 'Trip ended early.');
      if (recoveryAction === 'withdraw' || recoveryAction === 'not_happened') {
        router.replace(recoveryAction === 'withdraw' ? '/driver' : '/driver-history');
      }
    } catch {
      return;
    }
  }

  if (tripQuery.isLoading || !trip) {
    return (
      <Screen bottomNavigation={<DriverTabBar />}>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text singleLine style={styles.back}>‹ Back</Text>
        </Pressable>
        {tripQuery.isError
          ? <Text accessibilityRole="alert" style={styles.error}>Trip details could not be loaded. Pull to refresh or try again.</Text>
          : <ActivityIndicator color={theme.colors.primary} />}
      </Screen>
    );
  }

  if (trip.status === 'completed' && !readOnlyHistory) {
    return (
      <Screen
        refreshing={tripQuery.isRefetching}
        onRefresh={() => void tripQuery.refetch()}
        footer={<ActionButton title="Done" primary onPress={() => router.replace('/driver')} />}
        bottomNavigation={<DriverTabBar />}
      >
        <DriverTripSummary trip={trip} />
      </Screen>
    );
  }

  const statusText = readOnlyHistory
    ? trip.status === 'completed' ? 'Trip completed'
      : trip.status === 'missed' ? 'Trip missed' : 'Trip cancelled'
    : trip.status === 'in_progress' && currentGroup
      ? currentGroup.status === 'arrived'
        ? `At stop ${currentIndex + 1} of ${stopGroups.length}`
        : `Heading to stop ${currentIndex + 1} of ${stopGroups.length}`
      : trip.status === 'cancelled' ? 'Trip cancelled' : 'Trip scheduled';
  return (
    <>
      <Screen
        refreshing={tripQuery.isRefetching}
        onRefresh={() => void tripQuery.refetch()}
        bottomNavigation={<DriverTabBar />}
        footer={readOnlyHistory ? undefined : (
          <ActionStack>
            {noShowVisible && noShowStop && (
              <ActionButton
                title="Passenger not here"
                disabled={updateMutation.isPending}
                onPress={() => openNoShow(noShowStop)}
              />
            )}
            {exceptionVisible && (
              <ActionButton
                title="Couldn't complete drop-off"
                disabled={updateMutation.isPending}
                onPress={openDropoffException}
              />
            )}
            {primaryAction ? (
              <>
                {primaryAction.reason && <Text style={styles.footerReason}>{primaryAction.reason}</Text>}
                {tripMissedStart && supportPhone && (
                  <ActionButton
                    title="Call dispatch"
                    disabled={updateMutation.isPending}
                    onPress={() => void Linking.openURL(`tel:${supportPhone}`)}
                  />
                )}
                <ActionButton
                  title={primaryAction.title}
                  primary
                  disabled={!primaryAction.enabled || updateMutation.isPending}
                  loading={updateMutation.isPending}
                  onPress={primaryAction.action}
                />
              </>
            ) : trip.status === 'in_progress' ? (
              <ActionButton title="Updating trip" primary disabled onPress={() => undefined} />
            ) : null}
          </ActionStack>
        )}
      >
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text singleLine style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.pageTitle}>{readOnlyHistory ? 'Trip history' : 'Trip'}</Text>

        <View style={styles.tripCard}>
          <View style={styles.tripHeader}>
            <View style={styles.dateBlock}>
              <Text style={styles.month}>{formatTripDate(trip.scheduled_at).month.toUpperCase()}</Text>
              <Text style={styles.day}>{formatTripDate(trip.scheduled_at).day}</Text>
              <Text style={styles.weekday}>{formatTripDate(trip.scheduled_at).weekday.slice(0, 3)}</Text>
            </View>
            <View style={styles.tripCopy}>
              <Text style={styles.headline}>{tripHeadline(trip)}</Text>
              <Text style={styles.address}>
                {trip.workplace_name === 'Multiple workplaces'
                  ? 'Multiple workplaces'
                  : formatPlaceParts(trip.workplace_name, trip.workplace_address) || 'Workplace'}
              </Text>
              <Text style={styles.meta}>
                {trip.passenger_count} passengers{trip.distance_km !== null ? ` · ${trip.distance_km} km` : ''}
              </Text>
              <Text style={styles.status}>{trip.status.replace('_', ' ')}</Text>
            </View>
          </View>
          <View style={styles.vehicle}>
            <Text style={styles.meta}>
              {trip.vehicle_make} {trip.vehicle_model} · {trip.registration_number}
            </Text>
          </View>
        </View>

        <View style={styles.liveBanner}>
          <View style={styles.liveDot} />
          <View style={styles.liveCopy}>
            <Text style={styles.liveTitle}>{statusText}</Text>
            {trip.delay_minutes ? <Text style={styles.liveDetail}>Running {trip.delay_minutes} minutes late</Text> : null}
          </View>
        </View>

        {!readOnlyHistory && <ActionStack>
          {trip.status === 'accepted' && !trip.started_at && (
            <ActionButton title="Withdraw trip" onPress={() => openRecovery('withdraw')} />
          )}
          {trip.allowed_next_actions?.acknowledge_change && (
            <ActionButton
              title="Confirm trip changes"
              disabled={updateMutation.isPending}
              onPress={() => updateMutation.mutate({
                path: `/driver/trips/${id}/acknowledge-change`,
              })}
            />
          )}
          {trip.allowed_next_actions?.report_not_happened && (
            <ActionButton title="Report trip did not happen" onPress={() => openRecovery('not_happened')} />
          )}
          {currentGroup && (
            <ActionButton title="Navigate" onPress={() => void openCurrentStopMap()} />
          )}
          {trip.status === 'in_progress' && currentGroup?.status === 'en_route' && (
            <Text style={styles.helper}>Check the route in Maps, then choose your arrival time.</Text>
          )}
          {trip.allowed_next_actions?.delay && (
            <ActionButton title="Running late" onPress={() => setDelayVisible(true)} />
          )}
          {trip.status === 'in_progress' && (
            <>
              <ActionButton title="End trip early" onPress={() => openRecovery('end_early')} />
              <ActionButton title="Emergency or problem" onPress={() => setIncidentVisible(true)} />
            </>
          )}
        </ActionStack>}
        {!readOnlyHistory && trip.status === 'in_progress' && currentGroup?.status === 'en_route' && (
          <View style={styles.etaCard}>
            {currentEtaIsFresh && !etaEditing ? (
              <>
                <Text style={styles.etaTitle}>
                  Arriving at about {formatTripTime(currentGroup.eta_at!)}
                </Text>
                {currentGroup.eta_updated_at && (
                  <Text style={styles.helper}>{updatedAgo(currentGroup.eta_updated_at)}</Text>
                )}
                <ActionButton title="Change" onPress={() => setEtaEditing(true)} />
              </>
            ) : (
              <>
                <Text style={styles.etaTitle}>
                  {currentGroup.eta_at ? 'Update your arrival time' : `How long to ${etaStopLabel}?`}
                </Text>
                <View style={styles.chips}>
                  {(trip.eta_quick_options ?? [5, 10, 15, 20, 30, 45, 60]).map((minutes) => (
                    <Pressable
                      key={minutes}
                      accessibilityRole="button"
                      accessibilityLabel={`${minutes} minutes`}
                      disabled={updateMutation.isPending}
                      onPress={() => saveEta(minutes)}
                      style={styles.reasonChip}
                    >
                      <Text singleLine style={styles.reasonChipText}>{minutes} min</Text>
                    </Pressable>
                  ))}
                </View>
                <ActionButton title="Enter minutes" onPress={() => setEtaSheetVisible(true)} />
                {currentGroup.eta_updated_at && (
                  <Text style={styles.helper}>{updatedAgo(currentGroup.eta_updated_at)}</Text>
                )}
              </>
            )}
          </View>
        )}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {feedback && <Text style={styles.feedback}>{feedback}</Text>}
        {tripQuery.isError && <Text accessibilityRole="alert" style={styles.error}>Trip details could not be refreshed. Pull to try again.</Text>}

        <Text style={styles.sectionTitle}>Stops</Text>
        <View style={styles.stops}>
          {stopGroups.map((group, index) => {
            const isCurrent = !readOnlyHistory && group.id === currentGroup?.id;
            const actualTime = group.completed_at
              ? `Completed ${formatTripTime(group.completed_at)}`
              : group.arrived_at ? `Arrived ${formatTripTime(group.arrived_at)}` : null;
            return (
              <View key={group.id} style={[styles.stopCard, isCurrent && styles.stopCurrent]}>
                <View style={styles.stopHeading}>
                  <View style={[
                    styles.dot,
                    group.status === 'completed' && styles.dotDone,
                    group.status === 'skipped' && styles.dotSkipped,
                    isCurrent && styles.dotCurrent,
                  ]} />
                  <Text style={styles.stopTime}>
                    Stop {index + 1} · {group.planned_at ? formatTripTime(group.planned_at) : '—'}
                  </Text>
                  {isCurrent && <Text singleLine style={styles.currentBadge}>CURRENT</Text>}
                  {group.status === 'skipped' && <Text singleLine style={styles.skippedBadge}>SKIPPED</Text>}
                </View>
                <Text style={styles.stopAddress}>
                  {group.stop_type === 'pickup' ? 'Pick up' : 'Drop off'}
                  {group.stops.length > 1 ? ` ${group.stops.length} passengers` : ''}
                  {' · '}{formatPlaceParts(group.address, group.suburb)}
                </Text>
                {actualTime && <Text style={styles.actualTime}>{actualTime}</Text>}
                <View style={styles.passengerList}>
                  {group.stops.map((stop) => {
                    const contactNumber = stop.contact_number;
                    return (
                    <View key={stop.id}>
                      <View style={styles.passengerRow}>
                        <View style={styles.passengerCopy}>
                          <Text style={styles.passenger}>
                            {stop.passenger_name} {stop.passenger_surname}
                            {stop.status === 'skipped' ? ` · ${stop.skip_kind === 'no_show' ? 'No-show' : 'Skipped'}` : ''}
                          </Text>
                          {isCurrent && trip.status === 'in_progress' && (
                            <Text style={styles.passengerStatus}>
                              {stop.status.replace('_', ' ')}
                              {stop.status === 'arrived' && stop.arrived_at
                                ? ` · Wait ${elapsedLabel(Math.floor((now - Date.parse(stop.arrived_at)) / 1_000))}`
                                : ''}
                            </Text>
                          )}
                        </View>
                      </View>
                      {isCurrent
                        && group.stop_type === 'pickup'
                        && ['en_route', 'arrived'].includes(group.status)
                        && trip.status === 'in_progress'
                        && ['en_route', 'arrived'].includes(stop.status)
                        && contactNumber && (
                          <ActionStack>
                            <ActionButton title="Call" onPress={() => void contactPassenger(contactNumber, 'tel')} />
                            <ActionButton title="SMS" onPress={() => void contactPassenger(contactNumber, 'sms')} />
                          </ActionStack>
                        )}
                    </View>
                    );
                  })}
                </View>
                {group.status === 'arrived' && group.stop_type === 'pickup' && (
                  <Text style={styles.waitHint}>Wait timer {elapsedLabel(waitSeconds)}</Text>
                )}
              </View>
            );
          })}
        </View>
        {readOnlyHistory && (
          <>
            <Text style={styles.sectionTitle}>Trip timeline</Text>
            {trip.events?.length ? (
              <View style={styles.eventList}>
                {trip.events.map((event) => (
                  <View key={event.id} style={styles.eventRow}>
                    <View style={styles.eventDot} />
                    <View style={styles.eventCopy}>
                      <Text style={styles.eventTitle}>
                        {event.event_type.replace(/[._]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}
                      </Text>
                      <Text style={styles.helper}>
                        {formatTripDate(event.created_at).full} · {formatTripTime(event.created_at)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.helper}>No trip events recorded.</Text>
            )}
          </>
        )}
      </Screen>

      <ModalSheet visible={Boolean(skipStop)} onClose={() => setSkipStop(null)}>
        <Text style={styles.sheetTitle}>{skipKind === 'no_show' ? 'Confirm no-show' : 'Drop-off exception'}</Text>
        {skipKind === 'no_show' ? (
          <>
            <Text style={styles.helper}>
              Call {skipStop?.passenger_name} {skipStop?.passenger_surname} before recording a no-show.
            </Text>
            <View style={styles.chips}>
              {noShowReasons.map((reason) => (
                <ReasonChip
                  key={reason}
                  title={reason}
                  selected={skipReason === reason}
                  onPress={() => setSkipReason(reason)}
                />
              ))}
            </View>
          </>
        ) : (
          <View style={styles.chips}>
            {exceptionReasons.map(({ kind, label }) => (
              <ReasonChip
                key={kind}
                title={label}
                selected={skipKind === kind}
                onPress={() => {
                  setSkipKind(kind);
                  setSkipReason(label);
                }}
              />
            ))}
          </View>
        )}
        <TextInput
          accessibilityLabel="Reason"
          multiline
          onChangeText={setSkipReason}
          placeholder="Reason"
          style={styles.reasonInput}
          value={skipReason}
        />
        <View style={styles.actionRow}>
          <ActionButton title="Cancel" onPress={() => setSkipStop(null)} />
          <ActionButton
            title={skipKind === 'no_show' ? 'Confirm no-show' : 'Record exception'}
            primary
            disabled={!skipReason.trim() || updateMutation.isPending}
            loading={updateMutation.isPending}
            onPress={() => void saveSkip()}
          />
        </View>
      </ModalSheet>

      <ModalSheet visible={delayVisible} onClose={() => setDelayVisible(false)}>
        <Text style={styles.sheetTitle}>Running late</Text>
        <Text style={styles.helper}>Select the expected delay.</Text>
        <View style={styles.delayOptions}>
          {[5, 10, 15, 20, 30].map((minutes) => (
            <ActionButton
              key={minutes}
              title={`${minutes} minutes`}
              disabled={updateMutation.isPending}
              onPress={() => reportDelay(minutes as 5 | 10 | 15 | 20 | 30)}
            />
          ))}
        </View>
      </ModalSheet>

      <ModalSheet visible={recoveryVisible} onClose={() => setRecoveryVisible(false)}>
        <Text style={styles.sheetTitle}>
          {recoveryAction === 'withdraw' ? 'Withdraw trip'
            : recoveryAction === 'not_happened' ? 'Report trip did not happen'
              : 'End trip early'}
        </Text>
        <Text style={styles.helper}>
          {recoveryAction === 'withdraw'
            ? 'This returns the trip to dispatch for reassignment.'
            : recoveryAction === 'not_happened'
              ? 'This closes the trip as missed and notifies passengers.'
              : 'This completes the trip with an issue and returns passengers not dropped off to dispatch.'}
        </Text>
        {recoveryAction === 'withdraw' && (
          <View style={styles.chips}>
            {([
              { value: 'this', label: 'This trip' },
              { value: 'all_future', label: 'This and all future trips' },
            ] as const).map(({ value, label }) => (
              <ReasonChip
                key={value}
                title={label}
                selected={withdrawScope === value}
                onPress={() => setWithdrawScope(value)}
              />
            ))}
          </View>
        )}
        <View style={styles.chips}>
          {(recoveryAction === 'withdraw'
            ? withdrawalReasons
            : recoveryAction === 'not_happened'
              ? missedTripReasons
              : [
                { kind: 'vehicle_problem', label: 'Vehicle problem' },
                { kind: 'other', label: 'Other' },
              ]).map(({ kind, label }) => (
            <ReasonChip
              key={kind}
              title={label}
              selected={recoveryReason === kind}
              onPress={() => setRecoveryReason(kind)}
            />
          ))}
        </View>
        <TextInput
          accessibilityLabel={recoveryReason === 'other' ? 'Note (required)' : 'Note (optional)'}
          multiline
          maxLength={1000}
          onChangeText={setRecoveryNote}
          placeholder={recoveryReason === 'other' ? 'Note (required)' : 'Note (optional)'}
          style={styles.reasonInput}
          value={recoveryNote}
        />
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <View style={styles.actionRow}>
          <ActionButton title="Keep trip" onPress={() => setRecoveryVisible(false)} />
          <ActionButton
            title={recoveryAction === 'withdraw' ? 'Confirm withdrawal'
              : recoveryAction === 'not_happened' ? 'Submit report' : 'End trip'}
            primary
            disabled={updateMutation.isPending || (recoveryReason === 'other' && recoveryNote.trim().length < 5)}
            loading={updateMutation.isPending}
            onPress={() => void saveRecovery()}
          />
        </View>
      </ModalSheet>

      <ModalSheet visible={incidentVisible} onClose={() => setIncidentVisible(false)}>
        <Text style={styles.sheetTitle}>Emergency or problem</Text>
        <View style={styles.chips}>
          {incidentTypes.map(({ type, label }) => (
            <ReasonChip
              key={type}
              title={label}
              selected={incidentType === type}
              onPress={() => setIncidentType(type)}
            />
          ))}
        </View>
        <TextInput
          accessibilityLabel="Describe the problem"
          multiline
          onChangeText={setIncidentDescription}
          placeholder="Describe the problem"
          style={styles.reasonInput}
          value={incidentDescription}
        />
        {incidentType === 'emergency' && (
          <View style={styles.actionRow}>
            <ActionButton title="Call 112" onPress={() => void contactPassenger('112', 'tel')} />
            {supportPhone && <ActionButton title="Call dispatcher" onPress={() => void contactPassenger(supportPhone, 'tel')} />}
          </View>
        )}
        <View style={styles.actionRow}>
          <ActionButton title="Cancel" onPress={() => setIncidentVisible(false)} />
          <ActionButton
            title="Send report"
            primary
            disabled={!incidentDescription.trim() || incidentMutation.isPending}
            loading={incidentMutation.isPending}
            onPress={createIncident}
          />
        </View>
      </ModalSheet>

      <ModalSheet
        visible={etaSheetVisible}
        onClose={() => {
          setEtaSheetVisible(false);
          setEtaMinutes('');
        }}
      >
        <Text style={styles.sheetTitle}>Enter minutes</Text>
        <TextInput
          accessibilityLabel="Minutes until arrival"
          keyboardType="number-pad"
          maxLength={3}
          onChangeText={setEtaMinutes}
          placeholder="1 to 120"
          style={styles.etaInput}
          value={etaMinutes}
        />
        <ActionStack>
          <ActionButton
            title="Cancel"
            onPress={() => {
              setEtaSheetVisible(false);
              setEtaMinutes('');
            }}
          />
          <ActionButton
            title="Save arrival time"
            primary
            disabled={updateMutation.isPending}
            loading={updateMutation.isPending}
            onPress={submitManualEta}
          />
        </ActionStack>
      </ModalSheet>
    </>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 48, textAlignVertical: 'center', color: theme.colors.primary, fontSize: 15, fontWeight: '700' },
  pageTitle: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
  tripCard: { gap: theme.spacing.md, padding: theme.spacing.md, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  tripHeader: { flexDirection: 'row', gap: theme.spacing.md },
  dateBlock: { width: 60, height: 76, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryLight },
  month: { color: theme.colors.primary, fontSize: 10, fontWeight: '800' },
  day: { color: theme.colors.navy, fontSize: 25, fontWeight: '800' },
  weekday: { color: theme.colors.textSecondary, fontSize: 10, fontWeight: '700' },
  tripCopy: { flex: 1, gap: 5 },
  headline: { color: theme.colors.navy, fontSize: 16, fontWeight: '800' },
  address: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  meta: { color: theme.colors.textSecondary, fontSize: 12 },
  status: { alignSelf: 'flex-start', overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primaryLight, color: theme.colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  vehicle: { paddingTop: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border },
  liveBanner: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryLight },
  liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.primary },
  liveCopy: { flex: 1 },
  liveTitle: { color: theme.colors.navy, fontSize: 15, fontWeight: '800' },
  liveDetail: { color: theme.colors.textSecondary, fontSize: 12 },
  sectionTitle: { color: theme.colors.navy, fontSize: 18, fontWeight: '800' },
  stops: { gap: theme.spacing.sm },
  stopCard: { gap: 7, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  stopCurrent: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryLight },
  etaCard: { gap: theme.spacing.sm, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.primary, borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryLight },
  etaTitle: { color: theme.colors.navy, fontSize: 16, fontWeight: '800', lineHeight: 22 },
  stopHeading: { minHeight: 30, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing.sm },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: theme.colors.border },
  dotDone: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  dotSkipped: { borderColor: theme.colors.textSecondary, backgroundColor: theme.colors.textSecondary },
  dotCurrent: { borderColor: theme.colors.primary },
  stopTime: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '800' },
  currentBadge: { marginLeft: 'auto', color: theme.colors.primary, fontSize: 10, fontWeight: '800' },
  skippedBadge: { marginLeft: 'auto', color: theme.colors.textSecondary, fontSize: 10, fontWeight: '800' },
  stopAddress: { color: theme.colors.navy, fontSize: 14, fontWeight: '700' },
  actualTime: { color: theme.colors.primary, fontSize: 12, fontWeight: '700' },
  passengerList: { gap: theme.spacing.sm },
  passengerRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  passengerCopy: { flex: 1 },
  passenger: { color: theme.colors.textSecondary, fontSize: 12 },
  passengerStatus: { color: theme.colors.textSecondary, fontSize: 11, textTransform: 'capitalize' },
  waitHint: { color: theme.colors.primary, fontSize: 12, fontWeight: '700' },
  footerReason: { color: theme.colors.textSecondary, textAlign: 'center', fontSize: 12, lineHeight: 16 },
  actionRow: { flexDirection: 'column', gap: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  reasonChip: { minHeight: 48, flexShrink: 0, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  reasonChipSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryLight },
  reasonChipText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  reasonChipTextSelected: { color: theme.colors.primary },
  helper: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 18 },
  feedback: { color: theme.colors.success, fontSize: 13, fontWeight: '700' },
  modalKeyboard: { flex: 1 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#102D4670' },
  modalSheet: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.colors.white },
  modalSheetContent: { gap: theme.spacing.md, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: theme.colors.border },
  sheetTitle: { color: theme.colors.navy, fontSize: 20, fontWeight: '800' },
  reasonInput: { minHeight: 84, padding: theme.spacing.md, textAlignVertical: 'top', borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, color: theme.colors.text },
  etaInput: { minHeight: 52, paddingHorizontal: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, color: theme.colors.text, fontSize: 16 },
  delayOptions: { gap: theme.spacing.sm },
  summaryCard: { flex: 1, justifyContent: 'center', gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.lg, backgroundColor: theme.colors.white },
  summaryTitle: { color: theme.colors.navy, fontSize: 25, fontWeight: '800' },
  summaryTime: { color: theme.colors.textSecondary, fontSize: 14 },
  summaryStats: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  summaryStat: { width: '100%', minHeight: 72, justifyContent: 'center', gap: 4, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryLight },
  summaryValue: { color: theme.colors.primary, fontSize: 22, fontWeight: '800' },
  summaryLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  issueMessage: { color: theme.colors.error, fontSize: 13, fontWeight: '700' },
  eventList: { gap: theme.spacing.sm },
  eventRow: { flexDirection: 'row', gap: theme.spacing.md, paddingVertical: theme.spacing.sm },
  eventDot: { width: 10, height: 10, marginTop: 4, borderRadius: 5, backgroundColor: theme.colors.primary },
  eventCopy: { flex: 1, gap: 4 },
  eventTitle: { color: theme.colors.navy, fontSize: 13, fontWeight: '700' },
});
