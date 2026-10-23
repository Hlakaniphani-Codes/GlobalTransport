import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Switch, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { AuthRequestError, useAuth, type UserRole } from '@/auth/AuthContext';
import {
  normalizeSouthAfricanPhone,
  validateRegistration,
  type AuthFieldName,
  type FieldErrors,
} from '@/auth/validation';
import { AuthScreen } from '@/components/AuthScreen';
import { AuthError } from '@/components/AuthError';
import { AuthLink } from '@/components/AuthLink';
import { AppTextInput } from '@/components/AppTextInput';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

type SignupRole = Extract<UserRole, 'driver' | 'passenger'>;

function getLegalBaseUrl(): string | undefined {
  const configuredUrl = process.env.EXPO_PUBLIC_LEGAL_BASE_URL?.trim().replace(/\/+$/, '');
  if (configuredUrl) return configuredUrl;
  if (!__DEV__) return undefined;

  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!apiUrl) return undefined;

  try {
    const localAdminUrl = new URL(apiUrl);
    localAdminUrl.port = '5173';
    localAdminUrl.pathname = '';
    localAdminUrl.search = '';
    localAdminUrl.hash = '';
    return localAdminUrl.origin;
  } catch {
    return undefined;
  }
}

const legalBaseUrl = getLegalBaseUrl();

type SignupValues = Record<AuthFieldName, string>;

const initialValues: SignupValues = {
  name: '',
  surname: '',
  address: '',
  home_suburb: '',
  workplace_suburb: '',
  contact_number: '',
  email: '',
  id_number: '',
  employee_number: '',
  workplace: '',
  password: '',
  confirm_password: '',
};

function StepCard({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.stepCard}>
      <View style={styles.stepHeading}>
        <Text style={styles.stepNumber}>{step.padStart(2, '0')}</Text>
        <View style={styles.stepCopy}>
          <Text style={styles.stepTitle}>{title}</Text>
        </View>
      </View>
      <View style={styles.sectionFields}>{children}</View>
    </View>
  );
}

const knownFields = new Set<AuthFieldName>([
  'name',
  'surname',
  'address',
  'home_suburb',
  'workplace_suburb',
  'contact_number',
  'email',
  'id_number',
  'employee_number',
  'workplace',
  'password',
  'confirm_password',
]);

function knownFieldErrors(fields: Record<string, string>): FieldErrors {
  const result: FieldErrors = {};
  for (const [field, message] of Object.entries(fields)) {
    if (knownFields.has(field as AuthFieldName)) {
      result[field as AuthFieldName] = message;
    }
  }
  return result;
}

