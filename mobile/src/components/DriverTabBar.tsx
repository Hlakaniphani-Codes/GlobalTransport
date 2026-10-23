import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

const tabs = [
  { label: 'Today', route: '/driver', icon: 'home' },
  { label: 'Vehicle', route: '/driver-vehicle', icon: 'vehicle' },
  { label: 'History', route: '/driver-history', icon: 'history' },
  { label: 'Account', route: '/account', icon: 'account' },
] as const;

type TabIconName = typeof tabs[number]['icon'];

function TabIcon({ name, active }: { name: TabIconName; active: boolean }) {
  return (
    <View style={[styles.icon, active && styles.iconActive]}>
      {name === 'home' && (
        <View style={styles.homeIcon}>
          <View style={styles.homeRoofLeft} />
          <View style={styles.homeRoofRight} />
          <View style={styles.homeBody}>
            <View style={styles.homeDoor} />
          </View>
        </View>
      )}
      {name === 'vehicle' && (
        <View style={styles.carIcon}>
          <View style={styles.carWindow} />
          <View style={styles.carBody} />
          <View style={styles.carWheelLeft} />
          <View style={styles.carWheelRight} />
        </View>
      )}
      {name === 'history' && (
        <View style={styles.historyIcon}>
          <View style={styles.historyHandLong} />
          <View style={styles.historyHandShort} />
        </View>
      )}
      {name === 'account' && (
        <View style={styles.accountIcon}>
          <View style={styles.accountHead} />
          <View style={styles.accountShoulders} />
        </View>
      )}
    </View>
  );
}

export function DriverTabBar() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <View accessibilityRole="tablist" style={styles.bar}>
      {tabs.map((tab) => {
        const selected = pathname === tab.route
          || (tab.route === '/account' && pathname === '/driver-account');
        return (
          <Pressable
            key={tab.route}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            onPress={() => router.replace(tab.route)}
            style={styles.tab}
          >
            <TabIcon name={tab.icon} active={selected} />
            <Text singleLine style={[styles.label, selected && styles.labelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    minHeight: 74,
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  tab: {
    flex: 1,
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  icon: {
    width: 44,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    opacity: 0.72,
  },
  iconActive: { backgroundColor: theme.colors.primaryLight, opacity: 1 },
  label: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' },
  labelActive: { color: theme.colors.primary, fontWeight: '800' },
  homeIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end' },
  homeRoofLeft: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.navy,
    transform: [{ rotate: '-42deg' }],
  },
  homeRoofRight: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.navy,
    transform: [{ rotate: '42deg' }],
  },
  homeBody: {
    width: 16,
    height: 12,
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: theme.colors.navy,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  homeDoor: { width: 4, height: 7, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: theme.colors.navy },
  carIcon: { width: 23, height: 19, justifyContent: 'flex-end', alignItems: 'center' },
  carWindow: {
    width: 13,
    height: 6,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: theme.colors.navy,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
  },
  carBody: { width: 22, height: 7, borderRadius: 3, backgroundColor: theme.colors.navy },
  carWheelLeft: { position: 'absolute', bottom: 0, left: 3, width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.white, borderWidth: 1.5, borderColor: theme.colors.navy },
  carWheelRight: { position: 'absolute', bottom: 0, right: 3, width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.white, borderWidth: 1.5, borderColor: theme.colors.navy },
  historyIcon: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: theme.colors.navy },
  historyHandLong: { position: 'absolute', top: 3, left: 8, width: 2, height: 7, borderRadius: 1, backgroundColor: theme.colors.navy },
  historyHandShort: { position: 'absolute', top: 8, left: 9, width: 5, height: 2, borderRadius: 1, backgroundColor: theme.colors.navy, transform: [{ rotate: '25deg' }] },
  accountIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  accountHead: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: theme.colors.navy },
  accountShoulders: { width: 18, height: 9, borderWidth: 2, borderBottomWidth: 0, borderColor: theme.colors.navy, borderTopLeftRadius: 10, borderTopRightRadius: 10 },
});
