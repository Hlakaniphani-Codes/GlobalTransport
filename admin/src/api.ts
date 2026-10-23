export type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly requestId: string | null;

  constructor(message: string, status: number, requestId: string | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.requestId = requestId;
  }
}

const tokenKey = 'global-ride-admin-token';
let memoryToken: string | null = null;
const etagCache = new Map<string, { etag: string; payload: unknown }>();
const inFlightGets = new Map<string, Promise<unknown>>();
const maxCacheEntries = 500;
const pollingFailures = new WeakMap<object, { error: unknown; count: number }>();

function getCacheKey(path: string): string {
  return `${path}|${getToken() ?? ''}`;
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
  return Math.max(1_000, Math.round(seconds * 1_000 * (0.8 + Math.random() * 0.4)));
}

export function queryPollingInterval(
  query: { state: { data?: unknown; error: unknown; fetchFailureCount: number } },
  fallbackSeconds: number
): number {
  const result = query.state.data as {
    poll_after_seconds?: number;
    pages?: Array<{ poll_after_seconds?: number }>;
  } | undefined;
  const data = result?.pages?.[0] ?? result;
  const error = query.state.error;
  const status = error instanceof ApiRequestError ? error.status : undefined;
  const previous = pollingFailures.get(query as object);
  let failures = query.state.fetchFailureCount;
  if (status === 429 || (status !== undefined && status >= 500)) {
    failures = previous && previous.error === error ? previous.count : (previous?.count ?? 0) + 1;
    pollingFailures.set(query as object, { error, count: failures });
  } else if (error) {
    pollingFailures.delete(query as object);
  }
  return pollingInterval(data?.poll_after_seconds, fallbackSeconds, failures, status);
}

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  memoryToken = sessionStorage.getItem(tokenKey);
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  sessionStorage.setItem(tokenKey, token);
}

export function clearToken(): void {
  memoryToken = null;
  sessionStorage.removeItem(tokenKey);
}

async function performApiRequest<T>(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: unknown } = {}
): Promise<T> {
  const baseUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error("We couldn't connect. Check your connection and try again.");

  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const cacheKey = getCacheKey(path);
  const conditional = (options.method ?? 'GET').toUpperCase() === 'GET' && path.startsWith('/admin/');
  const cached = conditional ? etagCache.get(cacheKey) : undefined;
  if (cached) headers.set('If-None-Match', cached.etag);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error("We couldn't connect. Check your connection and try again.");
  }

  if (response.status === 304 && cached) return cached.payload as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null;
    if (response.status === 401 && token) {
      clearToken();
      window.dispatchEvent(new Event('admin-session-expired'));
    }
    throw new ApiRequestError(
      errorBody?.error?.message ?? 'We could not complete that request. Please try again.',
      response.status,
      response.headers.get('x-request-id')
    );
  }

  if (conditional) {
    const etag = response.headers.get('etag');
    if (etag) {
      etagCache.delete(cacheKey);
      etagCache.set(cacheKey, { etag, payload });
      while (etagCache.size > maxCacheEntries) {
        const oldest = etagCache.keys().next().value;
        if (oldest) etagCache.delete(oldest);
      }
    }
  }
  if ((options.method ?? 'GET').toUpperCase() !== 'GET') etagCache.clear();
  return payload as T;
}

export function apiRequest<T>(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: unknown } = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || options.signal) return performApiRequest<T>(path, options);
  const key = getCacheKey(path);
  const pending = inFlightGets.get(key);
  if (pending) return pending as Promise<T>;
  const request = performApiRequest<T>(path, options).finally(() => {
    if (inFlightGets.get(key) === request) inFlightGets.delete(key);
  });
  inFlightGets.set(key, request);
  return request;
}

export async function apiRequestAllPages<T>(path: string, collection: string): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let totalPages: number;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const payload = await apiRequest<Record<string, unknown> & {
      pagination?: { total_pages?: number };
    }>(`${path}${separator}page=${page}&page_size=100`);
    const currentRows = payload[collection];
    if (!Array.isArray(currentRows)) {
      throw new Error('We could not load that list. Please try again.');
    }
    rows.push(...currentRows as T[]);
    totalPages = Math.max(1, Number(payload.pagination?.total_pages) || 1);
    page += 1;
  } while (page <= totalPages);
  return rows;
}