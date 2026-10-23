import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, RefreshControl, StyleSheet, Switch, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, queryPollingInterval } from '@/api';
import { AppButton } from '@/components/ui/AppButton';
import { ActionStack } from '@/components/ui/ActionStack';
import { AppText as Text } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { DriverTabBar } from '@/components/DriverTabBar';
import { NotificationBell } from '@/notifications/NotificationProvider';
import { useTripReminders } from '@/notifications/useTripReminders';
import {
  fetchDriverHome,
  fetchDriverTrip,
  fetchUpcomingDriverTrips,
  formatTripDate,
  formatPlaceParts,
  formatPlannedDuration,
  formatTripTime,
  groupDriverStops,
  plannedStopGap,
  tripHeadline,
  type DriverTrip,
  type TripStop,
} from '@/driver/trips';
import { openMapsDirections } from '@/utils/maps';
import { theme } from '@/theme';

const supportPhone = process.env.EXPO_PUBLIC_SUPPORT_PHONE?.trim() ?? '';
const queryKeys = {
  home: ['driver', 'home'],
  trips: ['driver', 'trips'],
  offers: ['driver', 'offers'],
};

function InlineMessage({ children, error = false }: { children: string; error?: boolean }) {
  return <Text accessibilityRole={error ? 'alert' : undefined} style={[styles.message, error && styles.error]}>{children}</Text>;
}

function TripDateBlock({ value }: { value: string }) {
  const date = formatTripDate(value);
  return (
    <View style={styles.dateBlock}>
      <Text style={styles.dateMonth}>{date.month.toUpperCase()}</Text>
      <Text style={styles.dateDay}>{date.day}</Text>
      <Text style={styles.dateWeekday}>{date.weekday.slice(0, 3)}</Text>
    </View>
  );
}

function TripCard({
  trip,
  compact = false,
  onPress,
  onMap,
  onDispatcher,
}: {
  trip: DriverTrip;
  compact?: boolean;
  onPress?: () => void;
  onMap?: () => void;
  onDispatcher?: () => void;
}) {
  const date = formatTripDate(trip.scheduled_at);
  const open = onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.tripCard}>
      <TripCardContents trip={trip} compact={compact} date={date} />
    </Pressable>
  ) : (
    <View style={styles.tripCard}><TripCardContents trip={trip} compact={compact} date={date} /></View>
  );

  if (compact) return open;
  return (
    <View style={styles.tripCardWrap}>
      {open}
      <ActionStack style={styles.tripActions}>
        {onPress && (
          <ActionButton
            title={trip.status === 'in_progress' ? 'Continue trip' : 'View trip'}
            onPress={onPress}
            primary
          />
        )}
        {onMap && <ActionButton title="View map" onPress={onMap} />}
        {onDispatcher && <ActionButton title="Contact dispatcher" onPress={onDispatcher} />}
      </ActionStack>
    </View>
  );
}

function TripCardContents({
  trip,
  compact,
  date,
}: {
  trip: DriverTrip;
  compact: boolean;
  date: ReturnType<typeof formatTripDate>;
}) {
  return (
    <View style={styles.tripRow}>
      <TripDateBlock value={trip.scheduled_at} />
      <View style={styles.tripBody}>
        <View style={styles.tripHeadingRow}>
          <Text numberOfLines={1} style={styles.tripHeadline}>{tripHeadline(trip)}</Text>
          <Text singleLine style={styles.statusChip}>{trip.status.replace('_', ' ')}</Text>
        </View>
        <Text style={styles.tripPlace}>
          {trip.workplace_name === 'Multiple workplaces'
            ? 'Multiple workplaces'
            : formatPlaceParts(trip.workplace_name, trip.workplace_address) || 'Workplace'}
        </Text>
        <View style={styles.tripMeta}>
          <Text numberOfLines={1} style={styles.tripMetaText}>♙ {trip.passenger_count} passengers</Text>
          {trip.distance_km !== null && <Text numberOfLines={1} style={styles.tripMetaText}>↗ {trip.distance_km} km</Text>}
          {compact && <Text numberOfLines={1} style={styles.tripMetaText}>{date.weekday}</Text>}
        </View>
      </View>
    </View>
  );
}

