const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const notificationService = require('../src/services/notifications');
const recoveryService = require('../src/services/driverTripRecoveryService');
const {
  driverTripEndEarlySchema,
  driverTripNotHappenedSchema,
  driverTripWithdrawSchema,
} = require('../src/validators/operationsValidators');

const now = new Date('2026-04-01T10:00:00.000Z');

function makeTrip(overrides = {}) {
  return {
    id: 'trip-id',
    series_id: 'series-id',
    driver_user_id: 'driver-id',
    vehicle_id: 'vehicle-id',
    status: 'accepted',
    scheduled_at: '2026-04-01T12:00:00.000Z',
    starts_at: '2026-04-01T11:00:00.000Z',
    ends_at: '2026-04-01T13:00:00.000Z',
    started_at: null,
    closed_by: null,
    closed_reason: null,
    change_ack_required: false,
    change_acknowledged_at: null,
    first_stop_at: '2026-04-01T12:00:00.000Z',
    ...overrides,
  };
}

async function withRecoveryMocks(handler, run) {
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
        return {
          rowCount: 3,
          rows: [{ id: 'first-trip' }, { id: 'second-trip' }, { id: 'trip-id' }],
        };
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
    return await run({ notifications, statements });
  } finally {
    pool.connect = originalConnect;
    notificationService.notify = originalNotify;
  }
}

function emptyResult() {
  return { rowCount: 0, rows: [] };
}

test('driver recovery schemas validate reason kinds, scope, and Other notes', () => {
  assert.equal(driverTripWithdrawSchema.safeParse({
    reason_kind: 'other',
    scope: 'this',
    note: 'Valid note',
  }).success, true);
  assert.equal(driverTripWithdrawSchema.safeParse({
    reason_kind: 'other',
    scope: 'this',
    note: 'bad',
  }).success, false);
  assert.equal(driverTripWithdrawSchema.parse({
    reason_kind: 'personal',
  }).scope, 'this');
  assert.equal(driverTripNotHappenedSchema.safeParse({
    reason_kind: 'other',
    note: 'No',
  }).success, false);
  assert.equal(driverTripEndEarlySchema.safeParse({
    reason: 'other',
    note: 'Vehicle issue',
  }).success, true);
  assert.equal(driverTripEndEarlySchema.safeParse({
    reason: 'other',
    note: 'bad',
  }).success, false);
});

test('withdrawal is late when the first stop is within the window and retries do not duplicate actions', async () => {
  const trip = makeTrip({ first_stop_at: '2026-04-01T12:00:00.000Z' });
  let withdrawal;
  let tripState = { ...trip };
  await withRecoveryMocks(async (query, values) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...tripState }] };
    }
    if (query.includes('FROM trip_withdrawals')) {
      return withdrawal ? { rowCount: 1, rows: [withdrawal] } : emptyResult();
    }
    if (query.includes('INSERT INTO trip_series')) return { rowCount: 1, rows: [{ id: 'new-series' }] };
    if (query.includes('UPDATE trips') && query.includes("status = 'unassigned'")) {
      tripState = { ...tripState, status: 'unassigned', driver_user_id: null };
      return { rowCount: 1, rows: [{ id: trip.id, status: 'unassigned' }] };
    }
    if (query.includes('INSERT INTO trip_withdrawals')) {
      withdrawal = {
        trip_id: values[0],
        driver_user_id: values[1],
        reason_kind: values[2],
        note: values[3],
        scope: values[4],
        late: values[5],
      };
      return { rowCount: 1, rows: [] };
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const input = { reason_kind: 'vehicle_problem', scope: 'this' };
    const first = await recoveryService.withdrawTrip('driver-id', 'trip-id', input, { clock: () => now });
    const second = await recoveryService.withdrawTrip('driver-id', 'trip-id', input, { clock: () => now });
    assert.equal(first.trips_withdrawn, 1);
    assert.equal(withdrawal.late, true);
    assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
    assert.equal(second.trip.status, 'unassigned');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][1].type, 'driver_withdrew_reassigning');
    assert.equal(notifications[0][1].body, "Your trip is being reassigned. We'll confirm shortly.");
    assert.ok(statements.some(({ query }) => query.includes('trip.unassigned_driver_attention')));
    assert.equal(statements.filter(({ query }) => query.includes('INSERT INTO trip_withdrawals')).length, 1);
  });
});