export function SignupScreen({ role }: { role: SignupRole }) {
  const isDriver = role === 'driver';
  const { register } = useAuth();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  async function openLegalPage(page: 'terms' | 'privacy') {
    if (!legalBaseUrl) return;
    try {
      await Linking.openURL(`${legalBaseUrl}/${page}`);
    } catch {
      setServerError('Unable to open this page. Please try again.');
    }
  }

  function updateValue(field: AuthFieldName, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setServerError(null);
  }

  async function handleSubmit() {
    if (!legalBaseUrl) {
      setServerError('Terms and privacy information is not available. Please try again later.');
      return;
    }
    if (!termsAccepted) {
      setServerError('Please accept the terms and privacy policy to continue.');
      return;
    }
    const validationErrors = validateRegistration(role, values);
    setErrors(validationErrors);
    setServerError(null);
    if (Object.keys(validationErrors).length > 0) return;

    setSubmitting(true);
    try {
      const shared = {
        name: values.name.trim(),
        surname: values.surname.trim(),
        address: values.address.trim(),
        contact_number: normalizeSouthAfricanPhone(values.contact_number),
        email: values.email.trim().toLowerCase(),
        password: values.password.trim(),
        terms_accepted: true as const,
      };

      if (isDriver) {
        await register('driver', {
          ...shared,
          id_number: values.id_number.trim(),
        });
      } else {
        await register('passenger', {
          ...shared,
          home_suburb: values.home_suburb.trim(),
          workplace_suburb: values.workplace_suburb.trim(),
          employee_number: values.employee_number.trim(),
          workplace: values.workplace.trim(),
        });
      }
    } catch (error) {
      if (error instanceof AuthRequestError) {
        setErrors(knownFieldErrors(error.fields));
        setServerError(
          Object.keys(error.fields).length === 0 ? error.message : null
        );
      } else {
        setServerError('Unable to create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthScreen>
      <AuthError message={serverError} />

      <View style={styles.pageHeading}>
        <Text style={styles.pageEyebrow}>{isDriver ? 'DRIVER' : 'PASSENGER'}</Text>
        <Text style={styles.pageTitle}>Create your account</Text>
      </View>

      <View style={styles.form}>
        <StepCard step="1" title="Personal details">
          <View style={styles.nameRow}>
            <View style={styles.nameField}>
              <AppTextInput
                label="Name"
                value={values.name}
                onChangeText={(value) => updateValue('name', value)}
                autoComplete="name-given"
                textContentType="givenName"
                returnKeyType="next"
                error={errors.name}
              />
            </View>
            <View style={styles.nameField}>
              <AppTextInput
                label="Surname"
                value={values.surname}
                onChangeText={(value) => updateValue('surname', value)}
                autoComplete="name-family"
                textContentType="familyName"
                returnKeyType="next"
                error={errors.surname}
              />
            </View>
          </View>
          <View style={styles.fullWidthField}>
            <AppTextInput
              label={isDriver ? 'Address' : 'Home address'}
              value={values.address}
              onChangeText={(value) => updateValue('address', value)}
              autoComplete="street-address"
              textContentType="fullStreetAddress"
              returnKeyType="next"
              error={errors.address}
            />
          </View>
          {!isDriver && (
            <View style={styles.fullWidthField}>
              <AppTextInput
                label="Home suburb"
                value={values.home_suburb}
                onChangeText={(value) => updateValue('home_suburb', value)}
                returnKeyType="next"
                error={errors.home_suburb}
              />
            </View>
          )}
        </StepCard>

        <StepCard step="2" title="Contact">
          <View style={styles.fullWidthField}>
            <AppTextInput
              label="Contact number"
              value={values.contact_number}
              onChangeText={(value) => updateValue('contact_number', value)}
              placeholder="+27 82 123 4567"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="next"
              error={errors.contact_number}
            />
          </View>
          <View style={styles.fullWidthField}>
            <AppTextInput
              label="Email address"
              value={values.email}
              onChangeText={(value) => updateValue('email', value)}
              placeholder="you@company.co.za"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardAppearance="light"
              returnKeyType="next"
              error={errors.email}
            />
          </View>
        </StepCard>

        <StepCard step="3" title={isDriver ? 'Driver verification' : 'Work details'}>
          {isDriver ? (
            <View style={styles.fullWidthField}>
              <AppTextInput
                label="South African ID number"
                value={values.id_number}
                onChangeText={(value) => updateValue('id_number', value)}
                placeholder="13 digits"
                keyboardType="number-pad"
                autoCapitalize="none"
                maxLength={13}
                returnKeyType="next"
                error={errors.id_number}
              />
            </View>
          ) : (
            <>
              <View style={styles.fullWidthField}>
                <AppTextInput
                  label="Company name"
                  value={values.workplace}
                  onChangeText={(value) => updateValue('workplace', value)}
                  placeholder="Company or office name"
                  autoCapitalize="words"
                  maxLength={160}
                  returnKeyType="next"
                  error={errors.workplace}
                />
              </View>
              <View style={styles.fullWidthField}>
                <AppTextInput
                  label="Employee number"
                  value={values.employee_number}
                  onChangeText={(value) => updateValue('employee_number', value)}
                  autoCapitalize="characters"
                  returnKeyType="next"
                  error={errors.employee_number}
                />
              </View>
              <View style={styles.fullWidthField}>
                <AppTextInput
                  label="Workplace suburb"
                  value={values.workplace_suburb}
                  onChangeText={(value) => updateValue('workplace_suburb', value)}
                  autoCapitalize="words"
                  returnKeyType="next"
                  error={errors.workplace_suburb}
                />
              </View>
            </>
          )}
        </StepCard>

        <StepCard step="4" title="Security">
          <View style={styles.fullWidthField}>
            <AppTextInput
              label="Password"
              value={values.password}
              onChangeText={(value) => updateValue('password', value)}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="next"
              error={errors.password}
            />
          </View>
          <View style={styles.fullWidthField}>
            <AppTextInput
              label="Confirm password"
              value={values.confirm_password}
              onChangeText={(value) => updateValue('confirm_password', value)}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="done"
              onSubmitEditing={() => void handleSubmit()}
              error={errors.confirm_password}
            />
          </View>
          <Text style={styles.passwordHint}>Use at least 8 characters for your password.</Text>
        </StepCard>

        <View style={styles.consent}>
          <View style={styles.consentRow}>
            <Switch
              accessibilityLabel="Accept terms and privacy policy"
              value={termsAccepted}
              onValueChange={setTermsAccepted}
              trackColor={{ true: theme.colors.primary }}
            />
            <Text style={styles.consentText}>I agree to the terms and privacy policy.</Text>
          </View>
          <View style={styles.legalLinks}>
            <Pressable
              accessibilityRole="link"
              disabled={!legalBaseUrl}
              onPress={() => void openLegalPage('terms')}
              style={styles.legalLink}
            >
              <Text style={styles.linkText}>Terms</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              disabled={!legalBaseUrl}
              onPress={() => void openLegalPage('privacy')}
              style={styles.legalLink}
            >
              <Text style={styles.linkText}>Privacy policy</Text>
            </Pressable>
          </View>
        </View>

        <PrimaryButton
          title="Create account"
          loading={submitting}
          onPress={() => void handleSubmit()}
          style={styles.submitButton}
        />
      </View>

      <AuthLink prompt="Already have an account?" label="Log in" href="/login" />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  pageHeading: {
    gap: theme.spacing.xs,
  },
  pageEyebrow: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  pageTitle: {
    color: theme.colors.navy,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  form: {
    gap: theme.spacing.md,
  },
  stepCard: {
    gap: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  stepHeading: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  stepNumber: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  stepCopy: {
    gap: 1,
  },
  stepTitle: {
    color: theme.colors.navy,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
  },
  sectionFields: {
    gap: theme.spacing.md,
  },
  nameRow: {
    flexDirection: 'column',
    gap: theme.spacing.md,
  },
  nameField: {
    flex: 1,
    minWidth: 0,
  },
  fullWidthField: {
    width: '100%',
  },
  passwordHint: {
    marginTop: theme.spacing.xs,
    color: theme.colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
  },
  consent: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  consentRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  consentText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 12,
    lineHeight: 18,
  },
  legalLinks: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  legalLink: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xs,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  submitButton: {
    minHeight: 60,
    borderRadius: 18,
    backgroundColor: theme.colors.navy,
  },
});
