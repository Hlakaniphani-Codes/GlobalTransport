const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const adminRideRequestService = require('../src/services/adminRideRequestService');
const offersService = require('../src/services/offers');
const passengerTripService = require('../src/services/passengerTripService');
const notificationService = require('../src/services/notifications');
const { getRepeatDates } = require('../src/services/rideDateUtils');
const rideRequestService = require('../src/services/rideRequestService');
const tripAdminService = require('../src/services/tripAdminService');
const {
  tripCreateSchema,
  tripDatePreviewSchema,
  tripPatchSchema,
} = require('../src/validators/tripSeriesValidators');

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
        const legacyOrderQuery = query.replace('ORDER BY id', 'ORDER BY sequence');
        return handler ? handler(legacyOrderQuery, values, statements) : { rowCount: 1, rows: [] };
      }
      return handler ? handler(query, values, statements) : { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { client, statements };
}

test('repeat-date matching returns only selected ISO weekdays within the allowed dates', () => {
  assert.deepEqual(
    getRepeatDates({
      date: '2030-01-07',
      repeat: { weekdays: [1, 3, 5], until: '2030-01-15' },
    }),
    ['2030-01-07', '2030-01-09', '2030-01-11', '2030-01-14']
  );
});

test('passenger upcoming trip list excludes accepted trips whose first stop has passed', async () => {
  const originalQuery = pool.query;
  pool.query = async (query) => {
    assert.match(query, /t\.status = 'in_progress' OR \(/);
    assert.match(query, /t\.status = 'accepted'/);
    assert.match(query, /first_stop\.planned_at[\s\S]*\), t\.starts_at, t\.scheduled_at\) >= now\(\)/);
    assert.match(query, /AND r\.status = 'assigned'/);
    return { rowCount: 0, rows: [] };
  };

  try {
    const trips = await passengerTripService.listMine('passenger-id');
    assert.deepEqual(trips, []);
  } finally {
    pool.query = originalQuery;
  }
});

test('admin ride request reads are paginated and apply all requested search and filter fields', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query, values) => {
    statements.push({ query, values });
    return query.includes('count(*)')
      ? { rowCount: 1, rows: [{ total: 3 }] }
      : { rowCount: 0, rows: [] };
  };

  try {
    const result = await adminRideRequestService.list({
      page: 2,
      page_size: 2,
      from: '2030-01-01',
      to: '2030-01-31',
      direction: 'to_work',
      status: 'pending',
      unassigned_only: true,
      search: 'Worker',
      sort: 'asc',
    });

    test('admin ride cancellation locks its series, trips and stops before the request', async () => {
      const originalConnect = pool.connect;
      const statements = [];
      const client = {
        query: async (query, values = []) => {
          statements.push({ query, values });
          if (query.includes('SELECT trip_id FROM ride_requests')) {
            return { rowCount: 1, rows: [{ trip_id: 'trip-id' }] };
          }
          if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
            return { rowCount: 1, rows: [{ series_id: 'series-id' }] };
          }
          if (query.includes('FROM trip_series') && query.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [{ id: 'series-id' }] };
          }
          if (query.includes('SELECT id FROM trips') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [{ id: 'trip-id' }] };
          }
          if (query.includes('FROM trip_stops') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [{ id: 'stop-id' }] };
          }
          if (query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')) {
            return {
              rowCount: 1,
              rows: [{
                id: 'request-id',
                status: 'assigned',
                trip_id: 'trip-id',
                started_at: null,
                trip_status: 'accepted',
                driver_user_id: null,
                pickup_at: new Date(Date.now() + 60 * 60_000),
              }],
            };
          }
          if (query.includes('UPDATE ride_requests') && query.includes('RETURNING id, status')) {
            return {
              rowCount: 1,
              rows: [{ id: 'request-id', status: 'cancelled', cancelled_late: false }],
            };
          }
          if (query.includes('SELECT count(DISTINCT ride_request_id)::int AS passenger_count')) {
            return { rowCount: 1, rows: [{ passenger_count: 1 }] };
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
      pool.connect = async () => client;

      try {
        const result = await adminRideRequestService.cancel(
          'admin-id',
          'request-id',
          'Operations change'
        );
        assert.equal(result.status, 'cancelled');
        const seriesLock = statements.findIndex(({ query }) =>
          query.includes('FROM trip_series') && query.includes('FOR UPDATE')
        );
        const tripLock = statements.findIndex(({ query }) =>
          query.includes('SELECT id FROM trips') && query.includes('FOR UPDATE')
        );
        const stopLock = statements.findIndex(({ query }) =>
          query.includes('FROM trip_stops') && query.includes('FOR UPDATE')
        );
        const requestLock = statements.findIndex(({ query }) =>
          query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')
        );
        assert.ok(seriesLock >= 0 && tripLock > seriesLock && stopLock > tripLock && requestLock > stopLock);
      } finally {
        pool.connect = originalConnect;
      }
    });
    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.total, 3);
    for (const expression of [
      'r.scheduled_at >=',
      'r.direction =',
      'r.status =',
      "r.status = 'pending' AND r.trip_id IS NULL",
      'p.employee_number',
      'c.name',
      'p.workplace_suburb',
    ]) assert.ok(statements[0].query.includes(expression), expression);
    assert.ok(statements[1].query.includes('ORDER BY r.scheduled_at ASC, r.id'));
    assert.equal(statements[1].values.at(-2), 2);
    assert.equal(statements[1].values.at(-1), 2);
  } finally {
    pool.query = originalQuery;
  }
});

