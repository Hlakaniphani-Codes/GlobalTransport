const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
backendRequire('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const testDomain = '@loadtest.example.test';
const companyName = 'Load Test Fixture - loadtest.example.test';
const passengerCount = 1_000;
const driverCount = 150;
const tripCount = 300;
const pendingRequestCount = 400;

function assertLoadTestAllowed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed load-test data when NODE_ENV is production.');
  }
  if (process.env.LOADTEST_ALLOW !== 'true') {
    throw new Error('Set LOADTEST_ALLOW=true to explicitly enable load-test seeding.');
  }
  if (!process.env.LOADTEST_PASSWORD || process.env.LOADTEST_PASSWORD.length < 8) {
    throw new Error('Set LOADTEST_PASSWORD to a password of at least 8 characters.');
  }
  if (!process.env.LOADTEST_ADMIN_USER_ID) {
    throw new Error('Set LOADTEST_ADMIN_USER_ID to a provisioned non-production admin account.');
  }
  if (!process.env.LOADTEST_DATABASE_URL?.trim()) {
    throw new Error('Set LOADTEST_DATABASE_URL to the dedicated non-production load-test database.');
  }
  const target = new URL(process.env.LOADTEST_DATABASE_URL);
  if (/prod/i.test(target.hostname) || !/(loadtest|test)/i.test(target.pathname)) {
    throw new Error('Refusing to seed unless the database host is non-production and its name includes loadtest or test.');
  }
}

function dateAfterMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000);
}