test('all_future withdrawal detaches every later accepted trip into a new series', async () => {
  const first = makeTrip({ id: 'first-trip', first_stop_at: '2026-04-02T09:00:00.000Z' });
  const second = makeTrip({
    id: 'second-trip',
    scheduled_at: '2026-04-03T12:00:00.000Z',
    first_stop_at: '2026-04-03T11:00:00.000Z',
  });
  const trips = new Map([[first.id, first], [second.id, second]]);
  const withdrawals = [];
  let seriesNumber = 0;
  await withRecoveryMocks(async (query, values) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...trips.get(values[0]) }] };
    }
    if (query.includes('FROM trip_withdrawals')) return emptyResult();
    if (query.includes('WHERE trip.series_id = $1')) {
      return { rowCount: 2, rows: [first, second] };
    }
    if (query.includes('INSERT INTO trip_series')) {
      seriesNumber += 1;
      return { rowCount: 1, rows: [{ id: `new-series-${seriesNumber}` }] };
    }
    if (query.includes("status = 'unassigned'")) {
      const item = trips.get(values[0]);
      trips.set(values[0], { ...item, status: 'unassigned', driver_user_id: null });
      return { rowCount: 1, rows: [{ id: values[0], status: 'unassigned' }] };
    }
    if (query.includes('INSERT INTO trip_withdrawals')) {
      withdrawals.push(values);
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const result = await recoveryService.withdrawTrip(
      'driver-id',
      'first-trip',
      { reason_kind: 'schedule_conflict', scope: 'all_future' },
      { clock: () => now }
    );
    assert.equal(result.trips_withdrawn, 2);
    assert.equal(withdrawals.length, 2);
    assert.ok(withdrawals.every((values) => values[4] === 'all_future'));
    assert.equal(statements.filter(({ query }) => query.includes('INSERT INTO trip_series')).length, 2);
    assert.equal(notifications.length, 0);
  });
});

test('withdrawal enforces trip ownership before writing changes', async () => {
  await withRecoveryMocks(async (query) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...makeTrip({ driver_user_id: 'different-driver' }) }] };
    }
    return emptyResult();
  }, async ({ statements }) => {
    await assert.rejects(
      recoveryService.withdrawTrip(
        'driver-id',
        'trip-id',
        { reason_kind: 'personal', scope: 'this' },
        { clock: () => now }
      ),
      /Assigned trip not found/
    );
    assert.equal(statements.some(({ query }) => query.includes('UPDATE trips')), false);
  });
});

test('report, early-end, and change acknowledgement enforce trip ownership', async () => {
  const trip = makeTrip({
    driver_user_id: 'different-driver',
    status: 'in_progress',
    change_ack_required: true,
  });
  await withRecoveryMocks(async (query) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    return emptyResult();
  }, async ({ statements }) => {
    await assert.rejects(
      recoveryService.closeAsMissed('driver-id', 'trip-id', { reason_kind: 'could_not_start' }, { clock: () => now }),
      /Assigned trip not found/
    );
    await assert.rejects(
      recoveryService.endEarly('driver-id', 'trip-id', { reason: 'vehicle_problem' }, { clock: () => now }),
      /Assigned trip not found/
    );
    await assert.rejects(
      recoveryService.acknowledgeChange('driver-id', 'trip-id', { clock: () => now }),
      /Assigned trip not found/
    );
    assert.equal(statements.some(({ query }) => /UPDATE trips|INSERT INTO/.test(query)), false);
  });
});

