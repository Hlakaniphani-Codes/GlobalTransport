import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { api } from '@/api';

const DEVICE_TOKEN_KEY = 'global_ride_push_token';

export async function getDeviceToken(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.sessionStorage.getItem(DEVICE_TOKEN_KEY);
  return SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
}

export async function storeDeviceToken(token: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.sessionStorage.setItem(DEVICE_TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token);
}

export async function removeDeviceToken(): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.sessionStorage.removeItem(DEVICE_TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
}

export async function unregisterDeviceToken(): Promise<void> {
  const token = await getDeviceToken();
  if (!token) return;
  try {
    await api.delete(`/devices/${encodeURIComponent(token)}`);
  } finally {
    await removeDeviceToken();
  }
}
