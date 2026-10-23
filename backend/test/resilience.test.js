const assert = require('node:assert/strict');
const express = require('express');
const { test } = require('node:test');
const app = require('../index');
const pool = require('../src/db');
const requestTimeout = require('../src/middleware/requestTimeout');
const { recordWorkerTick } = require('../src/utils/workerMetrics');

async function listen(application) {
  const server = application.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('request timeout returns a retryable 503', async () => {
  const application = express();
  application.use(requestTimeout(5));
  application.get('/', async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!res.writableEnded) res.json({ status: 'late' });
  });
  const server = await listen(application);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The request took too long. Please try again shortly.',
      },
    });
  } finally {
    await close(server);
  }
});

test('malformed and oversized request bodies return 400 and 413', async () => {
  const server = await listen(app);
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/api/v1/auth/login`;
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: { code: 'BAD_REQUEST', message: 'Request body must contain valid JSON.' },
    });

    const oversized = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'x'.repeat(100 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
    });
  } finally {
    await close(server);
  }
});

test('metrics endpoint requires a bearer token and exposes protected operational metrics', async () => {
  const originalQuery = pool.query;
  const originalToken = process.env.METRICS_TOKEN;
  const server = await listen(app);
  try {
    process.env.METRICS_TOKEN = 'metrics-test-token';
    pool.query = async (query) => {
      if (query.includes('GROUP BY status')) {
        return { rows: [{ status: 'pending', count: 4 }, { status: 'failed', count: 1 }] };
      }
      if (query.includes('FROM trip_offers')) return { rows: [{ count: 2 }] };
      if (query.includes('FROM trips')) return { rows: [{ count: 3 }] };
      throw new Error(`Unexpected metrics query: ${query}`);
    };
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/metrics`;
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);
    const invalidToken = await fetch(url, {
      headers: { Authorization: 'Bearer incorrect-token' },
    });
    assert.equal(invalidToken.status, 401);
    const authorized = await fetch(url, {
      headers: { Authorization: 'Bearer metrics-test-token' },
    });
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('content-type') ?? '', /text\/plain/);
    const body = await authorized.text();
    assert.match(body, /http_requests_total/);
    assert.match(body, /db_pool_waiting_connections/);
    assert.match(body, /db_query_duration_seconds/);
    assert.match(body, /worker_tick_duration_seconds/);
    assert.match(body, /notification_jobs/);
    assert.match(body, /active_offers/);
    assert.match(body, /trips_in_progress/);
  } finally {
    pool.query = originalQuery;
    if (originalToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalToken;
    await close(server);
  }
});

test('readiness requires PostgreSQL, all migrations and a recent worker heartbeat', async () => {
  const originalQuery = pool.query;
  const server = await listen(app);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/health/ready`;
  try {
    pool.query = async () => ({
      rows: [{ database_ready: 1, migrations_applied: true }],
    });
    const liveServer = await fetch(`http://127.0.0.1:${address.port}/health/live`);
    assert.equal(liveServer.status, 200);

    recordWorkerTick({ durationMs: 2, oldestDueJobAgeSeconds: 0 });
    const ready = await fetch(url);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });

    pool.query = async () => ({
      rows: [{ database_ready: 1, migrations_applied: false }],
    });
    const migrationsPending = await fetch(url);
    assert.equal(migrationsPending.status, 503);

    pool.query = async () => { throw Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' }); };
    const databaseDown = await fetch(url);
    assert.equal(databaseDown.status, 503);

    pool.query = async () => ({
      rows: [{ database_ready: 1, migrations_applied: true }],
    });
    const recovered = await fetch(url);
    assert.equal(recovered.status, 200);

    recordWorkerTick({
      durationMs: 2,
      oldestDueJobAgeSeconds: 0,
      completedAt: new Date(Date.now() - 121_000).toISOString(),
    });
    const workerStale = await fetch(url);
    assert.equal(workerStale.status, 503);
    recordWorkerTick({ durationMs: 2, oldestDueJobAgeSeconds: 0 });

    pool.query = () => new Promise(() => {});
    const startedAt = Date.now();
    const databaseTimeout = await fetch(url);
    assert.equal(databaseTimeout.status, 503);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    pool.query = originalQuery;
    await close(server);
  }
});
