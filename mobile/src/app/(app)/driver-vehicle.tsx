import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { DriverVehicles } from '@/components/DriverVehicles';
import { DriverTabBar } from '@/components/DriverTabBar';
import { Screen } from '@/components/Screen';
import { theme } from '@/theme';

export default function DriverVehicleScreen() {
  const router = useRouter();
  return (
    <Screen bottomNavigation={<DriverTabBar />}>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/driver');
        }}
        style={styles.back}
      >
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>My vehicle</Text>
      <DriverVehicles />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 48, justifyContent: 'center' },
  backText: { color: theme.colors.primary, fontSize: 15, fontWeight: '700' },
  title: { color: theme.colors.navy, fontSize: 24, fontWeight: '800' },
});
