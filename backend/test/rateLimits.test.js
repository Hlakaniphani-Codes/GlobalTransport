const assert = require('node:assert/strict');
const express = require('express');
const { test } = require('node:test');
const { createAuthRateLimits } = require('../src/middleware/authRateLimit');
const { createUserRateLimits } = require('../src/middleware/userRateLimit');

function createApp(middlewares) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/resource', (req, res, next) => {
    if (req.get('x-user-id')) req.auth = { userId: req.get('x-user-id') };
    next();
  }, ...middlewares, (req, res) => res.status(200).json({ ok: true }));
  app.get('/resource', (req, res, next) => {
    if (req.get('x-user-id')) req.auth = { userId: req.get('x-user-id') };
    next();
  }, ...middlewares, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('authenticated request budgets are per user and writes have their own limit', async () => {
  const limits = createUserRateLimits({ generalLimit: 2, writeLimit: 1 });
  const app = createApp([limits.general, limits.writes]);
  await withServer(app, async (baseUrl) => {
    const get = (userId, ip) => fetch(`${baseUrl}/resource`, {
      headers: { 'X-User-Id': userId, 'X-Forwarded-For': ip },
    });
    assert.equal((await get('user-a', '198.51.100.10')).status, 200);
    assert.equal((await get('user-a', '198.51.100.11')).status, 200);
    const limitedUser = await get('user-a', '198.51.100.12');
    assert.equal(limitedUser.status, 429);
    assert.equal((await get('user-b', '198.51.100.10')).status, 200);

    const post = (userId, ip) => fetch(`${baseUrl}/resource`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'X-Forwarded-For': ip,
      },
      body: '{}',
    });
    assert.equal((await post('write-user', '203.0.113.1')).status, 200);
    const limitedWrite = await post('write-user', '203.0.113.2');
    assert.equal(limitedWrite.status, 429);
    assert.ok(Number(limitedWrite.headers.get('retry-after')) > 0);
    assert.deepEqual(await limitedWrite.json(), {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many changes. Please try again shortly.',
      },
    });
  });
});

test('login attempts are limited by normalized account and a higher shared-IP ceiling', async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  const [accountLimit, ipLimit] = createAuthRateLimits({ accountLimit: 2, ipLimit: 5 });
  app.post('/login', accountLimit, ipLimit, (req, res) => res.status(200).json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const login = (email) => fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.25',
      },
      body: JSON.stringify({ email }),
    });
    assert.equal((await login('Driver@example.test')).status, 200);
    assert.equal((await login('driver@example.test')).status, 200);
    const accountLimited = await login('DRIVER@example.test');
    assert.equal(accountLimited.status, 429);
    assert.equal((await login('passenger@example.test')).status, 200);
    assert.equal((await login('another@example.test')).status, 200);
    assert.equal((await login('last@example.test')).status, 200);
    const sharedIpLimited = await login('final@example.test');
    assert.equal(sharedIpLimited.status, 429);
    assert.ok(Number(sharedIpLimited.headers.get('retry-after')) > 0);
    assert.deepEqual(await sharedIpLimited.json(), {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Please try again later.',
      },
    });
  });
});
