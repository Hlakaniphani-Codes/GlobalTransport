import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <View accessibilityRole="alert" style={styles.container}>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: '#F2C6C2',
    borderRadius: theme.radius.sm,
    backgroundColor: '#FFF4F2',
  },
  message: {
    color: theme.colors.error,
    fontSize: 14,
    lineHeight: 20,
  },
});
