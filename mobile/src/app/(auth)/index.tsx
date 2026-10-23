import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

import { AppText as Text } from '@/components/AppText';
import { AppHeader } from '@/components/AppHeader';
import { TransportIllustration } from '@/components/TransportIllustration';
import { theme } from '@/theme';

function DriverIcon() {
  return (
    <View style={styles.driverIcon}>
      <View style={styles.vehicleRoof} />
      <View style={styles.vehicleBody}>
        <View style={styles.vehicleWindow} />
      </View>
      <View style={[styles.vehicleWheel, styles.vehicleWheelLeft]} />
      <View style={[styles.vehicleWheel, styles.vehicleWheelRight]} />
    </View>
  );
}

function PassengerIcon() {
  return (
    <View style={styles.passengerIcon}>
      <View style={styles.personHead} />
      <View style={styles.personBody} />
    </View>
  );
}

function RoleCard({
  href,
  title,
  subtitle,
  badge,
  children,
}: {
  href: '/signup-driver' | '/signup-passenger';
  title: string;
  subtitle: string;
  badge: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="button" style={styles.roleCard}>
        <View style={styles.roleIcon}>{children}</View>
        <View style={styles.roleCopy}>
          <View style={styles.roleTitleRow}>
            <Text style={styles.roleTitle}>{title}</Text>
            <Text style={styles.roleBadge}>{badge}</Text>
          </View>
          <Text style={styles.roleDescription}>{subtitle}</Text>
        </View>
        <View style={styles.arrowCircle}>
          <Text style={styles.arrow}>›</Text>
        </View>
      </Pressable>
    </Link>
  );
}

export default function WelcomeScreen() {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <ScrollView
        bounces={false}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.heroHeader}>
            <AppHeader inverse />
          </View>
          <View style={styles.illustration}>
            <TransportIllustration />
          </View>
        </View>

        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeading}>
            <Text style={styles.sheetTitle}>Create your account</Text>
            <Text style={styles.sheetSubtitle}>How will you use Global Ride?</Text>
          </View>

          <View style={styles.roleChoices}>
            <RoleCard
              href="/signup-driver"
              title="I'm a Driver"
              subtitle="Manage trips and your profile"
              badge="DRIVE"
            >
              <DriverIcon />
            </RoleCard>
            <RoleCard
              href="/signup-passenger"
              title="I'm a Passenger"
              subtitle="Book and track work rides"
              badge="RIDE"
            >
              <PassengerIcon />
            </RoleCard>
          </View>

          <Link href="/login" asChild>
            <Pressable accessibilityRole="button" style={styles.loginButton}>
              <Text style={styles.loginButtonText}>Log in to my account</Text>
              <Text style={styles.loginArrow}>›</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.navy,
  },
  scrollContent: {
    flexGrow: 1,
    backgroundColor: theme.colors.background,
  },
  hero: {
    minHeight: 310,
    overflow: 'hidden',
    paddingTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 34,
    backgroundColor: theme.colors.navy,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  illustration: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: 188,
    opacity: 0.82,
  },
  sheet: {
    zIndex: 2,
    flexGrow: 1,
    gap: theme.spacing.lg,
    marginTop: -22,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xl,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    backgroundColor: '#F8FAFC',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 46,
    height: 5,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: '#D5E4EF',
  },
  sheetHeading: {
    gap: 5,
  },
  sheetTitle: {
    color: theme.colors.navy,
    fontSize: 26,
    lineHeight: 34,
    fontFamily: 'Manrope_800ExtraBold',
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  sheetSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: 'Manrope_400Regular',
  },
  roleChoices: {
    gap: theme.spacing.sm,
  },
  roleCard: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderWidth: 1,
    borderColor: '#DDE7EE',
    borderRadius: 22,
    backgroundColor: theme.colors.white,
    shadowColor: theme.colors.navy,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  roleIcon: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: '#E4F0F9',
  },
  driverIcon: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehicleRoof: {
    position: 'absolute',
    top: 7,
    width: 18,
    height: 8,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: theme.colors.primaryDark,
  },
  vehicleBody: {
    width: 28,
    height: 12,
    alignItems: 'center',
    justifyContent: 'flex-start',
    borderWidth: 2,
    borderRadius: 6,
    borderColor: theme.colors.primaryDark,
  },
  vehicleWindow: {
    width: 12,
    height: 4,
    marginTop: 1,
    borderRadius: 2,
    backgroundColor: '#8DBCE0',
  },
  vehicleWheel: {
    position: 'absolute',
    bottom: 4,
    width: 7,
    height: 7,
    borderWidth: 2,
    borderColor: theme.colors.primaryDark,
    borderRadius: 4,
    backgroundColor: theme.colors.white,
  },
  vehicleWheelLeft: { left: 4 },
  vehicleWheelRight: { right: 4 },
  passengerIcon: {
    width: 28,
    height: 30,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  personHead: {
    width: 11,
    height: 11,
    borderWidth: 2,
    borderColor: theme.colors.primaryDark,
    borderRadius: 6,
  },
  personBody: {
    width: 23,
    height: 12,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: theme.colors.primaryDark,
    borderTopLeftRadius: 13,
    borderTopRightRadius: 13,
  },
  roleCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  roleTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  roleTitle: {
    color: theme.colors.navy,
    fontSize: 15,
    fontFamily: 'Manrope_700Bold',
    fontWeight: '700',
    letterSpacing: -0.25,
  },
  roleBadge: {
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
    backgroundColor: '#E5F2FB',
    color: theme.colors.primaryDark,
    fontSize: 9,
    fontFamily: 'Manrope_700Bold',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  roleDescription: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
    fontFamily: 'Manrope_400Regular',
  },
  arrowCircle: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: '#EDF3F7',
  },
  arrow: {
    marginTop: -2,
    color: theme.colors.navy,
    fontSize: 25,
    lineHeight: 30,
    fontFamily: 'Manrope_500Medium',
  },
  loginButton: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: 19,
    backgroundColor: theme.colors.navy,
  },
  loginButtonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontFamily: 'Manrope_700Bold',
    fontWeight: '700',
  },
  loginArrow: {
    marginTop: -2,
    color: '#B9DDF2',
    fontSize: 22,
    fontFamily: 'Manrope_600SemiBold',
  },
});
