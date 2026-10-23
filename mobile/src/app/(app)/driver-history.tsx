import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { memo, useCallback } from 'react';

import { AppText as Text } from '@/components/AppText';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';

import { Screen } from '@/components/Screen';
import { DriverTabBar } from '@/components/DriverTabBar';
import { fetchDriverTrips, formatTripDate, tripHeadline } from '@/driver/trips';
import { theme } from '@/theme';
import type { DriverTrip } from '@/driver/trips';

const DriverHistoryCard = memo(function DriverHistoryCard({
  trip,
  onPress,
}: {
  trip: DriverTrip;
  onPress: (tripId: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View trip from ${formatTripDate(trip.scheduled_at).full}`}
      onPress={() => onPress(trip.id)}
      style={styles.tripCard}
    >
      <View style={styles.tripHead}>
        <Text style={styles.date}>{formatTripDate(trip.scheduled_at).full}</Text>
        <Text style={[styles.status, trip.status === 'completed' ? styles.completed : styles.cancelled]}>
          {trip.status === 'missed' ? 'Missed' : trip.status}
        </Text>
      </View>
      <Text style={styles.headline}>{tripHeadline(trip)}</Text>
      <Text style={styles.workplace}>{trip.workplace_name ?? 'Workplace'}</Text>
      <Text style={styles.detail}>{trip.passenger_count} passengers · {trip.distance_km ?? '—'} km</Text>
      <Text style={styles.detail}>
        {trip.passengers_picked_up ?? 0} picked up · {trip.passengers_dropped_off ?? 0} dropped off
        {trip.no_shows ? ` · ${trip.no_shows} no-shows` : ''}
        {trip.exceptions ? ` · ${trip.exceptions} exceptions` : ''}
      </Text>
      <Text style={[styles.issueFlag, trip.has_issues && styles.issue]}>
        Issues: {trip.has_issues ? 'Yes' : 'No'}
      </Text>
    </Pressable>
  );
});

export default function DriverHistoryScreen() {
  const router = useRouter();
  const historyQuery = useInfiniteQuery({
    queryKey: ['driver', 'history'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchDriverTrips('history', pageParam ?? '', signal),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const trips = historyQuery.data?.pages.flatMap((page) => page.trips) ?? [];
  const openTrip = useCallback((tripId: string) => {
    router.push({ pathname: '/driver-trip/[id]', params: { id: tripId, history: 'true' } });
  }, [router]);
  const renderItem = useCallback(({ item }: { item: DriverTrip }) => (
    <DriverHistoryCard trip={item} onPress={openTrip} />
  ), [openTrip]);
  const keyExtractor = useCallback((trip: DriverTrip) => trip.id, []);
  const loadMore = useCallback(() => {
    if (historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) {
      void historyQuery.fetchNextPage();
    }
  }, [historyQuery]);

  return (
    <Screen bottomNavigation={<DriverTabBar />} virtualized>
      <FlatList
        style={styles.list}
        data={trips}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/driver');
              }}
              style={styles.back}
            >
              <Text style={styles.backText}>‹ Back</Text>
            </Pressable>
            <Text style={styles.title}>Trip history</Text>
          </>
        }
        ListEmptyComponent={
          historyQuery.isLoading
            ? <ActivityIndicator color={theme.colors.primary} />
            : historyQuery.isError
              ? (
                <View style={styles.messageBox}>
                  <Text accessibilityRole="alert" style={styles.error}>Trip history could not be loaded. Pull to refresh or try again.</Text>
                  <Pressable accessibilityRole="button" onPress={() => void historyQuery.refetch()} style={styles.retry}>
                    <Text style={styles.retryText}>Try again</Text>
                  </Pressable>
                </View>
              )
              : <Text style={styles.empty}>No trips in your history.</Text>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { gap: theme.spacing.md, paddingVertical: 8, paddingHorizontal: theme.spacing.md },
  back: { minHeight: 48, justifyContent: 'center' },
  backText: { color: theme.colors.primary, fontSize: 15, fontWeight: '700' },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
  tripCard: { gap: 6, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  tripHead: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm },
  date: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  status: { fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  completed: { color: theme.colors.success },
  cancelled: { color: theme.colors.textSecondary },
  headline: { color: theme.colors.navy, fontSize: 16, fontWeight: '800' },
  workplace: { color: theme.colors.textSecondary, fontSize: 13 },
  detail: { color: theme.colors.textSecondary, fontSize: 12 },
  issueFlag: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  issue: { color: theme.colors.error },
  empty: { color: theme.colors.textSecondary, fontSize: 14 },
  messageBox: { gap: theme.spacing.sm },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 18 },
  retry: { minHeight: 48, justifyContent: 'center' },
  retryText: { color: theme.colors.primary, fontWeight: '700' },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm },
  pageButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.sm, backgroundColor: theme.colors.white },
  pageText: { color: theme.colors.primary, fontSize: 13, fontWeight: '700' },
  pageCount: { color: theme.colors.textSecondary, fontSize: 12 },
  disabled: { opacity: 0.45 },
});
