import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { theme } from '@/theme';

type ChipProps = PropsWithChildren<{
  label: string;
  style?: ViewStyle;
}>;

export function Chip({ label, style }: ChipProps) {
  return (
    <View style={[styles.chip, style]}>
      <AppText singleLine style={styles.label}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 32,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primaryLight,
  },
  label: {
    flexShrink: 0,
    color: theme.colors.primaryDark,
    fontSize: 12,
    fontWeight: '700',
  },
});
