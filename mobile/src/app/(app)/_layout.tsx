import { Stack } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { NotificationProvider } from '@/notifications/NotificationProvider';

export default function AppLayout() {
  const { user } = useAuth();

  return (
    <NotificationProvider>
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={user?.role === 'driver'}>
        <Stack.Screen name="driver" />
        <Stack.Screen name="driver-offers" />
        <Stack.Screen name="driver-account" />
      </Stack.Protected>
      <Stack.Protected guard={user?.role === 'passenger'}>
        <Stack.Screen name="passenger" />
        <Stack.Screen name="passenger-request" />
        <Stack.Screen name="passenger-requests" />
        <Stack.Screen name="passenger-history" />
        <Stack.Screen name="passenger-account" />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(user)}>
        <Stack.Screen name="account" />
        <Stack.Screen name="delete-account" />
        <Stack.Screen name="notifications" />
      </Stack.Protected>
      <Stack.Protected guard={false}>
        <Stack.Screen name="admin" />
      </Stack.Protected>
    </Stack>
    </NotificationProvider>
  );
}
