import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

import { api, queryPollingInterval } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { AppText as Text } from '@/components/AppText';
import { AppButton } from '@/components/ui/AppButton';
import { ActionStack } from '@/components/ui/ActionStack';
import { Screen } from '@/components/Screen';
import { DriverTabBar } from '@/components/DriverTabBar';
import { fetchDriverOffers, formatTripDate, formatTripTime, type DriverOffer } from '@/driver/trips';
import { theme } from '@/theme';

const queryKeys = {
  home: ['driver', 'home'],
  trips: ['driver', 'trips'],
  offers: ['driver', 'offers'],
};

function getErrorMessage(error: unknown): string {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'The offer could not be updated. Please try again.';
  }
  return error instanceof Error ? error.message : 'The offer could not be updated. Please try again.';
}

function formatDateTime(value: string): string {
  const date = formatTripDate(value);
  return `${date.full} · ${formatTripTime(value)}`;
}

const OfferCard = memo(function OfferCard({
  offer,
  fallbackTime,
  busyOffer,
  confirmDecline,
  onRespond,
  onConfirmDecline,
}: {
  offer: DriverOffer;
  fallbackTime: number;
  busyOffer: string | null;
  confirmDecline: string | null;
  onRespond: (offerId: string, decision: 'accept' | 'decline') => void;
  onConfirmDecline: (offerId: string | null) => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const currentTime = Math.max(now, fallbackTime);
  const secondsRemaining = Math.max(0, Math.ceil((Date.parse(offer.expires_at) - currentTime) / 1_000));
  const countdown = `${String(Math.floor(secondsRemaining / 60)).padStart(2, '0')}:${String(secondsRemaining % 60).padStart(2, '0')}`;
  return (
    <View style={styles.card}>
      <View style={styles.offerHeading}>
        <Text style={styles.cardTitle}>{offer.trips.length} {offer.trips.length === 1 ? 'trip' : 'trips'}</Text>
        <Text style={styles.expiry}>{secondsRemaining > 0 ? `Expires in ${countdown}` : 'Offer expired'}</Text>
      </View>
      {offer.trips.map((trip) => (
        <View key={trip.trip_id} style={styles.trip}>
          <Text style={styles.tripTitle}>{trip.direction === 'home' ? 'Ride home' : 'Trip to work'}</Text>
          <Text style={styles.copy}>First stop: {formatDateTime(trip.starts_at)}</Text>
          {trip.direction === 'to_work' && (
            <Text style={styles.copy}>Arrive at workplace by: {formatDateTime(trip.scheduled_at)}</Text>
          )}
          {trip.workplace_name && <Text style={styles.copy}>{trip.workplace_name}</Text>}
          <Text style={styles.copy}>
            {trip.passenger_count} passenger{trip.passenger_count === 1 ? '' : 's'}
            {trip.distance_km !== null ? ` · ${trip.distance_km} km` : ''}
          </Text>
          {trip.suburbs.length > 0 && <Text style={styles.copy}>Suburbs: {trip.suburbs.join(' · ')}</Text>}
        </View>
      ))}
      <Text style={styles.vehicle}>Offer window: {offer.window_minutes} minutes</Text>
      {confirmDecline === offer.id ? (
        <>
          <Text style={styles.copy}>Decline this offer and pass it to the next Driver?</Text>
          <ActionStack>
            <AppButton
              label="Confirm decline"
              loading={busyOffer === offer.id}
              disabled={busyOffer !== null || secondsRemaining === 0}
              onPress={() => onRespond(offer.id, 'decline')}
              variant="primary"
            />
            <AppButton
              label="Keep offer"
              disabled={busyOffer !== null}
              onPress={() => onConfirmDecline(null)}
              variant="secondary"
            />
          </ActionStack>
        </>
      ) : (
        <ActionStack>
          <AppButton
            label="Accept trip"
            loading={busyOffer === offer.id}
            disabled={busyOffer !== null || secondsRemaining === 0}
            onPress={() => onRespond(offer.id, 'accept')}
          />
          <AppButton
            label="Decline"
            disabled={busyOffer !== null || secondsRemaining === 0}
            onPress={() => onConfirmDecline(offer.id)}
            variant="secondary"
          />
        </ActionStack>
      )}
    </View>
  );
});

export function DriverOfferPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [busyOffer, setBusyOffer] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const offersQuery = useInfiniteQuery({
    queryKey: queryKeys.offers,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchDriverOffers(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: user?.status === 'approved' && focused,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const offers = offersQuery.data?.pages.flatMap((page) => page.offers) ?? [];
  const refetchOffers = offersQuery.refetch;

  const respond = useCallback(async (offerId: string, decision: 'accept' | 'decline') => {
    setBusyOffer(offerId);
    setError(null);
    setMessage(null);
    try {
      await api.post(`/driver/offers/${offerId}/${decision}`);
      setConfirmDecline(null);
      setMessage(decision === 'accept' ? 'Trip offer accepted.' : 'Trip offer declined.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.home }),
        queryClient.invalidateQueries({ queryKey: queryKeys.trips }),
        refetchOffers(),
      ]);
      if (decision === 'accept') router.replace('/(app)/driver');
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusyOffer(null);
    }
  }, [queryClient, refetchOffers, router]);
  const renderItem = useCallback(({ item }: { item: DriverOffer }) => (
    <OfferCard
      offer={item}
      fallbackTime={offersQuery.dataUpdatedAt}
      busyOffer={busyOffer}
      confirmDecline={confirmDecline}
      onRespond={respond}
      onConfirmDecline={setConfirmDecline}
    />
  ), [busyOffer, confirmDecline, offersQuery.dataUpdatedAt, respond]);
  const keyExtractor = useCallback((offer: DriverOffer) => offer.id, []);
  const loadMore = useCallback(() => {
    if (offersQuery.hasNextPage && !offersQuery.isFetchingNextPage) {
      void offersQuery.fetchNextPage();
    }
  }, [offersQuery]);

  return (
    <Screen bottomNavigation={<DriverTabBar />} virtualized>
      <FlatList
        style={styles.list}
        data={offers}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={styles.heading}>
            <AppButton
              accessibilityLabel="Back to trips"
              label="Back to trips"
              onPress={() => router.back()}
              variant="secondary"
            />
            <Text style={styles.title}>Trip offers</Text>
            <Text style={styles.copy}>Review the trip details and respond before the offer expires.</Text>
            {message && <Text style={styles.success}>{message}</Text>}
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {user?.status !== 'approved' && (
              <Text style={styles.copy}>Trip offers are available after your driver account is approved.</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          user?.status !== 'approved'
            ? null
            : offersQuery.isLoading
              ? (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.primary} />
                  <Text style={styles.copy}>Loading trip offers</Text>
                </View>
              )
              : offersQuery.isError
                ? (
                  <View style={styles.card}>
                    <Text accessibilityRole="alert" style={styles.error}>Trip offers could not be loaded. Check your connection and try again.</Text>
                    <AppButton label="Try again" onPress={() => void offersQuery.refetch()} />
                  </View>
                )
                : (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>No active offers</Text>
                    <Text style={styles.copy}>New offers will appear here while you are available for trips.</Text>
                  </View>
                )
        }
        ListFooterComponent={offersQuery.hasNextPage ? (
          <AppButton
            label={offersQuery.isFetchingNextPage ? 'Loading…' : 'Load more offers'}
            loading={offersQuery.isFetchingNextPage}
            disabled={offersQuery.isFetchingNextPage}
            onPress={loadMore}
            variant="secondary"
          />
        ) : null}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={offersQuery.isRefetching}
            onRefresh={() => void offersQuery.refetch()}
            tintColor={theme.colors.primary}
          />
        }
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        removeClippedSubviews
      />
    </Screen>
  );
}

const styles = {
  list: { flex: 1 },
  listContent: { flexGrow: 1, gap: theme.spacing.md, padding: theme.spacing.md },
  heading: { gap: theme.spacing.xs },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' as const },
  copy: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 },
  loading: { minHeight: 96, alignItems: 'center' as const, justifyContent: 'center' as const, gap: theme.spacing.sm },
  card: { gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.lg, backgroundColor: theme.colors.white },
  cardTitle: { color: theme.colors.navy, fontSize: 17, fontWeight: '800' as const },
  offerHeading: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, flexWrap: 'wrap' as const, gap: theme.spacing.sm },
  expiry: { color: theme.colors.error, fontSize: 13, fontWeight: '800' as const },
  trip: { gap: theme.spacing.xs, paddingTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.colors.border },
  tripTitle: { color: theme.colors.navy, fontSize: 15, fontWeight: '800' as const },
  vehicle: { color: theme.colors.navySoft, fontSize: 13, fontWeight: '700' as const },
  success: { color: theme.colors.success, fontSize: 14, fontWeight: '700' as const },
  error: { color: theme.colors.error, fontSize: 14, lineHeight: 20 },
};
