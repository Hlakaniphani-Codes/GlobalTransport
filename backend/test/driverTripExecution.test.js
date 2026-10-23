const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const executionService = require('../src/services/driverTripExecutionService');
const notificationService = require('../src/services/notifications');
const {
  driverTripActionSchema,
  driverTripCompleteStopSchema,
  driverTripEtaSchema,
  stopSkipSchema,
  tripDelaySchema,
} = require('../src/validators/operationsValidators');

function executionFixture() {
  const startsAt = new Date(Date.now() + 10 * 60_000);
  const trip = {
    id: 'trip-id',
    series_id: 'series-id',
    direction: 'to_work',
    scheduled_at: new Date(startsAt.getTime() + 30 * 60_000),
    starts_at: startsAt,
    ends_at: new Date(startsAt.getTime() + 60 * 60_000),
    workplace_name: 'Office',
    workplace_address: '10 Work Road',
    distance_km: null,
    notes: null,
    status: 'accepted',
    started_at: null,
    completed_at: null,
    has_issues: false,
    delay_minutes: 0,
    delay_reported_at: null,
    change_ack_required: false,
  };
  const stops = [
    {
      id: 'pickup-1', ride_request_id: 'request-1', sequence: 1, stop_type: 'pickup',
      address: '1 Main Road', suburb: 'Midrand', planned_at: startsAt,
      status: 'pending', en_route_at: null, arrived_at: null, completed_at: null,
      skip_kind: null, skip_reason: null, passenger_name: 'A', passenger_surname: 'One',
      contact_number: '000', eta_at: null, eta_updated_at: null,
      eta_notified_at: null, eta_notified_for: null,
    },
    {
      id: 'dropoff-1', ride_request_id: 'request-1', sequence: 2, stop_type: 'dropoff',
      address: '10 Work Road', suburb: 'Midrand', planned_at: trip.scheduled_at,
      status: 'pending', en_route_at: null, arrived_at: null, completed_at: null,
      skip_kind: null, skip_reason: null, passenger_name: 'A', passenger_surname: 'One',
      contact_number: '000', eta_at: null, eta_updated_at: null,
      eta_notified_at: null, eta_notified_for: null,
    },
  ];
  const events = [];
  const requests = new Map([['request-1', 'assigned']]);
  const statements = [];
  const client = {
    query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: 'series-id' }] };
      }
      if (sql.includes('FROM trip_series WHERE id = $1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'series-id' }] };
      }
      if (sql.includes('SELECT id FROM trips') && sql.includes('ORDER BY id') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: trip.id }] };
      }
      if (sql.includes('FROM trips WHERE id = $1 AND driver_user_id = $2 FOR UPDATE')) {
        if (values[1] !== 'driver-id') return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            id: trip.id,
            status: trip.status,
            direction: trip.direction,
            starts_at: trip.starts_at,
            scheduled_at: trip.scheduled_at,
            ends_at: trip.ends_at,
            started_at: trip.started_at,
            has_issues: trip.has_issues,
            change_ack_required: trip.change_ack_required,
          }],
        };
      }
      if (sql.includes('FROM trips t')) return { rowCount: 1, rows: [{ ...trip }] };
      if (sql.includes('FROM trip_stops') && sql.includes('ORDER BY id') && sql.includes('FOR UPDATE')) {
        return { rowCount: stops.length, rows: stops.map((stop) => ({ ...stop })) };
      }
      if (sql.includes('FROM trip_stops s') && sql.includes('JOIN users u')) {
        return { rowCount: stops.length, rows: stops.map((stop) => ({ ...stop })) };
      }
      if (sql.includes('count(DISTINCT ride_request_id)::int AS count')) {
        return { rowCount: 1, rows: [{ count: 1 }] };
      }
      if (sql.includes('FROM trip_events WHERE trip_id')) {
        return { rowCount: events.length, rows: events.map((event) => ({ ...event })) };
      }
      if (sql.includes("UPDATE trips SET status = 'in_progress'")) {
        trip.status = 'in_progress';
        trip.started_at ??= new Date();
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE trips SET status = 'completed'")) {
        trip.status = 'completed';
        trip.completed_at ??= new Date();
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE trips SET has_issues = TRUE')) {
        trip.has_issues = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE trip_stops')) {
        const ids = Array.isArray(values[0]) ? values[0] : [];
        if (sql.includes('SET eta_at = now()')) {
          const etaAt = new Date(Date.now() + values[1] * 60_000);
          const updatedAt = new Date(Date.now());
          for (const stop of stops.filter(({ id }) => ids.includes(id))) {
            stop.eta_at = etaAt;
            stop.eta_updated_at = updatedAt;
            if (values[2]) {
              stop.eta_notified_at = updatedAt;
              stop.eta_notified_for = etaAt;
            }
          }
          return { rowCount: ids.length, rows: [{ eta_at: etaAt }] };
        }
        const status = sql.includes("status = 'en_route'") ? 'en_route'
          : sql.includes("status = 'arrived'") ? 'arrived'
            : sql.includes("status = 'completed'") ? 'completed' : 'skipped';
        for (const stop of stops.filter(({ id }) => ids.includes(id))) {
          stop.status = status;
          if (status === 'en_route') stop.en_route_at ??= new Date();
          if (status === 'arrived') stop.arrived_at ??= new Date();
          if (status === 'completed' || status === 'skipped') stop.completed_at ??= new Date();
          if (status === 'skipped') {
            stop.skip_kind = sql.includes("skip_kind = 'no_show'") ? 'no_show' : values[1];
            stop.skip_reason = sql.includes('skip_reason = $3') ? values[2] : values[1];
          }
        }
        return { rowCount: ids.length, rows: [] };
      }
      if (sql.includes("UPDATE ride_requests SET status = 'no_show'")) {
        requests.set(values[0], 'no_show');
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE ride_requests SET status = 'completed'")) {
        for (const [id, status] of requests) if (status === 'assigned') requests.set(id, 'completed');
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO trip_events')) {
        events.push({
          id: `event-${events.length + 1}`,
          trip_id: values[0],
          stop_id: values[1],
          event_type: values[2],
          actor_role: 'driver',
          client_time: values[4],
          metadata: values[5],
          created_at: new Date(),
        });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { client, events, requests, statements, stops, trip };
}

