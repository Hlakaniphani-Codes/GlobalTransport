const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  isAllowedCorsOrigin,
  loadConfig,
  parseLifecycleConfig,
  parseNotificationConfig,
  parseWorkerConfig,
} = require('../src/config');
const {
  runNotificationReceiptWorker,
  runOfferExpiryWorker,
} = require('../src/services/offerExpiryWorker');
const app = require('../index');
const pool = require('../src/db');

const validEnv = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:password@example.invalid:5432/ride',
  JWT_SECRET: 'a'.repeat(32),
  METRICS_TOKEN: 'metrics-test-token',
  CORS_ORIGINS: 'https://admin.example.invalid,https://www.example.invalid',
};

test('production config parses validated origins and safe database defaults', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.port, 3000);
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.metricsToken, 'metrics-test-token');
  assert.equal(config.sentryDsn, null);
  assert.deepEqual(config.corsOrigins, [
    'https://admin.example.invalid',
    'https://www.example.invalid',
  ]);
  assert.equal(config.databaseSsl, false);
  assert.equal(config.redisUrl, null);
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.databasePoolMin, 0);
  assert.equal(config.databaseIdleTimeoutMs, 30_000);
  assert.equal(config.databaseConnectTimeoutMs, 5_000);
  assert.equal(config.statementTimeoutMs, 15_000);
  assert.equal(config.idleInTransactionTimeoutMs, 15_000);
  assert.equal(config.slowQueryMs, 200);
  assert.equal(config.noShowWaitMinutes, 5);
  assert.equal(config.smsProvider, 'none');
  assert.equal(config.offerSmsFallbackSeconds, 120);
  assert.equal(config.tripReminderMinutes, 60);
  assert.equal(config.workerBatchSize, 200);
  assert.equal(config.notificationRetentionDays, 90);
  assert.equal(config.overdueGraceMinutes, 30);
  assert.equal(config.autoMissAfterMinutes, 60);
  assert.equal(config.lateWithdrawHours, 12);
  assert.equal(config.unassignedAlertHours, 3);
  assert.equal(config.requestExpireGraceMinutes, 15);
  assert.equal(config.changeCancelExemptHours, 24);
  assert.equal(config.etaStaleMinutes, 15);
  assert.equal(loadConfig({ ...validEnv, NO_SHOW_WAIT_MINUTES: '8' }).noShowWaitMinutes, 8);
});

test('worker configuration accepts bounded positive overrides', () => {
  assert.deepEqual(parseWorkerConfig({
    WORKER_BATCH_SIZE: '75',
    NOTIFICATION_RETENTION_DAYS: '120',
  }), {
    workerBatchSize: 75,
    notificationRetentionDays: 120,
  });
  assert.throws(
    () => parseWorkerConfig({ WORKER_BATCH_SIZE: '0' }),
    /WORKER_BATCH_SIZE must be a positive integer/
  );
  assert.throws(
    () => parseWorkerConfig({ NOTIFICATION_RETENTION_DAYS: '-1' }),
    /NOTIFICATION_RETENTION_DAYS must be a positive integer/
  );
});

