const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const notifications = require('../src/services/notifications');
const { createCircuitBreaker } = require('../src/utils/circuitBreaker');
const {
  deviceSchema,
  notificationPreferencesSchema,
} = require('../src/validators/notificationValidators');

test('repeated notification idempotency keys create one inbox row and one outbox job', async () => {
  const originalConnect = pool.connect;
  let notificationInsertCount = 0;
  let jobInsertCount = 0;
  const client = {
    query: async (query) => {
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] };
      if (query.includes('SELECT is_active')) {
        return {
          rowCount: 1,
          rows: [{
            is_active: true,
            notifications_push_enabled: true,
            notifications_sms_enabled: true,
          }],
        };
      }
      if (query.includes('INSERT INTO notifications')) {
        notificationInsertCount += 1;
        return notificationInsertCount === 1
          ? {
            rowCount: 1,
            rows: [{
              id: 'notification-id',
              user_id: 'user-id',
              type: 'offer_received',
              title: 'New trip offer',
              body: 'A trip offer is ready.',
              data: { offer_id: 'offer-id', screen: 'offers' },
              created_at: new Date(),
            }],
          }
          : { rowCount: 0, rows: [] };
      }
      if (query.includes('SELECT id, user_id, type')) {
        return {
          rowCount: 1,
          rows: [{ id: 'notification-id', type: 'offer_received' }],
        };
      }
      if (query.includes('INSERT INTO notification_jobs')) {
        jobInsertCount += 1;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    release() {},
  };
  pool.connect = async () => client;
  try {
    const input = {
      type: 'offer_received',
      title: 'New trip offer',
      body: 'A trip offer is ready.',
      data: { offer_id: 'offer-id', screen: 'offers' },
      channels: ['push'],
      idempotencyKey: 'offer_received:offer-id:user-id',
    };
    await notifications.notify('user-id', input);
    await notifications.notify('user-id', input);
    assert.equal(notificationInsertCount, 2);
    assert.equal(jobInsertCount, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('notification preferences keep inbox messages but suppress disabled delivery jobs', async () => {
  const originalConnect = pool.connect;
  let inserted = false;
  let jobsCreated = false;
  pool.connect = async () => ({
    query: async (query) => {
      if (query === 'BEGIN' || query === 'COMMIT') return { rows: [] };
      if (query.includes('SELECT is_active')) {
        return {
          rowCount: 1,
          rows: [{
            is_active: true,
            notifications_push_enabled: false,
            notifications_sms_enabled: false,
          }],
        };
      }
      if (query.includes('INSERT INTO notifications')) {
        inserted = true;
        return { rowCount: 1, rows: [{ id: 'notification-id', type: 'trip_scheduled' }] };
      }
      if (query.includes('INSERT INTO notification_jobs')) jobsCreated = true;
      return { rows: [] };
    },
    release() {},
  });
  try {
    const result = await notifications.notify('user-id', {
      type: 'trip_scheduled',
      title: 'Trip scheduled',
      body: 'Your trip is confirmed.',
      channels: ['push', 'sms'],
      idempotencyKey: 'trip_scheduled:trip-id:user-id',
    });
    assert.equal(result.id, 'notification-id');
    assert.equal(inserted, true);
    assert.equal(jobsCreated, false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('device test notification creates an idempotent push job for the signed-in user', async () => {
  const originalConnect = pool.connect;
  const jobs = [];
  const client = {
    query: async (query, values = []) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)) return { rows: [] };
      if (query.includes('SELECT is_active')) {
        return {
          rowCount: 1,
          rows: [{
            is_active: true,
            notifications_push_enabled: true,
            notifications_sms_enabled: true,
          }],
        };
      }
      if (query.includes('INSERT INTO notifications')) {
        return {
          rowCount: 1,
          rows: [{ id: 'test-notification-id', type: 'notification_test' }],
        };
      }
      if (query.includes('INSERT INTO notification_jobs')) {
        jobs.push(values);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    release() {},
  };
  pool.connect = async () => client;
  try {
    const result = await notifications.sendTestNotification('user-id');
    assert.equal(result.type, 'notification_test');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0][1], 'push');
    assert.match(jobs[0][3], /^notification_test:/);
  } finally {
    pool.connect = originalConnect;
  }
});

test('notification retry uses exponential backoff and fails after five attempts', async () => {
  const originalQuery = pool.query;
  const updates = [];
  pool.query = async (query, values) => {
    updates.push({ query, values });
    return { rowCount: 1, rows: [] };
  };
  try {
    assert.equal(notifications.retryDelaySeconds(1), 60);
    assert.equal(notifications.retryDelaySeconds(2), 120);
    assert.equal(notifications.retryDelaySeconds(5), 960);
    await notifications.retryJob({ id: 'job-id', attempts: 2 }, new Error('temporary outage'));
    await notifications.retryJob({ id: 'job-id', attempts: 5 }, new Error('temporary outage'));
    assert.equal(updates[0].values[1], 'pending');
    assert.equal(updates[0].values[3], 120);
    assert.equal(updates[1].values[1], 'failed');
    const retryAfter = new Error('Expo rate limited');
    retryAfter.retryAfterSeconds = 900;
    await notifications.retryJob({ id: 'job-id', attempts: 1 }, retryAfter);
    assert.equal(updates[2].values[3], 900);
  } finally {
    pool.query = originalQuery;
  }
});

test('external service circuit opens after five failures and recovers after its timeout', () => {
  let now = 1_000;
  const breaker = createCircuitBreaker({
    failureThreshold: 5,
    openMs: 60_000,
    clock: () => now,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) breaker.recordFailure();
  assert.equal(breaker.isOpen(), false);
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.retryAfterSeconds(), 60);
  now += 59_000;
  assert.equal(breaker.isOpen(), true);
  now += 1_000;
  assert.equal(breaker.isOpen(), false);
  breaker.recordSuccess();
  assert.equal(breaker.isOpen(), false);
});

test('offer SMS fallback skips offers that are no longer pending', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const completed = [];
  const dueJob = {
    id: 'sms-job-id',
    notification_id: 'notification-id',
    channel: 'sms',
    attempts: 1,
    user_id: 'driver-id',
    type: 'offer_received',
    title: 'New trip offer',
    body: 'A trip offer is ready.',
    data: { offer_id: 'offer-id' },
    is_offer_fallback: true,
  };
  pool.query = async (query, values) => {
    if (query.includes('FROM trip_offers')) return { rowCount: 0, rows: [] };
    if (query.includes('UPDATE notification_jobs')) {
      completed.push({ query, values });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  pool.connect = async () => ({
    query: async (query) => {
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] };
      if (query.includes('WITH due_jobs')) return { rowCount: 1, rows: [dueJob] };
      throw new Error(`Unexpected lock query: ${query}`);
    },
    release() {},
  });
  try {
    await notifications.processDueJobs();
    assert.equal(completed.length, 1);
    assert.match(completed[0].query, /SET status = \$2/);
    assert.equal(completed[0].values[0], 'sms-job-id');
    assert.equal(completed[0].values[1], 'skipped');
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('Expo DeviceNotRegistered receipts revoke the corresponding push token', async () => {
  const originalQuery = pool.query;
  const originalFetch = global.fetch;
  const revokedTokens = [];
  pool.query = async (query, values) => {
    if (query.includes('SELECT id, provider_receipt_id')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'job-id',
          provider_receipt_id: JSON.stringify([
            { receipt_id: 'receipt-id', token_id: 'token-id', status: 'pending' },
          ]),
        }],
      };
    }
    if (query.includes('UPDATE push_tokens')) {
      revokedTokens.push(values[0]);
      return { rowCount: 1, rows: [] };
    }
    if (query.includes('UPDATE notification_jobs')) return { rowCount: 1, rows: [] };
    if (query.includes('WHERE job.status =')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${query}`);
  };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        'receipt-id': { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }),
  });
  try {
    await notifications.processReceipts();
    assert.deepEqual(revokedTokens, ['token-id']);
  } finally {
    pool.query = originalQuery;
    global.fetch = originalFetch;
  }
});

test('worker claims no more than its batch size using SKIP LOCKED', async () => {
  const originalConnect = pool.connect;
  const queries = [];
  pool.connect = async () => ({
    query: async (query, values) => {
      queries.push({ query, values });
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });
  try {
    await notifications.processDueJobs(17);
    const claim = queries.find(({ query }) => query.includes('WITH due_jobs'));
    assert.ok(claim);
    assert.match(claim.query, /FOR UPDATE OF job SKIP LOCKED/);
    assert.deepEqual(claim.values, [17]);
  } finally {
    pool.connect = originalConnect;
  }
});

test('a failed job is retried without stopping the remainder of the claimed batch', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const completed = [];
  const jobs = ['first-offer', 'second-offer'].map((offerId, index) => ({
    id: `job-${index}`,
    notification_id: `notification-${index}`,
    channel: 'sms',
    attempts: 1,
    user_id: 'driver-id',
    type: 'offer_received',
    title: 'New trip offer',
    body: 'A trip offer is ready.',
    data: { offer_id: offerId },
    is_offer_fallback: true,
  }));
  pool.connect = async () => ({
    query: async (query) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)) return { rows: [] };
      if (query.includes('WITH due_jobs')) return { rowCount: jobs.length, rows: jobs };
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    release() {},
  });
  pool.query = async (query, values) => {
    if (query.includes('FROM trip_offers')) {
      if (values[0] === 'first-offer') throw new Error('simulated job failure');
      return { rowCount: 0, rows: [] };
    }
    if (query.includes('UPDATE notification_jobs')) {
      completed.push({ query, values });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    await notifications.processDueJobs(2);
    assert.equal(completed.length, 2);
    assert.deepEqual(
      completed.map(({ values }) => values[1]).sort(),
      ['pending', 'skipped']
    );
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('retention deletes in bounded batches using a controllable clock and advisory lock', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const queries = [];
  const lockQueries = [];
  pool.connect = async () => ({
    query: async (query, values) => {
      lockQueries.push({ query, values });
      return { rows: [{ locked: true }] };
    },
    release() {},
  });
  pool.query = async (query, values) => {
    queries.push({ query, values });
    return { rowCount: 0, rows: [] };
  };
  try {
    const result = await notifications.processDataRetention({
      retentionDays: 60,
      clock: () => new Date('2025-01-31T00:00:00.000Z'),
    });
    assert.deepEqual(result, {
      finished_jobs: 0,
      read_notifications: 0,
      revoked_push_tokens: 0,
    });
    assert.equal(lockQueries[0].values[0], 714335244);
    assert.equal(queries.length, 3);
    assert.ok(queries.every(({ values }) => values[1] === 1_000));
    assert.equal(queries[0].values[0].toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(queries[1].values[0].toISOString(), '2024-12-02T00:00:00.000Z');
    assert.equal(queries[2].values[0].toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(lockQueries.at(-1).query, 'SELECT pg_advisory_unlock($1)');
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('notification content rejects phone-number-like digit sequences', async () => {
  let connections = 0;
  const originalConnect = pool.connect;
  pool.connect = async () => {
    connections += 1;
    throw new Error('Database should not be reached for invalid message text.');
  };
  try {
    await assert.rejects(
      notifications.notify('user-id', {
        type: 'trip_scheduled',
        title: 'Trip scheduled',
        body: 'Call 071 234 5678 if needed.',
        channels: ['push'],
        idempotencyKey: 'trip_scheduled:trip-id:user-id',
      }),
      /must not contain a phone number/
    );
    assert.equal(connections, 0);
  } finally {
    pool.connect = originalConnect;
  }
});

test('device and preference request schemas validate inputs', () => {
  assert.equal(deviceSchema.safeParse({
    token: 'ExponentPushToken[abcdefghijklmnop]',
    platform: 'android',
    device_name: 'Phone',
  }).success, true);
  assert.equal(deviceSchema.safeParse({
    token: 'not-an-expo-token',
    platform: 'ios',
  }).success, false);
  assert.equal(notificationPreferencesSchema.safeParse({ push_enabled: false }).success, true);
  assert.equal(notificationPreferencesSchema.safeParse({}).success, false);
});
