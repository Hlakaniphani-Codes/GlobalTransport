import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
import { IosAuthorizationStatus } from 'expo-notifications/build/NotificationPermissions.types';
import type { PushTokenManagerModule } from 'expo-notifications/build/PushTokenManager.types';
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-notifications/build/NotificationPermissions';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  clearLastNotificationResponseAsync,
  getLastNotificationResponseAsync,
} from 'expo-notifications/build/NotificationsEmitter';
import { setNotificationHandler } from 'expo-notifications/build/NotificationsHandler';
import { getExpoPushTokenAsync } from 'expo-notifications/build/getExpoPushTokenAsync';
import { setBadgeCountAsync } from 'expo-notifications/build/setBadgeCountAsync';
import { setNotificationChannelAsync } from 'expo-notifications/build/setNotificationChannelAsync';

import { useAuth } from '@/auth/AuthContext';
import { api, deduplicatedGet, queryPollingInterval } from '@/api';
import { getDeviceToken, storeDeviceToken } from '@/notifications/deviceTokenStorage';
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

type BannerNotification = {
  title: string;
  body: string;
  data: Record<string, unknown>;
};

type ApiErrorResponse = { error?: { message?: string } };

function getRegistrationErrorMessage(error: unknown): string {
  if (isAxiosError<ApiErrorResponse>(error)) {
    const message = error.response?.data?.error?.message;
    if (message) return `Push notifications couldn't be set up: ${message}`;
    if (!error.response) {
      return 'Could not reach Global Ride to register this device. Check your connection and try again.';
    }
    if (error.response.status >= 500) {
      return 'The notification service is temporarily unavailable. Please try again later.';
    }
    if (error.response.status === 401 || error.response.status === 403) {
      return 'Your session could not register this device. Sign out and sign back in, then try again.';
    }
    return `Device registration failed (HTTP ${error.response.status}). Please try again.`;
  }
  if (error instanceof Error && error.message.trim()) {
    return `Push notifications couldn't be set up: ${error.message}`;
  }
  return 'Push notifications could not be set up. Please try again.';
}

type NotificationContextValue = {
  unreadCount: number;
  permissionGranted: boolean | null;
  pushSupported: boolean;
  deviceRegistered: boolean;
  lastNotificationReceivedAt: number | null;
  registrationError: string | null;
  retryPushRegistration: () => Promise<void>;
  dismissRegistrationError: () => void;
  refreshNotificationCount: () => Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);
const PROMPT_KEY_PREFIX = 'global_ride_notification_prompt_seen_';
const LAST_RECEIVED_KEY_PREFIX = 'global_ride_last_notification_received_';
const pushSupported = Platform.OS !== 'web'
  && Device.isDevice
  && !(Platform.OS === 'android' && Constants.executionEnvironment === 'storeClient');
const supportsAndroidNotificationChannels = Platform.OS === 'android'
  && Constants.executionEnvironment !== 'storeClient';
const pushTokenManager = Platform.OS === 'web'
  ? null
  : requireOptionalNativeModule<PushTokenManagerModule>('ExpoPushTokenManager');
setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function getPromptSeen(userId: string): Promise<string | null> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.sessionStorage.getItem(`${PROMPT_KEY_PREFIX}${userId}`));
  return SecureStore.getItemAsync(`${PROMPT_KEY_PREFIX}${userId}`);
}

async function setPromptSeen(userId: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.sessionStorage.setItem(`${PROMPT_KEY_PREFIX}${userId}`, 'true');
    return;
  }
  await SecureStore.setItemAsync(`${PROMPT_KEY_PREFIX}${userId}`, 'true');
}

function notificationRoute(data: Record<string, unknown>, role: string): Href {
  const tripId = typeof data.trip_id === 'string' ? data.trip_id : null;
  if (data.screen === 'offers' && role === 'driver') return '/(app)/driver-offers';
  if (data.screen === 'driver' && tripId && role === 'driver') {
    return `/(app)/driver-trip/${encodeURIComponent(tripId)}` as Href;
  }
  if (data.screen === 'passenger_requests' && role === 'passenger') return '/(app)/passenger-requests';
  if (data.screen === 'passenger' && role === 'passenger') return '/(app)/passenger';
  if (data.screen === 'account') return '/(app)/account';
  return '/(app)/notifications';
}

