import { isAxiosError } from 'axios';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText as Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { AppTextInput } from '@/components/AppTextInput';
import { PrimaryButton } from '@/components/PrimaryButton';
import { NotificationSettings } from '@/components/NotificationSettings';
import { DriverTabBar } from '@/components/DriverTabBar';
import { PassengerTabBar } from '@/components/PassengerTabBar';
import { Screen } from '@/components/Screen';
import { api } from '@/api';
import { theme } from '@/theme';

type ApiError = { error?: { message?: string } };

export default function AccountScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function changePassword() {
    setError(null);
    setSuccess(null);
    if (!currentPassword || newPassword.length < 8) {
      setError('Enter your current password and a new password of at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Password updated.');
    } catch (requestError) {
      setError(isAxiosError<ApiError>(requestError)
        ? requestError.response?.data?.error?.message ?? 'Unable to connect. Please try again.'
        : 'Unable to connect. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    let warning = false;
    try {
      await logout();
    } catch {
      warning = true;
    }
    router.replace('/login');
    if (warning) {
      Alert.alert(
        'Signed out',
        'This device could not be removed from notifications. Check your connection and contact support if alerts continue.'
      );
    }
  }

  return (
    <Screen
      bottomNavigation={
        user?.role === 'driver'
          ? <DriverTabBar />
          : user?.role === 'passenger'
            ? <PassengerTabBar />
            : undefined
      }
    >
      {user?.role !== 'passenger' && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace(user?.role === 'driver' ? '/driver' : '/passenger');
          }}
          style={styles.back}
        >
          <Text singleLine style={styles.backText}>‹ Back</Text>
        </Pressable>
      )}
      <Text style={styles.title}>Account</Text>
      <View style={styles.profileCard}>
        <Text style={styles.profileName}>{user?.name} {user?.surname}</Text>
        <Text style={styles.profileDetail}>{user?.email}</Text>
        <Text style={styles.profileDetail}>{user?.contact_number}</Text>
      </View>
      <NotificationSettings />
      <View style={styles.passwordCard}>
        <Text style={styles.sectionTitle}>Change password</Text>
        <AppTextInput
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="next"
        />
        <AppTextInput
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="next"
        />
        <AppTextInput
          label="Confirm new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="done"
        />
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {success && <Text style={styles.success}>{success}</Text>}
        <PrimaryButton title="Update password" loading={busy} onPress={() => void changePassword()} />
      </View>
      <PrimaryButton
        title="Delete account"
        variant="secondary"
        onPress={() => router.push('/delete-account')}
      />
      <PrimaryButton
        title="Log out"
        variant="secondary"
        onPress={() => void handleLogout()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 48, justifyContent: 'center' },
  backText: { color: theme.colors.primary, fontSize: 15, fontWeight: '700' },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
  profileCard: { gap: theme.spacing.xs, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.white, borderWidth: 1, borderColor: theme.colors.border },
  profileName: { color: theme.colors.navy, fontSize: 18, fontWeight: '800' },
  profileDetail: { color: theme.colors.textSecondary, fontSize: 13 },
  passwordCard: { gap: theme.spacing.md, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.white, borderWidth: 1, borderColor: theme.colors.border },
  sectionTitle: { color: theme.colors.navy, fontSize: 17, fontWeight: '800' },
  error: { color: theme.colors.error, fontSize: 13 },
  success: { color: theme.colors.success, fontSize: 13 },
});
