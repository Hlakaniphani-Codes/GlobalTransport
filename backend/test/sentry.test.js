const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initializeSentry, sanitizeEvent } = require('../src/utils/sentry');

test('Sentry is disabled when no DSN is configured', () => {
  assert.equal(initializeSentry(null), null);
});

test('Sentry event sanitization removes personal request context', () => {
  const event = {
    transaction: 'GET /api/v1/trips/private-id?token=private',
    user: { email: 'person@example.invalid' },
    request: {
      method: 'GET',
      url: 'https://api.example.invalid/trips/private-id?token=private',
      headers: { Authorization: 'Bearer secret' },
      data: { contact_number: 'private' },
    },
    breadcrumbs: [{ data: { email: 'person@example.invalid' } }],
    extra: { query: 'private' },
  };
  sanitizeEvent(event);
  assert.equal(event.transaction, 'HTTP request');
  assert.deepEqual(event.request, { method: 'GET', url: '/' });
  assert.deepEqual(event.breadcrumbs, []);
  assert.equal(event.user, undefined);
  assert.equal(event.extra, undefined);
});
