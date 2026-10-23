import { Image, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

export function AppHeader({ inverse = false }: { inverse?: boolean }) {
  return (
    <View style={styles.container}>
      <View style={[styles.logoFrame, inverse && styles.logoInverse]}>
        <Image
          accessibilityLabel="Global Ride Transport logo"
          source={require('../../assets/images/brand-icon.png')}
          resizeMethod="resize"
          style={styles.logo}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.name, inverse && styles.nameInverse]}>Global Ride</Text>
        <Text style={[styles.subtitle, inverse && styles.subtitleInverse]}>TRANSPORT</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  logoFrame: {
    width: 44,
    height: 44,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: theme.colors.white,
  },
  logo: {
    position: 'absolute',
    top: -22,
    left: -22,
    width: 88,
    height: 88,
    resizeMode: 'contain',
  },
  logoInverse: {
    backgroundColor: theme.colors.white,
  },
  copy: {
    gap: 2,
  },
  name: {
    color: theme.colors.navy,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  nameInverse: {
    color: theme.colors.white,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
  },
  subtitleInverse: {
    color: '#B9DDF2',
  },
});
