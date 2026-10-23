const assert = require('node:assert/strict');
const express = require('express');
const { test } = require('node:test');
const {
  computePollAfterSeconds,
  createResponseBehavior,
} = require('../src/middleware/responseBehavior');
const { createResponseCache } = require('../src/middleware/responseCache');

test('poll intervals use active, idle, background, and load-shedding values', () => {
  assert.equal(computePollAfterSeconds({
    path: '/driver/home',
    payload: { next_trip: { status: 'in_progress' } },
  }), 15);
  assert.equal(computePollAfterSeconds({
    path: '/driver/home',
    payload: { next_trip: null },
  }), 60);
  assert.equal(computePollAfterSeconds({
    path: '/driver/home',
    payload: { next_trip: { status: 'in_progress' } },
    eventLoopLagMs: 80,
  }), 30);
  assert.equal(computePollAfterSeconds({
    path: '/driver/home',
    payload: { next_trip: { status: 'in_progress' } },
    poolWaitingCount: 5,
  }), 60);
  assert.equal(computePollAfterSeconds({
    path: '/notifications',
    payload: {},
    background: true,
  }), 120);
});

test('conditional GET requests return a weak ETag and 304 without a body', async () => {
  const app = express();
  app.set('etag', 'weak');
  const middleware = createResponseBehavior({
    getEventLoopLagMs: () => 0,
    getPoolWaitingCount: () => 0,
  });
  let homeResponse = { next_trip: null };
  app.use((req, res, next) => {
    req.originalUrl = `/api/v1${req.originalUrl}`;
    middleware(req, res, next);
  });
  app.get('/driver/home', (req, res) => res.json(homeResponse));
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/driver/home`;
    const first = await fetch(url);
    const etag = first.headers.get('etag');
    assert.match(etag, /^W\/"/);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal((await first.json()).poll_after_seconds, 60);

    const second = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');

    homeResponse = { next_trip: { id: 'trip-2', status: 'in_progress' } };
    const changed = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.deepEqual(await changed.json(), {
      next_trip: { id: 'trip-2', status: 'in_progress' },
      poll_after_seconds: 15,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('response cache expires entries, maintains LRU bounds, and clears on invalidation', () => {
  let now = 0;
  const cache = createResponseCache({ ttlMs: 15, maxEntries: 2, now: () => now });
  const request = (url) => ({ method: 'GET', originalUrl: url });
  const makeResponse = () => {
    let body;
    const response = {
      statusCode: 200,
      status(status) {
        response.statusCode = status;
        return response;
      },
      json(value) {
        body = value;
        return response;
      },
    };
    return { response, body: () => body };
  };
  const run = (url, value) => {
    const { response, body } = makeResponse();
    let calledNext = false;
    cache.middleware(request(url), response, () => {
      calledNext = true;
      response.json(value);
    });
    return { calledNext, body: body() };
  };

  assert.equal(run('/api/v1/admin/dashboard/summary', { count: 1 }).calledNext, true);
  assert.equal(run('/api/v1/admin/needs-attention', { count: 2 }).calledNext, true);
  assert.equal(run('/api/v1/admin/dashboard/summary', { count: 9 }).calledNext, false);
  assert.deepEqual(run('/api/v1/admin/dashboard/summary', { count: 9 }).body, { count: 1 });
  run('/api/v1/admin/companies?page=1', { companies: [] });
  assert.equal(cache.size(), 2);
  let continued = false;
  cache.invalidateMiddleware({ method: 'POST' }, {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(cache.size(), 0);
  run('/api/v1/admin/dashboard/summary', { count: 4 });
  assert.equal(cache.size(), 1);
  now = 20;
  assert.equal(run('/api/v1/admin/dashboard/summary', { count: 3 }).calledNext, true);
  cache.clear();
  assert.equal(cache.size(), 0);
});
