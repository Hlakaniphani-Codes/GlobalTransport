import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { AuthRequestError, useAuth } from '@/auth/AuthContext';
import { validateLogin, type FieldErrors } from '@/auth/validation';
import { AuthScreen } from '@/components/AuthScreen';
import { AuthError } from '@/components/AuthError';
import { AuthLink } from '@/components/AuthLink';
import { AppTextInput } from '@/components/AppTextInput';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

export default function LoginScreen() {
  const { login, restoreError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const validationErrors = validateLogin(email, password);
    setErrors(validationErrors);
    setServerError(null);
    if (Object.keys(validationErrors).length > 0) return;

    setSubmitting(true);
    try {
      await login({ email: email.trim().toLowerCase(), password: password.trim() });
    } catch (error) {
      if (error instanceof AuthRequestError) {
        const fieldErrors: FieldErrors = {};
        if (error.fields.email) fieldErrors.email = error.fields.email;
        if (error.fields.password) fieldErrors.password = error.fields.password;
        setErrors(fieldErrors);
        setServerError(Object.keys(error.fields).length === 0 ? error.message : null);
      } else {
        setServerError("We couldn't connect. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthScreen>
      <View style={styles.heading}>
        <Text style={styles.title}>Log in</Text>
      </View>

      <AuthError message={serverError ?? restoreError} />

      <View style={styles.form}>
        <AppTextInput
          label="Email"
          value={email}
          onChangeText={(value) => {
            setEmail(value);
            setErrors((current) => ({ ...current, email: undefined }));
            setServerError(null);
          }}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          keyboardAppearance="light"
          returnKeyType="next"
          error={errors.email}
        />
        <AppTextInput
          label="Password"
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setErrors((current) => ({ ...current, password: undefined }));
            setServerError(null);
          }}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="done"
          onSubmitEditing={() => void handleSubmit()}
          error={errors.password}
        />
        <PrimaryButton
          title="Log in to my account"
          loading={submitting}
          onPress={() => void handleSubmit()}
          style={styles.submitButton}
        />
      </View>

      <AuthLink prompt="" label="Create an account" href="/(auth)" />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  heading: {
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  title: {
    color: theme.colors.navy,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  form: {
    gap: theme.spacing.md,
  },
  submitButton: {
    minHeight: 60,
    borderRadius: 18,
    backgroundColor: theme.colors.navy,
  },
});