test('driver execution action schemas validate optional client times and action-specific bodies', () => {
  assert.deepEqual(driverTripActionSchema.parse(undefined), {});
  assert.deepEqual(driverTripCompleteStopSchema.parse(undefined), {});
  assert.equal(stopSkipSchema.safeParse({ kind: 'no_show', reason: 'Called passenger' }).success, true);
  assert.equal(stopSkipSchema.safeParse({ reason: 'Missing kind' }).success, false);
  assert.equal(tripDelaySchema.safeParse({ minutes: 15 }).success, true);
  assert.equal(tripDelaySchema.safeParse({ minutes: 7 }).success, false);
  assert.equal(driverTripEtaSchema.safeParse({ minutes: 1 }).success, true);
  assert.equal(driverTripEtaSchema.safeParse({ minutes: 120 }).success, true);
  assert.equal(driverTripEtaSchema.safeParse({ minutes: 0 }).success, false);
  assert.equal(driverTripEtaSchema.safeParse({ minutes: 121 }).success, false);
  assert.equal(driverTripEtaSchema.safeParse({ minutes: '10' }).success, false);
});

test('trip details return grouped execution state, elapsed wait and server-approved actions', async () => {
  const originalQuery = pool.query;
  const fixture = executionFixture();
  pool.query = fixture.client.query;
  try {
    const trip = await executionService.getTrip('driver-id', 'trip-id');
    assert.equal(trip.stop_groups.length, 2);
    assert.equal(trip.stop_groups[0].status, 'pending');
    assert.equal(trip.allowed_next_actions.start, true);
    assert.equal(trip.stop_groups[0].stops[0].wait_seconds, 0);
    assert.equal(trip.stop_groups[0].stops[0].allowed_actions.no_show, false);
  } finally {
    pool.query = originalQuery;
  }
});

test('trip details expose contact numbers only for the current en-route or arrived pick-up', async () => {
  const originalQuery = pool.query;
  const fixture = executionFixture();
  fixture.trip.status = 'in_progress';
  fixture.stops[0].status = 'en_route';
  fixture.stops[1].status = 'pending';
  pool.query = fixture.client.query;
  try {
    const pickupTrip = await executionService.getTrip('driver-id', 'trip-id');
    assert.equal(pickupTrip.stop_groups[0].stops[0].contact_number, '000');
    assert.equal(pickupTrip.stop_groups[1].stops[0].contact_number, null);

    fixture.stops[0].status = 'completed';
    fixture.stops[1].status = 'arrived';
    const dropoffTrip = await executionService.getTrip('driver-id', 'trip-id');
    assert.equal(dropoffTrip.stop_groups[1].stops[0].contact_number, null);
    assert.equal(dropoffTrip.stops[0].contact_number, null);
  } finally {
    pool.query = originalQuery;
  }
});

