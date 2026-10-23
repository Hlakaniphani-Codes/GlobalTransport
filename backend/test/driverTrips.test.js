const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const driverTripService = require('../src/services/driverTripService');
const passengerTripService = require('../src/services/passengerTripService');
const offersService = require('../src/services/offers');
const tripController = require('../src/controllers/tripController');

function mockClient(handler) {
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
      if (query.includes('FROM trip_stops') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
        return handler(query.replace('ORDER BY id', 'ORDER BY sequence'), values, statements);
      }
      return handler(query, values, statements);
    },
    release() {},
  };
  return { client, statements };
}

test('driver offer listing only selects permitted unaccepted-offer information', async () => {
  const originalQuery = pool.query;
  let statement = '';
  let parameters;
  pool.query = async (query, values) => {
    statement = query;
    parameters = values;
    return { rows: [] };
  };
  const originalExpiry = offersService.processExpired;
  offersService.processExpired = async () => {};

  try {
    const result = await driverTripService.listOffers('driver-id');
    assert.deepEqual(parameters, ['driver-id', 26]);
    assert.deepEqual(result, { offers: [], next_cursor: null });
    assert.match(statement, /workplace_name/);
    assert.match(statement, /suburb/);
    assert.doesNotMatch(statement, /passenger_name|contact_number|stop\.address/);
    assert.doesNotMatch(statement, /home_address|workplace_address/);
  } finally {
    pool.query = originalQuery;
    offersService.processExpired = originalExpiry;
  }
});

test('driver home returns current next-trip and typed lifecycle attention data', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query) => {
    statements.push(query);
    if (query.includes('FROM drivers d')) {
      return {
        rowCount: 1,
        rows: [{
          name: 'Driver',
          status: 'approved',
          is_available: true,
          has_approved_vehicle: true,
          licence_valid: true,
          prdp_valid: true,
          expired_documents: [],
        }],
      };
    }
    if (query.includes('can_still_be_started')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'overdue-id',
          planned_at: '2026-04-01T09:00:00.000Z',
          can_still_be_started: true,
        }],
      };
    }
    if (query.includes('change_ack_required')) {
      return { rowCount: 1, rows: [{ id: 'changed-id', starts_at: '2026-04-02T09:00:00.000Z' }] };
    }
    if (query.includes('SELECT count(*)::int AS count FROM trips t')) {
      return { rowCount: 1, rows: [{ count: 2 }] };
    }
    if (query.includes('t.direction') && query.includes('LEFT JOIN LATERAL')) {
      return { rowCount: 1, rows: [{ id: 'next-id', status: 'accepted' }] };
    }
    if (query.includes("status = 'in_progress'")) {
      return { rowCount: 1, rows: [{ id: 'active-id', starts_at: '2026-04-01T10:00:00.000Z' }] };
    }
    if (query.includes('FROM trips t')) {
      return {
        rowCount: 1,
        rows: [{ id: 'next-id', status: 'accepted' }],
      };
    }
    if (query.includes('FROM trips')) return { rowCount: 1, rows: [{ count: 2 }] };
    if (query.includes('FROM trip_offers')) return { rowCount: 1, rows: [{ count: 1 }] };
    return { rowCount: 0, rows: [] };
  };
  try {
    const home = await driverTripService.getHome('driver-id');
    assert.equal(home.next_trip.id, 'next-id');
    assert.equal(home.upcoming_count, 2);
    assert.equal(home.pending_offers, 1);
    assert.deepEqual(home.attention.map(({ type }) => type), [
      'overdue_trip',
      'change_to_confirm',
      'in_progress_trip',
    ]);
    assert.equal(home.attention[0].can_still_be_started, true);
    assert.match(statements[1], /now\(\) <= t\.ends_at/);
    assert.match(statements[1], /OR t\.status = 'in_progress'/);
  } finally {
    pool.query = originalQuery;
  }
});