test('production config rejects weak secrets and wildcard or missing CORS origins', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, JWT_SECRET: 'short' }),
    /JWT_SECRET must be at least 32 characters/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, CORS_ORIGINS: 'https://*.example.invalid' }),
    /exact HTTP or HTTPS origins/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, CORS_ORIGINS: '' }),
    /at least one exact origin/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, METRICS_TOKEN: '' }),
    /METRICS_TOKEN must be configured in production/
  );
  assert.equal(
    loadConfig({ ...validEnv, SENTRY_DSN: 'https://public@example.invalid/1' }).sentryDsn,
    'https://public@example.invalid/1'
  );
  assert.throws(
    () => loadConfig({ ...validEnv, SENTRY_DSN: 'ftp://sentry.example.invalid/1' }),
    /SENTRY_DSN must be a valid HTTP or HTTPS URL/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/database' }),
    /must use PostgreSQL/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, REDIS_URL: 'https://redis.example.invalid' }),
    /must use redis:\/\//
  );
  assert.equal(loadConfig({ ...validEnv, REDIS_URL: 'rediss://cache.example.invalid:6379' }).redisUrl,
    'rediss://cache.example.invalid:6379');
  assert.throws(
    () => loadConfig({ ...validEnv, NO_SHOW_WAIT_MINUTES: '-1' }),
    /NO_SHOW_WAIT_MINUTES must be a non-negative integer/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, SLOW_QUERY_MS: '-1' }),
    /SLOW_QUERY_MS must be a non-negative integer/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, DB_POOL_MIN: '11' }),
    /DB_POOL_MIN must be a non-negative integer no greater than DB_POOL_MAX/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, STATEMENT_TIMEOUT_MS: '0' }),
    /STATEMENT_TIMEOUT_MS must be a positive integer/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, REQUEST_TIMEOUT_MS: '0' }),
    /REQUEST_TIMEOUT_MS must be a positive integer/
  );
});

test('database pool config accepts bounded pool and timeout overrides', () => {
  const config = loadConfig({
    ...validEnv,
    DB_POOL_MAX: '20',
    DB_POOL_MIN: '2',
    DB_IDLE_TIMEOUT_MS: '45000',
    DB_CONNECT_TIMEOUT_MS: '7000',
    STATEMENT_TIMEOUT_MS: '12000',
    IDLE_IN_TRANSACTION_TIMEOUT_MS: '9000',
  });
  assert.equal(config.databasePoolMax, 20);
  assert.equal(config.databasePoolMin, 2);
  assert.equal(config.databaseIdleTimeoutMs, 45_000);
  assert.equal(config.databaseConnectTimeoutMs, 7_000);
  assert.equal(config.statementTimeoutMs, 12_000);
  assert.equal(config.idleInTransactionTimeoutMs, 9_000);
});

test('trip lifecycle configuration accepts overrides and rejects invalid values', () => {
  assert.deepEqual(parseLifecycleConfig({
    OVERDUE_GRACE_MINUTES: '45',
    AUTO_MISS_AFTER_MINUTES: '75',
    LATE_WITHDRAW_HOURS: '8',
    UNASSIGNED_ALERT_HOURS: '2',
    REQUEST_EXPIRE_GRACE_MINUTES: '20',
    CHANGE_CANCEL_EXEMPT_HOURS: '36',
    ETA_STALE_MINUTES: '20',
  }), {
    overdueGraceMinutes: 45,
    autoMissAfterMinutes: 75,
    lateWithdrawHours: 8,
    unassignedAlertHours: 2,
    requestExpireGraceMinutes: 20,
    changeCancelExemptHours: 36,
    etaStaleMinutes: 20,
  });
  assert.throws(
    () => parseLifecycleConfig({ AUTO_MISS_AFTER_MINUTES: '-1' }),
    /AUTO_MISS_AFTER_MINUTES must be a non-negative integer/
  );
  assert.throws(
    () => parseLifecycleConfig({ ETA_STALE_MINUTES: '-1' }),
    /ETA_STALE_MINUTES must be a non-negative integer/
  );
});

test('notification configuration validates provider credentials and reminder intervals', () => {
  assert.throws(
    () => parseNotificationConfig({ SMS_PROVIDER: 'twilio' }),
    /credentials for the selected twilio SMS provider/
  );
  assert.equal(parseNotificationConfig({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'account',
    TWILIO_AUTH_TOKEN: 'secret',
    TWILIO_FROM_NUMBER: '+10000000000',
  }).smsProvider, 'twilio');
  assert.throws(
    () => parseNotificationConfig({ OFFER_SMS_FALLBACK_SECONDS: '-1' }),
    /OFFER_SMS_FALLBACK_SECONDS must be a non-negative integer/
  );
});

