const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../index');
const pool = require('../src/db');
const authService = require('../src/services/authService');
const reviewService = require('../src/services/reviewService');
const rideRequestService = require('../src/services/rideRequestService');
const tripService = require('../src/services/tripService');
const {
  changePasswordSchema,
  passengerRegistrationSchema,
} = require('../src/validators/authValidators');
const {
  driverDocumentsSchema,
  passengerPatchSchema,
  vehicleSubmissionSchema,
} = require('../src/validators/reviewValidators');
const { rideRequestCreateSchema } = require('../src/validators/passengerRideValidators');

test('admin endpoint accepts admin credentials and mobile endpoint rejects them', async () => {
  const originalQuery = pool.query;
  const originalSecret = process.env.JWT_SECRET;
  const credentials = {
    email: `${randomUUID()}@example.invalid`,
    password: randomBytes(32).toString('base64url'),
    terms_accepted: true,
  };
  const user = {
    id: randomUUID(),
    email: credentials.email,
    password_hash: await bcrypt.hash(credentials.password, 12),
    role: 'admin',
    name: 'Runtime',
    surname: 'Generated',
    contact_number: '+27821234567',
    is_active: true,
  };
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  pool.query = async (query) => {
    if (query.startsWith('SELECT')) return { rowCount: 1, rows: [user] };
    return { rowCount: 1, rows: [{ id: user.id }] };
  };

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    };
    const adminResponse = await fetch(`${baseUrl}/api/v1/admin/auth/login`, request);
    const mobileResponse = await fetch(`${baseUrl}/api/v1/auth/login`, request);

    assert.equal(adminResponse.status, 200);
    assert.equal((await adminResponse.json()).user.role, 'admin');
    assert.equal(mobileResponse.status, 401);
    assert.equal(
      (await mobileResponse.json()).error.message,
      "We couldn't sign you in. Check your email and password and try again."
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    pool.query = originalQuery;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('passenger registration accepts a typed workplace name', () => {
  const result = passengerRegistrationSchema.safeParse({
    name: 'Runtime',
    surname: 'Generated',
    address: '1 Example Street',
    home_suburb: 'Example Home Suburb',
    workplace_suburb: 'Example Workplace Suburb',
    employee_number: 'EMP-1',
    workplace: 'Central Office',
    contact_number: '0821234567',
    email: `${randomUUID()}@example.invalid`,
    password: randomBytes(32).toString('base64url'),
    terms_accepted: true,
  });

  assert.equal(result.success, true);
  assert.equal(
    passengerRegistrationSchema.safeParse({
      name: 'Runtime',
      surname: 'Generated',
      address: '1 Example Street',
      home_suburb: 'Example Home Suburb',
      workplace_suburb: 'Example Workplace Suburb',
      employee_number: 'EMP-1',
      workplace: 'W'.repeat(161),
      contact_number: '0821234567',
      email: `${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString('base64url'),
      terms_accepted: true,
    }).success,
    false
  );
  assert.equal(
    passengerRegistrationSchema.safeParse({
      name: 'Runtime',
      surname: 'Generated',
      address: '1 Example Street',
      home_suburb: 'Example Home Suburb',
      employee_number: 'EMP-1',
      workplace: 'Central Office',
      contact_number: '0821234567',
      email: `${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString('base64url'),
    }).success,
    false
  );
  assert.equal(
    passengerRegistrationSchema.safeParse({
      name: 'Runtime',
      surname: 'Generated',
      address: '1 Example Street',
      home_suburb: 'Example Home Suburb',
      workplace_suburb: 'Example Workplace Suburb',
      employee_number: 'EMP-1',
      workplace: 'Central Office',
      contact_number: '0821234567',
      email: `${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString('base64url'),
      terms_accepted: false,
    }).success,
    false
  );
});

test('registration records acceptance of the terms and privacy policy', async () => {
  const originalConnect = pool.connect;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const userId = randomUUID();
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('INSERT INTO users')) {
        return {
          rowCount: 1,
          rows: [{
            id: userId,
            email: 'driver@example.invalid',
            role: 'driver',
            name: 'Runtime',
            surname: 'Generated',
            contact_number: '+27821234567',
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await authService.register('driver', {
      name: 'Runtime',
      surname: 'Generated',
      address: '1 Example Street',
      contact_number: '+27821234567',
      email: 'driver@example.invalid',
      id_number: '8001015009087',
      password: randomBytes(32).toString('base64url'),
      terms_accepted: true,
    });
    const insert = statements.find(({ query }) => query.includes('INSERT INTO users'));
    assert.match(insert.query, /terms_accepted_at/);
    assert.match(insert.query, /now\(\)/);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('passenger registration creates a workplace when the typed name is not registered', async () => {
  const originalConnect = pool.connect;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const userId = randomUUID();
  const companyId = randomUUID();
  const workplaceId = randomUUID();
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT w.id, w.name')) return { rowCount: 0, rows: [] };
      if (query.includes('INSERT INTO companies')) {
        return {
          rowCount: 1,
          rows: [{ id: companyId, name: 'Example Company', is_active: true }],
        };
      }
      if (query.includes('INSERT INTO workplaces')) {
        return {
          rowCount: 1,
          rows: [{ id: workplaceId, name: 'Example Company' }],
        };
      }
      if (query.includes('INSERT INTO users')) {
        return {
          rowCount: 1,
          rows: [{
            id: userId,
            email: 'passenger@example.invalid',
            role: 'passenger',
            name: 'Runtime',
            surname: 'Generated',
            contact_number: '+27821234567',
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await authService.register('passenger', {
      name: 'Runtime',
      surname: 'Generated',
      address: '1 Example Street',
      home_suburb: 'Home Suburb',
      workplace_suburb: 'Workplace Suburb',
      employee_number: 'EMP-1',
      workplace: 'Example Company',
      contact_number: '+27821234567',
      email: 'passenger@example.invalid',
      password: randomBytes(32).toString('base64url'),
      terms_accepted: true,
    });

    const companyInsert = statements.find(({ query }) => query.includes('INSERT INTO companies'));
    const workplaceInsert = statements.find(({ query }) => query.includes('INSERT INTO workplaces'));
    const passengerInsert = statements.find(({ query }) => query.includes('INSERT INTO passengers'));
    assert.deepEqual(companyInsert.values, ['Example Company']);
    assert.deepEqual(workplaceInsert.values, [companyId, 'Example Company', 'Workplace Suburb']);
    assert.equal(passengerInsert.values[4], workplaceId);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('passenger profile updates are validated and audit-logged in the same transaction', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT p.user_id')) return { rowCount: 1, rows: [{ user_id: 'passenger-id' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const patch = passengerPatchSchema.parse({
      address: '2 Updated Street',
      workplace_suburb: 'Updated Workplace Suburb',
    });
    const result = await reviewService.updatePassenger('passenger-id', 'admin-id', patch);
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.deepEqual(result.updated_fields, ['address', 'workplace_suburb']);
    assert.equal(audit.values[0], 'admin-id');
    assert.equal(audit.values[1], 'passenger-id');
    assert.deepEqual(audit.values[2], { updated_fields: ['address', 'workplace_suburb'] });
    assert.equal(statements.at(-1).query, 'COMMIT');
    assert.equal(passengerPatchSchema.safeParse({}).success, false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('admin passenger directory applies search and server pagination', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes('count(*)')) return { rowCount: 1, rows: [{ total: 55 }] };
    return { rowCount: 1, rows: [{ id: 'passenger-id', home_suburb: null, workplace_suburb: 'CBD' }] };
  };

  try {
    const result = await reviewService.listPassengers({
      page: 2,
      page_size: 20,
      search: 'EMP-',
    });
    assert.equal(result.passengers[0].id, 'passenger-id');
    assert.deepEqual(result.pagination, { page: 2, page_size: 20, total: 55, total_pages: 3 });
    assert.match(calls[1].query, /lower\(p\.employee_number\) LIKE/);
    assert.deepEqual(calls[1].values, ['emp-%', 20, 20]);
  } finally {
    pool.query = originalQuery;
  }
});

test('rejected vehicle resubmission returns to pending and is audit-logged', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const vehicle = {
    id: randomUUID(),
    make: 'Toyota',
    model: 'Quantum',
    year: 2023,
    colour: 'White',
    registration_number: 'ABC123GP',
    seat_count: 14,
    status: 'pending',
    rejection_reason: null,
  };
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT id, status FROM vehicles')) {
        return { rowCount: 1, rows: [{ id: vehicle.id, status: 'rejected' }] };
      }
      if (query.includes('UPDATE vehicles')) return { rowCount: 1, rows: [vehicle] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const input = vehicleSubmissionSchema.parse({
      make: 'Toyota',
      model: 'Quantum',
      year: 2023,
      colour: 'White',
      registration_number: 'abc123gp',
      seat_count: 14,
    });
    const result = await reviewService.resubmitVehicle('driver-id', vehicle.id, input);
    const update = statements.find(({ query }) => query.includes('UPDATE vehicles'));
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.equal(result.status, 'pending');
    assert.equal(result.rejection_reason, null);
    assert.equal(update.values[4], 'ABC123GP');
    assert.equal(audit.values[0], 'driver-id');
    assert.match(audit.query, /vehicle\.resubmitted/);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('password changes require the current password and use a new bcrypt hash', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const oldHash = await bcrypt.hash('CurrentPass123', 4);
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT password_hash')) {
        return { rowCount: 1, rows: [{ password_hash: oldHash }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async () => ({ rowCount: 1, rows: [{ password_hash: oldHash }] });

  try {
    const input = changePasswordSchema.parse({
      current_password: 'CurrentPass123',
      new_password: 'NewPassword456',
    });
    await authService.changePassword('user-id', input);
    const update = statements.find(({ query }) => query.includes('UPDATE users'));
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.ok(update);
    assert.equal(await bcrypt.compare('NewPassword456', update.values[0]), true);
    assert.equal(update.values[1], 'user-id');
    assert.equal(audit.values[0], 'user-id');
    assert.match(audit.query, /account\.password_changed/);
    assert.equal(statements.at(-1).query, 'COMMIT');
    assert.equal(changePasswordSchema.safeParse({
      current_password: 'CurrentPass123',
      new_password: 'short',
    }).success, false);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('password change rejects an incorrect current password without changing credentials', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const oldHash = await bcrypt.hash('CurrentPass123', 4);
  const statements = [];
  const client = {
    query: async (query) => {
      statements.push(query);
      if (query.includes('SELECT password_hash')) {
        return { rowCount: 1, rows: [{ password_hash: oldHash }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async () => ({ rowCount: 1, rows: [{ password_hash: oldHash }] });

  try {
    await assert.rejects(
      authService.changePassword('user-id', {
        current_password: 'WrongPassword',
        new_password: 'NewPassword456',
      }),
      { statusCode: 400, message: 'Current password is incorrect.' }
    );
    assert.equal(statements.some((query) => query.includes('UPDATE users')), false);
    assert.equal(statements.length, 0);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('ride cancellation records late cancellation and skips the passenger stops', async () => {
  const originalConnect = pool.connect;
  const originalLateHours = process.env.LATE_CANCELLATION_HOURS;
  process.env.LATE_CANCELLATION_HOURS = '2';
  const statements = [];
  const pickupAt = new Date(Date.now() + 60 * 60_000);
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT id, series_id') && query.includes('FROM ride_requests')) {
        return { rowCount: 1, rows: [{ id: 'request-id', series_id: null }] };
      }
      if (query.includes('SELECT id, trip_id') && query.includes('FROM ride_requests')) {
        return { rowCount: 1, rows: [{ id: 'request-id', trip_id: 'trip-id' }] };
      }
      if (query.includes('SELECT id, series_id') && query.includes('FROM trips')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', series_id: null }] };
      }
      if (query.includes('SELECT id, series_id') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', series_id: null }] };
      }
      if (query.includes('SELECT r.id, r.scheduled_at, r.trip_id, t.started_at')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'request-id',
            scheduled_at: pickupAt,
            trip_id: 'trip-id',
            started_at: null,
          }],
        };
      }
      if (query.includes('SELECT planned_at')) {
        return { rowCount: 1, rows: [{ planned_at: pickupAt }] };
      }
      if (query.includes('UPDATE ride_requests') && query.includes('cancelled_late = $3')) {
        return {
          rowCount: 1,
          rows: [{ id: 'request-id', status: 'cancelled', cancelled_late: values[2] }],
        };
      }
      if (query.includes('SELECT count(DISTINCT ride_request_id)::int AS count')) {
        return { rowCount: 1, rows: [{ count: 1 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const cancelled = await rideRequestService.cancel('passenger-id', 'request-id');
    const update = statements.find(({ query }) =>
      query.includes('UPDATE ride_requests') && query.includes('cancelled_late = $3')
    );
    assert.equal(cancelled[0].cancelled_late, true);
    assert.equal(update.values[0], 'request-id');
    assert.equal(update.values[2], true);
    assert.ok(statements.some(({ query }) =>
      query.includes("SET status = 'skipped', skip_kind = 'cancelled'")
    ));
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    if (originalLateHours === undefined) delete process.env.LATE_CANCELLATION_HOURS;
    else process.env.LATE_CANCELLATION_HOURS = originalLateHours;
  }
});

test('passenger cancellation is exempt from late status shortly after a trip is rescheduled', async () => {
  const originalConnect = pool.connect;
  const originalExemptHours = process.env.CHANGE_CANCEL_EXEMPT_HOURS;
  process.env.CHANGE_CANCEL_EXEMPT_HOURS = '24';
  const statements = [];
  const pickupAt = new Date(Date.now() + 30 * 60_000);
  const rescheduledAt = new Date(Date.now() - 60 * 60_000);
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT id, series_id') && query.includes('FROM ride_requests')) {
        return { rowCount: 1, rows: [{ id: 'request-id', series_id: null }] };
      }
      if (query.includes('SELECT id, trip_id') && query.includes('FROM ride_requests')) {
        return { rowCount: 1, rows: [{ id: 'request-id', trip_id: 'trip-id' }] };
      }
      if (query.includes('SELECT id, series_id') && query.includes('FROM trips')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', series_id: null }] };
      }
      if (query.includes('SELECT id, series_id') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', series_id: null }] };
      }
      if (query.includes('SELECT r.id, r.scheduled_at, r.trip_id, t.started_at')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'request-id',
            scheduled_at: pickupAt,
            trip_id: 'trip-id',
            started_at: null,
            rescheduled_at: rescheduledAt,
          }],
        };
      }
      if (query.includes('SELECT planned_at')) {
        return { rowCount: 1, rows: [{ planned_at: pickupAt }] };
      }
      if (query.includes('UPDATE ride_requests') && query.includes('cancelled_late = $3')) {
        return {
          rowCount: 1,
          rows: [{ id: 'request-id', status: 'cancelled', cancelled_late: values[2] }],
        };
      }
      if (query.includes('SELECT count(DISTINCT ride_request_id)::int AS count')) {
        return { rowCount: 1, rows: [{ count: 1 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const cancelled = await rideRequestService.cancel('passenger-id', 'request-id');
    const update = statements.find(({ query }) =>
      query.includes('UPDATE ride_requests') && query.includes('cancelled_late = $3')
    );
    assert.equal(cancelled[0].cancelled_late, false);
    assert.equal(update.values[2], false);
  } finally {
    pool.connect = originalConnect;
    if (originalExemptHours === undefined) delete process.env.CHANGE_CANCEL_EXEMPT_HOURS;
    else process.env.CHANGE_CANCEL_EXEMPT_HOURS = originalExemptHours;
  }
});

test('account deletion requires the current password and blocks drivers with an in-progress trip', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const passwordHash = await bcrypt.hash('correct password', 4);
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('FROM users') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'driver-id', role: 'driver', password_hash: passwordHash }] };
      }
      if (query.includes("status = 'in_progress'")) {
        return { rowCount: 1, rows: [{ id: 'active-trip' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => query.includes('FROM users')
    ? { rowCount: 1, rows: [{ role: 'driver', password_hash: passwordHash }] }
    : { rowCount: 0, rows: [] };

  try {
    await assert.rejects(
      authService.deleteAccount('driver-id', { current_password: 'wrong password' }),
      /Current password is incorrect/
    );
    assert.equal(statements.length, 0);
    statements.length = 0;
    await assert.rejects(
      authService.deleteAccount('driver-id', { current_password: 'correct password' }),
      /cannot be deleted while a Trip is in progress/
    );
    assert.equal(statements.at(-1).query, 'ROLLBACK');
    assert.equal(statements.some(({ query }) => query.includes('UPDATE users')), false);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('driver account deletion cancels future trips and offers, anonymises driver data and audits atomically', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const passwordHash = await bcrypt.hash('correct password', 4);
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('FROM users') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'driver-id', role: 'driver', password_hash: passwordHash }] };
      }
      if (query.includes("status = 'in_progress'")) return { rowCount: 0, rows: [] };
      if (query.includes("status IN ('accepted','offered','unassigned','draft')")) {
        return { rowCount: 1, rows: [{ id: 'trip-id', series_id: 'series-id' }] };
      }
      if (query.includes('FROM trip_offers')) {
        return { rowCount: 1, rows: [{ series_id: 'series-id' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => query.includes('FROM users')
    ? { rowCount: 1, rows: [{ role: 'driver', password_hash: passwordHash }] }
    : { rowCount: 0, rows: [] };

  try {
    await authService.deleteAccount('driver-id', { current_password: 'correct password' });
    assert.ok(statements.some(({ query, values }) =>
      query.includes("SET status = 'cancelled', responded_at = now()")
      && values[0][0] === 'series-id'
    ));
    assert.ok(statements.some(({ query, values }) =>
      query.includes("SET status = 'cancelled', driver_user_id = NULL")
      && values[0][0] === 'trip-id'
    ));
    assert.ok(statements.some(({ query }) =>
      query.includes("SET address = 'Removed', id_number = 'DELETED-'")
      && query.includes('licence_number = NULL')
    ));
    const anonymizeUser = statements.find(({ query }) =>
      query.includes("email = 'deleted-' || id::text")
    );
    assert.ok(anonymizeUser.query.includes('deleted_at = now()'));
    assert.match(anonymizeUser.values[0], /^\$2[aby]\$/);
    const audit = statements.find(({ query }) => query.includes("'account.deleted'"));
    assert.equal(audit.values[0], 'driver-id');
    assert.equal(audit.values[1], 'driver');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('passenger account deletion cancels ride requests and anonymises trip-stop location data', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const passwordHash = await bcrypt.hash('correct password', 4);
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('FROM users') && query.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'passenger-id', role: 'passenger', password_hash: passwordHash }] };
      }
      if (query.includes('UPDATE ride_requests') && query.includes('RETURNING id, trip_id')) {
        return { rowCount: 1, rows: [{ id: 'request-id', trip_id: 'trip-id' }] };
      }
      if (query.includes('count(DISTINCT ride_request_id)')) {
        return { rowCount: 1, rows: [{ count: 0 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => query.includes('FROM users')
    ? { rowCount: 1, rows: [{ role: 'passenger', password_hash: passwordHash }] }
    : { rowCount: 0, rows: [] };

  try {
    await authService.deleteAccount('passenger-id', { current_password: 'correct password' });
    const cancelRequests = statements.find(({ query }) =>
      query.includes('UPDATE ride_requests') && query.includes('RETURNING id, trip_id')
    );
    assert.match(cancelRequests.query, /cancelled_by = \$1/);
    assert.match(cancelRequests.query, /cancel_reason = 'Passenger account deleted.'/);
    const redactStops = statements.find(({ query }) =>
      query.includes("address = 'Removed', suburb = NULL")
    );
    assert.equal(redactStops.values[0], 'passenger-id');
    assert.ok(statements.some(({ query }) => query.includes('emergency_contact_name = NULL')));
    assert.ok(statements.some(({ query }) =>
      query.includes("SET status = 'cancelled', cancelled_at = now()")
    ));
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('account deletion rejects administrator accounts even if called outside the route', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const client = {
    query: async (query) => query.includes('FROM users') && query.includes('FOR UPDATE')
      ? { rowCount: 1, rows: [{ id: 'admin-id', role: 'admin', password_hash: 'unused' }] }
      : { rowCount: 1, rows: [] },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async (query) => query.includes('FROM users')
    ? { rowCount: 1, rows: [{ role: 'admin', password_hash: 'unused' }] }
    : { rowCount: 0, rows: [] };

  try {
    await assert.rejects(
      authService.deleteAccount('admin-id', { current_password: 'password1' }),
      /Account not found/
    );
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('passenger ride request validation enforces the seven-day booking window', () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + 5 * 60_000));
  const part = (type) => parts.find((item) => item.type === type).value;
  const firstDate = `${part('year')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}`;
  const addDays = (value, days) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const weekdays = [1, 2, 3, 4, 5, 6, 7];
  const valid = rideRequestCreateSchema.safeParse({
    direction: 'to_work',
    date: firstDate,
    time,
    repeat: { weekdays, until: addDays(firstDate, 6) },
  });
  const invalid = rideRequestCreateSchema.safeParse({
    direction: 'home',
    date: '2030-02-31',
    time: '25:90',
  });
  const twoWeeksAhead = rideRequestCreateSchema.safeParse({
    direction: 'to_work',
    date: addDays(firstDate, 14),
    time,
  });
  const eightDaysAhead = rideRequestCreateSchema.safeParse({
    direction: 'to_work',
    date: addDays(firstDate, 8),
    time,
  });
  const repeatBeyondAWeek = rideRequestCreateSchema.safeParse({
    direction: 'to_work',
    date: firstDate,
    time,
    repeat: { weekdays, until: addDays(firstDate, 8) },
  });

  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
  assert.equal(eightDaysAhead.success, false);
  assert.equal(twoWeeksAhead.success, false);
  assert.equal(repeatBeyondAWeek.success, false);
});

test('passenger repeat booking creates matching dates in one shared series', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  let createdId = 0;
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT p.workplace_id')) return { rowCount: 1, rows: [{ workplace_id: 'workplace-id' }] };
      if (query.includes('SELECT id') && query.includes('FROM ride_requests')) return { rowCount: 0, rows: [] };
      if (query.includes('INSERT INTO ride_requests')) {
        createdId += 1;
        return {
          rowCount: 1,
          rows: [{
            id: `request-${createdId}`,
            direction: values[1],
            scheduled_at: values[2],
            series_id: values[3],
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const requests = await rideRequestService.create('passenger-id', {
      direction: 'to_work',
      date: '2030-01-07',
      time: '07:30',
      repeat: { weekdays: [1, 7], until: '2030-01-13' },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].series_id, requests[1].series_id);
    assert.notEqual(requests[0].series_id, null);
    assert.equal(requests[0].scheduled_at, '2030-01-07T07:30:00+02:00');
    assert.equal(requests[1].scheduled_at, '2030-01-13T07:30:00+02:00');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('passenger can rebook a cancelled ride and request multiple times per day', async () => {
  const originalConnect = pool.connect;
  const created = [];
  const client = {
    query: async (query, values) => {
      if (query.includes('SELECT p.workplace_id')) {
        return { rowCount: 1, rows: [{ workplace_id: 'workplace-id' }] };
      }
      if (query.includes('INSERT INTO ride_requests')) {
        const request = {
          id: `request-${created.length + 1}`,
          direction: values[1],
          scheduled_at: values[2],
          series_id: values[3],
        };
        created.push(request);
        return { rowCount: 1, rows: [request] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const morningRide = await rideRequestService.create('passenger-id', {
      direction: 'to_work',
      date: '2030-01-07',
      time: '07:30',
    });
    created[0].status = 'cancelled';
    const replacementRide = await rideRequestService.create('passenger-id', {
      direction: 'to_work',
      date: '2030-01-07',
      time: '07:30',
    });
    const laterRide = await rideRequestService.create('passenger-id', {
      direction: 'to_work',
      date: '2030-01-07',
      time: '09:15',
    });

    assert.equal(morningRide[0].direction, replacementRide[0].direction);
    assert.equal(morningRide[0].scheduled_at, replacementRide[0].scheduled_at);
    assert.equal(morningRide[0].direction, laterRide[0].direction);
    assert.notEqual(morningRide[0].scheduled_at, laterRide[0].scheduled_at);
    assert.equal(created.length, 3);
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver review writes its audit event in the same transaction', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('NULLIF(btrim(d.licence_number)')) {
        return { rowCount: 1, rows: [{ ready: true }] };
      }
      if (query.includes('UPDATE drivers')) {
        return {
          rowCount: 1,
          rows: [{ user_id: 'driver-id', status: 'approved', approved_at: new Date() }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const result = await reviewService.reviewDriver('driver-id', 'admin-id', {
      status: 'approved',
    });
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.equal(result.status, 'approved');
    assert.equal(audit.values[0], 'admin-id');
    assert.equal(audit.values[1], 'driver.approved');
    assert.match(statements.find(({ query }) => query.includes('UPDATE drivers')).query, /\$2::uuid/);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver approval is blocked until licence and vehicle eligibility are complete', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('NULLIF(btrim(d.licence_number)')) {
        return { rowCount: 1, rows: [{ ready: false }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await assert.rejects(
      reviewService.reviewDriver('driver-id', 'admin-id', { status: 'approved' }),
      (error) => error.statusCode === 409
        && error.message === 'Record a current driver licence and approve a complete vehicle before approving this driver.'
    );
    assert.ok(statements.some(({ query }) => query === 'ROLLBACK'));
    assert.equal(statements.some(({ query }) => query.includes('UPDATE drivers')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('driver document updates are validated and audit only expiry dates', async () => {
  const parsed = driverDocumentsSchema.safeParse({
    licence_number: '  D1234567  ',
    licence_expiry: '2030-12-31',
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.licence_number, 'D1234567');
  assert.equal(driverDocumentsSchema.safeParse({
    licence_number: '',
    licence_expiry: 'not-a-date',
  }).success, false);

  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('UPDATE drivers')) {
        return {
          rowCount: 1,
          rows: [{ user_id: 'driver-id', licence_expiry: '2030-12-31', prdp_expiry: null }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await reviewService.updateDriverDocuments('driver-id', 'admin-id', parsed.data);
    const update = statements.find(({ query }) => query.includes('UPDATE drivers'));
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));
    assert.match(update.query, /is_available = CASE WHEN \$3::date < CURRENT_DATE THEN FALSE ELSE is_available END/);
    assert.equal(audit.values[1], 'driver-id');
    assert.deepEqual(audit.values[2], { licence_expiry: '2030-12-31', prdp_expiry: null });
    assert.equal(JSON.stringify(audit.values[2]).includes('D1234567'), false);
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('vehicle approval updates only the pending vehicle and audits the admin decision', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('UPDATE vehicles')) {
        return {
          rowCount: 1,
          rows: [{ id: 'vehicle-id', driver_user_id: 'driver-id', status: 'approved' }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const result = await reviewService.reviewVehicle('vehicle-id', 'admin-id', {
      status: 'approved',
    });
    const update = statements.find(({ query }) => query.includes('UPDATE vehicles'));
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.equal(result.status, 'approved');
    assert.match(update.query, /approved_by = CASE WHEN \$1 = 'approved' THEN \$2::uuid/);
    assert.match(update.query, /WHERE id = \$4 AND status = 'pending'/);
    assert.equal(update.values[0], 'approved');
    assert.equal(update.values[1], 'admin-id');
    assert.equal(audit.values[1], 'vehicle.approved');
    assert.equal(audit.values[2], 'vehicle-id');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('vehicle onboarding reports the existing live-vehicle limit as a conflict', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query) => {
      statements.push(query);
      if (query.includes('SELECT d.user_id')) return { rowCount: 1, rows: [{ user_id: 'driver-id' }] };
      if (query.includes('INSERT INTO vehicles')) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'vehicles_one_live_per_driver_uq',
        });
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await assert.rejects(
      reviewService.onboardVehicle('admin-id', {
        driver_user_id: 'driver-id',
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        colour: 'White',
        registration_number: 'ABC123GP',
        seat_count: 4,
      }),
      (error) => error.statusCode === 409
        && error.message === 'This driver already has a pending or approved vehicle.'
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
  } finally {
    pool.connect = originalConnect;
  }
});

test('vehicle onboarding explains duplicate registration numbers', async () => {
  const originalConnect = pool.connect;
  const client = {
    query: async (query) => {
      if (query.includes('SELECT d.user_id')) return { rowCount: 1, rows: [{ user_id: 'driver-id' }] };
      if (query.includes('INSERT INTO vehicles')) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'vehicles_registration_number_uq',
        });
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    await assert.rejects(
      reviewService.onboardVehicle('admin-id', {
        driver_user_id: 'driver-id',
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        colour: 'White',
        registration_number: 'ABC123GP',
        seat_count: 4,
      }),
      (error) => error.statusCode === 409
        && error.message.includes('already in the system')
        && error.message.includes('Do not add it again')
    );
  } finally {
    pool.connect = originalConnect;
  }
});

test('approved driver search is prefix-based and clamps its page size to 100', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (query, params) => {
    calls.push({ query, params });
    return query.includes('count(*)::int AS total')
      ? { rowCount: 1, rows: [{ total: 250 }] }
      : { rowCount: 0, rows: [] };
  };

  try {
    const result = await reviewService.listApprovedDrivers(
      ' Jo%_ ',
      { page_size: 1000 }
    );
    assert.match(calls[1].query, /LIMIT \$2 OFFSET \$3/);
    assert.match(calls[1].query, /lower\(u\.name\) LIKE \$1/);
    assert.deepEqual(calls[1].params, ['jo\\%\\_%', 100, 0]);
    assert.equal(result.pagination.page_size, 100);
  } finally {
    pool.query = originalQuery;
  }
});

test('pending driver applications return only the requested page and total', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes('count(*)')) return { rows: [{ total: 43 }] };
    return { rows: [{ id: 'driver-id', status: 'pending' }] };
  };

  try {
    const result = await reviewService.listPendingDriverApplications({
      page: 2,
      page_size: 20,
      search: 'Ada',
    });

    assert.equal(result.applications.length, 1);
    assert.deepEqual(result.pagination, { page: 2, page_size: 20, total: 43, total_pages: 3 });
    assert.match(calls[1].query, /LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(calls[1].values, ['ada%', 20, 20]);
  } finally {
    pool.query = originalQuery;
  }
});

test('driver can submit a vehicle for review', async () => {
  const originalQuery = pool.query;
  const originalSecret = process.env.JWT_SECRET;
  const driverId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const vehicle = {
    id: randomUUID(),
    make: 'Toyota',
    model: 'Corolla',
    year: 2020,
    colour: 'White',
    registration_number: 'ABC123GP',
    seat_count: 4,
    status: 'pending',
    rejection_reason: null,
    created_at: new Date().toISOString(),
  };
  let insert;
  process.env.JWT_SECRET = secret;
  pool.query = async (query, values) => {
    insert = { query, values };
    return { rowCount: 1, rows: [vehicle] };
  };

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/vehicles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt.sign({ id: driverId, role: 'driver' }, secret)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        colour: 'White',
        registration_number: 'abc123gp',
        seat_count: 4,
      }),
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).vehicle.status, 'pending');
    assert.match(insert.query, /'pending'/);
    assert.equal(insert.values[0], driverId);
    assert.equal(insert.values[5], 'ABC123GP');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    pool.query = originalQuery;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('trip cancellation writes an audit event in the same transaction', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: null }] };
      }
      if (query.includes('SELECT id FROM trips WHERE id = $1 ORDER BY id FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id' }] };
      }
      if (query.includes('SELECT status')) {
        return { rowCount: 1, rows: [{ status: 'offering' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async () => ({ rows: [{ id: 'trip-id', status: 'cancelled' }] });

  try {
    await tripService.cancelTrip('trip-id', 'admin-id');
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.equal(audit.values[0], 'admin-id');
    assert.equal(audit.values[1], 'trip-id');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('driver starts only an assigned trip and audits the transition', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: null }] };
      }
      if (query.includes('SELECT id FROM trips WHERE id = $1 ORDER BY id FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id' }] };
      }
      if (query.includes('SELECT id, status')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', status: 'accepted' }] };
      }
      if (query.includes('UPDATE trips')) {
        return { rowCount: 1, rows: [{ id: 'trip-id', status: 'in_progress', started_at: new Date() }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const result = await tripService.startDriverTrip('driver-id', 'trip-id');
    const audit = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));

    assert.equal(result.status, 'in_progress');
    assert.equal(audit.values[0], 'driver-id');
    assert.equal(audit.values[1], 'trip-id');
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});

test('completing the final trip stop completes the trip and ride requests', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    query: async (query, values) => {
      statements.push({ query, values });
      if (query.includes('SELECT series_id FROM trips WHERE id = $1')) {
        return { rowCount: 1, rows: [{ series_id: null }] };
      }
      if (query.includes('SELECT id FROM trips WHERE id = $1 ORDER BY id FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'trip-id' }] };
      }
      if (query.includes('SELECT status')) {
        return { rowCount: 1, rows: [{ status: 'in_progress' }] };
      }
      if (query.includes('SELECT id, stop_order, status')) {
        return { rowCount: 1, rows: [{ id: 'stop-id', stop_order: 1, status: 'arrived' }] };
      }
      if (query.includes('UPDATE trip_stops')) {
        return {
          rowCount: 1,
          rows: [{ id: 'stop-id', stop_order: 1, stop_type: 'dropoff', status: 'completed' }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  try {
    const result = await tripService.updateDriverTripStop(
      'driver-id',
      'trip-id',
      'stop-id',
      'completed'
    );

    assert.equal(result.trip_completed, true);
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'completed', completed_at = now()")));
    assert.ok(statements.some(({ query }) => query.includes("SET status = 'completed'\n         WHERE trip_id = $1")));
    assert.equal(statements.at(-1).query, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
  }
});