test('trip details allow a late start until the planned end grace expires', async () => {
  const originalQuery = pool.query;
  const fixture = executionFixture();
  fixture.stops[0].planned_at = new Date(Date.now() - 10 * 60_000);
  fixture.trip.starts_at = fixture.stops[0].planned_at;
  fixture.trip.ends_at = new Date(Date.now() + 20 * 60_000);
  pool.query = fixture.client.query;
  try {
    const trip = await executionService.getTrip('driver-id', 'trip-id');
    assert.equal(trip.allowed_next_actions.start, true);
    assert.equal(trip.allowed_next_actions.report_not_happened, false);
  } finally {
    pool.query = originalQuery;
  }
});

async function withFixture(run) {
  const originalConnect = pool.connect;
  const originalWait = process.env.NO_SHOW_WAIT_MINUTES;
  const fixture = executionFixture();
  pool.connect = async () => fixture.client;
  process.env.NO_SHOW_WAIT_MINUTES = '5';
  try {
    await run(fixture);
  } finally {
    pool.connect = originalConnect;
    if (originalWait === undefined) delete process.env.NO_SHOW_WAIT_MINUTES;
    else process.env.NO_SHOW_WAIT_MINUTES = originalWait;
  }
}

test('starting an assigned trip moves its first stop group en route and is idempotent', async () => {
  await withFixture(async ({ events, stops, statements }) => {
    const first = await executionService.startTrip('driver-id', 'trip-id');
    const repeated = await executionService.startTrip('driver-id', 'trip-id');
    assert.equal(first.status, 'in_progress');
    assert.equal(first.stop_groups[0].status, 'en_route');
    assert.equal(repeated.status, 'in_progress');
    assert.equal(stops[0].status, 'en_route');
    assert.equal(events.filter(({ event_type }) => event_type === 'trip.started').length, 1);
    assert.equal(statements.filter(({ sql }) => sql.includes("UPDATE trips SET status = 'in_progress'")).length, 1);
  });
});

test('starting remains available after the first stop until the planned-end grace expires', async () => {
  await withFixture(async ({ stops, trip }) => {
    stops[0].planned_at = new Date(Date.now() - 10 * 60_000);
    trip.starts_at = stops[0].planned_at;
    trip.ends_at = new Date(Date.now() + 20 * 60_000);
    const started = await executionService.startTrip('driver-id', 'trip-id');
    assert.equal(started.status, 'in_progress');
    assert.equal(trip.status, 'in_progress');
  });
});

test('a trip cannot be started after the planned end and grace period', async () => {
  await withFixture(async ({ stops, trip }) => {
    stops[0].planned_at = new Date(Date.now() - 10 * 60_000);
    trip.starts_at = stops[0].planned_at;
    trip.ends_at = new Date(Date.now() - 31 * 60_000);
    await assert.rejects(
      executionService.startTrip('driver-id', 'trip-id'),
      /can no longer be started/
    );
    assert.equal(trip.status, 'accepted');
  });
});

test('completing a stop group advances the next group and completes the trip automatically', async () => {
  await withFixture(async ({ events, requests, stops, trip }) => {
    await executionService.startTrip('driver-id', 'trip-id');
    await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'arrive', {});
    const afterPickup = await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'complete', {});
    assert.equal(afterPickup.current_stop_group_id, 'dropoff-1');
    assert.equal(stops[1].status, 'en_route');
    await executionService.updateStop('driver-id', 'trip-id', 'dropoff-1', 'arrive', {});
    const completed = await executionService.updateStop('driver-id', 'trip-id', 'dropoff-1', 'complete', {});
    assert.equal(completed.status, 'completed');
    assert.equal(trip.status, 'completed');
    assert.equal(requests.get('request-1'), 'completed');
    assert.equal(events.filter(({ event_type }) => event_type === 'trip.completed').length, 1);
  });
});

test('no-show waits for the configured period, skips the matching drop-off and is idempotent', async () => {
  await withFixture(async ({ events, requests, stops }) => {
    await executionService.startTrip('driver-id', 'trip-id');
    await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'arrive', {});
    await assert.rejects(
      executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'skip', {
        kind: 'no_show',
        reason: 'Passenger did not arrive',
      }),
      /Wait .* before recording a no-show/
    );
    stops[0].arrived_at = new Date(Date.now() - 6 * 60_000);
    const skipped = await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'skip', {
      kind: 'no_show',
      reason: 'Passenger did not arrive',
    });
    await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'skip', {
      kind: 'no_show',
      reason: 'Passenger did not arrive',
    });
    assert.equal(stops[0].skip_kind, 'no_show');
    assert.equal(stops[1].skip_kind, 'no_show');
    assert.equal(requests.get('request-1'), 'no_show');
    assert.equal(skipped.status, 'completed');
    assert.equal(events.filter(({ event_type }) => event_type === 'stop.no_show').length, 1);
  });
});

