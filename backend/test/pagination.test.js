const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  decodeCursor,
  encodeCursor,
  normalizePagination,
  paginationMetadata,
} = require('../src/utils/pagination');
const pool = require('../src/db');
const driverTripService = require('../src/services/driverTripService');
const adminRideRequestService = require('../src/services/adminRideRequestService');
const notificationService = require('../src/services/notifications');
const reviewService = require('../src/services/reviewService');
const offersService = require('../src/services/offers');
const tripService = require('../src/services/tripService');
const tripAdminService = require('../src/services/tripAdminService');
const workplaceService = require('../src/services/workplaceService');
const passengerTripService = require('../src/services/passengerTripService');
const rideRequestService = require('../src/services/rideRequestService');

test('pagination defaults to page one and 25 rows', () => {
  assert.deepEqual(normalizePagination(), { page: 1, page_size: 25 });
});

test('pagination enforces a maximum page size of 100', () => {
  assert.deepEqual(normalizePagination({ page: 2, page_size: 1000 }), {
    page: 2,
    page_size: 100,
  });
});

test('pagination metadata clamps the requested page to the final page', () => {
  assert.deepEqual(paginationMetadata(51, { page: 9, page_size: 25 }), {
    page: 3,
    page_size: 25,
    total: 51,
    total_pages: 3,
  });
});

