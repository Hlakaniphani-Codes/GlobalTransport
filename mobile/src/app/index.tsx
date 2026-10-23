import { Redirect } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';

export default function IndexRoute() {
  const { user, sessionExpired } = useAuth();
  return <Redirect href={user ? '/(app)' : sessionExpired ? '/(auth)/login' : '/(auth)'} />;
}
