const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const notificationService = require('../src/services/notifications');
const { processLifecycle } = require('../src/services/tripLifecycleService');

const fixedNow = new Date('2026-04-01T10:00:00.000Z');
const config = {
  autoMissAfterMinutes: 60,
  requestExpireGraceMinutes: 15,
  unassignedAlertHours: 3,
};

async function withLifecycleMocks(handler, run) {
  const originalConnect = pool.connect;
  const originalNotify = notificationService.notify;
  const statements = [];
  const notifications = [];
  const client = {
    query: async (query, values = []) => {
      statements.push({ query, values });
      return handler(query, values, statements);
    },
    release() {},
  };
  pool.connect = async () => client;
  notificationService.notify = async (...args) => {
    notifications.push(args);
    return null;
  };
  try {
    return await run({ notifications, statements });
  } finally {
    pool.connect = originalConnect;
    notificationService.notify = originalNotify;
  }
}

function emptyResult() {
  return { rowCount: 0, rows: [] };
}

test('auto-misses an accepted trip once after its planned end and notifies its driver and passengers', async () => {
  let tripStatus = 'accepted';
  await withLifecycleMocks(async (query) => {
    if (query.includes('SELECT DISTINCT series_id') && query.includes('FROM trips')) {
      return tripStatus === 'accepted'
        ? { rowCount: 1, rows: [{ series_id: 'series-id' }] }
        : emptyResult();
    }
    if (query.includes('FROM trip_series') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ id: 'series-id' }] };
    }
    if (query.includes('FROM trips trip') && query.includes("trip.status = 'accepted'")) {
      return tripStatus === 'accepted'
        ? { rowCount: 1, rows: [{
          id: 'trip-id',
          driver_user_id: 'driver-id',
          scheduled_at: '2026-04-01T08:00:00.000Z',
          ends_at: '2026-04-01T08:30:00.000Z',
        }] }
        : emptyResult();
    }
    if (query.includes("SET status = 'missed'") && query.includes('UPDATE trips')) {
      tripStatus = 'missed';
      return { rowCount: 1, rows: [{ id: 'trip-id' }] };
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    if (query.includes('SELECT id, series_id, scheduled_at')) return emptyResult();
    if (query.includes('SELECT id, passenger_user_id, scheduled_at')) return emptyResult();
    if (query.includes('WITH upcoming AS')) return emptyResult();
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const first = await processLifecycle({ clock: () => fixedNow, config });
    const second = await processLifecycle({ clock: () => fixedNow, config });
    assert.deepEqual(first, {
      missed_trips: 1,
      expired_unassigned_trips: 0,
      expired_requests: 0,
      admin_attention: 0,
    });
    assert.equal(second.missed_trips, 0);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0][0], 'driver-id');
    assert.match(notifications[0][1].body, /closed because it did not start/);
    assert.equal(notifications[1][0], 'passenger-id');
    assert.match(notifications[1][1].body, /We couldn't complete your trip on/);
    const dueQuery = statements.find(({ query }) =>
      query.includes("trip.status = 'accepted'")
    );
    assert.deepEqual(dueQuery.values, [fixedNow.toISOString(), 60]);
    assert.ok(statements.some(({ query }) => query.includes("'trip.missed'")));
    const seriesLockIndex = statements.findIndex(({ query }) =>
      query.includes('FROM trip_series') && query.includes('FOR UPDATE')
    );
    const tripLockIndex = statements.findIndex(({ query }) =>
      query.includes('FROM trips trip') && query.includes('FOR UPDATE SKIP LOCKED')
    );
    assert.ok(seriesLockIndex >= 0 && tripLockIndex > seriesLockIndex);
  });
});

test('cancels expired draft and unassigned trips, their offers, and assigned requests', async () => {
  await withLifecycleMocks(async (query) => {
    if (query.includes('SELECT id, series_id, scheduled_at')) {
      return { rowCount: 1, rows: [{
        id: 'unassigned-trip',
        series_id: 'series-id',
        scheduled_at: '2026-04-01T08:00:00.000Z',
      }] };
    }
    if (query.includes("SET status = 'cancelled'") && query.includes('UPDATE trips')) {
      return { rowCount: 1, rows: [{ id: 'unassigned-trip' }] };
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) return emptyResult();
    return emptyResult();
  }, async ({ statements }) => {
    const result = await processLifecycle({ clock: () => fixedNow, config });
    assert.equal(result.expired_unassigned_trips, 1);
    assert.ok(statements.some(({ query }) =>
      query.includes('UPDATE trip_offers') && query.includes("status IN ('pending','queued')")
    ));
    assert.ok(statements.some(({ query, values }) =>
      query.includes("SET status = 'missed', closed_reason = 'expired_unassigned'")
        && values[0] === 'unassigned-trip'
    ));
    assert.ok(statements.some(({ query }) => query.includes("'trip.expired_unassigned'")));
  });
});

test('expires pending ride requests with no trip after the configured grace period', async () => {
  await withLifecycleMocks(async (query) => {
    if (query.includes('SELECT id, passenger_user_id, scheduled_at')) {
      return { rowCount: 1, rows: [{
        id: 'request-id',
        passenger_user_id: 'passenger-id',
        scheduled_at: '2026-04-01T09:00:00.000Z',
      }] };
    }
    if (query.includes("SET status = 'expired'")) return { rowCount: 1, rows: [{ id: 'request-id' }] };
    return emptyResult();
  }, async ({ notifications, statements }) => {
    const result = await processLifecycle({ clock: () => fixedNow, config });
    assert.equal(result.expired_requests, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], 'passenger-id');
    assert.equal(notifications[0][1].type, 'request_expired');
    assert.equal(notifications[0][1].data.screen, 'passenger_requests');
    assert.match(notifications[0][1].body, /We couldn't arrange a trip for/);
    const dueQuery = statements.find(({ query }) =>
      query.includes('scheduled_at <= $1::timestamptz')
    );
    assert.deepEqual(dueQuery.values, [fixedNow.toISOString(), 15]);
  });
});

test('creates one admin attention event for an unassigned trip starting within the configured window', async () => {
  let created = false;
  await withLifecycleMocks(async (query, values) => {
    if (query.includes('WITH upcoming AS')) {
      assert.deepEqual(values, [fixedNow.toISOString(), 3]);
      if (created) return emptyResult();
      created = true;
      return { rowCount: 1, rows: [{ trip_id: 'trip-id' }] };
    }
    return emptyResult();
  }, async () => {
    const first = await processLifecycle({ clock: () => fixedNow, config });
    const second = await processLifecycle({ clock: () => fixedNow, config });
    assert.equal(first.admin_attention, 1);
    assert.equal(second.admin_attention, 0);
  });
});