test('driver upcoming excludes trips whose planned first stop has passed; history includes missed', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query) => {
    statements.push(query);
    return query.includes('count(*)::int AS total')
      ? { rowCount: 1, rows: [{ total: 0 }] }
      : { rowCount: 0, rows: [] };
  };
  try {
    await driverTripService.listTrips('driver-id', {
      scope: 'upcoming',
      page: 1,
      page_size: 25,
    });
    assert.match(statements[0], /t\.status = 'accepted'/);
    assert.match(statements[0], />= now\(\)/);
    statements.length = 0;
    await driverTripService.listTrips('driver-id', {
      scope: 'history',
      page: 1,
      page_size: 25,
    });
    assert.match(statements[0], /'completed','cancelled','missed'/);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger upcoming and history queries use server-time lifecycle filters', async () => {
  const originalQuery = pool.query;
  let statement = '';
  pool.query = async (query) => {
    statement = query;
    return { rowCount: 0, rows: [] };
  };
  try {
    await passengerTripService.listMine('passenger-id', 'upcoming');
    assert.match(statement, /t\.status = 'in_progress' OR/);
    assert.match(statement, /COALESCE\([\s\S]*\) >= now\(\)/);
    await passengerTripService.listMine('passenger-id', 'history');
    assert.match(statement, /'completed','cancelled','missed'/);
  } finally {
    pool.query = originalQuery;
  }
});

test('accepting a pending series offer assigns every offered trip in one transaction', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT series_id, trip_id FROM trip_offers')) {
      return { rowCount: 1, rows: [{ series_id: 'series-id', trip_id: 'trip-id' }] };
    }
    if (query.includes('SELECT id FROM trip_series')) {
      return { rowCount: 1, rows: [{ id: 'series-id' }] };
    }
    if (query.includes('SELECT id, series_id, driver_user_id')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'offer-id',
          series_id: 'series-id',
          driver_user_id: 'driver-id',
          vehicle_id: 'vehicle-id',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000),
        }],
      };
    }
    if (query.includes('WITH proposed AS')) {
      return {
        rowCount: 1,
        rows: [{ user_id: 'driver-id', vehicle_id: 'vehicle-id' }],
      };
    }
    if (query.includes("status = 'pending' AND expires_at > now()")) {
      return { rowCount: 0, rows: [] };
    }
    if (query.includes("status = 'queued'")) return { rowCount: 0, rows: [] };
    if (query.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  });

  pool.connect = async () => client;

  try {
    const result = await offersService.respond('offer-id', 'driver-id', 'accept');
    const assignment = statements.find(({ query }) =>
      query.includes("SET status = 'accepted', driver_user_id")
    );
    assert.equal(result.accepted, true);
    assert.match(assignment.query, /WHERE series_id = \$3 AND status = 'offered'/);
    assert.deepEqual(assignment.values, ['driver-id', 'vehicle-id', 'series-id']);
    assert.ok(statements.some(({ query, values }) =>
      query.includes('INSERT INTO audit_logs') && values[1] === 'trip_series.accepted'
    ));
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('declining a series offer records a trip event and advances the queue', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT series_id, trip_id FROM trip_offers')) {
      return { rowCount: 1, rows: [{ series_id: 'series-id', trip_id: 'trip-id' }] };
    }
    if (query.includes('SELECT id FROM trip_series')) {
      return { rowCount: 1, rows: [{ id: 'series-id' }] };
    }
    if (query.includes('SELECT id, series_id, driver_user_id')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'offer-id',
          series_id: 'series-id',
          driver_user_id: 'driver-id',
          vehicle_id: 'vehicle-id',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000),
        }],
      };
    }
    if (query.includes("status = 'pending' AND expires_at > now()")) {
      return { rowCount: 0, rows: [] };
    }
    if (query.includes("status = 'queued'")) return { rowCount: 0, rows: [] };
    if (query.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const result = await offersService.respond('offer-id', 'driver-id', 'decline');
    const declineEvent = statements.find(({ query, values }) =>
      query.includes("VALUES ($1, 'trip_offer.declined'") && values[0] === 'trip-id'
    );
    assert.equal(result.declined, true);
    assert.deepEqual(declineEvent.values, ['trip-id', 'driver-id', { offer_id: 'offer-id' }]);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver offer acceptance passes the offer and authenticated driver IDs in service order', async () => {
  const originalRespond = offersService.respond;
  let received;
  offersService.respond = async (...args) => {
    received = args;
    return { accepted: true };
  };

  try {
    let response;
    await tripController.respondToOffer({
      auth: { userId: 'driver-id' },
      validatedParams: { offerId: 'offer-id' },
      validatedBody: { decision: 'accept' },
    }, {
      json: (value) => { response = value; },
    });
    assert.deepEqual(received, ['offer-id', 'driver-id', 'accept']);
    assert.deepEqual(response, { accepted: true });
  } finally {
    offersService.respond = originalRespond;
  }
});

