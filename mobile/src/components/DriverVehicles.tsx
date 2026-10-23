import { isAxiosError } from 'axios';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { api } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { AppTextInput } from '@/components/AppTextInput';
import { AuthError } from '@/components/AuthError';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

type Vehicle = {
  id: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  registration_number: string;
  seat_count: number;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  licence_disc_expiry?: string | null;
  expired_documents?: string[];
};

type VehicleForm = {
  make: string;
  model: string;
  year: string;
  colour: string;
  registration_number: string;
  seat_count: string;
};

const emptyForm: VehicleForm = {
  make: '',
  model: '',
  year: '',
  colour: '',
  registration_number: '',
  seat_count: '',
};

function getErrorMessage(error: unknown) {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

export function DriverVehicles() {
  const { refreshUser } = useAuth();
  const [expiredDocuments, setExpiredDocuments] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [values, setValues] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      refreshUser(),
      api.get<{ vehicles: Vehicle[] }>('/vehicles/mine'),
      api.get<{ expired_documents: string[] }>('/driver/home'),
    ])
      .then(([, response, homeResponse]) => {
        if (active) {
          setVehicles(response.data.vehicles);
          setExpiredDocuments(homeResponse.data.expired_documents);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(getErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [refreshUser]);

  function updateValue(field: keyof VehicleForm, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setError(null);
    setSuccess(null);
  }

  function editRejectedVehicle(vehicle: Vehicle) {
    setEditingVehicleId(vehicle.id);
    setValues({
      make: vehicle.make,
      model: vehicle.model,
      year: String(vehicle.year),
      colour: vehicle.colour,
      registration_number: vehicle.registration_number,
      seat_count: String(vehicle.seat_count),
    });
    setError(null);
    setSuccess(null);
  }

  function cancelEdit() {
    setEditingVehicleId(null);
    setValues(emptyForm);
  }

  async function submitVehicle() {
    const year = Number(values.year);
    const seatCount = Number(values.seat_count);
    if (
      !values.make.trim() ||
      !values.model.trim() ||
      !values.colour.trim() ||
      values.registration_number.trim().length < 3 ||
      !Number.isInteger(year) ||
      year < 1900 ||
      year > new Date().getFullYear() + 1 ||
      !Number.isInteger(seatCount) ||
      seatCount < 1 ||
      seatCount > 80
    ) {
      setError('Enter valid vehicle details, a year, a registration number and seat count.');
      return;
    }

    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const details = {
        make: values.make.trim(),
        model: values.model.trim(),
        year,
        colour: values.colour.trim(),
        registration_number: values.registration_number.trim().toUpperCase(),
        seat_count: seatCount,
      };
      const response = editingVehicleId
        ? await api.patch<{ vehicle: Vehicle }>(`/vehicles/${editingVehicleId}/resubmit`, details)
        : await api.post<{ vehicle: Vehicle }>('/vehicles', details);
      setVehicles((current) => editingVehicleId
        ? current.map((vehicle) => vehicle.id === editingVehicleId ? response.data.vehicle : vehicle)
        : [response.data.vehicle, ...current]);
      setValues(emptyForm);
      setSuccess(editingVehicleId ? 'Vehicle resubmitted for approval.' : 'Vehicle submitted for approval.');
      setEditingVehicleId(null);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text style={styles.sectionTitle}>Your vehicles</Text>
        <Text style={styles.helper}>
          Register each vehicle you plan to use. It must be approved before it can be assigned.
        </Text>
      </View>

      {error && <AuthError message={error} />}
      {success && <Text style={styles.success}>{success}</Text>}
      {expiredDocuments.length > 0 && (
        <View style={styles.expiryNotice} accessibilityRole="alert">
          <Text style={styles.expiryTitle}>Document renewal needed</Text>
          <Text style={styles.expiryText}>
            Renew: {expiredDocuments.join(', ')}. You cannot receive new trip offers until these documents are current.
          </Text>
        </View>
      )}
      {loading ? (
        <Text style={styles.helper}>Loading your vehicles…</Text>
      ) : vehicles.length === 0 && !error ? (
        <Text style={styles.empty}>No vehicles registered yet.</Text>
      ) : vehicles.length > 0 ? (
        <View style={styles.list}>
          {vehicles.map((vehicle) => (
            <View key={vehicle.id} style={styles.vehicleCard}>
              <View style={styles.vehicleHeading}>
                <Text style={styles.vehicleName}>
                  {vehicle.year} {vehicle.make} {vehicle.model}
                </Text>
                <Text style={[styles.status, styles[`status_${vehicle.status}`]]}>
                  {vehicle.status}
                </Text>
              </View>
              <Text style={styles.vehicleDetails}>
                {vehicle.colour} · {vehicle.registration_number} · {vehicle.seat_count} seats
              </Text>
              {vehicle.licence_disc_expiry && (
                <Text style={styles.vehicleDetails}>
                  Licence disc expires {new Intl.DateTimeFormat('en-ZA').format(new Date(vehicle.licence_disc_expiry))}
                </Text>
              )}
              {vehicle.status === 'rejected' && vehicle.rejection_reason && (
                <Text style={styles.rejection}>Review note: {vehicle.rejection_reason}</Text>
              )}
              {vehicle.status === 'rejected'
                && !vehicles.some(({ status }) => status === 'pending' || status === 'approved') && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => editRejectedVehicle(vehicle)}
                  style={styles.editButton}
                >
                  <Text style={styles.editButtonText}>Update and resubmit</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      ) : null}

      {!loading && !vehicles.some(({ status }) => status === 'pending' || status === 'approved') && (
        <View style={styles.form}>
          <Text style={styles.formTitle}>{editingVehicleId ? 'Update vehicle details' : 'Register a vehicle'}</Text>
        <AppTextInput
          label="Make"
          value={values.make}
          onChangeText={(value) => updateValue('make', value)}
          placeholder="Toyota"
          returnKeyType="next"
        />
        <AppTextInput
          label="Model"
          value={values.model}
          onChangeText={(value) => updateValue('model', value)}
          placeholder="Quantum"
          returnKeyType="next"
        />
        <View style={styles.row}>
          <View style={styles.half}>
            <AppTextInput
              label="Year"
              value={values.year}
              onChangeText={(value) => updateValue('year', value)}
              placeholder="2022"
              keyboardType="number-pad"
              maxLength={4}
              returnKeyType="next"
            />
          </View>
          <View style={styles.half}>
            <AppTextInput
              label="Seat count"
              value={values.seat_count}
              onChangeText={(value) => updateValue('seat_count', value)}
              placeholder="14"
              keyboardType="number-pad"
              maxLength={2}
              returnKeyType="next"
            />
          </View>
        </View>
        <AppTextInput
          label="Colour"
          value={values.colour}
          onChangeText={(value) => updateValue('colour', value)}
          placeholder="White"
          returnKeyType="next"
        />
        <AppTextInput
          label="Registration number"
          value={values.registration_number}
          onChangeText={(value) => updateValue('registration_number', value)}
          placeholder="ABC 123 GP"
          autoCapitalize="characters"
          returnKeyType="done"
        />
        <PrimaryButton
          title={editingVehicleId ? 'Resubmit for review' : 'Submit vehicle for review'}
          loading={submitting}
          onPress={() => void submitVehicle()}
        />
        {editingVehicleId && (
          <PrimaryButton title="Cancel" variant="secondary" onPress={cancelEdit} />
        )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: theme.spacing.md,
  },
  heading: {
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
  empty: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  expiryNotice: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryLight,
  },
  expiryTitle: {
    color: theme.colors.error,
    fontSize: 14,
    fontWeight: '800',
  },
  expiryText: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  list: {
    gap: theme.spacing.sm,
  },
  vehicleCard: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  vehicleHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  vehicleName: {
    flex: 1,
    color: theme.colors.navy,
    fontSize: 15,
    fontWeight: '700',
  },
  vehicleDetails: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  status: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  status_pending: {
    color: theme.colors.primary,
  },
  status_approved: {
    color: theme.colors.success,
  },
  status_rejected: {
    color: theme.colors.error,
  },
  rejection: {
    color: theme.colors.error,
    fontSize: 12,
  },
  editButton: {
    minHeight: 48,
    justifyContent: 'center',
  },
  editButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  success: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
  form: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryLight,
  },
  formTitle: {
    marginBottom: theme.spacing.xs,
    color: theme.colors.navy,
    fontSize: 16,
    fontWeight: '800',
  },
  row: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  half: {
    flex: 1,
  },
});