test('eligible drivers bind the series ID separately from pagination parameters', async () => {
  const originalQuery = pool.query;
  let statement = '';
  let parameters;
  pool.query = async (query, values) => {
    statement = query;
    parameters = values;
    return {
      rows: [{
        total: 1,
        user_id: 'driver-id',
        name: 'Driver',
        surname: 'Example',
        vehicle_id: 'vehicle-id',
      }],
    };
  };

  try {
    const result = await offersService.listEligibleDrivers('series-uuid', {
      page: 2,
      page_size: 10,
    });
    assert.deepEqual(parameters, ['series-uuid', 10, 2]);
    assert.match(statement, /WHERE t\.series_id = \$1/);
    assert.match(statement, /LIMIT \$2\s+OFFSET GREATEST\(0, LEAST\(\s*\(\$3 - 1\) \* \$2/);
    assert.equal(result.pagination.total, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test('history cursors round-trip timestamp and id', () => {
  const cursor = encodeCursor('2026-10-22T05:00:00.000Z', '01234567-89ab-cdef-0123-456789abcdef');
  assert.deepEqual(decodeCursor(cursor), {
    sort_at: '2026-10-22T05:00:00.000Z',
    id: '01234567-89ab-cdef-0123-456789abcdef',
  });
});

test('history cursors reject malformed input', () => {
  assert.throws(() => decodeCursor('not-a-cursor'), /cursor is invalid/);
});

test('passenger trip history returns a next cursor at the 25-row boundary', async () => {
  const originalQuery = pool.query;
  const rows = Array.from({ length: 26 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    starts_at: `2026-10-${String(22 - Math.floor(index / 24)).padStart(2, '0')}T05:00:00.000Z`,
    scheduled_at: '2026-10-22T05:00:00.000Z',
  }));
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows };
  };

  try {
    const result = await passengerTripService.listHistoryPage('passenger-id');
    assert.equal(result.trips.length, 25);
    assert.equal(values.at(-1), 26);
    assert.match(statement, /ORDER BY COALESCE\(t\.starts_at, t\.scheduled_at\) DESC, t\.id DESC/);
    assert.deepEqual(decodeCursor(result.next_cursor), {
      sort_at: rows[24].starts_at,
      id: rows[24].id,
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger trip history applies the cursor tuple to the next page', async () => {
  const originalQuery = pool.query;
  const cursor = encodeCursor('2026-10-22T05:00:00.000Z', '00000000-0000-4000-8000-000000000025');
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows: [] };
  };

  try {
    const result = await passengerTripService.listHistoryPage('passenger-id', cursor);
    assert.equal(result.next_cursor, null);
    assert.match(statement, /\(COALESCE\(t\.starts_at, t\.scheduled_at\), t\.id\)/);
    assert.deepEqual(values.slice(0, 3), [
      'passenger-id',
      '2026-10-22T05:00:00.000Z',
      '00000000-0000-4000-8000-000000000025',
    ]);
    assert.equal(values.at(-1), 26);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger requests return a next cursor at the 25-row boundary', async () => {
  const originalQuery = pool.query;
  const rows = Array.from({ length: 26 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    scheduled_at: `2026-10-${String(22 - Math.floor(index / 24)).padStart(2, '0')}T05:00:00.000Z`,
    status: 'completed',
  }));
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows };
  };

  try {
    const result = await rideRequestService.listMine('passenger-id');
    assert.equal(result.ride_requests.length, 25);
    assert.equal(values.at(-1), 26);
    assert.match(statement, /ORDER BY r\.scheduled_at DESC, r\.id DESC/);
    assert.deepEqual(decodeCursor(result.next_cursor), {
      sort_at: rows[24].scheduled_at,
      id: rows[24].id,
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger requests apply the cursor tuple to the next page', async () => {
  const originalQuery = pool.query;
  const cursor = encodeCursor('2026-10-22T05:00:00.000Z', '00000000-0000-4000-8000-000000000025');
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows: [] };
  };

  try {
    const result = await rideRequestService.listMine('passenger-id', cursor);
    assert.equal(result.next_cursor, null);
    assert.match(statement, /\(r\.scheduled_at, r\.id\) < \(\$2::timestamptz, \$3::uuid\)/);
    assert.deepEqual(values, [
      'passenger-id',
      '2026-10-22T05:00:00.000Z',
      '00000000-0000-4000-8000-000000000025',
      26,
    ]);
  } finally {
    pool.query = originalQuery;
  }
});

test('driver trip history returns a next cursor at the 25-row boundary', async () => {
  const originalQuery = pool.query;
  const rows = Array.from({ length: 26 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    starts_at: `2026-10-${String(22 - Math.floor(index / 24)).padStart(2, '0')}T05:00:00.000Z`,
    scheduled_at: '2026-10-22T05:00:00.000Z',
  }));
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows };
  };

  try {
    const result = await driverTripService.listTrips('driver-id', { scope: 'history' });
    assert.equal(result.trips.length, 25);
    assert.equal(values.at(-1), 26);
    assert.match(statement, /ORDER BY COALESCE\(t\.starts_at, t\.scheduled_at\) DESC, t\.id DESC/);
    assert.deepEqual(decodeCursor(result.next_cursor), {
      sort_at: rows[24].starts_at,
      id: rows[24].id,
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('driver trip history applies the cursor tuple to the next page', async () => {
  const originalQuery = pool.query;
  const cursor = encodeCursor('2026-10-22T05:00:00.000Z', '00000000-0000-4000-8000-000000000025');
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return { rows: [] };
  };

  try {
    const result = await driverTripService.listTrips('driver-id', { scope: 'history', cursor });
    assert.equal(result.next_cursor, null);
    assert.match(statement, /\(COALESCE\(t\.starts_at, t\.scheduled_at\), t\.id\)/);
    assert.deepEqual(values, [
      'driver-id',
      '2026-10-22T05:00:00.000Z',
      '00000000-0000-4000-8000-000000000025',
      26,
    ]);
  } finally {
    pool.query = originalQuery;
  }
});

test('admin ride request list clamps database limit to 100', async () => {
  const originalQuery = pool.query;
  let listValues;
  pool.query = async (query, values) => {
    if (query.includes('count(*)')) return { rows: [{ total: 250 }] };
    listValues = values;
    return { rows: [] };
  };

  try {
    const result = await adminRideRequestService.list({ page: 1, page_size: 1000 });
    assert.equal(listValues.at(-2), 100);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
});

test('admin trip list clamps database limit to 100', async () => {
  const originalQuery = pool.query;
  let listValues;
  pool.query = async (query, values) => {
    if (query.includes('count(*)')) return { rows: [{ total: 250 }] };
    listValues = values;
    return { rows: [] };
  };

  try {
    const result = await tripAdminService.listTrips({ page: 1, page_size: 1000 });
    assert.equal(listValues.at(-2), 100);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger upcoming trip list clamps its page size to 100', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (query, values) => {
    calls.push({ query, values });
    return query.includes('count(*)::int AS total')
      ? { rows: [{ total: 250 }] }
      : { rows: [] };
  };

  try {
    const result = await passengerTripService.listUpcomingPage('passenger-id', {
      page: 1,
      page_size: 1000,
    });
    assert.deepEqual(calls[1].values, ['passenger-id', 100, 0]);
    assert.match(calls[1].query, /LIMIT \$2 OFFSET \$3/);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
});

test('admin notification log clamps database limit to 100', async () => {
  const originalQuery = pool.query;
  let listValues;
  pool.query = async (query, values) => {
    if (query.includes('count(*)')) return { rows: [{ total: 250 }] };
    listValues = values;
    return { rows: [] };
  };

  try {
    const result = await notificationService.listNotificationLog({ page: 1, page_size: 1000 });
    assert.equal(listValues.at(-2), 100);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
});

test('eligible driver list clamps its database limit to 100', async () => {
  const originalQuery = pool.query;
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return {
      rows: [{
        total: 250,
        user_id: 'driver-id',
        name: 'Driver',
        surname: 'One',
        contact_number: '000',
        vehicle_id: 'vehicle-id',
        make: 'Van',
        model: 'Transit',
        registration_number: 'ABC123',
        seat_count: 8,
      }],
    };
  };

  try {
    const result = await tripService.listEligibleDrivers({
      scheduled_at: '2026-10-22T05:00:00.000Z',
      ends_at: '2026-10-22T08:00:00.000Z',
      passenger_count: 4,
      page: 1,
      page_size: 1000,
    });
    assert.equal(values.at(-2), 100);
    assert.equal(result.pagination.page_size, 100);
    assert.match(statement, /LIMIT \$4/);
    assert.doesNotMatch(statement, /SELECT\s+\*/i);
  } finally {
    pool.query = originalQuery;
  }
});

test('series eligible driver list clamps its database limit to 100', async () => {
  const originalQuery = pool.query;
  let statement = '';
  let values;
  pool.query = async (query, parameters) => {
    statement = query;
    values = parameters;
    return {
      rows: [{
        total: 250,
        user_id: 'driver-id',
        name: 'Driver',
        surname: 'One',
        vehicle_id: 'vehicle-id',
        make: 'Van',
        model: 'Transit',
        registration_number: 'ABC123',
        seat_count: 8,
        is_available: true,
        has_push_device: false,
      }],
    };
  };

  try {
    const result = await offersService.listEligibleDrivers(
      'series-id',
      { page: 1, page_size: 1000 }
    );
    assert.deepEqual(values, ['series-id', 100, 1]);
    assert.equal(result.pagination.page_size, 100);
    assert.match(statement, /LIMIT \$2/);
    assert.doesNotMatch(statement, /SELECT\s+\*/i);
  } finally {
    pool.query = originalQuery;
  }
});

for (const [name, list] of [
  ['public workplaces', workplaceService.listPublicWorkplaces],
  ['admin workplaces', workplaceService.listWorkplaces],
  ['admin companies', workplaceService.listCompanies],
]) {
  test(`${name} list clamps database limit to 100`, async () => {
    const originalQuery = pool.query;
    let listValues;
    pool.query = async (query, values) => {
      if (query.includes('count(*)')) return { rows: [{ total: 250 }] };
      listValues = values;
      return { rows: [] };
    };

    try {
      const result = await list({ page: 1, page_size: 1000 });
      assert.equal(listValues.at(-2), 100);
      assert.equal(result.pagination.page_size, 100);
    } finally {
      pool.query = originalQuery;
    }
  });
}

test('admin workplace search is filtered and paginated by the database', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (query, values) => {
    calls.push({ query, values });
    return query.includes('count(*)')
      ? { rows: [{ total: 30 }] }
      : { rows: [] };
  };

  try {
    const result = await workplaceService.listWorkplaces({
      page: 2,
      page_size: 25,
      search: 'Midrand',
    });
    const listQuery = calls.find(({ query }) => !query.includes('count(*)'));
    assert.match(listQuery.query, /ILIKE \$1/);
    assert.deepEqual(listQuery.values, ['%Midrand%', 25, 25]);
    assert.equal(result.pagination.total, 30);
    assert.equal(result.pagination.total_pages, 2);
  } finally {
    pool.query = originalQuery;
  }
});

async function assertServiceLimit(list, countQuery) {
  const originalQuery = pool.query;
  let listValues;
  pool.query = async (query, values) => {
    if (countQuery(query)) return { rows: [{ total: 250 }] };
    listValues = values;
    return { rows: [] };
  };

  try {
    const result = await list({ page: 1, page_size: 1000 });
    assert.equal(listValues.at(-2), 100);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
}

for (const [name, list, countQuery] of [
  ['pending drivers', reviewService.listPendingDrivers, (query) => query.startsWith('SELECT count(*)::int AS total FROM drivers')],
  ['all vehicles', reviewService.listVehicles, (query) => query.startsWith('SELECT count(*)::int AS total FROM vehicles')],
  ['pending vehicles', reviewService.listPendingVehicles, (query) => query.startsWith('SELECT count(*)::int AS total FROM vehicles')],
  ['pending trip requests', tripService.listPendingRequests, (query) => query.startsWith('SELECT count(*)::int AS total FROM ride_requests')],
  ['live trips', tripAdminService.listLiveTrips, (query) => query.startsWith('SELECT count(*)::int AS total FROM trips t')],
]) {
  test(`${name} list clamps database limit to 100`, () => assertServiceLimit(list, countQuery));
}