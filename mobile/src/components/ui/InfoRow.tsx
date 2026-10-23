import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { Chip } from '@/components/ui/Chip';

type InfoRowProps = {
  icon?: ReactNode;
  text: string;
  trailingChip?: string;
  style?: ViewStyle;
};

export function InfoRow({ icon, text, trailingChip, style }: InfoRowProps) {
  return (
    <View style={[styles.row, style]}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <AppText style={styles.text}>{text}</AppText>
      {trailingChip ? <Chip label={trailingChip} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: { flexShrink: 0 },
  text: { flex: 1, minWidth: 0 },
});
