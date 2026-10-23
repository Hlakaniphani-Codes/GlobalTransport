import { forwardRef } from 'react';
import {
  StyleSheet,
  Text as NativeText,
  type TextProps,
  type TextStyle,
} from 'react-native';

export type AppTextVariant = 'title' | 'body' | 'label' | 'caption';

type AppTextProps = TextProps & {
  variant?: AppTextVariant;
  singleLine?: boolean;
};

function fontForWeight(weight: TextStyle['fontWeight']): string {
  if (weight === '800' || weight === '900' || weight === 'bold') return 'Manrope_800ExtraBold';
  if (weight === '700') return 'Manrope_700Bold';
  if (weight === '600') return 'Manrope_600SemiBold';
  if (weight === '500') return 'Manrope_500Medium';
  return 'Manrope_400Regular';
}

const variantStyles = StyleSheet.create({
  title: { fontFamily: 'Manrope_800ExtraBold', fontWeight: '800' },
  body: { fontFamily: 'Manrope_400Regular' },
  label: { fontFamily: 'Manrope_700Bold', fontWeight: '700' },
  caption: { fontFamily: 'Manrope_500Medium', fontWeight: '500' },
});

export const AppText = forwardRef<NativeText, AppTextProps>(function AppText(
  { style, variant = 'body', singleLine = false, ...props },
  ref
) {
  const resolvedStyle = StyleSheet.flatten(style);
  const fontFamily = resolvedStyle?.fontFamily ?? fontForWeight(resolvedStyle?.fontWeight);

  return (
    <NativeText
      ref={ref}
      {...props}
      maxFontSizeMultiplier={Math.min(props.maxFontSizeMultiplier ?? 1.3, 1.3)}
      numberOfLines={singleLine ? 1 : props.numberOfLines}
      adjustsFontSizeToFit={singleLine ? true : props.adjustsFontSizeToFit}
      minimumFontScale={singleLine ? 0.8 : props.minimumFontScale}
      ellipsizeMode={singleLine ? 'tail' : props.ellipsizeMode}
      style={[variantStyles[variant], { fontFamily }, style]}
    />
  );
});