test('CORS allows local development origins but keeps production origins exact', () => {
  assert.equal(isAllowedCorsOrigin('http://localhost:5173', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://127.0.0.1:8081', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://192.168.1.25:5173', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://10.0.0.4:8081', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://172.20.1.9:19006', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://ride-phone.local:8081', [], 'development'), true);
  assert.equal(isAllowedCorsOrigin('http://localhost:5173/path', [], 'development'), false);
  assert.equal(isAllowedCorsOrigin('http://192.168.1.999:5173', [], 'development'), false);
  assert.equal(isAllowedCorsOrigin('ftp://localhost:5173', [], 'development'), false);
  assert.equal(isAllowedCorsOrigin('https://untrusted.example', [], 'development'), false);
  assert.equal(
    isAllowedCorsOrigin('https://admin.example.invalid', ['https://admin.example.invalid'], 'production'),
    true
  );
  assert.equal(
    isAllowedCorsOrigin('http://localhost:5173', ['https://admin.example.invalid'], 'production'),
    false
  );
  assert.equal(
    isAllowedCorsOrigin('http://192.168.1.25:5173', [], 'production'),
    false
  );
  assert.equal(isAllowedCorsOrigin(undefined, [], 'production'), true);
});

test('offer expiry worker skips overlapping instances and releases the lock client', async () => {
  const calls = [];
  const pool = {
    connect: async () => ({
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [{ locked: false }] };
      },
      release: () => calls.push({ released: true }),
    }),
  };
  let processed = false;
  const result = await runOfferExpiryWorker(pool, async () => { processed = true; });
  assert.equal(result, false);
  assert.equal(processed, false);
  assert.equal(calls.at(-1).released, true);
});

test('offer expiry worker releases advisory lock after processing', async () => {
  const calls = [];
  const pool = {
    connect: async () => ({
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [{ locked: true }] };
      },
      release: () => calls.push({ released: true }),
    }),
  };
  let processed = false;
  let lifecycleProcessed = false;
  const result = await runOfferExpiryWorker(
    pool,
    async () => { processed = true; },
    async () => {},
    async () => { lifecycleProcessed = true; }
  );
  assert.equal(result, true);
  assert.equal(processed, true);
  assert.equal(lifecycleProcessed, true);
  assert.equal(calls.filter(({ sql }) => sql === 'SELECT pg_advisory_unlock($1)').length, 1);
  assert.equal(calls.at(-1).released, true);
});

test('concurrent worker instances use the advisory lock to run singleton work once', async () => {
  let locked = false;
  let processed = 0;
  const pool = {
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (locked) return { rows: [{ locked: false }] };
          locked = true;
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          locked = false;
          return { rows: [] };
        }
        throw new Error(`Unexpected worker query: ${sql}`);
      },
      release() {},
    }),
  };
  const task = async () => {
    processed += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const results = await Promise.all([
    runOfferExpiryWorker(pool, task),
    runOfferExpiryWorker(pool, task),
  ]);
  assert.equal(processed, 1);
  assert.deepEqual(results.sort(), [false, true]);
});

test('notification receipt worker releases its dedicated advisory lock', async () => {
  const calls = [];
  const pool = {
    connect: async () => ({
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [{ locked: true }] };
      },
      release: () => calls.push({ released: true }),
    }),
  };
  let processed = false;
  const result = await runNotificationReceiptWorker(pool, async () => { processed = true; });
  assert.equal(result, true);
  assert.equal(processed, true);
  assert.equal(calls[0].values[0], 714335245);
  assert.equal(calls.at(-1).released, true);
});

test('health endpoint checks PostgreSQL and returns an opaque 503 when it is unavailable', async () => {
  const originalQuery = pool.query;
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/health`;

    pool.query = async (query) => {
      assert.equal(query, 'SELECT 1');
      return { rows: [{ '?column?': 1 }] };
    };
    const healthy = await fetch(url);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: 'ok' });
    assert.match(healthy.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);

    pool.query = async () => { throw Object.assign(new Error('database details'), { code: 'ECONNREFUSED' }); };
    const unavailable = await fetch(url);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: 'unavailable' });
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
