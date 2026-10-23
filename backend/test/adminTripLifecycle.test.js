const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const notificationService = require('../src/services/notifications');
const adminTripLifecycleService = require('../src/services/adminTripLifecycleService');
const {
  tripMarkMissedSchema,
  tripNotifyPassengersSchema,
  tripRescheduleSchema,
} = require('../src/validators/tripSeriesValidators');

const now = new Date('2026-04-01T08:00:00.000Z');

function makeTrip(overrides = {}) {
  return {
    id: 'trip-id',
    series_id: 'series-id',
    status: 'accepted',
    driver_user_id: 'driver-id',
    scheduled_at: '2026-04-01T10:00:00.000Z',
    starts_at: '2026-04-01T09:00:00.000Z',
    ends_at: '2026-04-01T11:00:00.000Z',
    started_at: null,
    rescheduled_at: null,
    change_ack_required: false,
    ...overrides,
  };
}

async function withMocks(handler, run) {
  const originalConnect = pool.connect;
  const originalNotify = notificationService.notify;
  const statements = [];
  const notifications = [];
  const client = {
    query: async (query, values = []) => {
      statements.push({ query, values });
      if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: 'series-id' }] };
      }
      if (query.includes('FROM trip_series WHERE id = $1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'series-id' }] };
      }
      if (query.includes('SELECT id FROM trips') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id' }] };
      }
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
    await run({ statements, notifications });
  } finally {
    pool.connect = originalConnect;
    notificationService.notify = originalNotify;
  }
}

function emptyResult() {
  return { rowCount: 0, rows: [] };
}

test('admin lifecycle schemas validate reschedule defaults and notification templates', () => {
  const reschedule = tripRescheduleSchema.parse({
    new_scheduled_at: '2036-04-02T10:00:00.000Z',
  });
  assert.equal(reschedule.shift_stops, true);
  assert.equal(reschedule.keep_driver, false);
  assert.equal(tripMarkMissedSchema.safeParse({ reason: 'Unable to run' }).success, true);
  assert.equal(tripMarkMissedSchema.safeParse({ reason: ' ' }).success, false);
  assert.equal(tripNotifyPassengersSchema.safeParse({
    template: 'delayed',
    minutes: 15,
  }).success, true);
  assert.equal(tripNotifyPassengersSchema.safeParse({
    template: 'custom',
    message: 'A short trip update.',
  }).success, true);
  assert.equal(tripNotifyPassengersSchema.safeParse({
    template: 'custom',
    message: 'x'.repeat(161),
  }).success, false);
});

