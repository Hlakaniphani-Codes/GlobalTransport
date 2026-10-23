import { isAxiosError } from 'axios';
import { memo, useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api, queryPollingInterval } from '@/api';
import { AppText as Text } from '@/components/AppText';
import { AppTextInput } from '@/components/AppTextInput';
import { PrimaryButton } from '@/components/PrimaryButton';
import {
  displayPassengerSchedule,
  fetchPassengerRequests,
  type PassengerRideRequest,
} from '@/passenger/rides';
import { theme } from '@/theme';

const weekdays = [
  { id: 1, label: 'Mon' },
  { id: 2, label: 'Tue' },
  { id: 3, label: 'Wed' },
  { id: 4, label: 'Thu' },
  { id: 5, label: 'Fri' },
  { id: 6, label: 'Sat' },
  { id: 7, label: 'Sun' },
];
const filters = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'assigned', label: 'Scheduled' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'no_show', label: 'Missed' },
  { id: 'missed', label: 'Trip missed' },
  { id: 'expired', label: 'Expired' },
] as const;
type RequestFilter = typeof filters[number]['id'];
const maxBookingAdvanceDays = 7;
const johannesburgOffsetMs = 2 * 60 * 60 * 1000;

function latestBookingDate(now: number): string {
  const latestDate = new Date(now + johannesburgOffsetMs);
  latestDate.setUTCDate(latestDate.getUTCDate() + maxBookingAdvanceDays);
  return latestDate.toISOString().slice(0, 10);
}

function getErrorMessage(error: unknown): string {
  if (isAxiosError<{ error?: { message?: string }; message?: string }>(error)) {
    return error.response?.data?.error?.message
      ?? error.response?.data?.message
      ?? 'Unable to connect. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'Unable to connect. Check your connection and try again.';
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function workplaceLabel(request: PassengerRideRequest): string {
  const company = request.company_name.trim();
  const workplace = request.workplace_name.trim();
  if (!workplace || company.toLocaleLowerCase() === workplace.toLocaleLowerCase()) return company || workplace;
  return `${company} · ${workplace}`;
}

function statusLabel(status: PassengerRideRequest['status']): string {
  if (status === 'assigned') return 'Scheduled';
  if (status === 'no_show' || status === 'missed') return 'Missed';
  return status[0].toLocaleUpperCase() + status.slice(1);
}

function DirectionButton({ title, subtitle, destination, selected, onPress }: {
  title: string; subtitle: string; destination: 'work' | 'home'; selected: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.directionButton, selected && styles.directionSelected]}
    >
      <View style={[styles.routeIcon, selected && styles.routeIconSelected]}>
        <View style={[styles.routeStart, selected && styles.routeMarkSelected]} />
        <View style={[styles.routeStroke, selected && styles.routeStrokeSelected]} />
        {destination === 'work' ? (
          <View style={[styles.workDestination, selected && styles.routeMarkSelected]} />
        ) : (
          <View style={[styles.homeDestination, selected && styles.routeMarkSelected]}>
            <View style={[styles.homeDestinationInner, selected && styles.homeDestinationInnerSelected]} />
          </View>
        )}
      </View>
      <View style={styles.directionCopy}>
        <Text style={[styles.directionText, selected && styles.directionTextSelected]}>{title}</Text>
        <Text style={[styles.directionSubtitle, selected && styles.directionSubtitleSelected]}>{subtitle}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <View style={styles.radioDot} />}
      </View>
    </Pressable>
  );
}

const PassengerRequestCard = memo(function PassengerRequestCard({
  request,
  cancelPending,
  onCancel,
  onBookAgain,
}: {
  request: PassengerRideRequest;
  cancelPending: boolean;
  onCancel: (request: PassengerRideRequest, scope: 'this' | 'series') => void;
  onBookAgain: (request: PassengerRideRequest) => void;
}) {
  return (
    <View style={styles.requestCard}>
      <View style={styles.requestHeading}>
        <Text style={styles.requestTitle}>{request.direction === 'home' ? 'Ride home' : 'Ride to work'}</Text>
        <Text style={[styles.status, request.status === 'cancelled' && styles.cancelled]}>
          {statusLabel(request.status)}
        </Text>
      </View>
      <Text style={styles.helper}>{displayPassengerSchedule(request.scheduled_at)}</Text>
      <Text style={styles.helper}>{workplaceLabel(request)}</Text>
      {request.outcome_reason && <Text style={styles.helper}>{request.outcome_reason}</Text>}
      {request.cancelled_late && <Text style={styles.helper}>Cancelled within 2 hours of pick-up.</Text>}
      {request.request_again && (
        <PrimaryButton
          title="Book this ride again"
          variant="secondary"
          onPress={() => onBookAgain(request)}
        />
      )}
      {['pending', 'assigned'].includes(request.status) && (
        <View style={styles.cancelActions}>
          <PrimaryButton
            title="Cancel request"
            variant="secondary"
            loading={cancelPending}
            onPress={() => onCancel(request, 'this')}
            style={styles.cancelButton}
          />
          {request.series_id && (
            <PrimaryButton
              title="Cancel remaining repeats"
              variant="secondary"
              loading={cancelPending}
              onPress={() => onCancel(request, 'series')}
              style={styles.cancelButton}
            />
          )}
        </View>
      )}
    </View>
  );
});

