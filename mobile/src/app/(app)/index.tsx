import { Redirect } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';

export default function AppIndexRoute() {
  const { user } = useAuth();

  if (user?.role === 'driver') {
    return <Redirect href="/(app)/driver" />;
  }
  if (user?.role === 'passenger') {
    return <Redirect href="/(app)/passenger" />;
  }
  return <Redirect href="/(auth)" />;
}
