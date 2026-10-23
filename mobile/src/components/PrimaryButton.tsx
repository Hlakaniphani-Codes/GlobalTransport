import type { PressableProps, StyleProp, ViewStyle } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';

type PrimaryButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title: string;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: 'primary' | 'secondary';
};

export function PrimaryButton({
  title,
  variant = 'primary',
  ...props
}: PrimaryButtonProps) {
  return <AppButton {...props} label={title} variant={variant} />;
}