export function NotificationProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [permissionState, setPermissionState] = useState<{ userId: string; granted: boolean } | null>(null);
  const [promptVisible, setPromptVisible] = useState(false);
  const [promptUserId, setPromptUserId] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerNotification | null>(null);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [deviceRegisteredUserId, setDeviceRegisteredUserId] = useState<string | null>(null);
  const [lastNotificationReceived, setLastNotificationReceived] = useState<{
    userId: string;
    timestamp: number;
  } | null>(null);

  const notificationCount = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: async ({ signal }) => (await deduplicatedGet<
      Pick<NotificationPage, 'unread_count'> & { poll_after_seconds?: number }
    >('/notifications', { signal })).data,
    enabled: Boolean(user),
    refetchInterval: (query) => queryPollingInterval(query, 60),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const openNotification = useCallback((data: Record<string, unknown>) => {
    setBanner(null);
    router.push(notificationRoute(data, user?.role ?? ''));
  }, [router, user?.role]);

  const refreshNotificationCount = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }, [queryClient]);

  const registerDevice = useCallback(async () => {
    if (!pushSupported || !user?.id) return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (typeof projectId !== 'string' || !projectId) {
      throw new Error('Push notifications are not configured for this app build.');
    }
    if (supportsAndroidNotificationChannels) {
      await setNotificationChannelAsync('offers', {
        name: 'Trip offers',
        importance: AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 250, 250, 250],
      });
      await setNotificationChannelAsync('trip_updates', {
        name: 'Trip updates',
        importance: AndroidImportance.HIGH,
        sound: 'default',
      });
      await setNotificationChannelAsync('general', {
        name: 'General updates',
        importance: AndroidImportance.DEFAULT,
      });
    }

    const permission = await getPermissionsAsync();
    const granted = permission.granted || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
    setPermissionState({ userId: user.id, granted });
    if (!granted) return;

    const token = (await getExpoPushTokenAsync({ projectId })).data;
    const previousToken = await getDeviceToken();
    await api.post('/devices', {
      token,
      platform: Platform.OS,
      device_name: Device.deviceName ?? undefined,
    });
    if (previousToken && previousToken !== token) {
      await api.delete(`/devices/${encodeURIComponent(previousToken)}`);
    }
    await storeDeviceToken(token);
    setDeviceRegisteredUserId(user.id);
    setRegistrationError(null);
  }, [user]);

  const retryPushRegistration = useCallback(async () => {
    try {
      await registerDevice();
    } catch (error) {
      setRegistrationError(getRegistrationErrorMessage(error));
    }
  }, [registerDevice]);
  const dismissRegistrationError = useCallback(() => setRegistrationError(null), []);

  useEffect(() => {
    if (!pushSupported || !user) {
      return undefined;
    }
    let active = true;
    const subscriptions: { remove: () => void }[] = [];

    subscriptions.push(addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as Record<string, unknown>;
      const receivedAt = Date.now();
      setLastNotificationReceived({ userId: user.id, timestamp: receivedAt });
      void SecureStore.setItemAsync(`${LAST_RECEIVED_KEY_PREFIX}${user.id}`, String(receivedAt))
        .catch((error: unknown) => {
          if (active) setRegistrationError(getRegistrationErrorMessage(error));
        });
      setBanner({
        title: notification.request.content.title ?? 'Global Ride update',
        body: notification.request.content.body ?? '',
        data,
      });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['driver'] });
      void queryClient.invalidateQueries({ queryKey: ['passenger'] });
    }));
    subscriptions.push(addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      openNotification(data);
    }));
    if (pushSupported && pushTokenManager) {
      subscriptions.push(pushTokenManager.addListener('onDevicePushToken', () => {
        void registerDevice().catch((error: unknown) => {
          if (active) setRegistrationError(getRegistrationErrorMessage(error));
        });
      }));
    }

    const initialize = async () => {
      await registerDevice().catch((error: unknown) => {
        if (active) setRegistrationError(getRegistrationErrorMessage(error));
      });
      const seen = await getPromptSeen(user.id);
      if (!active) return;
      if (!seen) {
        const permission = await getPermissionsAsync();
        const granted = permission.granted
          || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
        if (!granted && Device.isDevice) {
          setPromptUserId(user.id);
          setPromptVisible(true);
        }
      }
      const response = await getLastNotificationResponseAsync();
      if (!active || !response) return;
      const data = response.notification.request.content.data as Record<string, unknown>;
      openNotification(data);
      void clearLastNotificationResponseAsync();
    };
    void initialize().catch((error: unknown) => {
      if (active) setRegistrationError(getRegistrationErrorMessage(error));
    });

    return () => {
      active = false;
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [openNotification, queryClient, registerDevice, user]);

  const activeUserId = user?.id;
  useEffect(() => {
    if (!activeUserId || !pushSupported) return undefined;
    let active = true;
    void SecureStore.getItemAsync(`${LAST_RECEIVED_KEY_PREFIX}${activeUserId}`)
      .then((receivedAt) => {
        if (active && receivedAt) {
          setLastNotificationReceived({ userId: activeUserId, timestamp: Number(receivedAt) });
        }
      })
      .catch((error: unknown) => {
        if (active) setRegistrationError(getRegistrationErrorMessage(error));
      });
    return () => { active = false; };
  }, [activeUserId]);

  useEffect(() => {
    if (!pushSupported) return;
    let active = true;
    void setBadgeCountAsync(notificationCount.data?.unread_count ?? 0)
      .catch(() => {
        if (active) setRegistrationError('The notification badge could not be refreshed. Push alerts are not affected.');
      });
    return () => {
      active = false;
    };
  }, [notificationCount.data?.unread_count]);

  useEffect(() => {
    if (!banner) return undefined;
    const timeout = setTimeout(() => setBanner(null), 6_000);
    return () => clearTimeout(timeout);
  }, [banner]);

  const contextValue = useMemo(() => ({
    unreadCount: notificationCount.data?.unread_count ?? 0,
    permissionGranted: permissionState && permissionState.userId === activeUserId
      ? permissionState.granted
      : null,
    pushSupported,
    deviceRegistered: Boolean(activeUserId && pushSupported && deviceRegisteredUserId === activeUserId),
    lastNotificationReceivedAt: activeUserId && lastNotificationReceived?.userId === activeUserId
      ? lastNotificationReceived.timestamp
      : null,
    registrationError,
    retryPushRegistration,
    dismissRegistrationError,
    refreshNotificationCount,
  }), [
    notificationCount.data?.unread_count,
    deviceRegisteredUserId,
    lastNotificationReceived,
    permissionState,
    refreshNotificationCount,
    registrationError,
    retryPushRegistration,
    dismissRegistrationError,
    activeUserId,
  ]);

  async function dismissPrompt() {
    if (user) await setPromptSeen(user.id);
    setPromptVisible(false);
  }

  async function requestPermission() {
    try {
      if (supportsAndroidNotificationChannels) {
        await setNotificationChannelAsync('offers', {
          name: 'Trip offers',
          importance: AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 250, 250, 250],
        });
        await setNotificationChannelAsync('trip_updates', {
          name: 'Trip updates',
          importance: AndroidImportance.HIGH,
          sound: 'default',
        });
        await setNotificationChannelAsync('general', {
          name: 'General updates',
          importance: AndroidImportance.DEFAULT,
        });
      }
      await requestPermissionsAsync();
      await dismissPrompt();
      await registerDevice();
    } catch (error) {
      setRegistrationError(getRegistrationErrorMessage(error));
      await dismissPrompt();
    }
  }

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      {banner && (
        <Pressable
          accessibilityRole="button"
          onPress={() => openNotification(banner.data)}
          style={[styles.banner, { top: insets.top + theme.spacing.sm }]}
        >
          <Text style={styles.bannerTitle}>{banner.title}</Text>
          <Text numberOfLines={2} style={styles.bannerBody}>{banner.body}</Text>
        </Pressable>
      )}
      <Modal
        animationType="fade"
        onRequestClose={() => void dismissPrompt()}
        transparent
        visible={promptVisible && promptUserId === user?.id}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Turn on notifications</Text>
            <Text style={styles.promptBody}>
              {user?.role === 'driver'
                ? 'Get trip offers and important trip updates on this device.'
                : 'Get important updates about your trips on this device.'}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={styles.allowButton}>
              <Text style={styles.allowText}>Allow</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void dismissPrompt()} style={styles.laterButton}>
              <Text style={styles.laterText}>Not now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </NotificationContext.Provider>
  );
}

