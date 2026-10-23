import { isAxiosError } from 'axios';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText as Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { api } from '@/api';
import { AppTextInput } from '@/components/AppTextInput';
import { DriverTabBar } from '@/components/DriverTabBar';
import { PassengerTabBar } from '@/components/PassengerTabBar';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { theme } from '@/theme';

type ApiError = { error?: { message?: string } };

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { logout, user } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function returnToAccount() {
    if (router.canGoBack()) router.back();
    else router.replace('/account');
  }

  function confirmDeletion() {
    if (!password) {
      setError('Enter your password to continue.');
      return;
    }
    Alert.alert(
      'Delete account?',
      'This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => { void deleteAccount(); } },
      ]
    );
  }

  async function deleteAccount() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/delete-account', { current_password: password });
      try {
        await logout();
      } finally {
        router.replace('/login');
      }
    } catch (requestError) {
      setError(isAxiosError<ApiError>(requestError)
        ? requestError.response?.data?.error?.message ?? 'Unable to connect. Please try again.'
        : 'Unable to connect. Please try again.');
      setBusy(false);
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
      <Pressable accessibilityRole="button" onPress={returnToAccount} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Delete account</Text>
      <Text style={styles.copy}>
        Your personal and location details will be removed. Trip and booking records will be kept for accounting.
      </Text>
      <AppTextInput
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="done"
      />
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <PrimaryButton title="Delete account" loading={busy} onPress={confirmDeletion} />
      <PrimaryButton title="Cancel" variant="secondary" onPress={returnToAccount} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 48, justifyContent: 'center' },
  backText: { color: theme.colors.primary, fontSize: 15, fontWeight: '700' },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
  copy: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 23 },
  error: { color: theme.colors.error, fontSize: 13 },
});
