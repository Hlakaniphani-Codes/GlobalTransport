import { isAxiosError } from 'axios';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import type { ReactNode } from 'react';

import { api, apiGetAllPages } from '@/api';
import { AuthError } from '@/components/AuthError';
import { PrimaryButton } from '@/components/PrimaryButton';
import { theme } from '@/theme';

type DriverApplication = {
  id: string;
  email: string;
  name: string;
  surname: string;
  contact_number: string;
  address: string;
  created_at: string;
};

type VehicleApplication = {
  id: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  registration_number: string;
  seat_count: number;
  driver_name: string;
  driver_surname: string;
  driver_email: string;
};

function getErrorMessage(error: unknown) {
  if (isAxiosError<{ error?: { message?: string } }>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

export function AdminReviewQueue() {
  const [drivers, setDrivers] = useState<DriverApplication[]>([]);
  const [vehicles, setVehicles] = useState<VehicleApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeReview, setActiveReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function fetchQueue() {
    const [driverResponse, vehicleResponse] = await Promise.all([
      apiGetAllPages<DriverApplication>('/admin/drivers', 'drivers'),
      apiGetAllPages<VehicleApplication>('/admin/vehicles/pending', 'vehicles'),
    ]);
    return {
      drivers: driverResponse,
      vehicles: vehicleResponse,
    };
  }

  useEffect(() => {
    let active = true;
    fetchQueue()
      .then((queue) => {
        if (active) {
          setDrivers(queue.drivers);
          setVehicles(queue.vehicles);
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
  }, []);

  async function refreshQueue() {
    setRefreshing(true);
    try {
      const queue = await fetchQueue();
      setDrivers(queue.drivers);
      setVehicles(queue.vehicles);
      setError(null);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setRefreshing(false);
    }
  }

  async function review(
    kind: 'drivers' | 'vehicles',
    id: string,
    status: 'approved' | 'rejected'
  ) {
    const actionId = `${kind}:${id}`;
    setActiveReview(actionId);
    setError(null);
    setSuccess(null);
    try {
      const url = kind === 'drivers'
        ? `/admin/drivers/${id}/review`
        : `/admin/vehicles/${id}/review`;
      await api.patch(url, { status });
      if (kind === 'drivers') {
        setDrivers((current) => current.filter((driver) => driver.id !== id));
      } else {
        setVehicles((current) => current.filter((vehicle) => vehicle.id !== id));
      }
      setSuccess(
        kind === 'drivers'
          ? `Driver application ${status}.`
          : `Vehicle application ${status}.`
      );
      try {
        const queue = await fetchQueue();
        setDrivers(queue.drivers);
        setVehicles(queue.vehicles);
      } catch (refreshError) {
        setError(`Decision saved. ${getErrorMessage(refreshError)}`);
      }
    } catch (reviewError) {
      setError(getErrorMessage(reviewError));
    } finally {
      setActiveReview(null);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.queueHeading}>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>Verification queue</Text>
          <Text style={styles.subtitle}>
            Review driver and vehicle applications before they can be used on the platform.
          </Text>
        </View>
        <PrimaryButton
          title={refreshing ? 'Refreshing' : 'Refresh'}
          variant="secondary"
          disabled={refreshing || loading}
          onPress={() => void refreshQueue()}
          style={styles.refreshButton}
        />
      </View>

      {error && <AuthError message={error} />}
      {success && <Text style={styles.success}>{success}</Text>}
      {loading ? (
        <Text style={styles.empty}>Loading verification queue…</Text>
      ) : (
        <>
          <ReviewSection title="Driver applications" count={drivers.length}>
            {drivers.length === 0 ? (
              <Text style={styles.empty}>No driver applications need review.</Text>
            ) : (
              drivers.map((driver) => (
                <View key={driver.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{driver.name} {driver.surname}</Text>
                  <Text style={styles.detail}>{driver.email}</Text>
                  <Text style={styles.detail}>{driver.contact_number}</Text>
                  <Text style={styles.detail}>{driver.address}</Text>
                  <View style={styles.actions}>
                    <PrimaryButton
                      title="Approve"
                      loading={activeReview === `drivers:${driver.id}`}
                      disabled={activeReview !== null}
                      onPress={() => void review('drivers', driver.id, 'approved')}
                      style={styles.actionButton}
                    />
                    <PrimaryButton
                      title="Reject"
                      variant="secondary"
                      disabled={activeReview !== null}
                      onPress={() => void review('drivers', driver.id, 'rejected')}
                      style={styles.actionButton}
                    />
                  </View>
                </View>
              ))
            )}
          </ReviewSection>

          <ReviewSection title="Vehicle applications" count={vehicles.length}>
            {vehicles.length === 0 ? (
              <Text style={styles.empty}>No vehicle applications need review.</Text>
            ) : (
              vehicles.map((vehicle) => (
                <View key={vehicle.id} style={styles.card}>
                  <Text style={styles.cardTitle}>
                    {vehicle.year} {vehicle.make} {vehicle.model}
                  </Text>
                  <Text style={styles.detail}>
                    {vehicle.colour} · {vehicle.registration_number} · {vehicle.seat_count} seats
                  </Text>
                  <Text style={styles.detail}>
                    Driver: {vehicle.driver_name} {vehicle.driver_surname}
                  </Text>
                  <Text style={styles.detail}>{vehicle.driver_email}</Text>
                  <View style={styles.actions}>
                    <PrimaryButton
                      title="Approve"
                      loading={activeReview === `vehicles:${vehicle.id}`}
                      disabled={activeReview !== null}
                      onPress={() => void review('vehicles', vehicle.id, 'approved')}
                      style={styles.actionButton}
                    />
                    <PrimaryButton
                      title="Reject"
                      variant="secondary"
                      disabled={activeReview !== null}
                      onPress={() => void review('vehicles', vehicle.id, 'rejected')}
                      style={styles.actionButton}
                    />
                  </View>
                </View>
              ))
            )}
          </ReviewSection>
        </>
      )}
    </View>
  );
}

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.countPill}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      </View>
      <View style={styles.list}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.lg,
  },
  queueHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  headingCopy: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.navy,
    fontSize: 20,
    fontWeight: '800',
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  refreshButton: {
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.navy,
    fontSize: 16,
    fontWeight: '800',
  },
  countPill: {
    minWidth: 24,
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primaryLight,
  },
  countText: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '800',
  },
  list: {
    gap: theme.spacing.sm,
  },
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
  },
  cardTitle: {
    color: theme.colors.navy,
    fontSize: 15,
    fontWeight: '800',
  },
  detail: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  actionButton: {
    flex: 1,
  },
  empty: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  success: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
});