test('driver cannot start a trip before its configured start window', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT t.id, t.status')) {
      return { rowCount: 1, rows: [{ id: 'trip-id', status: 'accepted', starts_at: new Date(Date.now() + 3 * 60 * 60_000) }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(driverTripService.startTrip('driver-id', 'trip-id'), /within the start window/);
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes("SET status = 'in_progress'")), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver cannot advance to another stop before the prior stop is completed or skipped', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT status FROM trips')) {
      return { rowCount: 1, rows: [{ status: 'in_progress' }] };
    }
    if (query.includes('SELECT id, sequence, status, stop_type')) {
      return {
        rowCount: 2,
        rows: [
          { id: 'first-stop', sequence: 1, status: 'pending', stop_type: 'pickup' },
          { id: 'second-stop', sequence: 2, status: 'pending', stop_type: 'dropoff' },
        ],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      driverTripService.updateStop('driver-id', 'trip-id', 'second-stop', 'arrive'),
      /previous stop/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('UPDATE trip_stops')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver arrival and completion actions update a consecutive same-address stop group together', async () => {
  const originalConnect = pool.connect;
  const groupedStops = [
    { id: 'first-stop', sequence: 1, status: 'pending', stop_type: 'pickup', address: '1 Main St', suburb: 'Midrand' },
    { id: 'second-stop', sequence: 2, status: 'pending', stop_type: 'pickup', address: ' 1 MAIN ST ', suburb: 'MIDRAND' },
    { id: 'third-stop', sequence: 3, status: 'pending', stop_type: 'dropoff', address: 'Office', suburb: null },
  ];
  const { client, statements } = mockClient((query, values) => {
    if (query.includes('SELECT status FROM trips')) {
      return { rowCount: 1, rows: [{ status: 'in_progress' }] };
    }
    if (query.includes('SELECT id, sequence, status, stop_type, address, suburb')) {
      return { rowCount: groupedStops.length, rows: groupedStops };
    }
    if (query.includes('UPDATE trip_stops')) {
      groupedStops.filter(({ id }) => values[2].includes(id))
        .forEach((stop) => { stop.status = values[0]; });
      return {
        rowCount: values[2].length,
        rows: values[2].map((id, index) => ({ id, sequence: index + 1, status: values[0] })),
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await driverTripService.updateStop('driver-id', 'trip-id', 'first-stop', 'arrive');
    await driverTripService.updateStop('driver-id', 'trip-id', 'first-stop', 'complete');
    const updates = statements.filter(({ query }) => query.includes('UPDATE trip_stops'));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates.map(({ values }) => values[2]), [
      ['first-stop', 'second-stop'],
      ['first-stop', 'second-stop'],
    ]);
    assert.deepEqual(updates.map(({ values }) => values[0]), ['arrived', 'completed']);
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver cannot complete a trip while stops remain unfinished', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT id, status FROM trips')) {
      return { rowCount: 1, rows: [{ id: 'trip-id', status: 'in_progress' }] };
    }
    if (query.includes('SELECT count(*)::int AS count FROM trip_stops')) {
      return { rowCount: 1, rows: [{ count: 1 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(driverTripService.completeTrip('driver-id', 'trip-id'), /every stop/);
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes("SET status = 'completed'")), false);
  } finally {
    pool.connect = originalConnect;
  }
});
