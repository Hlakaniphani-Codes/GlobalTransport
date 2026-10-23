import { isAxiosError } from 'axios';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { api, apiGetAllPages } from '@/api';
import { AppTextInput } from '@/components/AppTextInput';
import { AuthError } from '@/components/AuthError';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

type Company = {
  id: string;
  name: string;
  is_active: boolean;
};

type Workplace = {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  address: string;
  suburb: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
};

function getErrorMessage(error: unknown) {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

export function AdminOperations() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [workplaceName, setWorkplaceName] = useState('');
  const [workplaceAddress, setWorkplaceAddress] = useState('');
  const [workplaceSuburb, setWorkplaceSuburb] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activeUpdate, setActiveUpdate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGetAllPages<Company>('/admin/companies', 'companies'),
      apiGetAllPages<Workplace>('/admin/workplaces', 'workplaces'),
    ])
      .then(([allCompanies, allWorkplaces]) => {
        if (active) {
          setCompanies(allCompanies);
          setWorkplaces(allWorkplaces);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createCompany() {
    if (companyName.trim().length < 2) {
      setError('Enter a company name with at least two characters.');
      return;
    }
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const response = await api.post<{ company: Company }>('/admin/companies', {
        name: companyName.trim(),
      });
      setCompanies((current) => [...current, response.data.company]);
      setCompanyId(response.data.company.id);
      setCompanyName('');
      setSuccess('Company added.');
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  }

  async function createWorkplace() {
    if (
      !companyId ||
      workplaceName.trim().length < 2 ||
      workplaceAddress.trim().length < 5 ||
      workplaceSuburb.trim().length < 2
    ) {
      setError('Choose a company and enter a workplace name, address and suburb.');
      return;
    }
    const latitudeValue = latitude.trim() ? Number(latitude) : null;
    const longitudeValue = longitude.trim() ? Number(longitude) : null;
    if (
      (latitudeValue === null) !== (longitudeValue === null) ||
      (latitudeValue !== null &&
        (!Number.isFinite(latitudeValue) || latitudeValue < -90 || latitudeValue > 90)) ||
      (longitudeValue !== null &&
        (!Number.isFinite(longitudeValue) || longitudeValue < -180 || longitudeValue > 180))
    ) {
      setError('Enter valid latitude and longitude together, or leave both blank for now.');
      return;
    }

    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const response = await api.post<{ workplace: Workplace }>('/admin/workplaces', {
        company_id: companyId,
        name: workplaceName.trim(),
        address: workplaceAddress.trim(),
        suburb: workplaceSuburb.trim(),
        latitude: latitudeValue,
        longitude: longitudeValue,
      });
      const selectedCompany = companies.find((item) => item.id === companyId);
      setWorkplaces((current) => [
        {
          ...response.data.workplace,
          company_name: selectedCompany?.name ?? '',
        },
        ...current,
      ]);
      setWorkplaceName('');
      setWorkplaceAddress('');
      setWorkplaceSuburb('');
      setLatitude('');
      setLongitude('');
      setSuccess('Workplace added and is available for passenger signup.');
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeActive(
    kind: 'companies' | 'workplaces',
    id: string,
    isActive: boolean
  ) {
    const key = `${kind}:${id}`;
    setActiveUpdate(key);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.patch<{ company?: Company; workplace?: Workplace }>(
        `/admin/${kind}/${id}/active`,
        { is_active: isActive }
      );
      if (kind === 'companies' && response.data.company) {
        setCompanies((current) =>
          current.map((company) =>
            company.id === id ? { ...company, is_active: isActive } : company
          )
        );
      }
      if (kind === 'workplaces' && response.data.workplace) {
        setWorkplaces((current) =>
          current.map((workplace) =>
            workplace.id === id ? { ...workplace, is_active: isActive } : workplace
          )
        );
      }
      setSuccess(`${kind === 'companies' ? 'Company' : 'Workplace'} ${isActive ? 'enabled' : 'disabled'}.`);
    } catch (updateError) {
      setError(getErrorMessage(updateError));
    } finally {
      setActiveUpdate(null);
    }
  }

  const activeCompanies = companies.filter((company) => company.is_active);

  return (
    <View style={styles.container}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Companies & workplaces</Text>
        <Text style={styles.helper}>
          Add company sites. Coordinates are optional until address search is configured.
        </Text>
      </View>
      {error && <AuthError message={error} />}
      {success && <Text style={styles.success}>{success}</Text>}
      {loading ? (
        <Text style={styles.helper}>Loading company records…</Text>
      ) : (
        <>
          <View style={styles.form}>
            <Text style={styles.formTitle}>Add a company</Text>
            <AppTextInput
              label="Company name"
              value={companyName}
              onChangeText={(value) => setCompanyName(value)}
              placeholder="Company name"
              returnKeyType="done"
            />
            <PrimaryButton
              title="Add company"
              loading={submitting}
              onPress={() => void createCompany()}
            />
          </View>

          <View style={styles.form}>
            <Text style={styles.formTitle}>Add a workplace site</Text>
            {activeCompanies.length === 0 ? (
              <Text style={styles.helper}>Add and enable a company before adding a workplace.</Text>
            ) : (
              <>
                <Text style={styles.label}>Company</Text>
                <View style={styles.companyOptions}>
                  {activeCompanies.map((company) => (
                    <Pressable
                      key={company.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: companyId === company.id }}
                      onPress={() => setCompanyId(company.id)}
                      style={[
                        styles.companyOption,
                        company.id === companyId && styles.companySelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.companyOptionText,
                          company.id === companyId && styles.companySelectedText,
                        ]}
                      >
                        {company.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <AppTextInput
                  label="Workplace/site name"
                  value={workplaceName}
                  onChangeText={setWorkplaceName}
                  placeholder="Sandton office"
                  returnKeyType="next"
                />
                <AppTextInput
                  label="Workplace address"
                  value={workplaceAddress}
                  onChangeText={setWorkplaceAddress}
                  placeholder="Street address"
                  returnKeyType="next"
                />
                <AppTextInput
                  label="Suburb"
                  value={workplaceSuburb}
                  onChangeText={setWorkplaceSuburb}
                  placeholder="Sandton"
                  returnKeyType="next"
                />
                <View style={styles.coordinateRow}>
                  <View style={styles.coordinateField}>
                    <AppTextInput
                      label="Latitude (optional)"
                      value={latitude}
                      onChangeText={setLatitude}
                      keyboardType="numbers-and-punctuation"
                      placeholder="-26.1076"
                    />
                  </View>
                  <View style={styles.coordinateField}>
                    <AppTextInput
                      label="Longitude (optional)"
                      value={longitude}
                      onChangeText={setLongitude}
                      keyboardType="numbers-and-punctuation"
                      placeholder="28.0567"
                    />
                  </View>
                </View>
                <Text style={styles.helper}>
                  Without coordinates, this workplace cannot yet be placed on the trip-planning map.
                </Text>
                <PrimaryButton
                  title="Add workplace"
                  loading={submitting}
                  onPress={() => void createWorkplace()}
                />
              </>
            )}
          </View>

          <View style={styles.listSection}>
            <Text style={styles.formTitle}>Companies</Text>
            {companies.length === 0 ? (
              <Text style={styles.helper}>No companies added yet.</Text>
            ) : (
              companies.map((company) => (
                <View key={company.id} style={styles.recordCard}>
                  <View style={styles.recordCopy}>
                    <Text style={styles.recordTitle}>{company.name}</Text>
                    <Text style={styles.status}>{company.is_active ? 'Active' : 'Inactive'}</Text>
                  </View>
                  <PrimaryButton
                    title={company.is_active ? 'Disable' : 'Enable'}
                    variant="secondary"
                    loading={activeUpdate === `companies:${company.id}`}
                    disabled={activeUpdate !== null}
                    onPress={() => void changeActive('companies', company.id, !company.is_active)}
                    style={styles.toggleButton}
                  />
                </View>
              ))
            )}
          </View>

          <View style={styles.listSection}>
            <Text style={styles.formTitle}>Workplace sites</Text>
            {workplaces.length === 0 ? (
              <Text style={styles.helper}>No workplace sites added yet.</Text>
            ) : (
              workplaces.map((workplace) => (
                <View key={workplace.id} style={styles.recordCard}>
                  <View style={styles.recordCopy}>
                    <Text style={styles.recordTitle}>{workplace.name}</Text>
                    <Text style={styles.helper}>
                      {workplace.company_name} · {workplace.suburb}
                    </Text>
                    <Text style={styles.helper}>{workplace.address}</Text>
                    <Text style={styles.helper}>
                      {workplace.latitude == null || workplace.longitude == null
                        ? 'Coordinates not set'
                        : `${workplace.latitude}, ${workplace.longitude}`}
                    </Text>
                    <Text style={styles.status}>{workplace.is_active ? 'Active' : 'Inactive'}</Text>
                  </View>
                  <PrimaryButton
                    title={workplace.is_active ? 'Disable' : 'Enable'}
                    variant="secondary"
                    loading={activeUpdate === `workplaces:${workplace.id}`}
                    disabled={activeUpdate !== null}
                    onPress={() =>
                      void changeActive('workplaces', workplace.id, !workplace.is_active)
                    }
                    style={styles.toggleButton}
                  />
                </View>
              ))
            )}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.md,
  },
  sectionHeading: {
    gap: theme.spacing.xs,
  },
  sectionTitle: {
    color: theme.colors.navy,
    fontSize: 20,
    fontWeight: '800',
  },
  helper: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  form: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryLight,
  },
  formTitle: {
    color: theme.colors.navy,
    fontSize: 16,
    fontWeight: '800',
  },
  label: {
    color: theme.colors.navy,
    fontSize: 13,
    fontWeight: '700',
  },
  companyOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
  },
  coordinateRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  coordinateField: {
    flex: 1,
  },
  companyOption: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.white,
  },
  companySelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  companyOptionText: {
    color: theme.colors.navy,
    fontSize: 12,
    fontWeight: '700',
  },
  companySelectedText: {
    color: theme.colors.white,
  },
  listSection: {
    gap: theme.spacing.sm,
  },
  recordCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  recordCopy: {
    flex: 1,
    gap: 3,
  },
  recordTitle: {
    color: theme.colors.navy,
    fontSize: 14,
    fontWeight: '800',
  },
  status: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  toggleButton: {
    minHeight: 38,
    paddingHorizontal: theme.spacing.sm,
  },
  success: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
});