function ActionButton({ title, onPress, primary = false, disabled = false }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean;
}) {
  return <AppButton label={title} onPress={onPress} disabled={disabled} variant={primary ? 'primary' : 'secondary'} />;
}

const UpcomingTripCard = memo(function UpcomingTripCard({
  trip,
  onPress,
}: {
  trip: DriverTrip;
  onPress: (tripId: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(trip.id)}
      style={styles.upcomingCard}
    >
      <TripDateBlock value={trip.scheduled_at} />
      <View style={styles.upcomingCopy}>
        <Text style={styles.upcomingWeekday}>{formatTripDate(trip.scheduled_at).weekday}</Text>
        <Text style={styles.upcomingTime}>{tripHeadline(trip)}</Text>
        <Text numberOfLines={1} style={styles.tripPlace}>{trip.workplace_name ?? 'Workplace'}</Text>
        <Text style={styles.tripMetaText}>{trip.passenger_count} passengers</Text>
      </View>
      <Text style={styles.menuItemArrow}>›</Text>
    </Pressable>
  );
});

function remainingStops(stops: TripStop[]): TripStop[] {
  const current = stops.findIndex(({ status }) => !['completed', 'skipped'].includes(status));
  return current < 0 ? [] : stops.slice(current);
}

export function DriverWorkspace() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [focused, setFocused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nextTripExpanded, setNextTripExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    void queryClient.invalidateQueries({ queryKey: queryKeys.home });
    void queryClient.invalidateQueries({ queryKey: queryKeys.trips });
    return () => setFocused(false);
  }, [queryClient]));
  const homeQuery = useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => fetchDriverHome(signal),
    retry: false,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const home = homeQuery.data;
  const tripsQuery = useQuery({
    queryKey: queryKeys.trips,
    queryFn: ({ signal }) => fetchUpcomingDriverTrips(signal),
    retry: false,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const upcoming = tripsQuery.data?.trips ?? [];
  const otherUpcoming = upcoming.filter(({ id }) => id !== home?.next_trip?.id);
  useTripReminders('driver', tripsQuery.data?.reminderTrips ?? tripsQuery.data?.trips, tripsQuery.dataUpdatedAt);
  const nextTripId = home?.next_trip?.id;
  const detailQuery = useQuery({
    queryKey: ['driver', 'trip', nextTripId],
    queryFn: ({ signal }) => fetchDriverTrip(nextTripId as string, signal),
    enabled: Boolean(nextTripId) && nextTripExpanded,
    retry: false,
    refetchInterval: focused && nextTripExpanded ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const availabilityMutation = useMutation({
    mutationFn: async (isAvailable: boolean) => {
      const response = await api.patch('/driver/availability', { is_available: isAvailable });
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers });
    },
    onError: (requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : 'Availability could not be changed.');
    },
  });

  async function viewMap(trip: DriverTrip) {
    try {
      await openMapsDirections(remainingStops(trip.stops).map(({ address, suburb }) => ({
        address: suburb ? `${address}, ${suburb}` : address,
      })));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Directions could not be opened.');
    }
  }

  async function contactDispatcher() {
    if (!supportPhone) {
      setError('The dispatcher phone number is not configured.');
      return;
    }
    try {
      await Linking.openURL(`tel:${supportPhone}`);
    } catch (contactError) {
      setError(contactError instanceof Error ? contactError.message : 'The dispatcher could not be reached.');
    }
  }

  const openTrip = useCallback((tripId: string) => {
    router.push({ pathname: '/driver-trip/[id]', params: { id: tripId } });
  }, [router]);
  const renderUpcomingTrip = useCallback(({ item }: { item: DriverTrip }) => (
    <UpcomingTripCard trip={item} onPress={openTrip} />
  ), [openTrip]);
  const keyUpcomingTrip = useCallback((trip: DriverTrip) => trip.id, []);

  async function doRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const results = await Promise.all([
        homeQuery.refetch(),
        tripsQuery.refetch(),
        nextTripId && nextTripExpanded ? detailQuery.refetch() : Promise.resolve(null),
      ]);
      const failedQuery = results.find((result) => result?.isError);
      if (failedQuery?.isError) {
        setError(
          failedQuery.error instanceof Error
            ? failedQuery.error.message
            : 'Some trip information could not be refreshed. Please try again.'
        );
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Some trip information could not be refreshed. Please try again.'
      );
    } finally {
      setRefreshing(false);
    }
  }

  if (homeQuery.isLoading) {
    return (
      <Screen
        refreshing={refreshing || homeQuery.isFetching}
        onRefresh={() => void doRefresh()}
        bottomNavigation={<DriverTabBar />}
      >
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.helper}>Loading trips</Text>
      </Screen>
    );
  }
  if (homeQuery.isError || !home) {
    return (
      <Screen
        refreshing={refreshing || homeQuery.isFetching}
        onRefresh={() => void doRefresh()}
        bottomNavigation={<DriverTabBar />}
      >
        <Text style={styles.screenTitle}>Driver, your day</Text>
        <InlineMessage error>Trips could not be loaded. Pull to refresh or try again.</InlineMessage>
        <ActionButton title="Try again" onPress={() => void homeQuery.refetch()} primary />
      </Screen>
    );
  }

  const pendingOfferCount = Number(home.pending_offers ?? home.pending_offer_count);

  return (
    <Screen bottomNavigation={<DriverTabBar />} virtualized>
      <FlatList
        style={styles.upcomingList}
        data={upcomingExpanded ? otherUpcoming : []}
        keyExtractor={keyUpcomingTrip}
        renderItem={renderUpcomingTrip}
        ItemSeparatorComponent={UpcomingTripSeparator}
        ListHeaderComponent={
          <View style={styles.dashboardListHeader}>
      <View style={styles.pageHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.screenTitle}>Driver, your day</Text>
        </View>
        <NotificationBell />
      </View>

      {(error || homeQuery.isError || tripsQuery.isError) && (
        <InlineMessage error>
          {error ?? 'Some trip information may be out of date. Pull down to refresh.'}
        </InlineMessage>
      )}

      <View style={styles.availabilityCard}>
        <View style={styles.availabilityRow}>
          <View style={styles.availabilityCopy}>
            <Text style={styles.availabilityLabel}>
              {home.is_available ? 'Available for trips' : 'Not accepting trips'}
            </Text>
            {!home.can_go_online && (
              <Text style={styles.availabilityReason}>
                {home.expired_documents.length > 0
                  ? `Renew ${home.expired_documents.join(', ')} before receiving trip offers.`
                  : home.driver_status !== 'approved'
                  ? 'Your driver account must be approved before going online.'
                  : 'An approved vehicle is required before going online.'}
              </Text>
            )}
          </View>
          <Switch
            accessibilityLabel="Available for trips"
            disabled={!home.can_go_online || availabilityMutation.isPending}
            value={home.is_available}
            onValueChange={(value) => availabilityMutation.mutate(value)}
            style={styles.availabilitySwitch}
            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
          />
        </View>
      </View>

      {home.driver_status !== 'approved' && (
        <View style={styles.statusBanner}>
          <Text style={styles.statusBannerTitle}>Driver account {home.driver_status}</Text>
        </View>
      )}

      {!home.can_go_online && (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/driver-vehicle')}
          style={styles.vehicleSetupCard}
        >
          <View style={styles.vehicleSetupCopy}>
            <Text style={styles.vehicleSetupTitle}>My vehicle</Text>
            <Text style={styles.vehicleSetupText}>Add your vehicle details or check their status.</Text>
          </View>
          <Text style={styles.vehicleSetupArrow}>›</Text>
        </Pressable>
      )}

      {Number.isFinite(pendingOfferCount) && pendingOfferCount > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => router.push('/(app)/driver-offers')} style={styles.offersBanner}>
          <View>
            <Text style={styles.offersBannerTitle}>Trip offers</Text>
            <Text style={styles.offersBannerHint}>Review and respond</Text>
          </View>
          <Text style={styles.offersBadge}>{String(Math.trunc(pendingOfferCount))}</Text>
        </Pressable>
      ) : null}

      {home.attention.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Needs your attention</Text>
          {home.attention.map((item) => (
            <Pressable
              key={`${item.type}:${item.trip_id}`}
              accessibilityRole="button"
              onPress={() => openTrip(item.trip_id)}
              style={styles.attentionCard}
            >
              <Text style={styles.attentionTitle}>
                {item.type === 'overdue_trip' ? 'Trip not started'
                  : item.type === 'change_to_confirm' ? 'Confirm trip changes'
                    : 'Trip in progress'}
              </Text>
              <Text style={styles.attentionText}>
                {item.type === 'overdue_trip'
                  ? item.can_still_be_started
                    ? 'This trip has passed its first stop time. Start it now or report that it did not happen.'
                    : 'This trip can no longer be started. Report that it did not happen.'
                  : item.type === 'change_to_confirm'
                    ? item.what_changed
                    : 'Continue updating the trip stops.'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: nextTripExpanded }}
          onPress={() => setNextTripExpanded((expanded) => !expanded)}
          style={styles.sectionToggle}
        >
          <View style={styles.sectionToggleCopy}>
            <Text style={styles.sectionTitle}>Next trip</Text>
            <Text numberOfLines={1} style={styles.sectionSubtitle}>
              {home.next_trip
                ? `${formatTripDate(home.next_trip.scheduled_at).full} · ${tripHeadline(home.next_trip)}`
                : 'No trip scheduled'}
            </Text>
          </View>
          <Text style={styles.toggleGlyph}>{nextTripExpanded ? '−' : '+'}</Text>
        </Pressable>
        {nextTripExpanded && (
          <View style={styles.expandedSection}>
            {home.next_trip ? (
              detailQuery.isLoading ? (
                <View style={styles.loadingCard}><ActivityIndicator color={theme.colors.primary} /></View>
              ) : detailQuery.isError ? (
                <InlineMessage error>Trip details could not be loaded.</InlineMessage>
              ) : detailQuery.data ? (
                <>
                  <TripCard
                    trip={detailQuery.data}
                    onPress={() => openTrip(detailQuery.data.id)}
                    onMap={() => void viewMap(detailQuery.data)}
                    onDispatcher={supportPhone ? () => void contactDispatcher() : undefined}
                  />
                  <Text style={styles.sectionTitle}>Route details</Text>
                  <TripTimeline stops={detailQuery.data.stops} />
                </>
              ) : null
            ) : (
              <View style={styles.emptyState}><Text style={styles.emptyText}>Your next accepted trip will appear here.</Text></View>
            )}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: upcomingExpanded }}
          onPress={() => setUpcomingExpanded((expanded) => !expanded)}
          style={styles.sectionToggle}
        >
          <View style={styles.sectionToggleCopy}>
            <Text style={styles.sectionTitle}>Upcoming trips</Text>
            <Text style={styles.sectionSubtitle}>
              {home.upcoming_count ?? home.upcoming_trip_count} scheduled
            </Text>
          </View>
          <Text style={styles.toggleGlyph}>{upcomingExpanded ? '−' : '+'}</Text>
        </Pressable>
      </View>
          </View>
        }
        ListEmptyComponent={upcomingExpanded ? (
          tripsQuery.isLoading
            ? <ActivityIndicator color={theme.colors.primary} />
            : <View style={styles.emptyState}><Text style={styles.emptyText}>No other upcoming trips.</Text></View>
        ) : null}
        contentContainerStyle={styles.dashboardListContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing || homeQuery.isRefetching || tripsQuery.isRefetching}
            onRefresh={() => void doRefresh()}
            tintColor={theme.colors.primary}
          />
        }
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
      />
    </Screen>
  );
}

