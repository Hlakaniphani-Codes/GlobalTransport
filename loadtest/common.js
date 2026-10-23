import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

export const baseUrl = __ENV.LOADTEST_BASE_URL;
export const environment = __ENV.LOADTEST_ENVIRONMENT;

if (!baseUrl || !['staging', 'test'].includes(environment) || __ENV.LOADTEST_ALLOW !== 'true') {
  throw new Error('Set LOADTEST_BASE_URL, LOADTEST_ENVIRONMENT=staging|test, and LOADTEST_ALLOW=true.');
}
const targetHost = /^https?:\/\/([^/:?#]+)/i.exec(baseUrl)?.[1];
if (!targetHost) throw new Error('LOADTEST_BASE_URL must be an absolute HTTP or HTTPS URL.');
if (/prod/i.test(targetHost)) {
  throw new Error('Refusing to run a load test against a production-looking hostname.');
}

const tokens = new SharedArray('loadtest tokens', () => [JSON.parse(open('./tokens.json'))]);
const fixtures = new SharedArray('loadtest fixture metadata', () => [JSON.parse(open('./fixtures.json'))]);
const http5xx = new Counter('http_5xx_total');
const selectedTokenIndexes = {};

export function setTokenIndex(role, index) {
  selectedTokenIndexes[role] = index;
}

export function tokenFor(role) {
  const list = tokens[0][role];
  if (!list?.length) throw new Error(`No ${role} tokens in loadtest/tokens.json.`);
  return list[(selectedTokenIndexes[role] ?? (__VU - 1)) % list.length];
}

export function fixtureFor(role, index = __VU - 1) {
  const list = fixtures[0][role];
  if (!list?.length) throw new Error(`No ${role} fixture data in loadtest/fixtures.json.`);
  return list[index % list.length];
}

export function tripsForDriver(userId) {
  return fixtures[0].trips.filter((trip) => trip.driver_user_id === userId);
}

export function request(role, method, path, body, tag = path) {
  const response = http.request(method, `${baseUrl}/api/v1${path}`, body && JSON.stringify(body), {
    headers: {
      authorization: `Bearer ${tokenFor(role)}`,
      'content-type': 'application/json',
    },
    tags: { name: tag, type: method === 'GET' ? 'read' : 'write' },
    timeout: '15s',
  });
  if (response.status >= 500) http5xx.add(1, { name: tag });
  check(response, {
    [`${tag} has no server error`]: (res) => res.status < 500,
    [`${tag} is not rate limited`]: (res) => res.status !== 429,
  });
  return response;
}

export function poll(role, path, tag = path) {
  globalThis.__pollState ||= {};
  const state = globalThis.__pollState[path] || { failures: 0, etag: null };
  const headers = { authorization: `Bearer ${tokenFor(role)}` };
  if (state.etag) headers['If-None-Match'] = state.etag;
  const response = http.get(`${baseUrl}/api/v1${path}`, {
    headers,
    tags: { name: tag, type: 'read' },
    timeout: '15s',
  });
  if (response.status >= 500) http5xx.add(1, { name: tag });
  check(response, {
    [`${tag} is successful or not modified`]: (res) => res.status === 200 || res.status === 304,
  });
  if (response.headers.ETag) state.etag = response.headers.ETag;
  if (response.status === 429 || response.status >= 500) {
    state.failures += 1;
    const retry = Number(response.headers['Retry-After']);
    const delay = Number.isFinite(retry) && retry > 0
      ? retry
      : Math.min(300, 2 ** Math.min(state.failures, 8));
    sleep(Math.min(300, Math.max(1, delay)));
  } else {
    state.failures = 0;
    const pollAfter = response.status === 304
      ? 15
      : Number(response.json('poll_after_seconds') || 15);
    sleep(pollAfter * (0.8 + Math.random() * 0.4));
  }
  globalThis.__pollState[path] = state;
  return response;
}

export const thresholds = {
  http_req_failed: ['rate<0.005'],
  'http_req_duration{type:read}': ['p(95)<500'],
  'http_req_duration{type:write}': ['p(95)<1000'],
  http_5xx_total: ['count==0'],
};
