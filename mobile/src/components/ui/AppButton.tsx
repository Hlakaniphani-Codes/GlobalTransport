import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { theme } from '@/theme';

export type AppButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

type AppButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: AppButtonVariant;
  loading?: boolean;
  leftIcon?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function AppButton({
  label,
  variant = 'primary',
  loading = false,
  disabled = false,
  leftIcon,
  style,
  ...pressableProps
}: AppButtonProps) {
  const unavailable = disabled || loading;

  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      accessibilityLabel={pressableProps.accessibilityLabel ?? label}
      accessibilityState={{ disabled: unavailable, busy: loading }}
      disabled={unavailable}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && !unavailable && variant === 'primary' && styles.pressed,
        unavailable && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? theme.colors.primary : theme.colors.white} />
      ) : (
        <View style={styles.content}>
          {leftIcon}
          <AppText singleLine style={[styles.label, styles[`${variant}Label`]]}>
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: '100%',
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
  },
  primary: { backgroundColor: theme.colors.primary },
  secondary: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  destructive: { backgroundColor: theme.colors.error },
  ghost: { backgroundColor: 'transparent' },
  content: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
  },
  label: {
    flexShrink: 1,
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  primaryLabel: { color: theme.colors.white },
  secondaryLabel: { color: theme.colors.primary },
  destructiveLabel: { color: theme.colors.white },
  ghostLabel: { color: theme.colors.primary },
  pressed: { backgroundColor: theme.colors.primaryDark },
  disabled: { opacity: 0.62 },
});