export function useNotificationStatus(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotificationStatus must be used within NotificationProvider.');
  return context;
}

export function NotificationBell() {
  const { unreadCount } = useNotificationStatus();
  const router = useRouter();
  return (
    <Pressable
      accessibilityLabel={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      accessibilityRole="button"
      onPress={() => router.push('/(app)/notifications')}
      style={styles.bell}
    >
      <View accessibilityElementsHidden style={styles.bellIcon}>
        <View style={styles.bellDome} />
        <View style={styles.bellBase} />
        <View style={styles.bellClapper} />
      </View>
      {unreadCount > 0 && (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: theme.spacing.md,
    right: theme.spacing.md,
    zIndex: 10,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
    borderWidth: 1,
    borderColor: theme.colors.border,
    elevation: 6,
  },
  bannerTitle: { color: theme.colors.navy, fontSize: 15, fontWeight: '800' },
  bannerBody: { marginTop: 4, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.lg,
    backgroundColor: 'rgba(9, 34, 56, 0.48)',
  },
  promptCard: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.white,
  },
  promptTitle: { color: theme.colors.navy, fontSize: 22, fontWeight: '800' },
  promptBody: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 22 },
  allowButton: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  allowText: { color: theme.colors.white, fontSize: 15, fontWeight: '800' },
  laterButton: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  laterText: { color: theme.colors.primary, fontSize: 14, fontWeight: '700' },
  bell: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primaryLight,
  },
  bellIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end' },
  bellDome: {
    position: 'absolute',
    top: 2,
    width: 17,
    height: 17,
    borderWidth: 2,
    borderColor: theme.colors.primaryDark,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },
  bellBase: { width: 22, height: 2, marginBottom: 2, backgroundColor: theme.colors.primaryDark },
  bellClapper: { position: 'absolute', bottom: 0, width: 4, height: 4, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primaryDark },
  unreadBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.error,
  },
  unreadBadgeText: { color: theme.colors.white, fontSize: 9, fontWeight: '800' },
});
