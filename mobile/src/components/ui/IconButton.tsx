import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { theme } from '@/theme';

type IconButtonProps = Omit<PressableProps, 'children' | 'accessibilityLabel' | 'style'> & {
  label: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({ label, children, style, ...props }: IconButtonProps) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, style]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 48,
    height: 48,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: theme.colors.primaryLight,
  },
  pressed: { opacity: 0.75 },
});
