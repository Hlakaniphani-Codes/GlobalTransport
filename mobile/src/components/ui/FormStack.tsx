import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

type FormStackProps = PropsWithChildren<{
  style?: ViewStyle;
  gap?: number;
}>;

export function FormStack({ children, style, gap = 16 }: FormStackProps) {
  return <View style={[styles.stack, { gap }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  stack: {
    width: '100%',
    flexDirection: 'column',
  },
});