test('drop-off exception records an issue and still auto-completes with the trip', async () => {
  await withFixture(async ({ events, trip }) => {
    await executionService.startTrip('driver-id', 'trip-id');
    await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'arrive', {});
    await executionService.updateStop('driver-id', 'trip-id', 'pickup-1', 'complete', {});
    await executionService.updateStop('driver-id', 'trip-id', 'dropoff-1', 'arrive', {});
    const completed = await executionService.updateStop('driver-id', 'trip-id', 'dropoff-1', 'skip', {
      kind: 'address_problem',
      reason: 'Building entrance is closed',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.has_issues, true);
    assert.equal(trip.has_issues, true);
    assert.equal(events.filter(({ event_type }) => event_type === 'stop_group.exception').length, 1);
  });
});

test('driver ETA is set for the current en-route group and notifies its passengers once', async () => {
  await withFixture(async ({ events, stops, trip }) => {
    const now = Date.now();
    const originalNow = Date.now;
    const originalNotify = notificationService.notifyTripPassengers;
    const notifications = [];
    Date.now = () => now;
    notificationService.notifyTripPassengers = async (...args) => notifications.push(args);
    try {
      trip.status = 'in_progress';
      stops[0].status = 'en_route';
      const current = await executionService.setStopEta('driver-id', 'trip-id', 'pickup-1', 20);
      assert.equal(stops[0].eta_at.getTime(), now + 20 * 60_000);
      assert.equal(current.stop_groups[0].eta_is_fresh, true);
      assert.deepEqual(current.eta_quick_options, [5, 10, 15, 20, 30, 45, 60]);
      assert.equal(events.at(-1).event_type, 'eta_set');
      assert.deepEqual(events.at(-1).metadata, { minutes: 20 });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0][2], 'driver_eta');
      assert.deepEqual(notifications[0][3].rideRequestIds, ['request-1']);
    } finally {
      Date.now = originalNow;
      notificationService.notifyTripPassengers = originalNotify;
    }
  });
});

test('driver ETA updates obey the five-minute notification throttle and freshness window', async () => {
  await withFixture(async ({ stops, trip }) => {
    const now = Date.now();
    const originalNow = Date.now;
    const originalNotify = notificationService.notifyTripPassengers;
    const notifications = [];
    Date.now = () => now;
    notificationService.notifyTripPassengers = async (...args) => notifications.push(args);
    try {
      trip.status = 'in_progress';
      stops[0].status = 'en_route';
      await executionService.setStopEta('driver-id', 'trip-id', 'pickup-1', 20);
      await executionService.setStopEta('driver-id', 'trip-id', 'pickup-1', 22);
      assert.equal(notifications.length, 1);
      Date.now = () => now + 5 * 60_000;
      await executionService.setStopEta('driver-id', 'trip-id', 'pickup-1', 27);
      assert.equal(notifications.length, 2);
      assert.equal(executionService.etaIsFresh(new Date(now).toISOString(), now + 15 * 60_000), true);
      assert.equal(executionService.etaIsFresh(new Date(now).toISOString(), now + 15 * 60_000 + 1), false);
      assert.equal(stops[0].eta_at.getTime(), now + 32 * 60_000);
    } finally {
      Date.now = originalNow;
      notificationService.notifyTripPassengers = originalNotify;
    }
  });
});

test('driver ETA is rejected for another driver or any stop other than the current en-route group', async () => {
  await withFixture(async ({ stops, trip }) => {
    trip.status = 'in_progress';
    stops[0].status = 'en_route';
    await assert.rejects(
      executionService.setStopEta('other-driver', 'trip-id', 'pickup-1', 10),
      /Assigned trip not found/
    );
    await assert.rejects(
      executionService.setStopEta('driver-id', 'trip-id', 'dropoff-1', 10),
      /current stop while it is on the way/
    );
    stops[0].status = 'pending';
    await assert.rejects(
      executionService.setStopEta('driver-id', 'trip-id', 'pickup-1', 10),
      /current stop while it is on the way/
    );
  });
});
