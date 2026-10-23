import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { theme } from '@/theme';

type FormFieldProps = {
  label: string;
  children: ReactNode;
  helper?: string;
  error?: string;
};

export function FormField({ label, children, helper, error }: FormFieldProps) {
  return (
    <View style={styles.container}>
      <AppText variant="label" singleLine style={styles.label}>{label}</AppText>
      {children}
      {error ? (
        <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>
      ) : helper ? (
        <AppText style={styles.helper}>{helper}</AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.navy,
    fontSize: 14,
  },
  error: {
    color: theme.colors.error,
    fontSize: 12,
  },
  helper: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
});
