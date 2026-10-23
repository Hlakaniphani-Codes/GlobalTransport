import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { AppText as Text } from '@/components/ui/AppText';
import { FormField } from '@/components/ui/FormField';
import { theme } from '@/theme';

type AppTextInputProps = Omit<TextInputProps, 'secureTextEntry'> & {
  label: string;
  error?: string;
  secureTextEntry?: boolean;
};

export function AppTextInput({
  label,
  error,
  secureTextEntry = false,
  style,
  onFocus,
  onBlur,
  ...inputProps
}: AppTextInputProps) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const isPassword = secureTextEntry;

  return (
    <FormField label={label} error={error}>
      <View>
        <View style={[styles.inputRow, focused && styles.inputFocused, error && styles.inputError]}>
          <TextInput
            accessibilityLabel={label}
            autoCapitalize={inputProps.autoCapitalize ?? (isPassword ? 'none' : 'sentences')}
            placeholderTextColor={theme.colors.textSecondary}
            secureTextEntry={isPassword && !passwordVisible}
            style={[styles.input, style]}
            onFocus={(event) => {
              setFocused(true);
              onFocus?.(event);
            }}
            onBlur={(event) => {
              setFocused(false);
              onBlur?.(event);
            }}
            {...inputProps}
          />
          {isPassword && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'}
              onPress={() => setPasswordVisible((visible) => !visible)}
              style={styles.toggle}
            >
              <Text singleLine style={styles.toggleText}>{passwordVisible ? 'Hide' : 'Show'}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </FormField>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 20,
    backgroundColor: theme.colors.white,
  },
  inputFocused: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.white,
  },
  inputError: {
    borderColor: theme.colors.error,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    color: theme.colors.text,
    paddingHorizontal: 18,
    fontSize: 14,
    fontFamily: 'Manrope_400Regular',
  },
  toggle: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontFamily: 'Manrope_700Bold',
    fontWeight: '600',
  },
  error: {
    minHeight: 15,
    color: theme.colors.error,
    fontSize: 11,
    fontFamily: 'Manrope_400Regular',
  },
});
