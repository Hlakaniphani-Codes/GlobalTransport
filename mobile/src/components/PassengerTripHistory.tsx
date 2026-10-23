import { memo, useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';

import { fetchPassengerTripHistory, displayPassengerSchedule, type PassengerTrip } from '@/passenger/rides';
import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

const PassengerHistoryCard = memo(function PassengerHistoryCard({ trip }: { trip: PassengerTrip }) {
  return (
    <View style={styles.tripCard}>
      <View style={styles.row}>
        <Text style={styles.tripTitle}>{trip.direction === 'home' ? 'Ride home' : 'Ride to work'}</Text>
        <Text style={styles.status}>
          {trip.status === 'completed' ? 'Completed' : trip.status === 'missed' ? 'Trip missed' : 'Cancelled'}
        </Text>
      </View>
      <Text style={styles.detail}>{displayPassengerSchedule(trip.scheduled_at)}</Text>
      {trip.rescheduled_at && (
        <Text style={styles.helper}>Rescheduled {displayPassengerSchedule(trip.rescheduled_at)}.</Text>
      )}
      <Text style={styles.detail}>{trip.workplace_name ?? 'Workplace'}</Text>
      <Text style={styles.detail}>
        {trip.passengers_picked_up ?? 0} picked up · {trip.passengers_dropped_off ?? 0} dropped off
        {trip.no_shows ? ` · ${trip.no_shows} missed` : ''}
        {trip.exceptions ? ` · ${trip.exceptions} exceptions` : ''}
      </Text>
      <Text style={[styles.issueFlag, trip.has_issues && styles.issue]}>
        Issues: {trip.has_issues ? 'Yes' : 'No'}
      </Text>
      {trip.own_stops.map((stop) => (
        <View key={stop.id} style={styles.stopRow}>
          <Text style={styles.stopTitle}>
            {stop.stop_type === 'pickup' ? 'Pick-up' : 'Drop-off'} · {stop.status.replace('_', ' ')}
          </Text>
          <Text style={styles.detail}>{stop.address}{stop.suburb ? `, ${stop.suburb}` : ''}</Text>
          {stop.planned_at && <Text style={styles.helper}>{displayPassengerSchedule(stop.planned_at)}</Text>}
        </View>
      ))}
    </View>
  );
});

export function PassengerTripHistory() {
  const historyQuery = useInfiniteQuery({
    queryKey: ['passenger', 'trip-history', 'pages'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchPassengerTripHistory(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const trips = historyQuery.data?.pages.flatMap((page) => page.trips) ?? [];
  const renderItem = useCallback(({ item }: { item: PassengerTrip }) => <PassengerHistoryCard trip={item} />, []);
  const keyExtractor = useCallback((trip: PassengerTrip) => trip.id, []);
  const loadMore = useCallback(() => {
    if (historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) {
      void historyQuery.fetchNextPage();
    }
  }, [historyQuery]);

  return (
    <FlatList
      style={styles.list}
      data={trips}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={<Text style={styles.title}>Trip history</Text>}
      ListEmptyComponent={
        historyQuery.isLoading
          ? <ActivityIndicator color={theme.colors.primary} />
          : historyQuery.isError
            ? (
              <View style={styles.messageBox}>
                <Text accessibilityRole="alert" style={styles.error}>Trip history could not be loaded. Check your connection and try again.</Text>
                <Pressable accessibilityRole="button" onPress={() => void historyQuery.refetch()} style={styles.retry}>
                  <Text style={styles.retryText}>Try again</Text>
                </Pressable>
              </View>
            )
            : <Text style={styles.empty}>Your completed trips will appear here.</Text>
      }
      ListFooterComponent={historyQuery.hasNextPage ? (
        <Pressable
          accessibilityRole="button"
          disabled={historyQuery.isFetchingNextPage}
          onPress={loadMore}
          style={styles.retry}
        >
          <Text style={styles.retryText}>
            {historyQuery.isFetchingNextPage ? 'Loading…' : 'Load more trips'}
          </Text>
        </Pressable>
      ) : null}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={historyQuery.isRefetching}
          onRefresh={() => void historyQuery.refetch()}
          tintColor={theme.colors.primary}
        />
      }
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { gap: theme.spacing.md, paddingVertical: 8, paddingHorizontal: theme.spacing.md },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
  tripCard: { gap: theme.spacing.xs, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm },
  tripTitle: { flex: 1, color: theme.colors.navy, fontSize: 15, fontWeight: '800' },
  status: { color: theme.colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  detail: { color: theme.colors.navySoft, fontSize: 13, lineHeight: 18 },
  helper: { color: theme.colors.textSecondary, fontSize: 12 },
  issueFlag: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  issue: { color: theme.colors.error },
  stopRow: { gap: 2, marginTop: theme.spacing.xs, paddingTop: theme.spacing.xs, borderTopWidth: 1, borderTopColor: theme.colors.border },
  stopTitle: { color: theme.colors.navy, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  empty: { color: theme.colors.textSecondary, fontSize: 13 },
  messageBox: { gap: theme.spacing.sm },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 18 },
  retry: { minHeight: 48, justifyContent: 'center' },
  retryText: { color: theme.colors.primary, fontWeight: '700' },
});