export function PassengerRideRequestForm() {
  const routeParams = useLocalSearchParams<{
    direction?: string | string[];
    date?: string | string[];
    time?: string | string[];
    weekdays?: string | string[];
  }>();
  const directionParam = Array.isArray(routeParams.direction) ? routeParams.direction[0] : routeParams.direction;
  const dateParam = Array.isArray(routeParams.date) ? routeParams.date[0] : routeParams.date;
  const timeParam = Array.isArray(routeParams.time) ? routeParams.time[0] : routeParams.time;
  const weekdaysParam = Array.isArray(routeParams.weekdays) ? routeParams.weekdays[0] : routeParams.weekdays;
  const prefilledWeekdays = [...new Set((weekdaysParam ?? '')
    .split(',')
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))];
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'to_work' | 'home'>(
    directionParam === 'to_work' || directionParam === 'home' ? directionParam : 'home'
  );
  const [date, setDate] = useState(dateParam && isValidDate(dateParam) ? dateParam : '');
  const [time, setTime] = useState(timeParam && /^([01]\d|2[0-3]):[0-5]\d$/.test(timeParam) ? timeParam : '');
  const [repeat, setRepeat] = useState(prefilledWeekdays.length > 0);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>(prefilledWeekdays);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!isValidDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new Error('Enter a valid date and time.');
      }
      const now = Date.now();
      const bookingLimitDate = latestBookingDate(now);
      const scheduledAt = Date.parse(`${date}T${time}:00+02:00`);
      if (scheduledAt <= now) {
        throw new Error('Choose a future date and time.');
      }
      if (date > bookingLimitDate) {
        throw new Error('Choose a date and time within the next 7 days.');
      }
      if (repeat) {
        if (!isValidDate(repeatUntil) || repeatWeekdays.length === 0) {
          throw new Error('Choose repeat weekdays and an end date.');
        }
        const daysApart = (Date.parse(`${repeatUntil}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
        if (daysApart < 0 || daysApart > maxBookingAdvanceDays || repeatUntil > bookingLimitDate) {
          throw new Error('The repeat end date must be within the next 7 days.');
        }
      }
      const body = {
        direction,
        date,
        time,
        ...(repeat ? { repeat: { weekdays: [...repeatWeekdays].sort((a, b) => a - b), until: repeatUntil } } : {}),
      };
      await api.post('/ride-requests', body);
    },
    onSuccess: async () => {
      setDate('');
      setTime('');
      setRepeat(false);
      setRepeatUntil('');
      setRepeatWeekdays([]);
      setError(null);
      setSuccess('Ride request sent.');
      await queryClient.invalidateQueries({ queryKey: ['passenger', 'ride-requests'] });
    },
    onError: (requestError: unknown) => {
      setSuccess(null);
      setError(getErrorMessage(requestError));
    },
  });

  function toggleWeekday(day: number) {
    setRepeatWeekdays((current) => current.includes(day)
      ? current.filter((selected) => selected !== day)
      : [...current, day]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>YOUR NEXT JOURNEY</Text>
        <Text style={styles.title}>Request a ride</Text>
        <Text style={styles.intro}>Choose your destination and pickup time.</Text>
      </View>
      <View style={styles.form}>
        <View style={styles.fieldGroup}>
          <View style={styles.fieldHeading}>
            <Text style={styles.label}>Your journey</Text>
            <Text style={styles.helper}>Choose a direction.</Text>
          </View>
          <View style={styles.directionRow}>
            <DirectionButton
              title="To work"
              subtitle="Home to workplace"
              destination="work"
              selected={direction === 'to_work'}
              onPress={() => setDirection('to_work')}
            />
            <DirectionButton
              title="Going home"
              subtitle="Workplace to home"
              destination="home"
              selected={direction === 'home'}
              onPress={() => setDirection('home')}
            />
          </View>
        </View>
        <View style={styles.fieldGroup}>
          <View style={styles.fieldHeading}>
            <Text style={styles.label}>Pickup schedule</Text>
            <Text style={styles.helper}>Choose a date within 7 days. Times use the 24-hour clock.</Text>
          </View>
          <View style={styles.scheduleRow}>
            <View style={styles.dateField}>
              <AppTextInput
                label="Date"
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoComplete="off"
                maxLength={10}
                returnKeyType="next"
              />
            </View>
            <View style={styles.timeField}>
              <AppTextInput
                label="Time"
                value={time}
                onChangeText={setTime}
                placeholder="17:00"
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                maxLength={5}
                returnKeyType="done"
              />
            </View>
          </View>
        </View>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: repeat }}
          onPress={() => setRepeat((value) => !value)}
          style={styles.repeatToggle}
        >
          <View style={[styles.checkbox, repeat && styles.checkboxSelected]} />
          <View style={styles.repeatCopy}>
            <Text style={styles.repeatLabel}>Repeat this ride</Text>
            <Text style={styles.helper}>Set the days for a regular commute.</Text>
          </View>
        </Pressable>
        {repeat && (
          <View style={styles.repeatFields}>
            <View style={styles.fieldHeading}>
              <Text style={styles.label}>Repeat schedule</Text>
              <Text style={styles.helper}>Choose days within the next 7 days.</Text>
            </View>
            <View style={styles.weekdays}>
              {weekdays.map((day) => {
                const selected = repeatWeekdays.includes(day.id);
                return (
                  <Pressable
                    key={day.id}
                    accessibilityRole="checkbox"
                    accessibilityLabel={day.label}
                    accessibilityState={{ checked: selected }}
                    onPress={() => toggleWeekday(day.id)}
                    style={[styles.weekdayButton, selected && styles.weekdaySelected]}
                  >
                    <Text singleLine style={[styles.weekdayText, selected && styles.weekdayTextSelected]}>{day.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <AppTextInput
              label="Repeat until"
              value={repeatUntil}
              onChangeText={setRepeatUntil}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoComplete="off"
              maxLength={10}
              returnKeyType="done"
            />
          </View>
        )}
        {error && (
          <View accessibilityRole="alert" style={styles.feedbackError}>
            <Text style={styles.error}>{error}</Text>
          </View>
        )}
        {success && (
          <View style={styles.feedbackSuccess}>
            <Text style={styles.success}>{success}</Text>
          </View>
        )}
        <PrimaryButton
          title="Send ride request"
          loading={createMutation.isPending}
          onPress={() => createMutation.mutate()}
        />
      </View>
    </View>
  );
}

export function PassengerRequestsList() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState<RequestFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const requestsQuery = useInfiniteQuery({
    queryKey: ['passenger', 'ride-requests'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchPassengerRequests(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: focused,
    refetchInterval: focused ? (query) => queryPollingInterval(query, 60) : false,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const cancelMutation = useMutation({
    mutationFn: async ({ requestId, scope }: { requestId: string; scope: 'this' | 'series' }) => {
      await api.post(`/ride-requests/${requestId}/cancel`, { scope });
    },
    onSuccess: async () => {
      setError(null);
      setSuccess('Ride request cancelled.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['passenger', 'ride-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trips'] }),
        queryClient.invalidateQueries({ queryKey: ['passenger', 'trip-history'] }),
      ]);
    },
    onError: (requestError: unknown) => {
      setSuccess(null);
      setError(getErrorMessage(requestError));
    },
  });
  const cancelRideRequest = cancelMutation.mutate;

  const confirmCancel = useCallback((request: PassengerRideRequest, scope: 'this' | 'series') => {
    const message = scope === 'series'
      ? 'This will cancel all eligible rides in this repeat series.'
      : request.cancelled_late
        ? 'This cancellation may be considered late. Do you want to continue?'
        : 'Are you sure you want to cancel this ride request?';
    Alert.alert(scope === 'series' ? 'Cancel repeated rides?' : 'Cancel ride request?', message, [
      { text: 'Keep request', style: 'cancel' },
      {
        text: 'Cancel request',
        style: 'destructive',
        onPress: () => cancelRideRequest({ requestId: request.id, scope }),
      },
    ]);
  }, [cancelRideRequest]);

  const requests = requestsQuery.data?.pages.flatMap((page) => page.ride_requests) ?? [];
  const filtered = filter === 'all' ? requests : requests.filter(({ status }) => status === filter);
  const bookAgain = useCallback((request: PassengerRideRequest) => {
    router.push({
      pathname: '/(app)/passenger-request',
      params: {
        direction: request.request_again?.direction,
        date: request.request_again?.date,
        time: request.request_again?.time_of_day,
        weekdays: request.request_again?.repeat_pattern?.weekdays.join(','),
      },
    });
  }, [router]);
  const renderItem = useCallback(({ item }: { item: PassengerRideRequest }) => (
    <PassengerRequestCard
      request={item}
      cancelPending={cancelMutation.isPending}
      onCancel={confirmCancel}
      onBookAgain={bookAgain}
    />
  ), [bookAgain, cancelMutation.isPending, confirmCancel]);
  const keyExtractor = useCallback((request: PassengerRideRequest) => request.id, []);
  const loadMore = useCallback(() => {
    if (requestsQuery.hasNextPage && !requestsQuery.isFetchingNextPage) {
      void requestsQuery.fetchNextPage();
    }
  }, [requestsQuery]);

  return (
    <FlatList
      style={styles.list}
      data={filtered}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={
        <View style={styles.container}>
          <Text style={styles.title}>My requests</Text>
          <View style={styles.filters}>
            {filters.map(({ id, label }) => (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ checked: filter === id }}
                onPress={() => setFilter(id)}
                style={[styles.filterChip, filter === id && styles.filterChipSelected]}
              >
                <Text singleLine style={[styles.filterText, filter === id && styles.filterTextSelected]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {requestsQuery.isLoading && <Text style={styles.helper}>Loading requests…</Text>}
          {requestsQuery.isError && (
            <Text accessibilityRole="alert" style={styles.error}>Ride requests could not be loaded. Check your connection and try again.</Text>
          )}
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {success && <Text style={styles.success}>{success}</Text>}
        </View>
      }
      ListEmptyComponent={!requestsQuery.isLoading && !requestsQuery.isError ? (
        <Text style={styles.empty}>
          {filter === 'all' ? 'You have no ride requests.' : `No ${filters.find(({ id }) => id === filter)?.label.toLocaleLowerCase()} requests.`}
        </Text>
      ) : null}
      ListFooterComponent={
        <View style={styles.container}>
          {requestsQuery.hasNextPage && (
            <PrimaryButton
              title={requestsQuery.isFetchingNextPage ? 'Loading…' : 'Load more requests'}
              variant="secondary"
              loading={requestsQuery.isFetchingNextPage}
              onPress={loadMore}
            />
          )}
          <PrimaryButton
            title="Refresh"
            variant="secondary"
            loading={requestsQuery.isRefetching}
            onPress={() => void requestsQuery.refetch()}
          />
        </View>
      }
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={requestsQuery.isRefetching}
          onRefresh={() => void requestsQuery.refetch()}
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
  container: { gap: theme.spacing.md },
  listContent: { gap: theme.spacing.md, paddingVertical: 8, paddingHorizontal: theme.spacing.md },
  heading: {
    gap: theme.spacing.xs,
    padding: theme.spacing.lg,
    borderRadius: 20,
    backgroundColor: theme.colors.navy,
  },
  eyebrow: {
    color: '#B9DDF2',
    fontSize: 10,
    fontFamily: 'Manrope_700Bold',
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  title: {
    color: theme.colors.white,
    fontSize: 27,
    fontFamily: 'Manrope_800ExtraBold',
    fontWeight: '800',
    letterSpacing: -0.8,
    lineHeight: 36,
  },
  intro: { color: '#E2EEF6', fontSize: 14, fontFamily: 'Manrope_400Regular', lineHeight: 22 },
  helper: { color: theme.colors.textSecondary, fontSize: 12, fontFamily: 'Manrope_400Regular', lineHeight: 18 },
  form: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
    borderRadius: 20,
    backgroundColor: theme.colors.white,
    shadowColor: theme.colors.navy,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 3,
  },
  fieldGroup: { gap: theme.spacing.sm },
  fieldHeading: { gap: 3 },
  label: { color: theme.colors.navy, fontSize: 14, fontFamily: 'Manrope_700Bold', fontWeight: '800', letterSpacing: -0.1 },
  directionRow: { gap: theme.spacing.sm },
  directionButton: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderWidth: 1,
    borderColor: '#C9DCEA',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  directionSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  routeIcon: {
    width: 34,
    height: 42,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  routeIconSelected: { opacity: 1 },
  routeStart: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary },
  routeStroke: { position: 'absolute', top: 9, bottom: 9, width: 2, backgroundColor: '#C9DCEA' },
  routeStrokeSelected: { backgroundColor: '#B9DDF2' },
  workDestination: {
    width: 11,
    height: 11,
    borderWidth: 2,
    borderColor: theme.colors.primary,
    borderRadius: 3,
    backgroundColor: theme.colors.white,
  },
  homeDestination: {
    width: 12,
    height: 12,
    borderWidth: 2,
    borderColor: theme.colors.primary,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeDestinationInner: { width: 4, height: 4, borderRadius: 2, backgroundColor: theme.colors.primary },
  routeMarkSelected: { backgroundColor: theme.colors.white, borderColor: theme.colors.white },
  homeDestinationInnerSelected: { backgroundColor: theme.colors.primary },
  directionCopy: { flex: 1, minWidth: 0, gap: 3 },
  directionText: { color: theme.colors.navy, fontSize: 14, fontFamily: 'Manrope_700Bold', fontWeight: '800' },
  directionTextSelected: { color: theme.colors.white },
  directionSubtitle: { color: theme.colors.textSecondary, fontSize: 11, fontFamily: 'Manrope_400Regular', lineHeight: 16 },
  directionSubtitleSelected: { color: '#E2EEF6' },
  radio: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: theme.colors.border, borderRadius: 10 },
  radioSelected: { borderColor: theme.colors.white },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.white },
  scheduleRow: { flexDirection: 'column', gap: theme.spacing.md },
  dateField: { width: '100%' },
  timeField: { width: '100%' },
  repeatToggle: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.sm,
    borderWidth: 1,
    borderColor: '#C9DCEA',
    borderRadius: theme.radius.md,
    backgroundColor: '#E8F2F9',
  },
  checkbox: { width: 22, height: 22, borderWidth: 2, borderColor: theme.colors.border, borderRadius: 6, backgroundColor: theme.colors.white },
  checkboxSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  repeatCopy: { flex: 1, gap: 2 },
  repeatLabel: { color: theme.colors.navy, fontSize: 14, fontFamily: 'Manrope_700Bold', fontWeight: '800' },
  repeatFields: { gap: theme.spacing.md, paddingTop: theme.spacing.xs },
  weekdays: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: theme.spacing.xs },
  weekdayButton: { flexGrow: 1, flexBasis: 38, minWidth: 38, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.sm, backgroundColor: theme.colors.white },
  weekdaySelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  weekdayText: { color: theme.colors.navy, fontSize: 12, fontFamily: 'Manrope_600SemiBold', fontWeight: '700' },
  weekdayTextSelected: { color: theme.colors.white, fontFamily: 'Manrope_700Bold', fontWeight: '700' },
  requestCard: { gap: theme.spacing.xs, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, backgroundColor: theme.colors.white },
  requestHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm },
  requestTitle: { flex: 1, color: theme.colors.navy, fontSize: 15, fontFamily: 'Manrope_700Bold', fontWeight: '800' },
  status: { color: theme.colors.primary, fontSize: 11, fontFamily: 'Manrope_700Bold', fontWeight: '800', textTransform: 'capitalize' },
  cancelled: { color: theme.colors.textSecondary },
  empty: { color: theme.colors.textSecondary, fontSize: 13 },
  feedbackError: { padding: theme.spacing.sm, borderRadius: theme.radius.sm, backgroundColor: '#FEF3F2' },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 19 },
  feedbackSuccess: { padding: theme.spacing.sm, borderRadius: theme.radius.sm, backgroundColor: '#E8F2F9' },
  success: { color: theme.colors.primaryDark, fontSize: 13, fontFamily: 'Manrope_700Bold', fontWeight: '700', lineHeight: 19 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs },
  filterChip: { minHeight: 38, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.white },
  filterChipSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryLight },
  filterText: { color: theme.colors.textSecondary, fontSize: 12, fontFamily: 'Manrope_600SemiBold', fontWeight: '700' },
  filterTextSelected: { color: theme.colors.primary, fontFamily: 'Manrope_700Bold', fontWeight: '700' },
  cancelActions: { gap: theme.spacing.xs },
  cancelButton: { minHeight: 48 },
});