test('driver report closes only overdue trips and retries are idempotent', async () => {
  let trip = makeTrip({
    ends_at: '2026-04-01T09:29:00.000Z',
  });
  let incidentCount = 0;
  await withRecoveryMocks(async (query, values) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes("SET status = 'missed'") && query.includes('UPDATE trips')) {
      trip = { ...trip, status: 'missed', closed_by: 'driver-id', closed_reason: values[1] };
      return { rowCount: 1, rows: [{ id: trip.id, status: trip.status, closed_reason: trip.closed_reason }] };
    }
    if (query.includes('INSERT INTO incidents')) {
      incidentCount += 1;
      return { rowCount: 1, rows: [{ id: 'incident-id' }] };
    }
    if (query.includes('SELECT DISTINCT passenger_user_id')) {
      return { rowCount: 1, rows: [{ passenger_user_id: 'passenger-id' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications }) => {
    await assert.rejects(
      recoveryService.closeAsMissed(
        'driver-id',
        'trip-id',
        { reason_kind: 'could_not_start' },
        { clock: () => new Date('2026-04-01T09:40:00.000Z') }
      ),
      /can still be started/
    );
    const input = { reason_kind: 'could_not_start' };
    await recoveryService.closeAsMissed('driver-id', 'trip-id', input, { clock: () => now });
    await recoveryService.closeAsMissed('driver-id', 'trip-id', input, { clock: () => now });
    assert.equal(trip.status, 'missed');
    assert.equal(incidentCount, 1);
    assert.equal(notifications.length, 1);
  });
});

test('end early completes with issues, returns unfinished requests, and is idempotent', async () => {
  let trip = makeTrip({ status: 'in_progress' });
  let incidentCount = 0;
  await withRecoveryMocks(async (query, values) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('SELECT request.id, request.passenger_user_id')) {
      return { rowCount: 1, rows: [{ id: 'request-id', passenger_user_id: 'passenger-id' }] };
    }
    if (query.includes('UPDATE trips') && query.includes("status = 'completed'")) {
      trip = {
        ...trip,
        status: 'completed',
        has_issues: true,
        completed_at: values[1],
        closed_by: 'driver-id',
        closed_reason: values[2],
      };
      return {
        rowCount: 1,
        rows: [{
          id: trip.id,
          status: trip.status,
          has_issues: true,
          completed_at: trip.completed_at,
          closed_reason: trip.closed_reason,
          closed_by: trip.closed_by,
        }],
      };
    }
    if (query.includes("event_type = 'trip.ended_early'")) {
      return {
        rowCount: 1,
        rows: [{ metadata: { affected_request_count: 1 } }],
      };
    }
    if (query.includes('INSERT INTO incidents')) {
      incidentCount += 1;
      return { rowCount: 1, rows: [{ id: 'incident-id' }] };
    }
    return { rowCount: 1, rows: [] };
  }, async ({ notifications, statements }) => {
    const input = { reason: 'vehicle_problem' };
    const first = await recoveryService.endEarly('driver-id', 'trip-id', input, { clock: () => now });
    const second = await recoveryService.endEarly('driver-id', 'trip-id', input, { clock: () => now });
    assert.equal(first.affected_request_count, 1);
    assert.equal(second.status, 'completed');
    assert.equal(second.affected_request_count, first.affected_request_count);
    assert.equal(incidentCount, 1);
    assert.equal(notifications.length, 1);
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'pending', trip_id = NULL")));
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'skipped'")));
  });
});

test('change acknowledgement is repeatable and only updates a pending acknowledgement once', async () => {
  let trip = makeTrip({ change_ack_required: true });
  let updates = 0;
  await withRecoveryMocks(async (query, values) => {
    if (query.includes('WHERE trip.id = $1') && query.includes('FOR UPDATE OF trip')) {
      return { rowCount: 1, rows: [{ ...trip }] };
    }
    if (query.includes('SET change_ack_required = FALSE')) {
      updates += 1;
      trip = { ...trip, change_ack_required: false, change_acknowledged_at: values[1] };
      return { rowCount: 1, rows: [{ id: trip.id, change_ack_required: false, change_acknowledged_at: values[1] }] };
    }
    return { rowCount: 1, rows: [] };
  }, async () => {
    const first = await recoveryService.acknowledgeChange('driver-id', 'trip-id', { clock: () => now });
    const second = await recoveryService.acknowledgeChange('driver-id', 'trip-id', { clock: () => now });
    assert.equal(first.change_ack_required, false);
    assert.equal(second.change_ack_required, false);
    assert.equal(updates, 1);
  });
});
