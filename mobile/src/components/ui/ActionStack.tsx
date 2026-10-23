import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

type ActionStackProps = PropsWithChildren<{
  sticky?: boolean;
  style?: ViewStyle;
}>;

export function ActionStack({ children, sticky = false, style }: ActionStackProps) {
  return (
    <View style={[styles.stack, sticky && styles.sticky, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    width: '100%',
    flexDirection: 'column',
    gap: 12,
  },
  sticky: {
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
});
