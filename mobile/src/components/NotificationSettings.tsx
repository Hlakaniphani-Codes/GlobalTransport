import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Linking, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import Constants from 'expo-constants';

import { AppText as Text } from '@/components/AppText';
import { api } from '@/api';
import { useNotificationStatus } from '@/notifications/NotificationProvider';
import { AppButton } from '@/components/ui/AppButton';
import { theme } from '@/theme';

type Preferences = { push_enabled: boolean; sms_enabled: boolean };

export function NotificationSettings() {
  const queryClient = useQueryClient();
  const {
    permissionGranted,
    pushSupported,
    deviceRegistered,
    lastNotificationReceivedAt,
    registrationError,
    retryPushRegistration,
    dismissRegistrationError,
  } = useNotificationStatus();
  const preferencesQuery = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async ({ signal }) => (await api.get<{ preferences: Preferences }>(
      '/me/notification-preferences',
      { signal }
    )).data.preferences,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  const update = useMutation({
    mutationFn: async (preferences: Partial<Preferences>) =>
      (await api.patch<{ preferences: Preferences }>('/me/notification-preferences', preferences)).data.preferences,
    onSuccess: async (preferences) => {
      queryClient.setQueryData(['notification-preferences'], preferences);
    },
  });
  const sendTest = useMutation({
    mutationFn: async () => api.post('/devices/test'),
  });
  const preferences = preferencesQuery.data;
  const pushUnavailableMessage = Platform.OS === 'android'
    && Constants.executionEnvironment === 'storeClient'
    ? 'Android remote push notifications are not available in Expo Go. Install the development build and start Metro with npm run start:dev-client to test device push.'
    : 'Push notifications need the installed app on a physical device. Install the development build to test device push.';

  function changePreference(key: keyof Preferences, value: boolean) {
    if (!preferences) return;
    update.mutate({ [key]: value });
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Notifications</Text>
      <View style={styles.statusLines}>
        <Text style={styles.copy}>Permission: {permissionGranted ? 'on' : 'off'}</Text>
        <Text style={styles.copy}>This device: {deviceRegistered ? 'registered' : 'not registered'}</Text>
        <Text style={styles.copy}>
          Last notification received: {lastNotificationReceivedAt
            ? new Date(lastNotificationReceivedAt).toLocaleString('en-ZA', {
              dateStyle: 'short',
              timeStyle: 'short',
              hourCycle: 'h23',
              timeZone: 'Africa/Johannesburg',
            })
            : 'Never'}
        </Text>
      </View>
      {!pushSupported && (
        <Text style={styles.copy}>{pushUnavailableMessage}</Text>
      )}
      {pushSupported && (
        <AppButton
          label={sendTest.isPending ? 'Sending test notification…' : 'Send a test notification'}
          onPress={() => sendTest.mutate()}
          disabled={sendTest.isPending || !permissionGranted}
          variant="secondary"
        />
      )}
      {sendTest.isSuccess && (
        <Text style={styles.copy}>Test notification queued. Delivery may take a short time.</Text>
      )}
      {sendTest.isError && (
        <Text accessibilityRole="alert" style={styles.error}>
          The test notification could not be sent. Please try again later.
        </Text>
      )}
      {preferencesQuery.isLoading ? (
        <Text style={styles.copy}>Loading your notification settings…</Text>
      ) : preferencesQuery.isError || !preferences ? (
        <Text accessibilityRole="alert" style={styles.error}>Notification settings could not be loaded.</Text>
      ) : (
        <>
          <View style={styles.preferenceRow}>
            <View style={styles.preferenceCopy}>
              <Text style={styles.label}>Push notifications</Text>
              <Text style={styles.copy}>Trip offers and important trip updates</Text>
            </View>
            <Switch
              accessibilityLabel="Push notifications"
              disabled={update.isPending || !pushSupported}
              value={preferences.push_enabled}
              onValueChange={(value) => changePreference('push_enabled', value)}
              trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
            />
          </View>
          <View style={styles.preferenceRow}>
            <View style={styles.preferenceCopy}>
              <Text style={styles.label}>SMS updates</Text>
              <Text style={styles.copy}>Time-critical updates when available</Text>
            </View>
            <Switch
              accessibilityLabel="SMS updates"
              disabled={update.isPending}
              value={preferences.sms_enabled}
              onValueChange={(value) => changePreference('sms_enabled', value)}
              trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
            />
          </View>
          {permissionGranted === false && (
            <View style={styles.permissionNotice}>
              <Text style={styles.copy}>Push notifications are turned off in your device settings.</Text>
              <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()}>
                <Text style={styles.settingsLink}>Open device settings</Text>
              </Pressable>
            </View>
          )}
          {registrationError && (
            <View style={styles.permissionNotice}>
              <Text accessibilityRole="alert" style={styles.error}>{registrationError}</Text>
              <View style={styles.errorActions}>
                <Pressable accessibilityRole="button" onPress={() => void retryPushRegistration()}>
                  <Text style={styles.settingsLink}>Try again</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={dismissRegistrationError}>
                  <Text style={styles.settingsLink}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
          )}
          {update.isError && (
            <Text accessibilityRole="alert" style={styles.error}>Your notification preference could not be saved. Try again.</Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  title: { color: theme.colors.navy, fontSize: 17, fontWeight: '800' },
  statusLines: { gap: theme.spacing.xs },
  preferenceRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  preferenceCopy: { flex: 1, gap: 3 },
  label: { color: theme.colors.navy, fontSize: 14, fontWeight: '700' },
  copy: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
  permissionNotice: { gap: theme.spacing.xs, paddingTop: theme.spacing.sm },
  errorActions: { flexDirection: 'row', gap: theme.spacing.md },
  settingsLink: { color: theme.colors.primary, fontSize: 13, fontWeight: '700' },
  error: { color: theme.colors.error, fontSize: 13, lineHeight: 19 },
});
