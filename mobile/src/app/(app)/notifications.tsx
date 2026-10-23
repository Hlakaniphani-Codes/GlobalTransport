import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { memo, useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { api } from '@/api';
import { DriverTabBar } from '@/components/DriverTabBar';
import { PassengerTabBar } from '@/components/PassengerTabBar';
import { Screen } from '@/components/Screen';
import { NotificationBell } from '@/notifications/NotificationProvider';
import { theme } from '@/theme';

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

type NotificationPage = {
  notifications: NotificationRow[];
  unread_count: number;
  next_cursor: string | null;
};

const NotificationCard = memo(function NotificationCard({
  notification,
  onPress,
}: {
  notification: NotificationRow;
  onPress: (notification: NotificationRow) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(notification)}
      style={[styles.card, !notification.read_at && styles.unreadCard]}
    >
      <View style={styles.itemHeader}>
        {!notification.read_at && <View style={styles.unreadDot} />}
        <Text style={styles.itemTitle}>{notification.title}</Text>
      </View>
      <Text style={styles.body}>{notification.body}</Text>
      <Text style={styles.date}>{formatDate(notification.created_at)}</Text>
    </Pressable>
  );
});

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
}

function getRoute(data: Record<string, unknown> | null): Href {
  if (data?.screen === 'offers') return '/(app)/driver-offers';
  if (data?.screen === 'driver' && typeof data.trip_id === 'string') {
    return `/(app)/driver-trip/${encodeURIComponent(data.trip_id)}` as Href;
  }
  if (data?.screen === 'passenger_requests') return '/(app)/passenger-requests';
  if (data?.screen === 'passenger') return '/(app)/passenger';
  if (data?.screen === 'account') return '/(app)/account';
  return '/(app)/notifications';
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const notificationsQuery = useInfiniteQuery({
    queryKey: ['notifications', 'inbox'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const params = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return (await api.get<NotificationPage>(`/notifications${params}`, { signal })).data;
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const markRead = useMutation({
    mutationFn: async (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  const markAllRead = useMutation({
    mutationFn: async () => api.post('/notifications/read-all'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  const notifications = notificationsQuery.data?.pages.flatMap((page) => page.notifications) ?? [];
  const unreadCount = notificationsQuery.data?.pages[0]?.unread_count ?? 0;
  const markNotificationRead = markRead.mutate;
  const openNotification = useCallback((notification: NotificationRow) => {
    if (!notification.read_at) markNotificationRead(notification.id);
    router.push(getRoute(notification.data));
  }, [markNotificationRead, router]);
  const renderItem = useCallback(({ item }: { item: NotificationRow }) => (
    <NotificationCard notification={item} onPress={openNotification} />
  ), [openNotification]);
  const keyExtractor = useCallback((notification: NotificationRow) => notification.id, []);
  const loadMore = useCallback(() => {
    if (notificationsQuery.hasNextPage && !notificationsQuery.isFetchingNextPage) {
      void notificationsQuery.fetchNextPage();
    }
  }, [notificationsQuery]);

  return (
    <Screen
      virtualized
      bottomNavigation={
        user?.role === 'driver'
          ? <DriverTabBar />
          : user?.role === 'passenger'
            ? <PassengerTabBar />
            : undefined
      }
    >
      <FlatList
        style={styles.list}
        data={notifications}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <View style={styles.header}>
              <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
                <Text style={styles.backText}>‹ Back</Text>
              </Pressable>
              <Text style={styles.title}>Notifications</Text>
              <NotificationBell />
            </View>
            {unreadCount > 0 && (
              <Pressable
                accessibilityRole="button"
                disabled={markAllRead.isPending}
                onPress={() => markAllRead.mutate()}
                style={styles.markAll}
              >
                <Text style={styles.markAllText}>
                  {markAllRead.isPending ? 'Updating…' : 'Mark all as read'}
                </Text>
              </Pressable>
            )}
            {markAllRead.isError && (
              <Text accessibilityRole="alert" style={styles.error}>
                Notifications could not be updated. Please try again.
              </Text>
            )}
            {markRead.isError && (
              <Text accessibilityRole="alert" style={styles.error}>
                This notification could not be marked as read. Please try again.
              </Text>
            )}
            {notificationsQuery.isLoading && <ActivityIndicator color={theme.colors.primary} />}
            {notificationsQuery.isError && (
              <View style={styles.emptyCard}>
                <Text accessibilityRole="alert" style={styles.error}>
                  Notifications could not be loaded. Pull to refresh and try again.
                </Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={!notificationsQuery.isLoading && !notificationsQuery.isError ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>You’re all caught up</Text>
            <Text style={styles.body}>Important trip updates will appear here.</Text>
          </View>
        ) : null}
        ListFooterComponent={notificationsQuery.hasNextPage ? (
          <Pressable
            accessibilityRole="button"
            disabled={notificationsQuery.isFetchingNextPage}
            onPress={loadMore}
            style={styles.loadMore}
          >
            <Text style={styles.markAllText}>
              {notificationsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Text>
          </Pressable>
        ) : null}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={notificationsQuery.isRefetching}
            onRefresh={() => void notificationsQuery.refetch()}
            tintColor={theme.colors.primary}
          />
        }
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { flexGrow: 1, gap: theme.spacing.md, padding: theme.spacing.md },
  listHeader: { gap: theme.spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm },
  backButton: { minWidth: 46, minHeight: 44, justifyContent: 'center' },
  backText: { color: theme.colors.primary, fontSize: 14, fontWeight: '700' },
  title: { flex: 1, color: theme.colors.navy, fontSize: 22, fontWeight: '800' },
  markAll: { minHeight: 42, alignItems: 'flex-end', justifyContent: 'center' },
  markAllText: { color: theme.colors.primary, fontSize: 14, fontWeight: '700' },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  unreadCard: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryLight },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  unreadDot: { width: 8, height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primary },
  itemTitle: { flex: 1, color: theme.colors.navy, fontSize: 16, fontWeight: '800' },
  body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21 },
  date: { color: theme.colors.textSecondary, fontSize: 12 },
  emptyCard: { gap: theme.spacing.sm, padding: theme.spacing.lg, borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  emptyTitle: { color: theme.colors.navy, fontSize: 17, fontWeight: '800' },
  error: { color: theme.colors.error, fontSize: 14, lineHeight: 20 },
  loadMore: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
