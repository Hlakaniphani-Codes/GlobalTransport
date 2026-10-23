import { isAxiosError } from 'axios';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import { api } from '@/api';
import { getStoredToken, removeStoredToken, storeToken } from '@/auth/tokenStorage';
import { registerSessionExpiryHandler } from '@/auth/sessionExpiry';
import { unregisterDeviceToken } from '@/notifications/deviceTokenStorage';
import { cancelTripReminders } from '@/notifications/tripReminderScheduler';

export type UserRole = 'driver' | 'passenger' | 'admin';

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  surname: string;
  contact_number: string;
  status?: 'pending' | 'approved' | 'rejected';
};

type DriverRegistration = {
  name: string;
  surname: string;
  address: string;
  contact_number: string;
  email: string;
  id_number: string;
  password: string;
  terms_accepted: true;
};

type PassengerRegistration = {
  name: string;
  surname: string;
  address: string;
  home_suburb: string;
  workplace_suburb: string;
  employee_number: string;
  workplace: string;
  contact_number: string;
  email: string;
  password: string;
  terms_accepted: true;
};

type LoginCredentials = {
  email: string;
  password: string;
};

type AuthResponse = {
  token: string;
  user: AuthUser;
};

type ApiFieldIssue = {
  field: string;
  message: string;
};

type ApiErrorResponse = {
  error?: {
    message?: string;
    fields?: ApiFieldIssue[];
  };
};

export class AuthRequestError extends Error {
  readonly fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'AuthRequestError';
    this.fields = fields;
  }
}

type Register = {
  (role: 'driver', details: DriverRegistration): Promise<AuthUser>;
  (role: 'passenger', details: PassengerRegistration): Promise<AuthUser>;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  sessionExpired: boolean;
  restoreError: string | null;
  register: Register;
  login: (credentials: LoginCredentials) => Promise<AuthUser>;
  refreshUser: () => Promise<AuthUser>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function getRequestError(error: unknown): string {
  if (isAxiosError<ApiErrorResponse>(error)) {
    return error.response?.data?.error?.message ?? 'Unable to connect. Please try again.';
  }

  return "We couldn't connect. Check your connection and try again.";
}

function toAuthRequestError(error: unknown): AuthRequestError {
  if (isAxiosError<ApiErrorResponse>(error)) {
    const fields = Object.fromEntries(
      (error.response?.data?.error?.fields ?? []).map(({ field, message }) => [field, message])
    );
    return new AuthRequestError(
      error.response?.data?.error?.message ?? 'Unable to connect. Please try again.',
      fields
    );
  }

  return new AuthRequestError(getRequestError(error));
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => registerSessionExpiryHandler(async () => {
    setToken(null);
    setUser(null);
    setSessionExpired(true);
    setRestoreError(null);
    await cancelTripReminders();
  }), []);

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      try {
        const storedToken = await getStoredToken();
        if (!active) return;

        if (!storedToken) {
          setLoading(false);
          return;
        }

        setToken(storedToken);
        const response = await api.get<{ user: AuthUser }>('/auth/me');
        if (active) {
          if (response.data.user.role === 'admin') {
            await removeStoredToken();
            setToken(null);
            setSessionExpired(true);
          } else {
            setUser(response.data.user);
          }
        }
      } catch (error) {
        if (!active) return;

        if (isAxiosError(error) && error.response?.status === 401) {
          await removeStoredToken();
          setToken(null);
          setSessionExpired(true);
        } else {
          setRestoreError(getRequestError(error));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void restoreSession();

    return () => {
      active = false;
    };
  }, []);

  const saveAuth = useCallback(async (response: AuthResponse) => {
    await storeToken(response.token);
    setToken(response.token);
    setUser(response.user);
    setSessionExpired(false);
    setRestoreError(null);
    return response.user;
  }, []);

  const register = useCallback(
    async (
      role: 'driver' | 'passenger',
      details: DriverRegistration | PassengerRegistration
    ): Promise<AuthUser> => {
      try {
        const response = await api.post<AuthResponse>(`/auth/register/${role}`, details);
        return await saveAuth(response.data);
      } catch (error) {
        throw toAuthRequestError(error);
      }
    },
    [saveAuth]
  );

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      try {
        const response = await api.post<AuthResponse>('/auth/login', credentials);
        return await saveAuth(response.data);
      } catch (error) {
        throw toAuthRequestError(error);
      }
    },
    [saveAuth]
  );

  const refreshUser = useCallback(async () => {
    const response = await api.get<{ user: AuthUser }>('/auth/me');
    setUser(response.data.user);
    return response.data.user;
  }, []);

  const logout = useCallback(async () => {
    let revokeFailed = false;
    let reminderCancelFailed = false;
    try {
      await unregisterDeviceToken();
    } catch {
      revokeFailed = true;
    }
    try {
      await cancelTripReminders();
    } catch {
      reminderCancelFailed = true;
    }
    setToken(null);
    setUser(null);
    setSessionExpired(false);
    setRestoreError(null);
    await removeStoredToken();
    if (revokeFailed || reminderCancelFailed) {
      throw new Error('You have been signed out, but some notification settings could not be cleared from this device.');
    }
  }, []);

  const value = useMemo(
    () => ({ user, token, loading, sessionExpired, restoreError, register, login, refreshUser, logout }),
    [user, token, loading, sessionExpired, restoreError, register, login, refreshUser, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }

  return context;
}