test('reschedule shifts stop times and ride requests, retains driver for confirmation, and is retry-safe', async () => {
  let trip = makeTrip();
  const stops = [
    { id: 'stop-first', sequence: 1, planned_at: '2026-04-01T09:00:00.000Z' },
    { id: 'stop-last', sequence: 2, planned_at: '2026-04-01T11:00:00.000Z' },
  ];
  const stopUpdates = [];
  await withMocks(async (query, values) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('FROM trip_stops') && query.includes('FOR UPDATE')) {
      return { rowCount: stops.length, rows: stops };
    }
    if (query.includes('UPDATE trip_stops')) {
      stopUpdates.push(values[0]);
      return { rowCount: 1, rows: [] };
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    if (query.includes('RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id')) {
      trip = {
        ...trip,
        status: values[3],
        scheduled_at: values[1],
        change_ack_required: values[4],
      };
      return { rowCount: 1, rows: [{ id: trip.id, status: trip.status, scheduled_at: trip.scheduled_at }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const input = {
      new_scheduled_at: '2026-04-01T12:00:00.000Z',
      shift_stops: true,
      keep_driver: true,
    };
    const first = await adminTripLifecycleService.rescheduleTrip('trip-id', 'admin-id', input, { clock: () => now });
    assert.equal(first.status, 'accepted');
    assert.equal(first.rescheduled, true);
    assert.deepEqual(stopUpdates, ['stop-last', 'stop-first']);
    assert.ok(statements.some(({ query }) => query.includes('UPDATE ride_requests')));
    assert.ok(statements.some(({ query, values }) =>
      query.includes('INSERT INTO trip_events') && values[1] === 'trip.rescheduled'
    ));
    assert.ok(notifications.some(([, notification]) =>
      notification.type === 'trip_changed'
      && notification.body.startsWith('Trip changed: new time ')
    ));
    assert.ok(notifications.some(([, notification]) => notification.type === 'trip_rescheduled'));
    const writeCount = statements.filter(({ query }) =>
      query.includes('INSERT INTO audit_logs')
    ).length;
    const retry = await adminTripLifecycleService.rescheduleTrip('trip-id', 'admin-id', input, { clock: () => now });
    assert.equal(retry.rescheduled, false);
    assert.equal(statements.filter(({ query }) => query.includes('INSERT INTO audit_logs')).length, writeCount);
    assert.equal(notifications.length, 2);
  });
});

test('home reschedule without shifting updates the first stop instead of requiring an arrival target', async () => {
  const trip = makeTrip({
    direction: 'home',
    scheduled_at: '2026-04-01T09:00:00.000Z',
    starts_at: '2026-04-01T09:00:00.000Z',
    ends_at: '2026-04-01T11:00:00.000Z',
  });
  const stopUpdateValues = [];
  await withMocks(async (query, values) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('FROM trip_stops') && query.includes('FOR UPDATE')) {
      return {
        rowCount: 2,
        rows: [
          { id: 'stop-first', sequence: 1, planned_at: '2026-04-01T09:00:00.000Z' },
          { id: 'stop-last', sequence: 2, planned_at: '2026-04-01T11:00:00.000Z' },
        ],
      };
    }
    if (query.includes('UPDATE trip_stops')) stopUpdateValues.push(values);
    if (query.includes('RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id')) {
      return { rowCount: 1, rows: [{ id: trip.id, status: 'unassigned' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ statements }) => {
    const result = await adminTripLifecycleService.rescheduleTrip('trip-id', 'admin-id', {
      new_scheduled_at: '2026-04-01T09:30:00.000Z',
      shift_stops: false,
      keep_driver: false,
    }, { clock: () => now });
    assert.equal(result.rescheduled, true);
    assert.deepEqual(stopUpdateValues, [['stop-first', '2026-04-01T09:30:00.000Z']]);
    assert.ok(statements.some(({ query }) => query.includes('SET scheduled_at = $2::timestamptz')));
  });
});

test('rescheduling without retaining an accepted driver clears assignment and unassigns the trip', async () => {
  let trip = makeTrip();
  await withMocks(async (query, values) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('FROM trip_stops') && query.includes('FOR UPDATE')) return emptyResult();
    if (query.includes('RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id')) {
      trip = { ...trip, status: values[3], scheduled_at: values[1], driver_user_id: null };
      return { rowCount: 1, rows: [{ id: trip.id, status: trip.status }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const result = await adminTripLifecycleService.rescheduleTrip('trip-id', 'admin-id', {
      new_scheduled_at: '2026-04-01T12:00:00.000Z',
      shift_stops: false,
      keep_driver: false,
    }, { clock: () => now });
    assert.equal(result.status, 'unassigned');
    assert.ok(statements.some(({ query }) => query.includes('driver_user_id = CASE WHEN $5 THEN')));
    assert.ok(notifications.some(([, notification]) =>
      notification.data.screen === 'driver'
      && notification.body === 'A trip assignment has changed. Check the app for the latest details.'
    ));
  });
});

test('rescheduling a draft trip preserves its draft status', async () => {
  let trip = makeTrip({ status: 'draft', driver_user_id: null });
  await withMocks(async (query, values) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('FROM trip_stops') && query.includes('FOR UPDATE')) return emptyResult();
    if (query.includes('RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id')) {
      trip = { ...trip, status: values[3], scheduled_at: values[1] };
      return { rowCount: 1, rows: [{ id: trip.id, status: trip.status }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ statements }) => {
    const result = await adminTripLifecycleService.rescheduleTrip('trip-id', 'admin-id', {
      new_scheduled_at: '2026-04-01T12:00:00.000Z',
      shift_stops: false,
      keep_driver: false,
    }, { clock: () => now });
    assert.equal(result.status, 'draft');
    const update = statements.find(({ query }) =>
      query.includes('RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id')
    );
    assert.equal(update.values[3], 'draft');
  });
});

test('admin marks a trip missed once, updates requests, and notifies passengers', async () => {
  let trip = makeTrip();
  let missedRequests = 0;
  await withMocks(async (query, values) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes("SET status = 'missed'") && query.includes('UPDATE trips')) {
      trip = { ...trip, status: 'missed', closed_reason: values[1] };
      return { rowCount: 1, rows: [{ id: trip.id, status: trip.status, closed_reason: trip.closed_reason }] };
    }
    if (query.includes('UPDATE ride_requests')) missedRequests += 1;
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const first = await adminTripLifecycleService.markTripMissed(
      'trip-id',
      'admin-id',
      'No driver was available.',
      { clock: () => now }
    );
    const retry = await adminTripLifecycleService.markTripMissed(
      'trip-id',
      'admin-id',
      'No driver was available.',
      { clock: () => now }
    );
    assert.equal(first.status, 'missed');
    assert.equal(retry.marked, false);
    assert.equal(missedRequests, 1);
    assert.equal(notifications.filter(([, notification]) => notification.type === 'trip_missed').length, 1);
    assert.ok(statements.some(({ query, values }) =>
      query.includes('INSERT INTO trip_events') && values[1] === 'trip.admin_marked_missed'
    ));
  });
});

test('reinstatement restores only future requests and writes an audit event', async () => {
  let restored = false;
  await withMocks(async (query) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [makeTrip({ status: 'missed', driver_user_id: null })] };
    }
    if (query.includes('UPDATE ride_requests request')) {
      if (restored) return emptyResult();
      restored = true;
      return { rowCount: 1, rows: [{ id: 'future-request' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ statements }) => {
    const first = await adminTripLifecycleService.reinstateTripPassengers('trip-id', 'admin-id', { clock: () => now });
    const second = await adminTripLifecycleService.reinstateTripPassengers('trip-id', 'admin-id', { clock: () => now });
    assert.equal(first.reinstated_count, 1);
    assert.equal(second.reinstated_count, 0);
    assert.ok(statements.some(({ query }) => query.includes('request.scheduled_at >')));
    assert.equal(statements.filter(({ query }) => query.includes('INSERT INTO audit_logs')).length, 1);
  });
});

test('admin passenger notification templates are idempotent and reject private details in custom text', async () => {
  let notifiedEvent = false;
  await withMocks(async (query) => {
    if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [makeTrip()] };
    }
    if (query.includes('u.name, u.surname')) {
      return {
        rowCount: 1,
        rows: [{
          passenger_user_id: 'passenger-id',
          name: 'Passenger',
          surname: 'One',
          contact_number: '0712345678',
          address: '12 Main Street',
          suburb: 'Central',
        }],
      };
    }
    if (query.includes("event_type = 'trip.passengers_notified'")) {
      return notifiedEvent ? { rowCount: 1, rows: [{ id: 'event-id' }] } : emptyResult();
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    if (query.includes("VALUES ($1, $2, $3, 'admin', $4)")) notifiedEvent = true;
    return { rowCount: 1, rows: [] };
  }, async ({ notifications }) => {
    const first = await adminTripLifecycleService.notifyPassengers(
      'trip-id',
      'admin-id',
      { template: 'delayed', minutes: 10 }
    );
    const retry = await adminTripLifecycleService.notifyPassengers(
      'trip-id',
      'admin-id',
      { template: 'delayed', minutes: 10 }
    );
    assert.equal(first.already_notified, false);
    assert.equal(retry.already_notified, true);
    assert.equal(notifications.length, 1);
    await assert.rejects(
      adminTripLifecycleService.notifyPassengers('trip-id', 'admin-id', {
        template: 'custom',
        message: 'Passenger One will be picked up at 12 Main Street.',
      }),
      /must not contain passenger names or contact details/
    );
  });
});
