const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const AppError = require('../src/utils/AppError');
const incidentService = require('../src/services/incidentService');
const driverTripService = require('../src/services/driverTripService');
const tripAdminService = require('../src/services/tripAdminService');
const tripService = require('../src/services/tripService');
const offersService = require('../src/services/offers');
const reviewService = require('../src/services/reviewService');
const { incidentCreateSchema } = require('../src/validators/incidentValidators');

function createMockClient(handler) {
  const statements = [];
  const client = {
    query: async (query, values) => {
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
  return { client, statements };
}

test('driver eligibility excludes expired driver and vehicle documents', async () => {
  const originalQuery = pool.query;
  let sql = '';
  pool.query = async (query) => {
    sql = query;
    return { rows: [] };
  };

  try {
    await tripService.listEligibleDrivers({
      scheduled_at: '2026-06-08T08:00:00+02:00',
      ends_at: '2026-06-08T10:00:00+02:00',
      passenger_count: 1,
    });
    assert.match(sql, /d\.licence_expiry >= CURRENT_DATE/);
    assert.match(sql, /d\.prdp_expiry IS NULL OR d\.prdp_expiry >= CURRENT_DATE/);
    assert.match(sql, /v\.licence_disc_expiry IS NULL OR v\.licence_disc_expiry >= CURRENT_DATE/);
    await offersService.getEligibleDrivers('series-id');
    assert.match(sql, /d\.licence_expiry >= CURRENT_DATE/);
    assert.match(sql, /v\.licence_disc_expiry IS NULL OR v\.licence_disc_expiry >= CURRENT_DATE/);
  } finally {
    pool.query = originalQuery;
  }
});

test('incident input accepts only supported types and a non-empty description', () => {
  assert.equal(incidentCreateSchema.safeParse({
    type: 'emergency',
    description: 'Need immediate assistance.',
  }).success, true);
  assert.equal(incidentCreateSchema.safeParse({
    type: 'unlisted_type',
    description: 'Need immediate assistance.',
  }).success, false);
  assert.equal(incidentCreateSchema.safeParse({
    type: 'other',
    description: '   ',
  }).success, false);
});

test('driver directory is paginated and includes expiry and performance fields', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query, values) => {
    statements.push({ query, values });
    if (query.includes('count(*)::int AS total')) return { rows: [{ total: 2 }] };
    return { rows: [{ user_id: 'driver-id' }] };
  };

  try {
    const result = await reviewService.listDriverDirectory({
      page: 2,
      page_size: 1,
      search: 'Dlamini',
    });
    assert.equal(result.pagination.page, 2);
    assert.match(statements[1].query, /d\.licence_expiry/);
    assert.match(statements[1].query, /average_rating/);
    assert.match(statements[1].query, /trip_count/);
    assert.match(statements[1].query, /AS trips_completed/);
    assert.match(statements[1].query, /AS withdrawals/);
    assert.match(statements[1].query, /AS late_withdrawals/);
    assert.match(statements[1].query, /AS missed_trips/);
    assert.deepEqual(statements[1].values, ['dlamini%', 1, 1]);
  } finally {
    pool.query = originalQuery;
  }
});

test('needs-attention aggregates recent no-shows and prioritises emergency incidents', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query) => {
    statements.push(query);
    return {
      rows: query.includes('open_incident_count')
        ? [{ open_incident_count: 0, open_emergency_count: 0 }]
        : query.includes('FROM notification_jobs')
          ? [{ count: 0 }]
          : [],
    };
  };

  try {
    const attention = await incidentService.getNeedsAttention();
    assert.deepEqual(Object.keys(attention), [
      'documents',
      'open_incidents',
      'overdue_trips',
      'completed_with_issues',
      'recent_no_shows',
      'unassigned_trips',
      'overdue_never_started_trips',
      'recent_withdrawals',
      'trips_waiting_for_driver_confirmation',
      'recent_missed_trips',
      'recent_expired_requests',
      'running_late_trips',
      'recent_declined_offers',
      'failed_notifications_last_24_hours',
      'open_incident_count',
      'open_emergency_count',
    ]);
    assert.ok(statements.some((query) => query.includes("CASE WHEN type = 'emergency' THEN 0")));
    assert.ok(statements.some((query) => query.includes("e.created_at >= now() - interval '7 days'")));
    assert.ok(statements.filter((query) =>
      !query.includes('open_incident_count') && !query.includes('FROM notification_jobs'))
      .every((query) => query.includes('LIMIT 100')));
    assert.ok(statements.every((query) => !/SELECT\s+\*/i.test(query)));
    assert.ok(statements.some((query) => query.includes('open_emergency_count')));
    assert.ok(statements.some((query) => query.includes('FROM trip_withdrawals')));
    assert.ok(statements.some((query) => query.includes('change_ack_required = TRUE')));
    assert.ok(statements.some((query) => query.includes("WHERE status = 'missed'")));
    assert.ok(statements.some((query) => query.includes("WHERE status = 'expired'")));
    assert.ok(statements.some((query) => query.includes("stop.eta_at > stop.planned_at + interval '10 minutes'")));
    assert.ok(statements.some((query) => query.includes("offer.status = 'declined'")));
  } finally {
    pool.query = originalQuery;
  }
});