test('trip creation rejects a drop-off before its passenger pick-up', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')) {
      assert.match(query, /COALESCE\(p\.workplace_address, w\.address, p\.workplace, w\.name\) AS workplace_address/);
      return {
        rowCount: 1,
        rows: [{
          id: 'request-id',
          passenger_user_id: 'passenger-id',
          direction: 'to_work',
          scheduled_at: new Date('2030-01-07T05:30:00Z'),
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      tripAdminService.createTrips('admin-id', {
        direction: 'to_work',
        dates: ['2030-01-07'],
        target_time: '07:00',
        workplace_name: 'Office',
        workplace_address: 'Office address',
        stops: [
          { ride_request_id: 'request-id', stop_type: 'dropoff', sequence: 1, planned_time: '06:30' },
          { ride_request_id: 'request-id', stop_type: 'pickup', sequence: 2, planned_time: '06:00' },
        ],
      }),
      /pick-up must come before/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO trip_series')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('trip creation rejects stop times that do not follow the selected route order', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'request-id',
          passenger_user_id: 'passenger-id',
          direction: 'to_work',
          scheduled_at: new Date('2030-01-07T05:30:00Z'),
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      tripAdminService.createTrips('admin-id', {
        direction: 'to_work',
        dates: ['2030-01-07'],
        target_time: '07:00',
        workplace_name: 'Office',
        workplace_address: 'Office address',
        stops: [
          { ride_request_id: 'request-id', stop_type: 'pickup', sequence: 1, planned_time: '06:30' },
          { ride_request_id: 'request-id', stop_type: 'dropoff', sequence: 2, planned_time: '06:00' },
        ],
      }),
      /pick-up time must be before their drop-off time/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO trip_series')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('trip creation rejects a workplace drop-off scheduled before its passenger pick-up', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'request-id',
          passenger_user_id: 'passenger-id',
          direction: 'to_work',
          scheduled_at: new Date('2030-01-07T05:30:00Z'),
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      tripAdminService.createTrips('admin-id', {
        direction: 'to_work',
        dates: ['2030-01-07'],
        target_time: '07:00',
        workplace_name: 'Office',
        workplace_address: 'Office address',
        stops: [
          { ride_request_id: 'request-id', stop_type: 'pickup', sequence: 1, planned_time: '07:15' },
          { ride_request_id: 'request-id', stop_type: 'dropoff', sequence: 2, planned_time: '07:00' },
        ],
      }),
      /pick-up time must be before their drop-off time/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO trip_series')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('trip creation requires workplace stop groups to use the target time', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('FROM ride_requests r') && query.includes('FOR UPDATE OF r')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'request-id',
          passenger_user_id: 'passenger-id',
          direction: 'to_work',
          scheduled_at: new Date('2030-01-07T05:30:00Z'),
          address: 'Home',
          home_suburb: 'Midrand',
          workplace_suburb: 'Midrand',
          workplace_address: 'Office address',
        }],
      };
    }
    if (query.includes('SELECT r.id, r.passenger_user_id') && query.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ id: 'request-id', passenger_user_id: 'passenger-id' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      tripAdminService.createTrips('admin-id', {
        direction: 'to_work',
        dates: ['2030-01-07'],
        target_time: '07:00',
        workplace_name: 'Office',
        workplace_address: 'Office address',
        stops: [
          { ride_request_id: 'request-id', stop_type: 'pickup', sequence: 1, planned_time: '06:30' },
          { ride_request_id: 'request-id', stop_type: 'dropoff', sequence: 2, planned_time: '06:45' },
        ],
      }),
      /Workplace stops must be scheduled at the target time/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO trips')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('home trip creation needs no arrival target and stores each workplace address per stop', async () => {
  const originalConnect = pool.connect;
  const baseRequests = [
    {
      id: '00000000-0000-4000-8000-000000000011',
      passenger_user_id: '00000000-0000-4000-8000-000000000021',
      direction: 'home',
      scheduled_at: new Date('2030-01-07T15:00:00Z'),
      address: '11 Oak Street',
      home_suburb: 'Rosebank',
      workplace_suburb: 'Sandton',
      workplace_name: 'Central Office',
      workplace_address: '1 Main Road',
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      passenger_user_id: '00000000-0000-4000-8000-000000000022',
      direction: 'home',
      scheduled_at: new Date('2030-01-07T15:00:00Z'),
      address: '22 Pine Avenue',
      home_suburb: 'Midrand',
      workplace_suburb: 'Midrand',
      workplace_name: 'Warehouse',
      workplace_address: '5 Quarry Road',
    },
  ];
  const stopInserts = [];
  let tripInsert;
  const { client, statements } = mockClient((query, values) => {
    if (query.includes('FOR UPDATE OF r')) {
      return { rowCount: baseRequests.length, rows: baseRequests };
    }
    if (query.includes('SELECT r.id, r.passenger_user_id') && query.includes('FOR UPDATE')) {
      return {
        rowCount: 2,
        rows: baseRequests.map(({ id, passenger_user_id }) => ({ id, passenger_user_id })),
      };
    }
    if (query.includes('INSERT INTO trips')) tripInsert = values;
    if (query.includes('INSERT INTO trip_stops')) stopInserts.push(values);
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const input = {
      direction: 'home',
      dates: ['2030-01-07'],
      workplace_name: 'Multiple workplaces',
      workplace_address: 'Multiple workplaces',
      stops: [
        { ride_request_id: baseRequests[0].id, stop_type: 'pickup', sequence: 1, planned_time: '17:00' },
        { ride_request_id: baseRequests[0].id, stop_type: 'dropoff', sequence: 2, planned_time: '17:30' },
        { ride_request_id: baseRequests[1].id, stop_type: 'pickup', sequence: 3, planned_time: '17:45' },
        { ride_request_id: baseRequests[1].id, stop_type: 'dropoff', sequence: 4, planned_time: '18:20' },
      ],
    };
    assert.equal(tripCreateSchema.safeParse(input).success, true);
    const result = await tripAdminService.createTrips('admin-id', input);
    assert.equal(result.trips.length, 1);
    assert.equal(tripInsert[2], 'home');
    assert.equal(tripInsert[3], '2030-01-07T17:00:00+02:00');
    assert.equal(tripInsert[4], '2030-01-07T17:00:00+02:00');
    assert.deepEqual(stopInserts.map((values) => values[5]), [
      '1 Main Road', '11 Oak Street', '5 Quarry Road', '22 Pine Avenue',
    ]);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('trip creation uses the selected request when duplicate pending requests match its passenger and date', async () => {
  const originalConnect = pool.connect;
  const selectedRequestId = '00000000-0000-4000-8000-000000000031';
  const duplicateRequestId = '00000000-0000-4000-8000-000000000032';
  const passengerId = '00000000-0000-4000-8000-000000000041';
  const workplaceId = '00000000-0000-4000-8000-000000000051';
  const stopRequestIds = [];
  const { client, statements } = mockClient((query, values) => {
    if (query.includes('FOR UPDATE OF r')) {
      return {
        rowCount: 1,
        rows: [{
          id: selectedRequestId,
          passenger_user_id: passengerId,
          workplace_id: workplaceId,
          direction: 'home',
          scheduled_at: new Date('2030-01-07T15:00:00Z'),
          address: 'Home address',
          home_suburb: 'Rosebank',
          workplace_suburb: 'Sandton',
          workplace_address: 'Office address',
        }],
      };
    }
    if (query.includes('SELECT r.id, r.passenger_user_id') && query.includes('FOR UPDATE')) {
      assert.match(query, /CASE WHEN r\.id = ANY\(\$4::uuid\[\]\) THEN 0 ELSE 1 END/);
      assert.deepEqual(values[3], [selectedRequestId]);
      return {
        rowCount: 2,
        rows: [
          { id: duplicateRequestId, passenger_user_id: passengerId, workplace_id: workplaceId },
          { id: selectedRequestId, passenger_user_id: passengerId, workplace_id: workplaceId },
        ],
      };
    }
    if (query.includes('INSERT INTO trip_stops')) stopRequestIds.push(values[1]);
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const result = await tripAdminService.createTrips('admin-id', {
      direction: 'home',
      dates: ['2030-01-07'],
      workplace_name: 'Office',
      workplace_address: 'Office address',
      stops: [
        { ride_request_id: selectedRequestId, stop_type: 'pickup', sequence: 1, planned_time: '17:00' },
        { ride_request_id: selectedRequestId, stop_type: 'dropoff', sequence: 2, planned_time: '17:30' },
      ],
    });

    assert.equal(result.trips.length, 1);
    assert.deepEqual(stopRequestIds, [selectedRequestId, selectedRequestId]);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('trip date preview identifies dates missing selected passenger and workplace requests', async () => {
  const originalQuery = pool.query;
  const selectedRequests = [
    {
      id: '00000000-0000-4000-8000-000000000061',
      passenger_user_id: '00000000-0000-4000-8000-000000000071',
      workplace_id: '00000000-0000-4000-8000-000000000081',
    },
    {
      id: '00000000-0000-4000-8000-000000000062',
      passenger_user_id: '00000000-0000-4000-8000-000000000072',
      workplace_id: '00000000-0000-4000-8000-000000000082',
    },
  ];
  pool.query = async (query, values) => {
    if (query.includes('SELECT id, passenger_user_id, workplace_id')) {
      assert.deepEqual(values, [
        selectedRequests.map(({ id }) => id),
        'to_work',
      ]);
      return { rowCount: 2, rows: selectedRequests };
    }
    assert.match(query, /scheduled_at AT TIME ZONE 'Africa\/Johannesburg'/);
    assert.deepEqual(values.slice(3), [
      '2030-01-07',
      '2030-01-08',
      ['2030-01-07', '2030-01-08'],
    ]);
    return {
      rowCount: 3,
      rows: [
        {
          passenger_user_id: selectedRequests[0].passenger_user_id,
          workplace_id: selectedRequests[0].workplace_id,
          local_date: '2030-01-07',
        },
        {
          passenger_user_id: selectedRequests[1].passenger_user_id,
          workplace_id: selectedRequests[1].workplace_id,
          local_date: '2030-01-07',
        },
        {
          passenger_user_id: selectedRequests[0].passenger_user_id,
          workplace_id: selectedRequests[0].workplace_id,
          local_date: '2030-01-08',
        },
      ],
    };
  };

  try {
    const input = {
      direction: 'to_work',
      dates: ['2030-01-07', '2030-01-08'],
      request_ids: selectedRequests.map(({ id }) => id),
    };
    assert.equal(tripDatePreviewSchema.safeParse(input).success, true);
    assert.deepEqual(await tripAdminService.previewTripDates(input), {
      dates: [
        {
          date: '2030-01-07',
          available: true,
          matched_request_groups: 2,
          required_request_groups: 2,
          missing_request_groups: 0,
          missing_request_ids: [],
        },
        {
          date: '2030-01-08',
          available: false,
          matched_request_groups: 1,
          required_request_groups: 2,
          missing_request_groups: 1,
          missing_request_ids: [selectedRequests[1].id],
        },
      ],
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('trip date preview rejects a selected request that is no longer pending', async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rowCount: 0, rows: [] });

  try {
    await assert.rejects(
      tripAdminService.previewTripDates({
        direction: 'home',
        dates: ['2030-01-07'],
        request_ids: ['00000000-0000-4000-8000-000000000091'],
      }),
      /no longer available/
    );
  } finally {
    pool.query = originalQuery;
  }
});

test('trip creation input enforces ordered contiguous stops and matching pickup/drop-off pairs', () => {
  const parsed = tripCreateSchema.safeParse({
    direction: 'to_work',
    dates: ['2030-01-07'],
    target_time: '07:00',
    workplace_name: 'Office',
    workplace_address: 'Office address',
    stops: [
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'pickup', sequence: 1, planned_time: '06:00' },
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'dropoff', sequence: 2, planned_time: '07:00' },
    ],
  });
  assert.equal(parsed.success, true);
  assert.equal(tripCreateSchema.safeParse({
    direction: 'to_work',
    dates: ['2030-01-07'],
    workplace_name: 'Office',
    workplace_address: 'Office address',
    stops: [
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'pickup', sequence: 1, planned_time: '06:00' },
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'dropoff', sequence: 2, planned_time: '07:00' },
    ],
  }).success, false);
  const outOfOrderTimes = tripCreateSchema.safeParse({
    direction: 'to_work',
    dates: ['2030-01-07'],
    target_time: '07:00',
    workplace_name: 'Office',
    workplace_address: 'Office address',
    stops: [
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'pickup', sequence: 1, planned_time: '06:30' },
      { ride_request_id: '00000000-0000-4000-8000-000000000001', stop_type: 'dropoff', sequence: 2, planned_time: '06:00' },
    ],
  });
  assert.equal(outOfOrderTimes.success, false);
  const outOfOrderEdit = tripPatchSchema.safeParse({
    stops: [
      { id: '00000000-0000-4000-8000-000000000001', sequence: 1, planned_at: '2030-01-07T06:30:00+02:00' },
      { id: '00000000-0000-4000-8000-000000000002', sequence: 2, planned_at: '2030-01-07T06:00:00+02:00' },
    ],
  });
  assert.equal(outOfOrderEdit.success, false);
});

test('accepted trip edits require driver confirmation and notify the affected users', async () => {
  const originalConnect = pool.connect;
  const originalPoolQuery = pool.query;
  const originalNotify = notificationService.notify;
  const originalNotifyPassengers = notificationService.notifyTripPassengers;
  const originalListForSeries = offersService.listForSeries;
  const statements = [];
  const notifications = [];
  let trip = {
    id: 'trip-id',
    series_id: 'series-id',
    status: 'accepted',
    direction: 'to_work',
    scheduled_at: '2030-01-07T07:00:00.000Z',
    starts_at: '2030-01-07T06:00:00.000Z',
    ends_at: '2030-01-07T07:00:00.000Z',
    driver_user_id: 'driver-id',
    workplace_name: 'Old workplace',
    workplace_address: 'Office address',
    distance_km: 10,
    notes: null,
    change_ack_required: false,
  };
  const client = {
    query: async (query, values = []) => {
      statements.push({ query, values });
      if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: trip.series_id }] };
      }
      if (query.includes('FROM trip_series WHERE id = $1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: trip.series_id }] };
      }
      if (query.includes('SELECT id FROM trips') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: trip.id }] };
      }
      if (query.includes('FROM trips WHERE id = $1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...trip }] };
      }
      if (query.includes('UPDATE trips SET workplace_name')) {
        trip = { ...trip, workplace_name: values[0] };
      }
      if (query.includes('SET change_ack_required = TRUE')) {
        trip = { ...trip, change_ack_required: true };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => query.includes('SELECT t.id, t.series_id, t.direction, t.scheduled_at')
    ? { rowCount: 1, rows: [{ ...trip }] }
    : { rowCount: 0, rows: [] };
  notificationService.notify = async (...args) => {
    notifications.push(args);
    return null;
  };
  notificationService.notifyTripPassengers = async (...args) => {
    notifications.push(args);
    return null;
  };
  offersService.listForSeries = async () => [];

  try {
    const result = await tripAdminService.updateTrip('trip-id', 'admin-id', {
      workplace_name: 'Updated workplace',
    });
    assert.equal(result.status, 'accepted');
    assert.equal(trip.change_ack_required, true);
    assert.equal(notifications.length, 2);
    assert.ok(statements.some(({ query }) => query.includes('trip.admin_edited')));
    assert.ok(statements.some(({ query }) => query.includes('INSERT INTO audit_logs')));
  } finally {
    pool.connect = originalConnect;
    pool.query = originalPoolQuery;
    notificationService.notify = originalNotify;
    notificationService.notifyTripPassengers = originalNotifyPassengers;
    offersService.listForSeries = originalListForSeries;
  }
});

test('admin trip cancellation records its reason and audit entry transactionally', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT id, series_id, status, driver_user_id FROM trips')) {
      return { rowCount: 1, rows: [{ id: 'trip-id', series_id: 'series-id', status: 'draft' }] };
    }
    if (query.includes('count(*)::int AS count FROM trips')) {
      return { rowCount: 1, rows: [{ count: 0 }] };
    }
    if (query.includes("UPDATE trips SET status = 'cancelled'")) {
      return { rowCount: 1, rows: [{ id: 'trip-id', status: 'cancelled', cancel_reason: 'Weather' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const trip = await tripAdminService.cancelTrip('trip-id', 'admin-id', 'Weather');
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));
    assert.equal(trip.status, 'cancelled');
    assert.deepEqual(audit.values[2], { reason: 'Weather', series_id: 'series-id' });
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('admin cannot cancel an in-progress trip and must use force-complete handling', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT id, series_id, status, driver_user_id FROM trips')) {
      return {
        rowCount: 1,
        rows: [{ id: 'trip-id', series_id: 'series-id', status: 'in_progress', driver_user_id: 'driver-id' }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      tripAdminService.cancelTrip('trip-id', 'admin-id', 'Vehicle problem'),
      /already in progress.*Force-complete/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes("UPDATE trips SET status = 'cancelled'")), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('removing a passenger skips stops, cancels the empty trip and audits the reason', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT id, status, driver_user_id FROM trips')) {
      return { rowCount: 1, rows: [{ id: 'trip-id', status: 'accepted', driver_user_id: null }] };
    }
    if (query.includes('SELECT r.id, r.passenger_user_id')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'request-id',
          status: 'assigned',
          cancelled_late: false,
          pickup_at: new Date(Date.now() + 3 * 60 * 60_000),
        }],
      };
    }
    if (query.includes('count(DISTINCT ride_request_id)')) {
      return { rows: [{ count: 0 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const result = await tripAdminService.removePassenger('trip-id', 'admin-id', {
      ride_request_id: 'request-id',
      reason: 'No show',
      kind: 'no_show',
    });
    assert.equal(result.cancelled_late, false);
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'skipped'")));
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'cancelled'")));
    assert.equal(
      statements.find(({ query }) => query.includes('INSERT INTO audit_logs')).values[2].kind,
      'no_show'
    );
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('reassigning a trip detaches it to a new draft series and audits the old assignment', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT id, series_id, driver_user_id, status')) {
      return {
        rowCount: 1,
        rows: [{ id: 'trip-id', series_id: 'old-series', driver_user_id: 'driver-id', status: 'accepted' }],
      };
    }
    if (query.includes('SELECT is_active, notifications_push_enabled')) {
      return { rowCount: 0, rows: [] };
    }
    if (query.includes('UPDATE trips') && query.includes("status = 'draft'")) {
      return { rowCount: 1, rows: [{ id: 'trip-id', series_id: 'new-series', status: 'draft' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const trip = await tripAdminService.reassignTrip('trip-id', 'admin-id');
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));
    assert.equal(trip.status, 'draft');
    assert.notEqual(audit.values[2].series_id, audit.values[2].previous_series_id);
    assert.equal(audit.values[2].previous_driver_user_id, 'driver-id');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('series offer cancellation closes queued offers and records an audit entry', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('count(*) FILTER (WHERE status =')) {
      return { rowCount: 1, rows: [{ offered_count: 1 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await offersService.cancel('series-id', 'admin-id');
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));
    assert.equal(audit.values[0], 'admin-id');
    assert.equal(audit.values[1], 'trip_series.offers_cancelled');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('expired offers skip ineligible queued drivers and promote the next eligible driver', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('FROM trip_series WHERE id = $1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'series-id' }] };
      }
      if (query.includes('SELECT id FROM trips') && query.includes('ORDER BY id') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id' }] };
      }
      if (query.includes('SELECT id, series_id, driver_user_id, status, expires_at')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'expired-offer',
            series_id: 'series-id',
            driver_user_id: 'expired-driver',
            status: 'pending',
            expires_at: new Date(Date.now() - 1_000),
          }],
        };
      }
      if (query.includes('SELECT id, driver_user_id, vehicle_id, position, window_minutes')) {
        return {
          rowCount: 2,
          rows: [
            { id: 'ineligible-offer', driver_user_id: 'ineligible-driver', vehicle_id: 'vehicle-1', position: 1, window_minutes: 30 },
            { id: 'eligible-offer', driver_user_id: 'eligible-driver', vehicle_id: 'vehicle-2', position: 2, window_minutes: 30 },
          ],
        };
      }
      if (query.includes("status = 'pending' AND expires_at > now()")) {
        return { rowCount: 0, rows: [] };
      }
      if (query.includes('WITH proposed AS')) {
        return {
          rowCount: 1,
          rows: [{ user_id: 'eligible-driver', vehicle_id: 'vehicle-2' }],
        };
      }
      if (query.includes("SET status = 'pending', offered_at = now()")) {
        return { rowCount: 1, rows: [{ id: 'eligible-offer' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => {
    assert.match(query, /status = 'pending' AND expires_at <= now\(\)/);
    return { rowCount: 1, rows: [{ id: 'expired-offer', series_id: 'series-id' }] };
  };

  try {
    await offersService.processExpired();
    const eligibilityQuery = statements.find(({ query }) => query.includes('WITH proposed AS'));
    const ineligible = statements.find(({ query, values }) =>
      query.includes("SET status = 'cancelled'") && values[0] === 'ineligible-offer'
    );
    const promoted = statements.find(({ query, values }) =>
      query.includes("SET status = 'pending', offered_at = now()") && values[0] === 'eligible-offer'
    );
    assert.ok(eligibilityQuery.query.includes("d.status = 'approved'"));
    assert.ok(eligibilityQuery.query.includes("v.status = 'approved'"));
    assert.ok(eligibilityQuery.query.includes("d.is_available = TRUE"));
    assert.ok(eligibilityQuery.query.includes("interval '15 minutes'"));
    assert.ok(ineligible);
    assert.ok(promoted);
    assert.equal(statements.some(({ query }) => query.includes("SET status = 'unassigned'")), false);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('passenger trip list avoids DISTINCT ordering errors and returns only the passenger trips', async () => {
  const originalQuery = pool.query;
  let statement = '';
  pool.query = async (query, values) => {
    statement = query;
    assert.deepEqual(values, ['passenger-id', 100]);
    return { rowCount: 1, rows: [{ id: 'trip-id', own_stops: [] }] };
  };

  try {
    const trips = await passengerTripService.listMine('passenger-id');
    assert.equal(trips.length, 1);
    assert.match(statement, /WHERE \(t\.status = 'in_progress' OR \(/);
    assert.match(statement, /first_stop\.planned_at[\s\S]*\), t\.starts_at, t\.scheduled_at\) >= now\(\)/);
    assert.match(statement, /JOIN ride_requests r ON r\.trip_id = t\.id AND r\.passenger_user_id = \$1/);
    assert.doesNotMatch(statement, /SELECT DISTINCT/);
    assert.match(statement, /ORDER BY COALESCE\(t\.starts_at, t\.scheduled_at\)/);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger trip details limit driver contact to the allowed trip status and time window', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query) => {
    statements.push(query);
    return query.includes('FROM trip_stops WHERE trip_id = $1 ORDER BY sequence')
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ id: 'trip-id', driver_contact_number: null, own_stops: [] }] };
  };

  try {
    await passengerTripService.getMine('passenger-id', 'trip-id');
    const statement = statements[0];
    assert.match(statement, /WHEN t\.status IN \('accepted','in_progress'\)/);
    assert.match(statement, /now\(\) >= COALESCE\([\s\S]*interval '90 minutes'/);
    assert.match(statement, /now\(\) <= COALESCE\(t\.ends_at, t\.completed_at, t\.scheduled_at\)/);
    assert.match(statement, /WHERE stop\.trip_id = t\.id AND stop\.passenger_user_id = \$1/);
    assert.match(statement, /WHERE t\.id = \$2 AND t\.status IN \('accepted','in_progress','completed','cancelled','missed'\)/);
    assert.match(statements[1], /SELECT id, sequence, stop_type, address, suburb/);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger live trip details return delay-adjusted own stops and no other passenger details', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (query) => {
    statements.push(query);
    if (query.includes('FROM trip_stops WHERE trip_id = $1 ORDER BY sequence')) {
      return {
        rowCount: 4,
        rows: [
          { id: 'pickup-own', sequence: 1, stop_type: 'pickup', address: 'Own home', suburb: 'Midrand' },
          { id: 'pickup-other', sequence: 2, stop_type: 'pickup', address: 'Other home', suburb: 'Centurion' },
          { id: 'dropoff-other', sequence: 3, stop_type: 'dropoff', address: 'Office', suburb: 'Midrand' },
          { id: 'dropoff-own', sequence: 4, stop_type: 'dropoff', address: 'Own home', suburb: 'Midrand' },
        ],
      };
    }
    return {
      rowCount: 1,
      rows: [{
        id: 'trip-id',
        status: 'in_progress',
        ride_request_status: 'assigned',
        delay_minutes: 10,
        driver_first_name: 'Alex',
        vehicle_make: 'Toyota',
        vehicle_colour: 'Blue',
        vehicle_plate: 'ABC123',
        driver_contact_number: null,
        own_stops: [
          { id: 'pickup-own', stop_type: 'pickup', status: 'completed', address: 'Own home', planned_at: '2030-01-07T05:10:00Z' },
          { id: 'dropoff-own', stop_type: 'dropoff', status: 'pending', address: 'Own home', planned_at: '2030-01-07T06:10:00Z' },
        ],
      }],
    };
  };

  try {
    const trip = await passengerTripService.getMine('passenger-id', 'trip-id');
    assert.equal(trip.phase, 'on_board');
    assert.equal(trip.stops_before_pickup, 0);
    assert.equal(trip.stops_before_dropoff, 3);
    assert.equal(trip.delay_minutes, 10);
    assert.equal(trip.driver_first_name, 'Alex');
    assert.equal(trip.vehicle_colour, 'Blue');
    assert.equal(trip.vehicle_plate, 'ABC123');
    assert.equal(trip.driver_contact_number, null);
    assert.equal(trip.own_stops.length, 2);
    assert.doesNotMatch(JSON.stringify(trip), /Other home|Centurion/);
    assert.match(statements[0], /stop\.planned_at \+ \(t\.delay_minutes \* interval '1 minute'\)/);
    assert.match(statements[0], /split_part\(trim\(driver\.name\), ' ', 1\) AS driver_first_name/);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger trip history includes completed, cancelled and missed trips for the signed-in passenger', async () => {
  const originalQuery = pool.query;
  let statement = '';
  pool.query = async (query, values) => {
    statement = query;
    assert.deepEqual(values, ['passenger-id', 101]);
    return { rowCount: 0, rows: [] };
  };

  try {
    const trips = await passengerTripService.listMine('passenger-id', 'history');
    assert.deepEqual(trips, []);
    assert.match(statement, /t\.status IN \('completed','cancelled','missed'\)/);
    assert.match(statement, /r\.trip_id = t\.id AND r\.passenger_user_id = \$1/);
    assert.match(statement, /stop\.trip_id = t\.id AND stop\.passenger_user_id = \$1/);
  } finally {
    pool.query = originalQuery;
  }
});

test('admin trip details include driver withdrawal records', async () => {
  const originalQuery = pool.query;
  const originalListForSeries = offersService.listForSeries;
  let tripQuery = '';
  pool.query = async (query) => {
    if (query.includes('SELECT t.id, t.series_id, t.direction, t.scheduled_at')) {
      tripQuery = query;
      return {
        rowCount: 1,
        rows: [{
          id: 'trip-id',
          series_id: 'series-id',
          direction: 'home',
          scheduled_at: '2026-04-01T10:00:00.000Z',
          status: 'unassigned',
        }],
      };
    }
    if (query.includes('FROM trip_withdrawals')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'withdrawal-id',
          driver_user_id: 'driver-id',
          reason_kind: 'vehicle_problem',
          scope: 'this',
          late: true,
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  };
  offersService.listForSeries = async () => [];

  try {
    const trip = await tripAdminService.getTrip('trip-id');
    assert.equal(trip.withdrawals.length, 1);
    assert.equal(trip.withdrawals[0].reason_kind, 'vehicle_problem');
    assert.equal(trip.withdrawals[0].late, true);
    assert.doesNotMatch(tripQuery, /SELECT\s+t\.\*/i);
    assert.match(tripQuery, /t\.change_acknowledged_at/);
  } finally {
    pool.query = originalQuery;
    offersService.listForSeries = originalListForSeries;
  }
});

test('cancelled, missed, and expired passenger requests include a safe request-again payload', async () => {
  const originalQuery = pool.query;
  pool.query = async (query, values) => {
    assert.deepEqual(values, ['passenger-id', 26]);
    assert.match(query, /r\.closed_reason/);
    assert.match(query, /'Africa\/Johannesburg', 'HH24:MI'/);
    assert.match(query, /EXTRACT\(ISODOW FROM series_request\.scheduled_at AT TIME ZONE 'Africa\/Johannesburg'\)/);
    return {
      rowCount: 3,
      rows: [
        {
          id: 'cancelled-id',
          direction: 'to_work',
          status: 'cancelled',
          series_id: null,
          closed_reason: null,
          date_of_ride: '2030-01-08',
          time_of_day: '07:15',
          repeat_weekdays: null,
        },
        {
          id: 'missed-id',
          direction: 'to_work',
          status: 'missed',
          series_id: 'series-id',
          closed_reason: 'no_activity',
          date_of_ride: '2030-01-07',
          time_of_day: '07:30',
          repeat_weekdays: [1, 3, 5],
        },
        {
          id: 'expired-id',
          direction: 'home',
          status: 'expired',
          series_id: null,
          closed_reason: 'no_trip',
          date_of_ride: '2030-01-06',
          time_of_day: '17:00',
          repeat_weekdays: null,
        },
      ],
    };
  };

  try {
    const { ride_requests: [cancelled, missed, expired] } = await rideRequestService.listMine('passenger-id');
    assert.deepEqual(cancelled.request_again, {
      direction: 'to_work',
      date: '2030-01-08',
      time_of_day: '07:15',
      repeat_pattern: null,
    });
    assert.equal(missed.outcome_reason, 'The trip did not start.');
    assert.deepEqual(missed.request_again, {
      direction: 'to_work',
      date: '2030-01-07',
      time_of_day: '07:30',
      repeat_pattern: { weekdays: [1, 3, 5] },
    });
    assert.equal(expired.outcome_reason, 'No trip could be arranged before your requested time.');
    assert.deepEqual(expired.request_again, {
      direction: 'home',
      date: '2030-01-06',
      time_of_day: '17:00',
      repeat_pattern: null,
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('live trips return current grouped stops and operational counters', async () => {
  const originalQuery = pool.query;
  pool.query = async (query, values) => {
    if (query.startsWith('SELECT count(*)::int AS total FROM trips t')) {
      assert.deepEqual(values, undefined);
      return { rowCount: 1, rows: [{ total: 1 }] };
    }
    assert.deepEqual(values, [25, 0]);
    assert.match(query, /t\.status = 'in_progress'/);
    assert.match(query, /stop\.status IN \('en_route','arrived'\)/);
    return {
      rowCount: 1,
      rows: [{
        id: 'trip-id',
        status: 'in_progress',
        delay_minutes: 10,
        no_shows: 1,
        exceptions: 2,
        open_incidents: 1,
        last_update_at: new Date('2030-01-07T05:20:00Z'),
        active_stops: [
          {
            id: 'stop-1', ride_request_id: 'request-1', sequence: 2,
            stop_type: 'pickup', address: '10 Main St', suburb: 'Midrand', status: 'arrived',
          },
          {
            id: 'stop-2', ride_request_id: 'request-2', sequence: 3,
            stop_type: 'pickup', address: '10 main st', suburb: 'MIDRAND', status: 'arrived',
          },
          {
            id: 'stop-3', ride_request_id: 'request-3', sequence: 4,
            stop_type: 'dropoff', address: 'Office', suburb: null, status: 'en_route',
          },
        ],
      }],
    };
  };

  try {
    const result = await tripAdminService.listLiveTrips();
    const trips = result.trips;
    assert.equal(trips.length, 1);
    assert.deepEqual(result.pagination, { page: 1, page_size: 25, total: 1, total_pages: 1 });
    assert.equal(trips[0].current_stop_group.passenger_count, 2);
    assert.equal(trips[0].current_stop_group.sequence, 2);
    assert.equal(trips[0].current_stop_group.status, 'arrived');
    assert.equal(trips[0].no_shows, 1);
    assert.equal(trips[0].exceptions, 2);
    assert.equal(trips[0].open_incidents, 1);
    assert.equal('active_stops' in trips[0], false);
  } finally {
    pool.query = originalQuery;
  }
});

test('passenger can rate a completed trip only once', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT t.id, t.driver_user_id, t.status')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'trip-id',
          driver_user_id: 'driver-id',
          status: 'completed',
          passenger_was_picked_up: true,
        }],
      };
    }
    if (query.includes('INSERT INTO trip_ratings')) {
      return {
        rowCount: 1,
        rows: [{ id: 'rating-id', rating: 5, comment: 'Good trip', created_at: new Date() }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    const rating = await passengerTripService.rateMine('passenger-id', 'trip-id', {
      rating: 5,
      comment: 'Good trip',
    });
    assert.equal(rating.rating, 5);
    assert.ok(statements.some(({ query }) =>
      query.includes("pickup.stop_type = 'pickup' AND pickup.status = 'completed'")
    ));
    const insert = statements.find(({ query }) => query.includes('INSERT INTO trip_ratings'));
    assert.deepEqual(insert.values, ['trip-id', 'passenger-id', 'driver-id', 5, 'Good trip']);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('passengers who were not picked up cannot rate a completed trip', async () => {
  const originalConnect = pool.connect;
  const { client, statements } = mockClient((query) => {
    if (query.includes('SELECT t.id, t.driver_user_id, t.status')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'trip-id',
          driver_user_id: 'driver-id',
          status: 'completed',
          passenger_was_picked_up: false,
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  pool.connect = async () => client;

  try {
    await assert.rejects(
      passengerTripService.rateMine('passenger-id', 'trip-id', { rating: 5 }),
      /You must have been picked up to rate the trip/
    );
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO trip_ratings')), false);
  } finally {
    pool.connect = originalConnect;
  }
});
