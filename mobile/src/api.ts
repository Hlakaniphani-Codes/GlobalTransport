import { create, isAxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { getStoredToken } from '@/auth/tokenStorage';
import { expireSession } from '@/auth/sessionExpiry';

function resolveApiUrl(): string | undefined {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  if (!configuredUrl || !__DEV__ || Platform.OS === 'web') return configuredUrl;

  const apiUrl = new URL(configuredUrl);
  if (apiUrl.hostname !== 'localhost' && apiUrl.hostname !== '127.0.0.1') {
    return configuredUrl;
  }

  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return configuredUrl;

  const packagerUrl = new URL(`http://${hostUri}`);
  const isPrivateIpv4 =
    /^10\./.test(packagerUrl.hostname) ||
    /^192\.168\./.test(packagerUrl.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(packagerUrl.hostname);
  if (isPrivateIpv4) {
    apiUrl.hostname = packagerUrl.hostname;
    return apiUrl.toString().replace(/\/+$/, '');
  }

  return configuredUrl;
}

const apiUrl = resolveApiUrl();
type CachedGet = { etag: string; data: unknown };
type InFlightGet = {
  controller: AbortController;
  consumers: number;
  promise: Promise<AxiosResponse<unknown>>;
  settled: boolean;
};
const conditionalGetPaths = new Set([
  '/driver/home',
  '/driver/offers',
  '/driver/trips',
  '/rides/trips',
  '/rides/requests',
  '/ride-requests',
  '/notifications',
]);
const conditionalGetCache = new Map<string, CachedGet>();
const inFlightGets = new Map<string, InFlightGet>();
const cacheLimit = 500;
const pollingFailures = new WeakMap<object, { error: unknown; count: number }>();

if (!__DEV__) {
  if (!apiUrl) {
    throw new Error('EXPO_PUBLIC_API_URL must be configured in production builds.');
  }

  let parsedApiUrl: URL;
  try {
    parsedApiUrl = new URL(apiUrl);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid HTTPS URL in production builds.');
  }

  if (parsedApiUrl.protocol !== 'https:' || parsedApiUrl.username || parsedApiUrl.password) {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid HTTPS URL in production builds.');
  }
}

export const api = create({
  baseURL: apiUrl ? `${apiUrl}/api/v1` : undefined,
  timeout: 20_000,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

function requestKey(config: AxiosRequestConfig): string {
  const headers = config.headers;
  const authorization = headers && 'get' in headers && typeof headers.get === 'function'
    ? headers.get('Authorization')
    : headers?.Authorization;
  return `${api.getUri(config)}|${String(authorization ?? '')}`;
}

function isConditionalGet(config: { method?: string; url?: string }): boolean {
  if (config.method?.toLowerCase() !== 'get' || !config.url) return false;
  const path = new URL(config.url, 'https://global-ride.invalid').pathname.replace(/^\/api\/v1/, '');
  return conditionalGetPaths.has(path);
}

function storeEtag(key: string, etag: string, data: unknown): void {
  conditionalGetCache.delete(key);
  conditionalGetCache.set(key, { etag, data });
  while (conditionalGetCache.size > cacheLimit) {
    const oldest = conditionalGetCache.keys().next().value;
    if (oldest) conditionalGetCache.delete(oldest);
  }
}

function jittered(milliseconds: number): number {
  return Math.max(1_000, Math.round(milliseconds * (0.8 + Math.random() * 0.4)));
}

function cancellationError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Request was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function pollingInterval(
  pollAfterSeconds: number | undefined,
  fallbackSeconds: number,
  failures = 0,
  status?: number
): number {
  if (status === 429 || (status !== undefined && status >= 500)) {
    return Math.min(300_000, 1_000 * (2 ** Math.max(0, failures - 1)));
  }
  const seconds = pollAfterSeconds && pollAfterSeconds > 0 ? pollAfterSeconds : fallbackSeconds;
  return jittered(seconds * 1_000);
}

export function queryPollingInterval(
  query: {
    state: { data?: unknown; error: unknown; fetchFailureCount: number };
  },
  fallbackSeconds: number
): number {
  const result = query.state.data as {
    poll_after_seconds?: number;
    pages?: { poll_after_seconds?: number }[];
  } | undefined;
  const data = result?.pages?.[0] ?? result;
  const error = query.state.error;
  const status = isAxiosError(error) ? error.response?.status : undefined;
  const prior = pollingFailures.get(query as object);
  let failures = query.state.fetchFailureCount;
  if (status === 429 || (status !== undefined && status >= 500)) {
    failures = prior?.error === error ? prior?.count ?? 0 : (prior?.count ?? 0) + 1;
    pollingFailures.set(query as object, { error, count: failures });
  } else if (error) {
    pollingFailures.delete(query as object);
  }
  return pollingInterval(
    data?.poll_after_seconds,
    fallbackSeconds,
    failures,
    status
  );
}

export async function deduplicatedGet<T>(
  path: string,
  config: AxiosRequestConfig & { signal?: AbortSignal } = {}
): Promise<AxiosResponse<T>> {
  const token = await getStoredToken();
  const key = `${path}?${JSON.stringify(config.params ?? {})}|${token ?? ''}`;
  const { signal, ...requestConfig } = config;
  let entry = inFlightGets.get(key) as InFlightGet | undefined;
  if (entry?.controller.signal.aborted) {
    inFlightGets.delete(key);
    entry = undefined;
  }
  if (!entry) {
    const controller = new AbortController();
    const created: InFlightGet = {
      controller,
      consumers: 0,
      promise: Promise.resolve({} as AxiosResponse<unknown>),
      settled: false,
    };
    created.promise = api.get<T>(path, { ...requestConfig, signal: controller.signal })
      .finally(() => {
        created.settled = true;
        if (inFlightGets.get(key) === created) inFlightGets.delete(key);
      });
    entry = created;
    inFlightGets.set(key, entry);
  }
  if (!entry) throw new Error('Request deduplication entry could not be created.');
  const current = entry;
  if (signal?.aborted) throw cancellationError(signal.reason);
  current.consumers += 1;
  return new Promise<AxiosResponse<T>>((resolve, reject) => {
    let active = true;
    const release = () => {
      current.consumers -= 1;
      if (current.consumers === 0 && !current.settled) current.controller.abort();
    };
    const abort = () => {
      if (!active) return;
      active = false;
      release();
      reject(cancellationError(signal?.reason));
    };
    signal?.addEventListener('abort', abort, { once: true });
    current.promise.then((response) => {
      if (!active) return;
      active = false;
      signal?.removeEventListener('abort', abort);
      release();
      resolve(response as AxiosResponse<T>);
    }, (error: unknown) => {
      if (!active) return;
      active = false;
      signal?.removeEventListener('abort', abort);
      release();
      reject(error);
    });
  });
}

api.interceptors.request.use((config) => {
  config.headers.set('X-Client-App-State', AppState.currentState === 'active' ? 'foreground' : 'background');
  if (isConditionalGet(config)) {
    const cached = conditionalGetCache.get(requestKey(config));
    if (cached) config.headers.set('If-None-Match', cached.etag);
  }
  return config;
});

api.interceptors.response.use((response) => {
  if (isConditionalGet(response.config)) {
    const etag = response.headers.etag;
    if (etag) storeEtag(requestKey(response.config), etag, response.data);
  }
  return response;
}, async (error: unknown) => {
  if (isAxiosError(error) && error.response?.status === 304 && error.config) {
    const cached = conditionalGetCache.get(requestKey(error.config));
    if (cached) return { ...error.response, status: 200, data: cached.data };
  }
  if (isAxiosError(error) && error.response?.status === 401) {
    const requestUrl = error.config?.url ?? '';
    const isPublicAuthRequest = requestUrl === '/auth/login'
      || requestUrl.startsWith('/auth/register/');
    const hasSession = Boolean(error.config?.headers?.Authorization);

    if (hasSession && !isPublicAuthRequest) {
      await expireSession();
    }
  }

  return Promise.reject(error);
});

export async function apiGetAllPages<T>(path: string, collection: string): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await deduplicatedGet<Record<string, unknown> & {
      pagination?: { total_pages?: number };
    }>(path, { params: { page, page_size: 100 } });
    const currentRows = response.data[collection];
    if (!Array.isArray(currentRows)) {
      throw new Error('We could not load that list. Please try again.');
    }
    rows.push(...currentRows as T[]);
    totalPages = Math.max(1, Number(response.data.pagination?.total_pages) || 1);
    page += 1;
  } while (page <= totalPages);
  return rows;
}

api.interceptors.request.use(async (config) => {
  if (!apiUrl) {
    throw new Error('EXPO_PUBLIC_API_URL must be configured before making API requests.');
  }

  const token = await getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});