test('driver cannot go available when a licence has expired', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = createMockClient((query) => {
    if (query.includes('SELECT d.status')) {
      return {
        rowCount: 1,
        rows: [{
          status: 'approved',
          has_vehicle: true,
          expired_documents: ['Driver licence'],
        }],
      };
    }
    if (query.includes('licence_expired')) {
      return {
        rowCount: 1,
        rows: [{ licence_expired: true, prdp_expired: false, licence_missing: false }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      driverTripService.setAvailability('driver-id', true),
      (error) => error instanceof AppError && /Driver licence/.test(error.message)
    );
    assert.ok(statements.some(({ query }) => query === 'ROLLBACK'));
    assert.equal(statements.some(({ query }) => query.includes('UPDATE drivers SET is_available')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('linked incident creation validates trip ownership and writes a trip event', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = createMockClient((query) => {
    if (query.includes('SELECT id FROM trips')) return { rowCount: 1, rows: [{ id: 'trip-id' }] };
    if (query.includes('INSERT INTO incidents')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'incident-id',
          trip_id: 'trip-id',
          type: 'vehicle_problem',
          status: 'open',
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const incident = await incidentService.create('driver-id', 'driver', {
      trip_id: 'trip-id',
      type: 'vehicle_problem',
      description: 'Tyre warning light is on.',
    });
    assert.equal(incident.id, 'incident-id');
    const event = statements.find(({ query }) => query.includes("VALUES ($1, 'incident.reported'"));
    assert.deepEqual(event.values, [
      'trip-id',
      'driver-id',
      'driver',
      null,
      { incident_id: 'incident-id', type: 'vehicle_problem' },
    ]);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('incident creation rejects a trip the reporter does not own', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = createMockClient((query) => {
    if (query.includes('SELECT id FROM trips')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      incidentService.create('driver-id', 'driver', {
        trip_id: 'another-driver-trip',
        type: 'emergency',
        description: 'Unsafe situation.',
      }),
      (error) => error instanceof AppError && error.statusCode === 404
    );
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO incidents')), false);
    assert.equal(statements.at(-1).query, 'ROLLBACK');
  } finally {
    pool.connect = originalConnect;
  }
});

test('force-completing a trip releases passengers who have not been dropped off', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = createMockClient((query) => {
    if (query.includes('SELECT id, status FROM trips')) {
      return { rowCount: 1, rows: [{ id: 'trip-id', status: 'in_progress' }] };
    }
    if (query.includes('bool_or(s.stop_type')) {
      return {
        rowCount: 2,
        rows: [
          { id: 'request-dropped', status: 'assigned', dropped_off: true },
          { id: 'request-remaining', status: 'assigned', dropped_off: false },
        ],
      };
    }
    if (query.includes('RETURNING id, status, completed_at, has_issues')) {
      return {
        rowCount: 1,
        rows: [{ id: 'trip-id', status: 'completed', has_issues: true }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await tripAdminService.forceComplete('trip-id', 'admin-id', {
      reason: 'Vehicle is no longer safe to drive.',
      release_remaining: true,
    });
    assert.ok(statements.some(({ query, values }) =>
      query.includes("SET status = 'pending', trip_id = NULL")
      && values[0] === 'request-remaining'
    ));
    assert.equal(statements.some(({ query, values }) =>
      query.includes("SET status = 'pending', trip_id = NULL")
      && values[0] === 'request-dropped'
    ), false);
    assert.ok(statements.some(({ query }) => query.includes("'trip.force_completed'")));
    assert.ok(statements.some(({ query }) => query.includes("VALUES ($1, 'trip.force_completed'")));
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});