export function TripTimeline({ stops }: { stops: TripStop[] }) {
  const groups = groupDriverStops(stops);
  const current = groups.findIndex(({ status }) => !['completed', 'skipped'].includes(status));
  const plannedDuration = groups.length > 1 && groups[0].planned_at
    ? plannedStopGap(groups[0].planned_at, groups[groups.length - 1].planned_at)
    : null;
  return (
    <View style={styles.timelineCard}>
      <Text style={styles.routeSummary}>
        {groups.length} stops{plannedDuration !== null ? ` · ${formatPlannedDuration(plannedDuration)} total schedule span` : ''}
      </Text>
      <View style={styles.timeline}>
        {groups.map((group, index) => {
          const status = group.status === 'completed' ? 'completed'
            : group.status === 'skipped' ? 'skipped'
              : index === current ? 'current' : 'pending';
          const gap = index > 0 && groups[index - 1].planned_at && group.planned_at
            ? plannedStopGap(groups[index - 1].planned_at, group.planned_at)
            : null;
          return (
            <View key={group.id} style={styles.timelineRow}>
              <View style={styles.timelineTime}>
                <Text style={styles.timelineTimeText}>{group.planned_at ? formatTripTime(group.planned_at) : '—'}</Text>
                <View style={[styles.timelineDot, styles[`dot_${status}`]]} />
              </View>
              <View style={styles.timelineCopy}>
                <Text style={styles.timelineStopLabel}>
                  Stop {index + 1} · {group.stop_type === 'pickup' ? 'Pick up' : 'Drop off'}
                  {group.stops.length > 1 ? ` ${group.stops.length} passengers` : ''}
                </Text>
                <Text numberOfLines={2} style={styles.timelineAddress}>
                  {formatPlaceParts(group.address, group.suburb)}
                </Text>
                <Text style={styles.timelinePassenger}>
                  {group.stops.map(({ passenger_name, passenger_surname }) =>
                    `${passenger_name} ${passenger_surname}`).join(', ')}
                </Text>
                {gap !== null && (
                  <Text style={styles.timelineGap}>
                    {formatPlannedDuration(gap)} scheduled from previous stop
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  upcomingList: { flex: 1 },
  dashboardListContent: { flexGrow: 1, gap: theme.spacing.md, paddingHorizontal: theme.spacing.md, paddingVertical: 28 },
  dashboardListHeader: { gap: theme.spacing.md },
  upcomingSeparator: { height: theme.spacing.md },
  pageHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, marginBottom: theme.spacing.xs },
  headerCopy: { flex: 1, gap: 2 },
  screenTitle: { color: theme.colors.navy, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  section: { gap: theme.spacing.sm },
  sectionTitle: { color: theme.colors.navy, fontSize: 17, fontWeight: '800' },
  sectionToggle: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 18, backgroundColor: theme.colors.white, shadowColor: theme.colors.navy, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.035, shadowRadius: 10, elevation: 1 },
  sectionToggleCopy: { flex: 1, gap: 5 },
  sectionSubtitle: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  toggleGlyph: { width: 30, height: 30, borderRadius: 15, overflow: 'hidden', backgroundColor: theme.colors.primaryLight, color: theme.colors.primary, textAlign: 'center', textAlignVertical: 'center', fontSize: 20, fontWeight: '600' },
  expandedSection: { gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 18, backgroundColor: theme.colors.white },
  attentionCard: { gap: theme.spacing.xs, padding: theme.spacing.md, borderRadius: 16, borderWidth: 1, borderColor: '#E9B74C', backgroundColor: '#FFF8E8' },
  attentionTitle: { color: theme.colors.navy, fontSize: 14, fontWeight: '800' },
  attentionText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  tripCardWrap: { borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white, overflow: 'hidden', shadowColor: theme.colors.navy, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.045, shadowRadius: 14, elevation: 2 },
  tripCard: { padding: theme.spacing.md, backgroundColor: theme.colors.white },
  tripRow: { flexDirection: 'row', gap: theme.spacing.md },
  dateBlock: { width: 60, height: 74, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryLight },
  dateMonth: { color: theme.colors.primary, fontSize: 10, fontWeight: '800' },
  dateDay: { color: theme.colors.navy, fontSize: 24, fontWeight: '800', lineHeight: 27 },
  dateWeekday: { color: theme.colors.textSecondary, fontSize: 10, fontWeight: '700' },
  tripBody: { flex: 1, gap: theme.spacing.xs },
  tripHeadingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs },
  tripHeadline: { flex: 1, color: theme.colors.navy, fontSize: 16, fontWeight: '800' },
  statusChip: { overflow: 'hidden', borderRadius: theme.radius.pill, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: theme.colors.primaryLight, color: theme.colors.primary, fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  tripPlace: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  tripMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  tripMetaText: { flexShrink: 0, color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' },
  tripActions: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.md },
  timelineCard: { gap: theme.spacing.md, padding: theme.spacing.md, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  timeline: { gap: theme.spacing.sm },
  timelineRow: { flexDirection: 'row', gap: theme.spacing.md, minHeight: 68, paddingVertical: theme.spacing.xs },
  timelineTime: { width: 58, alignItems: 'center', gap: 6 },
  timelineTimeText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  dot_completed: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  dot_current: { borderColor: theme.colors.primary, backgroundColor: theme.colors.white, width: 16, height: 16, borderRadius: 8 },
  dot_pending: { borderColor: theme.colors.border },
  dot_skipped: { borderColor: theme.colors.textSecondary, backgroundColor: theme.colors.textSecondary },
  timelineCopy: { flex: 1, paddingBottom: theme.spacing.sm },
  routeSummary: { color: theme.colors.navy, fontSize: 13, fontWeight: '800' },
  timelineStopLabel: { color: theme.colors.primary, fontSize: 12, fontWeight: '800' },
  timelineAddress: { color: theme.colors.navy, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  timelinePassenger: { marginTop: 3, color: theme.colors.textSecondary, fontSize: 11 },
  timelineGap: { marginTop: 3, color: theme.colors.textSecondary, fontSize: 11 },
  upcomingCard: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, padding: theme.spacing.md, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  upcomingCopy: { flex: 1, gap: theme.spacing.xs },
  upcomingWeekday: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700' },
  upcomingTime: { color: theme.colors.navy, fontSize: 14, fontWeight: '800' },
  availabilityCard: { gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 20, backgroundColor: theme.colors.white, shadowColor: theme.colors.navy, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.04, shadowRadius: 12, elevation: 1 },
  availabilityRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  availabilityCopy: { flex: 1, gap: 4 },
  availabilitySwitch: { width: 56, height: 48 },
  availabilityLabel: { color: theme.colors.navy, fontSize: 14, fontWeight: '700' },
  availabilityReason: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  statusBanner: { padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.primaryLight },
  statusBannerTitle: { color: theme.colors.primaryDark, fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  vehicleSetupCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, padding: theme.spacing.md, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  vehicleSetupCopy: { flex: 1, gap: theme.spacing.xs },
  vehicleSetupTitle: { color: theme.colors.navy, fontSize: 15, fontWeight: '800' },
  vehicleSetupText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  vehicleSetupArrow: { color: theme.colors.primary, fontSize: 28, fontWeight: '700' },
  offersBanner: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: theme.spacing.md, borderRadius: 18, backgroundColor: theme.colors.primary },
  offersBannerTitle: { color: theme.colors.white, fontSize: 15, fontWeight: '800' },
  offersBannerHint: { marginTop: 3, color: '#E5F1FA', fontSize: 12 },
  offersBadge: { minWidth: 28, height: 28, overflow: 'hidden', borderRadius: 14, backgroundColor: theme.colors.white, color: theme.colors.primary, textAlign: 'center', textAlignVertical: 'center', fontWeight: '800' },
  emptyState: { minHeight: 96, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  emptyText: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' },
  loadingCard: { minHeight: 96, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  helper: { color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center' },
  message: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  error: { color: theme.colors.error },
  menuItemArrow: { color: theme.colors.primary, fontSize: 24 },
});

function UpcomingTripSeparator() {
  return <View style={styles.upcomingSeparator} />;
}
