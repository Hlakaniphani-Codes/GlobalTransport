const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
backendRequire('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

function assertLoadTestAllowed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to clean load-test data when NODE_ENV is production.');
  }
  if (process.env.LOADTEST_ALLOW !== 'true') {
    throw new Error('Set LOADTEST_ALLOW=true to explicitly enable load-test cleanup.');
  }
  if (!process.env.LOADTEST_DATABASE_URL?.trim()) {
    throw new Error('Set LOADTEST_DATABASE_URL to the dedicated non-production load-test database.');
  }
  const target = new URL(process.env.LOADTEST_DATABASE_URL);
  if (/prod/i.test(target.hostname) || !/(loadtest|test)/i.test(target.pathname)) {
    throw new Error('Refusing to clean unless the database host is non-production and its name includes loadtest or test.');
  }
}

async function clean() {
  assertLoadTestAllowed();
  process.env.DATABASE_URL = process.env.LOADTEST_DATABASE_URL;
  const pool = require('../backend/src/db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE loadtest_users ON COMMIT DROP AS
       SELECT id FROM users
       WHERE lower(email::text) LIKE '%@loadtest.example.test'`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_trips ON COMMIT DROP AS
       SELECT DISTINCT trip.id
       FROM trips trip
       WHERE trip.created_by IN (SELECT id FROM loadtest_users)
          OR trip.driver_user_id IN (SELECT id FROM loadtest_users)
          OR EXISTS (
            SELECT 1
            FROM trip_stops stop
            JOIN ride_requests request ON request.id = stop.ride_request_id
            WHERE stop.trip_id = trip.id
              AND request.passenger_user_id IN (SELECT id FROM loadtest_users)
          )`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_requests ON COMMIT DROP AS
       SELECT id FROM ride_requests
       WHERE passenger_user_id IN (SELECT id FROM loadtest_users)
          OR trip_id IN (SELECT id FROM loadtest_trips)`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_stops ON COMMIT DROP AS
       SELECT id FROM trip_stops
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR ride_request_id IN (SELECT id FROM loadtest_requests)
          OR passenger_user_id IN (SELECT id FROM loadtest_users)`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_series ON COMMIT DROP AS
       SELECT DISTINCT series_id AS id FROM trips
       WHERE id IN (SELECT id FROM loadtest_trips)
       UNION
       SELECT id FROM trip_series WHERE created_by IN (SELECT id FROM loadtest_users)`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_workplaces ON COMMIT DROP AS
       SELECT id FROM workplaces
       WHERE company_id IN (
         SELECT id FROM companies
         WHERE name = 'Load Test Fixture - loadtest.example.test'
       )`
    );
    await client.query(
      `CREATE TEMP TABLE loadtest_companies ON COMMIT DROP AS
       SELECT id FROM companies
       WHERE name = 'Load Test Fixture - loadtest.example.test'`
    );

    const deletionQueries = [
      `DELETE FROM trip_events
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR stop_id IN (SELECT id FROM loadtest_stops)
          OR actor_user_id IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM incidents
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR reported_by IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM trip_ratings
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR passenger_user_id IN (SELECT id FROM loadtest_users)
          OR driver_user_id IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM trip_withdrawals
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR driver_user_id IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM audit_logs
       WHERE actor_id IN (SELECT id FROM loadtest_users)
          OR (entity_type = 'trip' AND entity_id IN (SELECT id FROM loadtest_trips))
          OR (entity_type = 'trip_stop' AND entity_id IN (SELECT id FROM loadtest_stops))
          OR (entity_type = 'ride_request' AND entity_id IN (SELECT id FROM loadtest_requests))`,
      `DELETE FROM trip_offers
       WHERE trip_id IN (SELECT id FROM loadtest_trips)
          OR driver_user_id IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM trip_stops WHERE id IN (SELECT id FROM loadtest_stops)`,
      `DELETE FROM trips WHERE id IN (SELECT id FROM loadtest_trips)`,
      `DELETE FROM ride_requests WHERE id IN (SELECT id FROM loadtest_requests)`,
      `DELETE FROM trip_series WHERE id IN (SELECT id FROM loadtest_series)`,
      `DELETE FROM users WHERE id IN (SELECT id FROM loadtest_users)`,
      `DELETE FROM workplaces
       WHERE id IN (SELECT id FROM loadtest_workplaces)
         AND NOT EXISTS (SELECT 1 FROM passengers WHERE workplace_id = workplaces.id)
         AND NOT EXISTS (SELECT 1 FROM ride_requests WHERE workplace_id = workplaces.id)`,
      `DELETE FROM companies
       WHERE id IN (SELECT id FROM loadtest_companies)
         AND NOT EXISTS (SELECT 1 FROM workplaces WHERE company_id = companies.id)`,
    ];
    for (const query of deletionQueries) {
      await client.query(query);
    }
    await client.query('COMMIT');
    try {
      await fs.unlink(path.join(__dirname, 'fixtures.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.info('Removed only load-test-domain rows and their dependent fixtures.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  clean().catch((error) => {
    console.error(`Load-test cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { clean };