function upcomingShiftDateTime(index, daysAhead = 1) {
  const localDate = new Date(Date.now() + 120 * 60_000);
  localDate.setUTCHours(0, 0, 0, 0);
  localDate.setUTCDate(localDate.getUTCDate() + daysAhead);
  const date = localDate.toISOString().slice(0, 10);
  const hour = [5, 14, 22][index % 3];
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+02:00`);
}

function dateIso(value) {
  return value.toISOString();
}

async function seed() {
  assertLoadTestAllowed();
  process.env.DATABASE_URL = process.env.LOADTEST_DATABASE_URL;
  const bcrypt = backendRequire('bcryptjs');
  const pool = require('../backend/src/db');
  const passwordHash = await bcrypt.hash(process.env.LOADTEST_PASSWORD, 10);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const admin = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'admin' AND is_active = TRUE`,
      [process.env.LOADTEST_ADMIN_USER_ID]
    );
    if (admin.rowCount !== 1) {
      throw new Error('LOADTEST_ADMIN_USER_ID must identify an active admin in the dedicated test database.');
    }
    const existing = await client.query(
      `SELECT count(*)::int AS count
       FROM users
       WHERE lower(email::text) LIKE $1`,
      [`%${testDomain}`]
    );
    if (existing.rows[0].count > 0) {
      throw new Error(
        'Load-test users already exist. Run loadtest:clean explicitly before reseeding.'
      );
    }
    const companyExists = await client.query(
      'SELECT 1 FROM companies WHERE lower(name) = lower($1) LIMIT 1',
      [companyName]
    );
    if (companyExists.rowCount > 0) {
      throw new Error('The load-test company marker already exists; refusing to reuse it.');
    }

    const company = await client.query(
      `INSERT INTO companies (name, contact_name, contact_email)
       VALUES ($1, 'Load Test Fixture', 'loadtest@loadtest.example.test')
       RETURNING id`,
      [companyName]
    );
    const companyId = company.rows[0].id;
    const workplaces = [];
    for (let index = 1; index <= 10; index += 1) {
      const result = await client.query(
        `INSERT INTO workplaces (company_id, name, address, suburb)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          companyId,
          `Load Test Workplace ${String(index).padStart(2, '0')}`,
          `${index} Test Avenue`,
          `Load Test Suburb ${String(index).padStart(2, '0')}`,
        ]
      );
      workplaces.push(result.rows[0].id);
    }

    const passengerUsers = Array.from({ length: passengerCount }, (_, index) => ({
      id: randomUUID(),
      email: `lt.passenger${String(index + 1).padStart(4, '0')}${testDomain}`,
      role: 'passenger',
      name: 'Loadtest',
      surname: `Passenger${String(index + 1).padStart(4, '0')}`,
      phone: `+2782${String(index + 1).padStart(7, '0')}`,
    }));
    const driverUsers = Array.from({ length: driverCount }, (_, index) => ({
      id: randomUUID(),
      email: `lt.driver${String(index + 1).padStart(4, '0')}${testDomain}`,
      role: 'driver',
      name: 'Loadtest',
      surname: `Driver${String(index + 1).padStart(4, '0')}`,
      phone: `+2783${String(index + 1).padStart(7, '0')}`,
    }));
    const users = [...passengerUsers, ...driverUsers];
    await client.query(
      `INSERT INTO users
         (id, email, password_hash, role, name, surname, contact_number, terms_accepted_at)
       SELECT source.id, source.email, $7, source.role, source.name, source.surname,
              source.contact_number, now()
       FROM unnest(
         $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
       ) AS source(id, email, role, name, surname, contact_number)`,
      [
        users.map(({ id }) => id),
        users.map(({ email }) => email),
        users.map(({ role }) => role),
        users.map(({ name }) => name),
        users.map(({ surname }) => surname),
        users.map(({ phone }) => phone),
        passwordHash,
      ]
    );

    const passengerWorkplaces = passengerUsers.map((_, index) => workplaces[index % workplaces.length]);
    await client.query(
      `INSERT INTO passengers
         (user_id, address, employee_number, workplace, workplace_id,
          home_suburb, workplace_suburb)
       SELECT source.user_id, source.address, source.employee_number, source.workplace,
              source.workplace_id, source.home_suburb, source.workplace_suburb
       FROM unnest(
         $1::uuid[], $2::text[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::text[]
       ) AS source(user_id, address, employee_number, workplace, workplace_id,
                   home_suburb, workplace_suburb)`,
      [
        passengerUsers.map(({ id }) => id),
        passengerUsers.map((_, index) => `${index + 1} Load Test Street`),
        passengerUsers.map((_, index) => `LT-EMP-${String(index + 1).padStart(5, '0')}`),
        passengerWorkplaces.map((_, index) => `Load Test Workplace ${String((index % 10) + 1).padStart(2, '0')}`),
        passengerWorkplaces,
        passengerUsers.map((_, index) => `Home Suburb ${String((index % 20) + 1).padStart(2, '0')}`),
        passengerUsers.map((_, index) => `Work Suburb ${String((index % 20) + 1).padStart(2, '0')}`),
      ]
    );

    await client.query(
      `INSERT INTO drivers
         (user_id, address, id_number, status, licence_number, licence_expiry,
          prdp_number, prdp_expiry, is_available, approved_at)
       SELECT source.user_id, source.address, source.id_number, 'approved',
              source.licence_number, CURRENT_DATE + 730,
              source.prdp_number, CURRENT_DATE + 730, TRUE, now()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS source(user_id, address, id_number, licence_number, prdp_number)`,
      [
        driverUsers.map(({ id }) => id),
        driverUsers.map((_, index) => `${index + 1} Load Test Road`),
        driverUsers.map((_, index) => String(9_000_000_000_000 + index + 1)),
        driverUsers.map((_, index) => `LT-LIC-${String(index + 1).padStart(4, '0')}`),
        driverUsers.map((_, index) => `LT-PRDP-${String(index + 1).padStart(4, '0')}`),
      ]
    );

    const vehicleIds = driverUsers.map(() => randomUUID());
    await client.query(
      `INSERT INTO vehicles
         (id, driver_user_id, make, model, year, colour, registration_number,
          seat_count, licence_disc_expiry, status)
       SELECT source.id, source.driver_user_id, 'Toyota', 'Quantum', 2023,
              'White', source.registration_number, 15, CURRENT_DATE + 730, 'approved'
       FROM unnest($1::uuid[], $2::uuid[], $3::text[])
         AS source(id, driver_user_id, registration_number)`,
      [
        vehicleIds,
        driverUsers.map(({ id }) => id),
        driverUsers.map((_, index) => `LT${String(index + 1).padStart(6, '0')}`),
      ]
    );

    const createdBy = admin.rows[0].id;
    const seriesIds = Array.from({ length: tripCount }, () => randomUUID());
    await client.query(
      `INSERT INTO trip_series (id, created_by)
       SELECT source.id, source.created_by
       FROM unnest($1::uuid[], $2::uuid[]) AS source(id, created_by)`,
      [seriesIds, seriesIds.map(() => createdBy)]
    );

    const trips = Array.from({ length: tripCount }, (_, index) => {
      const status = index < 100 ? 'offered'
        : index < 200 ? 'accepted'
          : index < 250 ? 'in_progress'
            : 'completed';
      const driverIndex = index >= 100 && index < 250
        ? index - 100
        : index >= 250 ? index - 250
          : null;
      const scheduledAt = status === 'in_progress'
        ? dateAfterMinutes(-60 + (index - 200) * 0.1)
        : status === 'completed'
          ? dateAfterMinutes(-2 * 24 * 60 + (index - 250) * 3)
          : status === 'accepted' && index % 5 === 0
            ? dateAfterMinutes(60 + (index % 20))
            : upcomingShiftDateTime(index, 1 + (index % 6));
      const startedAt = status === 'in_progress'
        ? dateAfterMinutes(-55 + (index - 200) * 0.1)
        : status === 'completed' ? dateAfterMinutes(-2 * 24 * 60 + (index - 250) * 3) : null;
      const completedAt = status === 'completed'
        ? new Date(scheduledAt.getTime() + 75 * 60_000)
        : null;
      return {
        id: randomUUID(),
        seriesId: seriesIds[index],
        status,
        scheduledAt,
        endsAt: dateAfterMinutes((scheduledAt.getTime() - Date.now()) / 60_000 + 90),
        startedAt,
        completedAt,
        driverId: driverIndex === null ? null : driverUsers[driverIndex].id,
        vehicleId: driverIndex === null ? null : vehicleIds[driverIndex],
        workplaceId: workplaces[index % workplaces.length],
      };
    });
    await client.query(
      `INSERT INTO trips
         (id, direction, scheduled_at, starts_at, ends_at, status, started_at, completed_at, driver_user_id,
          vehicle_id, created_by, series_id, workplace_name, workplace_address)
       SELECT source.id, source.direction, source.scheduled_at, source.scheduled_at,
              source.ends_at, source.status, source.started_at, source.completed_at,
              source.driver_user_id, source.vehicle_id,
              source.created_by, source.series_id, source.workplace_name, source.workplace_address
       FROM unnest(
         $1::uuid[], $2::text[], $3::timestamptz[], $4::timestamptz[],
         $5::text[], $6::timestamptz[], $7::timestamptz[], $8::uuid[],
         $9::uuid[], $10::uuid[], $11::text[], $12::text[], $13::uuid[]
       ) AS source(id, direction, scheduled_at, ends_at, status, started_at,
                   completed_at, driver_user_id, vehicle_id, series_id,
                   workplace_name, workplace_address, created_by)`,
      [
        trips.map(({ id }) => id),
        trips.map((_, index) => index % 2 ? 'home' : 'to_work'),
        trips.map(({ scheduledAt }) => dateIso(scheduledAt)),
        trips.map(({ endsAt }) => dateIso(endsAt)),
        trips.map(({ status }) => status),
        trips.map(({ startedAt }) => startedAt && dateIso(startedAt)),
        trips.map(({ completedAt }) => completedAt && dateIso(completedAt)),
        trips.map(({ driverId }) => driverId),
        trips.map(({ vehicleId }) => vehicleId),
        trips.map(({ seriesId }) => seriesId),
        trips.map(({ workplaceId }) => `Load Test Workplace ${String((workplaces.indexOf(workplaceId) % 10) + 1).padStart(2, '0')}`),
        trips.map((_, index) => `${index + 1} Test Avenue`),
        trips.map(() => createdBy),
      ]
    );

    const tripRequests = trips.map((trip, index) => ({
      id: randomUUID(),
      trip,
      passenger: passengerUsers[index].id,
      workplace: trip.workplaceId,
      direction: index % 2 ? 'home' : 'to_work',
      status: trip.status === 'completed' ? 'completed' : 'assigned',
    }));
    const pendingRequests = Array.from({ length: pendingRequestCount }, (_, index) => ({
      id: randomUUID(),
      passenger: passengerUsers[index + tripCount].id,
      workplace: workplaces[(index + tripCount) % workplaces.length],
      direction: index % 2 ? 'home' : 'to_work',
      scheduledAt: upcomingShiftDateTime(index, 1 + (index % 6)),
    }));
    const requests = [
      ...tripRequests.map((request) => ({
        ...request,
        scheduledAt: request.trip.scheduledAt,
        tripId: request.trip.id,
      })),
      ...pendingRequests.map((request) => ({
        ...request,
        status: 'pending',
        tripId: null,
      })),
    ];
    await client.query(
      `INSERT INTO ride_requests
         (id, passenger_user_id, workplace_id, direction, scheduled_at, status, trip_id)
       SELECT source.id, source.passenger_user_id, source.workplace_id,
              source.direction, source.scheduled_at, source.status, source.trip_id
       FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[],
         $5::timestamptz[], $6::text[], $7::uuid[]
       ) AS source(id, passenger_user_id, workplace_id, direction, scheduled_at, status, trip_id)`,
      [
        requests.map(({ id }) => id),
        requests.map(({ passenger }) => passenger),
        requests.map(({ workplace }) => workplace),
        requests.map(({ direction }) => direction),
        requests.map(({ scheduledAt }) => dateIso(scheduledAt)),
        requests.map(({ status }) => status),
        requests.map(({ tripId }) => tripId),
      ]
    );

    const stops = tripRequests.flatMap((request, index) => {
      const pickupStatus = request.trip.status === 'in_progress' ? 'completed'
        : request.trip.status === 'completed' ? 'completed'
          : 'pending';
      const dropoffStatus = request.trip.status === 'in_progress' && index < 225 ? 'en_route'
        : request.trip.status === 'in_progress' ? 'arrived'
        : request.trip.status === 'completed' ? 'completed'
          : 'pending';
      const pickupAt = request.trip.scheduledAt;
      const dropoffAt = new Date(pickupAt.getTime() + 45 * 60_000);
      const pickupOccurredAt = request.trip.startedAt ?? pickupAt;
      const dropoffOccurredAt = request.trip.status === 'in_progress'
        ? dateAfterMinutes(-2)
        : request.trip.status === 'completed'
          ? request.trip.completedAt
          : null;
      return [
        {
          id: randomUUID(),
          requestId: request.id,
          tripId: request.trip.id,
          passengerId: request.passenger,
          order: 1,
          type: 'pickup',
          address: `${index + 1} Load Test Street`,
          suburb: `Home Suburb ${String((index % 20) + 1).padStart(2, '0')}`,
          plannedAt: pickupAt,
          status: pickupStatus,
          enRouteAt: pickupStatus === 'pending' ? null : pickupOccurredAt,
          arrivedAt: pickupStatus === 'pending' ? null : pickupOccurredAt,
          completedAt: pickupStatus === 'completed' ? pickupOccurredAt : null,
        },
        {
          id: randomUUID(),
          requestId: request.id,
          tripId: request.trip.id,
          passengerId: request.passenger,
          order: 2,
          type: 'dropoff',
          address: `${index + 1} Test Avenue`,
          suburb: `Work Suburb ${String((index % 20) + 1).padStart(2, '0')}`,
          plannedAt: dropoffAt,
          status: dropoffStatus,
          enRouteAt: ['en_route', 'arrived', 'completed'].includes(dropoffStatus)
            ? (dropoffOccurredAt ?? dropoffAt)
            : null,
          arrivedAt: ['arrived', 'completed'].includes(dropoffStatus)
            ? (dropoffOccurredAt ?? dropoffAt)
            : null,
          completedAt: dropoffStatus === 'completed' ? dropoffOccurredAt : null,
        },
      ];
    });
    await client.query(
      `INSERT INTO trip_stops
         (id, trip_id, ride_request_id, passenger_user_id, stop_order, sequence,
          stop_type, address, suburb, planned_at, status, en_route_at, arrived_at, completed_at)
       SELECT source.id, source.trip_id, source.ride_request_id, source.passenger_user_id,
              source.stop_order, sequence_values.sequence, source.stop_type, source.address,
              source.suburb, source.planned_at, source.status, source.en_route_at,
              source.arrived_at, source.completed_at
       FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::int[],
         $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::text[],
         $11::timestamptz[], $12::timestamptz[], $13::timestamptz[]
       ) AS source(id, trip_id, ride_request_id, passenger_user_id, stop_order,
                   stop_type, address, suburb, planned_at, status, en_route_at, arrived_at,
                   completed_at)
       CROSS JOIN LATERAL (SELECT source.stop_order AS sequence) sequence_values`,
      [
        stops.map(({ id }) => id),
        stops.map(({ tripId }) => tripId),
        stops.map(({ requestId }) => requestId),
        stops.map(({ passengerId }) => passengerId),
        stops.map(({ order }) => order),
        stops.map(({ type }) => type),
        stops.map(({ address }) => address),
        stops.map(({ suburb }) => suburb),
        stops.map(({ plannedAt }) => dateIso(plannedAt)),
        stops.map(({ status }) => status),
        stops.map(({ enRouteAt }) => enRouteAt && dateIso(enRouteAt)),
        stops.map(({ arrivedAt }) => arrivedAt && dateIso(arrivedAt)),
        stops.map(({ completedAt }) => completedAt && dateIso(completedAt)),
      ]
    );

    const offers = trips.filter(({ status }) => ['offered', 'accepted'].includes(status))
      .map((trip, tripIndex) => {
        const driverIndex = trip.status === 'offered'
          ? 100 + (tripIndex % 50)
          : tripIndex - 100;
        return {
          id: randomUUID(),
          tripId: trip.id,
          seriesId: trip.seriesId,
          driverId: trip.driverId ?? driverUsers[driverIndex].id,
          vehicleId: trip.vehicleId ?? vehicleIds[driverIndex],
          status: trip.status === 'offered' ? 'pending' : 'accepted',
        };
      });
    await client.query(
      `INSERT INTO trip_offers
         (id, trip_id, series_id, driver_user_id, vehicle_id, offer_order, position,
          window_minutes, status, offered_at, expires_at, responded_at)
       SELECT source.id, source.trip_id, source.series_id, source.driver_user_id,
              source.vehicle_id, 1, 1, 30, source.status, now(),
              CASE WHEN source.status = 'pending' THEN now() + interval '2 hours' END,
              CASE WHEN source.status = 'accepted' THEN now() END
       FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[]
       ) AS source(id, trip_id, series_id, driver_user_id, vehicle_id, status)`,
      [
        offers.map(({ id }) => id),
        offers.map(({ tripId }) => tripId),
        offers.map(({ seriesId }) => seriesId),
        offers.map(({ driverId }) => driverId),
        offers.map(({ vehicleId }) => vehicleId),
        offers.map(({ status }) => status),
      ]
    );

    const fixtureManifest = {
      passengers: passengerUsers.map(({ id }) => id),
      drivers: driverUsers.map(({ id }, index) => ({ user_id: id, vehicle_id: vehicleIds[index] })),
      trips: trips.map((trip) => ({
        id: trip.id,
        series_id: trip.seriesId,
        status: trip.status,
        driver_user_id: trip.driverId,
        starts_at: dateIso(trip.scheduledAt),
        stops: stops.filter((stop) => stop.tripId === trip.id)
          .map(({ id, type, status }) => ({ id, type, status })),
      })),
      offers: offers.map(({ id, tripId, driverId, status }) => ({
        id,
        trip_id: tripId,
        driver_user_id: driverId,
        status,
      })),
      pending_requests: pendingRequests.map((request) => request.id),
    };
    await client.query('COMMIT');
    await fs.writeFile(
      path.join(__dirname, 'fixtures.json'),
      `${JSON.stringify(fixtureManifest)}\n`,
      { mode: 0o600 }
    );
    console.info(JSON.stringify({
      seeded: true,
      passengers: passengerCount,
      drivers: driverCount,
      vehicles: driverCount,
      trips: tripCount,
      pending_ride_requests: pendingRequestCount,
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seed().catch((error) => {
    console.error(`Load-test seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { seed };
