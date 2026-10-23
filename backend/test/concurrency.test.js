const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, test } = require('node:test');

const concurrencyEnabled = process.env.NODE_ENV !== 'production'
  && process.env.LOADTEST_ALLOW === 'true'
  && Boolean(process.env.LOADTEST_DATABASE_URL);
if (!concurrencyEnabled) {
  if (process.env.npm_lifecycle_event === 'test:concurrency') {
    throw new Error(
      'Concurrency tests require LOADTEST_ALLOW=true and LOADTEST_DATABASE_URL set to a disposable test database.'
    );
  }
  test('database concurrency suite requires explicit load-test database opt-in', {
    skip: 'Set LOADTEST_ALLOW=true and LOADTEST_DATABASE_URL to run database integration tests.',
  }, () => {});
} else {
  const database = new URL(process.env.LOADTEST_DATABASE_URL);
  if (/prod/i.test(database.hostname) || !/(loadtest|test)/i.test(database.pathname)) {
    throw new Error('Refusing tests unless the database host is non-production and its name includes "loadtest" or "test".');
  }
  process.env.DATABASE_URL = process.env.LOADTEST_DATABASE_URL;

const pool = require('../src/db');
const authService = require('../src/services/authService');
const driverExecution = require('../src/services/driverTripExecutionService');
const notificationService = require('../src/services/notifications');
const offersService = require('../src/services/offers');
const tripAdminService = require('../src/services/tripAdminService');
const fixtureEmail = '%@loadtest.example.test';

after(async () => {
  await pool.end();
});

async function fixtureAdminId() {
  const adminId = process.env.LOADTEST_ADMIN_USER_ID;
  if (!adminId) throw new Error('Set LOADTEST_ADMIN_USER_ID to a provisioned test admin user id.');
  const result = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'admin' AND is_active = TRUE`,
    [adminId]
  );
  assert.equal(result.rowCount, 1, 'The supplied admin id must be an active admin account.');
  return adminId;
}

test('50 simultaneous accept attempts accept a single fixture offer once', async () => {
  const offers = await pool.query(
    `SELECT offer.id, offer.series_id, offer.driver_user_id, offer.vehicle_id
     FROM trip_offers offer
     JOIN trips trip ON trip.id = offer.trip_id
     JOIN users driver ON driver.id = offer.driver_user_id
     WHERE offer.status = 'pending' AND offer.expires_at > now()
       AND trip.status = 'offered'
       AND driver.email LIKE $1
     ORDER BY offer.offered_at, offer.id`,
    [fixtureEmail]
  );
  let fixtureOffer;
  for (const offer of offers.rows) {
    const eligible = await offersService.getEligibleDrivers(
      offer.series_id,
      pool,
      [offer.driver_user_id]
    );
    if (eligible.some((driver) => driver.vehicle_id === offer.vehicle_id)) {
      fixtureOffer = offer;
      break;
    }
  }
  assert.ok(fixtureOffer, 'Seed at least one pending offer for an eligible load-test driver.');

  const attempts = await Promise.allSettled(Array.from({ length: 50 }, () =>
    offersService.respond(fixtureOffer.id, fixtureOffer.driver_user_id, 'accept')
  ));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const accepted = await pool.query(
    `SELECT count(*)::int AS count FROM trip_offers
     WHERE id = $1 AND status = 'accepted' AND driver_user_id = $2`,
    [fixtureOffer.id, fixtureOffer.driver_user_id]
  );
  assert.equal(accepted.rows[0].count, 1);
});

test('100 parallel arrive actions on an arrived fixture stop remain idempotent', async () => {
  const fixture = await pool.query(
    `SELECT trip.id AS trip_id, trip.driver_user_id, stop.id AS stop_id
     FROM trips trip
     JOIN users driver ON driver.id = trip.driver_user_id
     JOIN trip_stops stop ON stop.trip_id = trip.id
     WHERE trip.status = 'in_progress' AND driver.email LIKE $1
       AND stop.status = 'arrived'
     ORDER BY trip.id, stop.sequence
     LIMIT 1`,
    [fixtureEmail]
  );
  assert.equal(fixture.rowCount, 1, 'Seed an in-progress fixture trip with an arrived stop.');
  const { trip_id: tripId, driver_user_id: driverId, stop_id: stopId } = fixture.rows[0];

  const results = await Promise.all(Array.from({ length: 100 }, () =>
    driverExecution.updateStop(driverId, tripId, stopId, 'arrive')
  ));
  assert.equal(results.length, 100);
  const stop = await pool.query(
    `SELECT status FROM trip_stops WHERE id = $1 AND trip_id = $2`,
    [stopId, tripId]
  );
  assert.equal(stop.rows[0]?.status, 'arrived');
});

test('simultaneous trip cancellation and passenger removal preserve fixture stop relationships', async () => {
  const adminId = await fixtureAdminId();
  const fixture = await pool.query(
    `SELECT trip.id AS trip_id, request.id AS request_id
     FROM trips trip
     JOIN trip_stops stop ON stop.trip_id = trip.id AND stop.stop_type = 'pickup'
     JOIN ride_requests request ON request.id = stop.ride_request_id
     JOIN users passenger ON passenger.id = request.passenger_user_id
     WHERE trip.status = 'accepted' AND request.status = 'assigned'
       AND passenger.email LIKE $1
     ORDER BY trip.id, request.id
     LIMIT 1`,
    [fixtureEmail]
  );
  assert.equal(fixture.rowCount, 1, 'Seed an accepted fixture trip with an assigned passenger.');
  const { trip_id: tripId, request_id: requestId } = fixture.rows[0];
  const outcomes = await Promise.allSettled([
    tripAdminService.cancelTrip(tripId, adminId, 'Load-test concurrency fixture.'),
    tripAdminService.removePassenger(tripId, adminId, {
      ride_request_id: requestId,
      reason: 'Load-test concurrency fixture.',
      kind: 'cancelled',
    }),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  const orphanedStops = await pool.query(
    `SELECT count(*)::int AS count
     FROM trip_stops stop
     LEFT JOIN ride_requests request
       ON request.id = stop.ride_request_id
      AND request.passenger_user_id = stop.passenger_user_id
     WHERE stop.trip_id = $1 AND request.id IS NULL`,
    [tripId]
  );
  assert.equal(orphanedStops.rows[0].count, 0);
});

test('two notification workers claim a due fixture job only once', async () => {
  const user = await pool.query(
    `SELECT candidate.id
     FROM users candidate
     WHERE candidate.email LIKE $1 AND candidate.role = 'passenger'
       AND NOT EXISTS (
         SELECT 1 FROM push_tokens token
         WHERE token.user_id = candidate.id AND token.revoked_at IS NULL
       )
     ORDER BY candidate.email
     LIMIT 1`,
    [fixtureEmail]
  );
  assert.equal(user.rowCount, 1, 'Seed at least one load-test passenger without a push token.');
  const notificationId = randomUUID();
  const idempotencyKey = `loadtest-worker-concurrency:${randomUUID()}`;
  await pool.query(
    `INSERT INTO notifications (id, user_id, type, title, body, data, idempotency_key)
     VALUES ($1, $2, 'general', 'Load-test', 'Worker concurrency check.', '{}'::jsonb, $3)`,
    [notificationId, user.rows[0].id, `${idempotencyKey}:notification`]
  );
  const job = await pool.query(
    `INSERT INTO notification_jobs (notification_id, channel, status, next_attempt_at, idempotency_key)
     VALUES ($1, 'push', 'pending', now(), $2)
     RETURNING id`,
    [notificationId, idempotencyKey]
  );
  try {
    await Promise.all([
      notificationService.processDueJobs(1),
      notificationService.processDueJobs(1),
    ]);
    const result = await pool.query(
      `SELECT attempts, status FROM notification_jobs WHERE id = $1`,
      [job.rows[0].id]
    );
    assert.equal(result.rows[0]?.attempts, 1);
    assert.equal(result.rows[0]?.status, 'skipped');
  } finally {
    await pool.query(`DELETE FROM notifications WHERE id = $1`, [notificationId]);
  }
});

test('a registration race for one fixture email creates exactly one account', async () => {
  const email = `lt.race.${randomUUID()}@loadtest.example.test`;
  const input = {
    name: 'Loadtest',
    surname: 'Race',
    address: '1 Load Test Street',
    home_suburb: 'Load Test Suburb',
    workplace_suburb: 'Load Test Workplace Suburb',
    employee_number: `LT-RACE-${randomUUID()}`,
    workplace: 'Load Test Workplace 01',
    contact_number: '+27820000001',
    email,
    password: process.env.LOADTEST_PASSWORD || 'loadtest-only-password',
    terms_accepted: true,
  };
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () =>
      authService.register('passenger', input)
    ));
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const account = await pool.query(
      `SELECT count(*)::int AS count FROM users WHERE email = $1`,
      [email]
    );
    assert.equal(account.rows[0].count, 1);
  } finally {
    await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
  }
});
}
