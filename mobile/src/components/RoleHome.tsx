import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import type { ReactNode } from 'react';

import { useAuth } from '@/auth/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TransportIllustration } from '@/components/TransportIllustration';
import { theme } from '@/theme';

type RoleHomeProps = {
  title: string;
  showDriverStatus?: boolean;
  showPassengerMessage?: boolean;
  children?: ReactNode;
};

export function RoleHome({
  title,
  showDriverStatus = false,
  showPassengerMessage = false,
  children,
}: RoleHomeProps) {
  const { user, logout } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setError(null);
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      setError('Unable to clear your saved session. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <Screen card>
      <AppHeader />
      <TransportIllustration />
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>{title.toUpperCase()}</Text>
        <Text style={styles.heading}>Good to have you here, {user?.name ?? 'there'}.</Text>
        {showDriverStatus && user?.status === 'pending' && (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>Application in review</Text>
            <Text style={styles.bannerText}>
              Your driver account is awaiting approval by Global Ride Transport.
            </Text>
          </View>
        )}
        {showDriverStatus && user?.status === 'approved' && (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>Driver account approved</Text>
            <Text style={styles.bannerText}>
              Add your vehicle details below so they can be reviewed.
            </Text>
          </View>
        )}
        {showDriverStatus && user?.status === 'rejected' && (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>Application needs attention</Text>
            <Text style={styles.bannerText}>
              Your driver application was not approved. Please contact Global Ride Transport.
            </Text>
          </View>
        )}
        {showPassengerMessage && (
          <Text style={styles.body}>Your next journey starts with Global Ride.</Text>
        )}
        {children}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
      <PrimaryButton title="Log out" loading={loggingOut} onPress={handleLogout} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  copy: {
    gap: theme.spacing.sm,
  },
  eyebrow: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  heading: {
    color: theme.colors.navy,
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  body: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  banner: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryLight,
  },
  bannerTitle: {
    marginBottom: theme.spacing.xs,
    color: theme.colors.primaryDark,
    fontSize: 14,
    fontWeight: '800',
  },
  bannerText: {
    color: theme.colors.navySoft,
    fontSize: 13,
    lineHeight: 20,
  },
  error: {
    color: theme.colors.error,
    fontSize: 14,
  },
});
