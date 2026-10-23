import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

const tabs = [
  { label: 'Home', route: '/passenger', icon: 'home' },
  { label: 'Request', route: '/passenger-request', icon: 'request' },
  { label: 'Rides', route: '/passenger-requests', icon: 'rides' },
  { label: 'History', route: '/passenger-history', icon: 'history' },
  { label: 'Account', route: '/passenger-account', icon: 'account' },
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
      {name === 'request' && (
        <View style={styles.requestIcon}>
          <View style={styles.requestVertical} />
          <View style={styles.requestHorizontal} />
        </View>
      )}
      {name === 'rides' && (
        <View style={styles.ridesIcon}>
          <View style={styles.ridesLineTop} />
          <View style={styles.ridesLineMiddle} />
          <View style={styles.ridesLineBottom} />
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

export function PassengerTabBar() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <View accessibilityRole="tablist" style={styles.bar}>
      {tabs.map((tab) => {
        const selected = pathname === tab.route
          || (tab.route === '/passenger-account' && pathname === '/account');
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
            <Text numberOfLines={1} style={[styles.label, selected && styles.labelActive]}>
              {tab.label}
            </Text>
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
    paddingHorizontal: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  icon: {
    width: 40,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    opacity: 0.72,
  },
  iconActive: { backgroundColor: theme.colors.primaryLight, opacity: 1 },
  label: { color: theme.colors.textSecondary, fontSize: 10, fontWeight: '600' },
  labelActive: { color: theme.colors.primary, fontWeight: '800' },
  homeIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end' },
  homeRoofLeft: {
    position: 'absolute', top: 3, left: 3, width: 12, height: 2, borderRadius: 1,
    backgroundColor: theme.colors.navy, transform: [{ rotate: '-42deg' }],
  },
  homeRoofRight: {
    position: 'absolute', top: 3, right: 3, width: 12, height: 2, borderRadius: 1,
    backgroundColor: theme.colors.navy, transform: [{ rotate: '42deg' }],
  },
  homeBody: {
    width: 16, height: 12, borderWidth: 2, borderTopWidth: 0, borderColor: theme.colors.navy,
    alignItems: 'center', justifyContent: 'flex-end',
  },
  homeDoor: { width: 4, height: 7, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: theme.colors.navy },
  requestIcon: {
    width: 20, height: 20, borderWidth: 2, borderColor: theme.colors.navy, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  requestVertical: { position: 'absolute', width: 2, height: 10, borderRadius: 1, backgroundColor: theme.colors.navy },
  requestHorizontal: { position: 'absolute', width: 10, height: 2, borderRadius: 1, backgroundColor: theme.colors.navy },
  ridesIcon: {
    width: 21, height: 19, borderWidth: 2, borderColor: theme.colors.navy, borderRadius: 4,
    justifyContent: 'space-evenly', paddingHorizontal: 4,
  },
  ridesLineTop: { height: 2, borderRadius: 1, backgroundColor: theme.colors.navy },
  ridesLineMiddle: { height: 2, width: 10, borderRadius: 1, backgroundColor: theme.colors.navy },
  ridesLineBottom: { height: 2, width: 7, borderRadius: 1, backgroundColor: theme.colors.navy },
  historyIcon: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: theme.colors.navy },
  historyHandLong: { position: 'absolute', top: 3, left: 8, width: 2, height: 7, borderRadius: 1, backgroundColor: theme.colors.navy },
  historyHandShort: { position: 'absolute', top: 8, left: 9, width: 5, height: 2, borderRadius: 1, backgroundColor: theme.colors.navy, transform: [{ rotate: '25deg' }] },
  accountIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  accountHead: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: theme.colors.navy },
  accountShoulders: { width: 18, height: 9, borderWidth: 2, borderBottomWidth: 0, borderColor: theme.colors.navy, borderTopLeftRadius: 10, borderTopRightRadius: 10 },
});
