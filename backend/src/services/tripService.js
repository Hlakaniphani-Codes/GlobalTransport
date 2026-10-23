const pool = require('../db');
const AppError = require('../utils/AppError');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');
const withTransaction = require('../utils/withTransaction');
const {
  lockStopsById,
  lockTripSeries,
  lockTripSet,
} = require('../utils/tripLocking');

const OFFER_WINDOW_SECONDS = 120;

async function runTransaction(work) {
  return withTransaction(work);
}

async function isEligibleCandidate(client, tripId, driverUserId, vehicleId) {
  const result = await client.query(
    `SELECT d.user_id
     FROM trips t
     JOIN drivers d ON d.user_id = $2
     JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
     JOIN vehicles v ON v.id = $3 AND v.driver_user_id = d.user_id
     WHERE t.id = $1
       AND t.status = 'offering'
       AND d.status = 'approved'
       AND d.is_available = TRUE
       AND d.licence_expiry >= CURRENT_DATE
       AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
       AND v.status = 'approved'
       AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
       AND v.seat_count >= (
         SELECT count(DISTINCT ride_request_id)
         FROM trip_stops
         WHERE trip_id = t.id AND stop_type = 'pickup'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM trips active_trip
         WHERE active_trip.driver_user_id = d.user_id
           AND active_trip.status IN ('accepted','in_progress')
           AND active_trip.scheduled_at < t.ends_at
           AND active_trip.ends_at > t.scheduled_at
       )
       AND NOT EXISTS (
         SELECT 1
         FROM trip_offers current_offer
         WHERE current_offer.driver_user_id = d.user_id
           AND current_offer.status = 'pending'
           AND current_offer.trip_id <> t.id
       )`,
    [tripId, driverUserId, vehicleId]
  );
  return result.rowCount === 1;
}

async function releaseTripRequests(client, tripId) {
  await client.query(
    `UPDATE ride_requests
     SET status = 'pending', trip_id = NULL
     WHERE trip_id = $1 AND status = 'assigned'`,
    [tripId]
  );
}

async function dispatchNextOffer(client, tripId) {
  const tripResult = await client.query(
    `SELECT id, scheduled_at, ends_at, status
     FROM trips
     WHERE id = $1
     FOR UPDATE`,
    [tripId]
  );
  const trip = tripResult.rows[0];
  if (!trip || trip.status !== 'offering') return null;

  const currentResult = await client.query(
    `SELECT id
     FROM trip_offers
     WHERE trip_id = $1 AND status = 'pending'
     LIMIT 1`,
    [tripId]
  );
  if (currentResult.rowCount > 0) return currentResult.rows[0].id;

  while (true) {
    const candidateResult = await client.query(
      `SELECT offer.id, offer.driver_user_id, offer.vehicle_id
       FROM trip_offers offer
       JOIN drivers d ON d.user_id = offer.driver_user_id
       JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
       JOIN vehicles v ON v.id = offer.vehicle_id
         AND v.driver_user_id = d.user_id
       WHERE offer.trip_id = $1
         AND offer.status = 'queued'
         AND d.status = 'approved'
         AND d.is_available = TRUE
         AND d.licence_expiry >= CURRENT_DATE
         AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
         AND v.status = 'approved'
         AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
         AND v.seat_count >= (
           SELECT count(DISTINCT ride_request_id)
           FROM trip_stops
           WHERE trip_id = $1 AND stop_type = 'pickup'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM trips active_trip
           WHERE active_trip.driver_user_id = d.user_id
             AND active_trip.status IN ('accepted','in_progress')
             AND active_trip.scheduled_at < $3
             AND active_trip.ends_at > $2
         )
       ORDER BY offer.offer_order
       LIMIT 1
       FOR UPDATE OF offer SKIP LOCKED`,
      [tripId, trip.scheduled_at, trip.ends_at]
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) break;

    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
      [candidate.driver_user_id]
    );
    if (!lockResult.rows[0].locked) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'skipped', responded_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [candidate.id]
      );
      continue;
    }
    const eligible = await isEligibleCandidate(
      client,
      tripId,
      candidate.driver_user_id,
      candidate.vehicle_id
    );
    if (!eligible) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'skipped', responded_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [candidate.id]
      );
      continue;
    }

    const offerResult = await client.query(
      `UPDATE trip_offers
       SET status = 'pending',
           offered_at = now(),
           expires_at = now() + ($2 * INTERVAL '1 second')
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [candidate.id, OFFER_WINDOW_SECONDS]
    );
    if (offerResult.rowCount === 1) return candidate.id;
  }

  await client.query(
    `UPDATE trip_offers
     SET status = 'skipped', responded_at = now()
     WHERE trip_id = $1 AND status = 'queued'`,
    [tripId]
  );
  await client.query(
    `UPDATE trips
     SET status = 'unassigned'
     WHERE id = $1 AND status = 'offering'`,
    [tripId]
  );
  await releaseTripRequests(client, tripId);
  return null;
}

async function listPendingRequests(input = {}) {
  const pagination = require('../utils/pagination').normalizePagination(input);
  const { paginationMetadata } = require('../utils/pagination');
  const [count, result] = await Promise.all([
    pool.query("SELECT count(*)::int AS total FROM ride_requests WHERE status = 'pending' AND trip_id IS NULL"),
    pool.query(
    `SELECT r.id, r.direction, r.scheduled_at,
            u.name AS passenger_name, u.surname AS passenger_surname,
            u.contact_number, p.address AS home_address, p.home_suburb,
            p.home_latitude, p.home_longitude, p.employee_number,
            w.id AS workplace_id, w.name AS workplace_name,
            w.address AS workplace_address, w.suburb AS workplace_suburb,
            w.latitude AS workplace_latitude, w.longitude AS workplace_longitude,
            c.name AS company_name
     FROM ride_requests r
     JOIN passengers p ON p.user_id = r.passenger_user_id
     JOIN users u ON u.id = p.user_id
     JOIN workplaces w ON w.id = r.workplace_id
     JOIN companies c ON c.id = w.company_id
     WHERE r.status = 'pending' AND r.trip_id IS NULL
     ORDER BY r.scheduled_at ASC
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return {
    ride_requests: result.rows,
    pagination: paginationMetadata(count.rows[0].total, pagination),
  };
}

async function listEligibleDrivers(input) {
  const pagination = normalizePagination(input);
  const result = await pool.query(
    `WITH eligible AS (
       SELECT d.user_id, u.name, u.surname, u.contact_number,
              v.id AS vehicle_id, v.make, v.model, v.registration_number, v.seat_count,
              lower(u.name) AS sort_name, lower(u.surname) AS sort_surname
       FROM drivers d
       JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
       JOIN vehicles v ON v.driver_user_id = d.user_id AND v.status = 'approved'
       WHERE d.status = 'approved'
         AND d.is_available = TRUE
         AND d.licence_expiry >= CURRENT_DATE
         AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
         AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
         AND v.seat_count >= $3
         AND NOT EXISTS (
           SELECT 1
           FROM trips t
           WHERE t.driver_user_id = d.user_id
             AND t.status IN ('accepted','in_progress')
             AND t.scheduled_at < $2
             AND t.ends_at > $1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM trip_offers pending_offer
           WHERE pending_offer.driver_user_id = d.user_id
             AND pending_offer.status = 'pending'
         )
     ),
     totals AS (SELECT count(*)::int AS total FROM eligible)
     SELECT totals.total,
            page.user_id, page.name, page.surname, page.contact_number,
            page.vehicle_id, page.make, page.model, page.registration_number,
            page.seat_count
     FROM totals
     LEFT JOIN LATERAL (
       SELECT user_id, name, surname, contact_number, vehicle_id,
              make, model, registration_number, seat_count
       FROM eligible
       ORDER BY sort_surname, sort_name, user_id, seat_count, vehicle_id
       LIMIT $4
       OFFSET GREATEST(0, LEAST(
         ($5 - 1) * $4,
         ((totals.total - 1) / $4) * $4
       ))
     ) page ON TRUE`,
    [
      input.scheduled_at,
      input.ends_at,
      input.passenger_count,
      pagination.page_size,
      pagination.page,
    ]
  );
  const total = result.rows[0]?.total ?? 0;
  const drivers = result.rows
    .filter((row) => row.user_id !== null)
    .map((row) => {
      const driver = { ...row };
      delete driver.total;
      return driver;
    });
  return {
    drivers,
    pagination: paginationMetadata(total, pagination),
  };
}

async function getTrip(tripId) {
  const result = await pool.query(
    `SELECT t.id, t.direction, t.scheduled_at, t.ends_at, t.status,
            t.created_at, t.driver_user_id, u.name AS driver_name,
            u.surname AS driver_surname, v.registration_number,
            (SELECT count(DISTINCT ride_request_id)
             FROM trip_stops WHERE trip_id = t.id AND stop_type = 'pickup') AS passenger_count,
            COALESCE((
              SELECT json_agg(json_build_object(
                'stop_order', s.stop_order,
                'stop_type', s.stop_type,
                'passenger_name', passenger.name,
                'passenger_surname', passenger.surname,
                'address', s.address,
                'suburb', s.suburb,
                'planned_at', s.planned_at
              ) ORDER BY s.stop_order)
              FROM trip_stops s
              JOIN users passenger ON passenger.id = s.passenger_user_id
              WHERE s.trip_id = t.id
            ), '[]'::json) AS stops
     FROM trips t
     LEFT JOIN users u ON u.id = t.driver_user_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.id = $1`,
    [tripId]
  );
  return result.rows[0] || null;
}

async function createTrip(adminUserId, input) {
  const passengerCount = input.ride_request_ids.length;
  const result = await runTransaction(async (client) => {
    const requestResult = await client.query(
      `SELECT r.id, r.direction, r.scheduled_at, r.trip_id,
              p.user_id AS passenger_user_id, p.address AS home_address,
              p.home_suburb, p.home_latitude, p.home_longitude,
              w.address AS workplace_address, w.suburb AS workplace_suburb,
              w.latitude AS workplace_latitude, w.longitude AS workplace_longitude
       FROM ride_requests r
       JOIN passengers p ON p.user_id = r.passenger_user_id
       JOIN workplaces w ON w.id = r.workplace_id
       WHERE r.id = ANY($1::uuid[])
       FOR UPDATE OF r`,
      [input.ride_request_ids]
    );
    if (requestResult.rowCount !== passengerCount) {
      throw new AppError(409, 'One or more ride requests are no longer available.');
    }
    if (requestResult.rows.some((request) =>
      request.trip_id || request.direction !== input.direction
      || request.scheduled_at < new Date(input.scheduled_at)
      || request.scheduled_at > new Date(input.ends_at)
    )) {
      throw new AppError(
        409,
        'Selected ride requests must be unassigned, match the trip direction, and fall within its time window.'
      );
    }

    for (const candidate of input.candidate_drivers) {
      const eligible = await client.query(
        `SELECT d.user_id
         FROM drivers d
         JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
         JOIN vehicles v ON v.id = $2 AND v.driver_user_id = d.user_id
         WHERE d.user_id = $1
           AND d.status = 'approved' AND d.is_available = TRUE
           AND d.licence_expiry >= CURRENT_DATE
           AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
           AND v.status = 'approved'
           AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
           AND v.seat_count >= $3
           AND NOT EXISTS (
             SELECT 1 FROM trips t
             WHERE t.driver_user_id = d.user_id
               AND t.status IN ('accepted','in_progress')
               AND t.scheduled_at < $5 AND t.ends_at > $4
           )
           AND NOT EXISTS (
             SELECT 1 FROM trip_offers o
             WHERE o.driver_user_id = d.user_id AND o.status = 'pending'
           )
         FOR SHARE OF d, v`,
        [
          candidate.driver_user_id,
          candidate.vehicle_id,
          passengerCount,
          input.scheduled_at,
          input.ends_at,
        ]
      );
      if (eligible.rowCount !== 1) {
        throw new AppError(
          409,
          'A selected driver or vehicle is no longer available for this trip.'
        );
      }
    }

    const tripResult = await client.query(
      `INSERT INTO trips (direction, scheduled_at, ends_at, status, created_by)
       VALUES ($1, $2, $3, 'offering', $4)
       RETURNING id`,
      [input.direction, input.scheduled_at, input.ends_at, adminUserId]
    );
    const tripId = tripResult.rows[0].id;

    await client.query(
      `UPDATE ride_requests
       SET status = 'assigned', trip_id = $1
       WHERE id = ANY($2::uuid[])`,
      [tripId, input.ride_request_ids]
    );

    const requests = new Map(requestResult.rows.map((request) => [request.id, request]));
    for (let index = 0; index < input.stop_order.length; index += 1) {
      const stop = input.stop_order[index];
      const request = requests.get(stop.ride_request_id);
      const useHomeAddress = stop.stop_type === 'pickup'
        ? input.direction === 'to_work'
        : input.direction === 'home';
      await client.query(
        `INSERT INTO trip_stops
           (trip_id, ride_request_id, passenger_user_id, stop_order, stop_type,
            address, suburb, latitude, longitude, planned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tripId,
          request.id,
          request.passenger_user_id,
          index + 1,
          stop.stop_type,
          useHomeAddress ? request.home_address : request.workplace_address,
          useHomeAddress ? request.home_suburb : request.workplace_suburb,
          useHomeAddress ? request.home_latitude : request.workplace_latitude,
          useHomeAddress ? request.home_longitude : request.workplace_longitude,
          stop.stop_type === 'pickup' ? request.scheduled_at : null,
        ]
      );
    }

    for (let index = 0; index < input.candidate_drivers.length; index += 1) {
      const candidate = input.candidate_drivers[index];
      await client.query(
        `INSERT INTO trip_offers (trip_id, driver_user_id, vehicle_id, offer_order)
         VALUES ($1, $2, $3, $4)`,
        [tripId, candidate.driver_user_id, candidate.vehicle_id, index + 1]
      );
    }
    await dispatchNextOffer(client, tripId);
    return tripId;
  });

  return getTrip(result);
}

async function listTrips() {
  const result = await pool.query(
    `SELECT t.id, t.direction, t.scheduled_at, t.ends_at, t.status,
            u.name AS driver_name, u.surname AS driver_surname,
            v.registration_number,
            (SELECT count(DISTINCT ride_request_id)
             FROM trip_stops WHERE trip_id = t.id AND stop_type = 'pickup') AS passenger_count
     FROM trips t
     LEFT JOIN users u ON u.id = t.driver_user_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     ORDER BY t.scheduled_at DESC
     LIMIT 100`
  );
  return result.rows;
}

async function cancelTrip(tripId, adminUserId) {
  await runTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Trip not found.');
    const result = await client.query(
      `SELECT status
       FROM trips
       WHERE id = $1
       FOR UPDATE`,
      [tripId]
    );
    if (result.rowCount !== 1) throw new AppError(404, 'Trip not found.');
    if (['completed', 'cancelled'].includes(result.rows[0].status)) {
      throw new AppError(409, 'This trip can no longer be cancelled.');
    }
    const previousStatus = result.rows[0].status;
    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = now()
       WHERE trip_id = $1 AND status IN ('queued','pending')`,
      [tripId]
    );
    await releaseTripRequests(client, tripId);
    await client.query(
      `UPDATE trips
       SET status = 'cancelled', driver_user_id = NULL, vehicle_id = NULL
       WHERE id = $1`,
      [tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.cancelled', 'trip', $2, $3)`,
      [adminUserId, tripId, { previous_status: previousStatus }]
    );
  });
  return getTrip(tripId);
}

async function listDriverOffers(driverUserId) {
  await processExpiredOffers();
  const result = await pool.query(
    `SELECT offer.id, offer.expires_at, trip.id AS trip_id,
            trip.direction, trip.scheduled_at, trip.ends_at,
            vehicle.make, vehicle.model, vehicle.registration_number,
            vehicle.seat_count,
            (SELECT count(DISTINCT ride_request_id)
             FROM trip_stops WHERE trip_id = trip.id AND stop_type = 'pickup') AS passenger_count,
            COALESCE((
              SELECT json_agg(json_build_object(
                'stop_order', stop.stop_order,
                'stop_type', stop.stop_type,
                'passenger_name', passenger.name,
                'passenger_surname', passenger.surname,
                'address', stop.address,
                'suburb', stop.suburb,
                'planned_at', stop.planned_at
              ) ORDER BY stop.stop_order)
              FROM trip_stops stop
              JOIN users passenger ON passenger.id = stop.passenger_user_id
              WHERE stop.trip_id = trip.id
            ), '[]'::json) AS stops
     FROM trip_offers offer
     JOIN trips trip ON trip.id = offer.trip_id
     JOIN vehicles vehicle ON vehicle.id = offer.vehicle_id
     WHERE offer.driver_user_id = $1
       AND offer.status = 'pending'
       AND offer.expires_at > now()
     ORDER BY offer.expires_at`,
    [driverUserId]
  );
  return result.rows;
}

async function listDriverTrips(driverUserId) {
  const result = await pool.query(
    `SELECT trip.id, trip.direction, trip.scheduled_at, trip.ends_at, trip.status,
            trip.started_at, trip.completed_at,
            vehicle.make, vehicle.model, vehicle.registration_number,
            vehicle.seat_count,
            (SELECT count(DISTINCT ride_request_id)
             FROM trip_stops WHERE trip_id = trip.id AND stop_type = 'pickup') AS passenger_count,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', stop.id,
                'stop_order', stop.stop_order,
                'stop_type', stop.stop_type,
                'passenger_name', passenger.name,
                'passenger_surname', passenger.surname,
                'address', stop.address,
                'suburb', stop.suburb,
                'planned_at', stop.planned_at,
                'status', stop.status,
                'arrived_at', stop.arrived_at,
                'completed_at', stop.completed_at
              ) ORDER BY stop.stop_order)
              FROM trip_stops stop
              JOIN users passenger ON passenger.id = stop.passenger_user_id
              WHERE stop.trip_id = trip.id
            ), '[]'::json) AS stops
     FROM trips trip
     JOIN vehicles vehicle ON vehicle.id = trip.vehicle_id
     WHERE trip.driver_user_id = $1
       AND trip.status IN ('accepted','in_progress')
     ORDER BY trip.scheduled_at`,
    [driverUserId]
  );
  return result.rows;
}

async function startDriverTrip(driverUserId, tripId) {
  return runTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
    const trip = await client.query(
      `SELECT id, status
       FROM trips
       WHERE id = $1 AND driver_user_id = $2
       FOR UPDATE`,
      [tripId, driverUserId]
    );
    if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
    if (trip.rows[0].status === 'in_progress') return trip.rows[0];
    if (trip.rows[0].status !== 'accepted') {
      throw new AppError(409, 'This trip cannot be started in its current status.');
    }

    const result = await client.query(
      `UPDATE trips
       SET status = 'in_progress', started_at = now()
       WHERE id = $1 AND driver_user_id = $2 AND status = 'accepted'
       RETURNING id, status, started_at`,
      [tripId, driverUserId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.started', 'trip', $2, '{}'::jsonb)`,
      [driverUserId, tripId]
    );
    return result.rows[0];
  });
}

async function updateDriverTripStop(driverUserId, tripId, stopId, status) {
  return runTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
    const trip = await client.query(
      `SELECT status
       FROM trips
       WHERE id = $1 AND driver_user_id = $2
       FOR UPDATE`,
      [tripId, driverUserId]
    );
    if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
    if (trip.rows[0].status !== 'in_progress') {
      throw new AppError(409, 'Start the trip before updating its stops.');
    }

    const stops = {
      rows: await lockStopsById(client, tripId, 'id, stop_order, status'),
    };
    stops.rows.sort((left, right) => left.stop_order - right.stop_order);
    const stopIndex = stops.rows.findIndex((stop) => stop.id === stopId);
    if (stopIndex < 0) throw new AppError(404, 'Trip stop not found.');
    const stop = stops.rows[stopIndex];
    const expectedStatus = status === 'arrived' ? 'pending' : 'arrived';
    if (stop.status !== expectedStatus) {
      throw new AppError(409, 'This stop cannot be updated in its current status.');
    }
    if (status === 'arrived' && stops.rows.slice(0, stopIndex).some((previous) => previous.status !== 'completed')) {
      throw new AppError(409, 'Complete the previous stop before continuing.');
    }

    const result = await client.query(
      `UPDATE trip_stops
       SET status = $1,
           arrived_at = CASE WHEN $1 = 'arrived' THEN now() ELSE arrived_at END,
           completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END
       WHERE id = $2 AND trip_id = $3
       RETURNING id, stop_order, stop_type, status, arrived_at, completed_at`,
      [status, stopId, tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'trip_stop', $3, $4)`,
      [driverUserId, `trip_stop.${status}`, stopId, { trip_id: tripId, stop_order: stop.stop_order }]
    );

    const tripCompleted = status === 'completed'
      && stops.rows.every((item) => item.id === stopId || item.status === 'completed');
    if (tripCompleted) {
      await client.query(
        `UPDATE trips
         SET status = 'completed', completed_at = now()
         WHERE id = $1 AND driver_user_id = $2 AND status = 'in_progress'`,
        [tripId, driverUserId]
      );
      await client.query(
        `UPDATE ride_requests
         SET status = 'completed'
         WHERE trip_id = $1 AND status = 'assigned'`,
        [tripId]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'trip.completed', 'trip', $2, '{}'::jsonb)`,
        [driverUserId, tripId]
      );
    }

    return { stop: result.rows[0], trip_completed: tripCompleted };
  });
}

async function respondToOffer(driverUserId, offerId, decision) {
  const response = await runTransaction(async (client) => {
    const lookup = await client.query(
      `SELECT trip_id
       FROM trip_offers
       WHERE id = $1 AND driver_user_id = $2`,
      [offerId, driverUserId]
    );
    const tripId = lookup.rows[0]?.trip_id;
    if (!tripId) throw new AppError(404, 'Active trip offer not found.');
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Active trip offer not found.');
    const result = await client.query(
      `SELECT offer.id, offer.trip_id, offer.vehicle_id, offer.status,
              offer.expires_at, trip.scheduled_at, trip.ends_at
       FROM trip_offers offer
       JOIN trips trip ON trip.id = offer.trip_id
       WHERE offer.id = $1 AND offer.driver_user_id = $2
       FOR UPDATE OF offer`,
      [offerId, driverUserId]
    );
    const offer = result.rows[0];
    if (!offer || offer.status !== 'pending') {
      throw new AppError(404, 'Active trip offer not found.');
    }
    if (new Date(offer.expires_at) <= new Date()) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'expired', responded_at = now()
         WHERE id = $1`,
        [offerId]
      );
      await dispatchNextOffer(client, offer.trip_id);
      return { expired: true, trip_id: offer.trip_id };
    }

    if (decision === 'decline') {
      await client.query(
        `UPDATE trip_offers
         SET status = 'declined', responded_at = now()
         WHERE id = $1`,
        [offerId]
      );
      await dispatchNextOffer(client, offer.trip_id);
      return { declined: true, trip_id: offer.trip_id };
    }

    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
      [driverUserId]
    );
    if (!lockResult.rows[0].locked) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'skipped', responded_at = now()
         WHERE id = $1`,
        [offerId]
      );
      await dispatchNextOffer(client, offer.trip_id);
      return { unavailable: true, trip_id: offer.trip_id };
    }
    const eligible = await client.query(
      `SELECT d.user_id
       FROM drivers d
       JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
       JOIN vehicles v ON v.id = $2 AND v.driver_user_id = d.user_id
       WHERE d.user_id = $1
         AND d.status = 'approved' AND d.is_available = TRUE
         AND v.status = 'approved'
         AND d.licence_expiry >= CURRENT_DATE
         AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
         AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
         AND v.seat_count >= (
           SELECT count(DISTINCT ride_request_id)
           FROM trip_stops WHERE trip_id = $3 AND stop_type = 'pickup'
         )
         AND NOT EXISTS (
           SELECT 1 FROM trips active_trip
           WHERE active_trip.driver_user_id = d.user_id
             AND active_trip.id <> $3
             AND active_trip.status IN ('accepted','in_progress')
             AND active_trip.scheduled_at < $5
             AND active_trip.ends_at > $4
         )`,
      [driverUserId, offer.vehicle_id, offer.trip_id, offer.scheduled_at, offer.ends_at]
    );
    if (eligible.rowCount !== 1) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'skipped', responded_at = now()
         WHERE id = $1`,
        [offerId]
      );
      await dispatchNextOffer(client, offer.trip_id);
      return { unavailable: true, trip_id: offer.trip_id };
    }

    await client.query(
      `UPDATE trip_offers
       SET status = 'accepted', responded_at = now()
       WHERE id = $1`,
      [offerId]
    );
    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = now()
       WHERE trip_id = $1 AND status = 'queued'`,
      [offer.trip_id]
    );
    await client.query(
      `UPDATE trips
       SET status = 'accepted', driver_user_id = $1, vehicle_id = $2
       WHERE id = $3`,
      [driverUserId, offer.vehicle_id, offer.trip_id]
    );
    return { accepted: true, trip_id: offer.trip_id };
  });

  if (response.expired) throw new AppError(409, 'This trip offer has expired.');
  if (response.unavailable) {
    throw new AppError(409, 'You are no longer eligible for this trip offer.');
  }
  return response;
}

async function setDriverAvailability(driverUserId, isAvailable) {
  return runTransaction(async (client) => {
    const pendingTripIds = await client.query(
      `SELECT DISTINCT trip_id
       FROM trip_offers
       WHERE driver_user_id = $1 AND status = 'pending'`,
      [driverUserId]
    );
    const tripIds = pendingTripIds.rows.map(({ trip_id: tripId }) => tripId);
    const lockedTripIds = new Set(await lockTripSet(client, tripIds));
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [driverUserId]
    );
    const currentOffers = await client.query(
      `SELECT DISTINCT trip_id
       FROM trip_offers
       WHERE driver_user_id = $1 AND status = 'pending'`,
      [driverUserId]
    );
    const currentTripIds = currentOffers.rows.map(({ trip_id: tripId }) => tripId);
    if (currentTripIds.some((tripId) => !lockedTripIds.has(tripId))) {
      const error = new Error('A pending trip offer changed while acquiring ordered row locks.');
      error.code = '40001';
      throw error;
    }

    if (isAvailable) {
      const eligible = await client.query(
        `SELECT d.user_id
         FROM drivers d
         JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
         JOIN vehicles v ON v.driver_user_id = d.user_id AND v.status = 'approved'
         WHERE d.user_id = $1 AND d.status = 'approved'
           AND d.licence_expiry >= CURRENT_DATE
           AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
           AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
         LIMIT 1
         FOR UPDATE OF d`,
        [driverUserId]
      );
      if (eligible.rowCount !== 1) {
        throw new AppError(409, 'Driver and at least one vehicle must be approved to go online.');
      }
      const updated = await client.query(
        `UPDATE drivers SET is_available = TRUE
         WHERE user_id = $1 RETURNING is_available`,
        [driverUserId]
      );
      return updated.rows[0];
    }

    const updated = await client.query(
      `UPDATE drivers SET is_available = FALSE
       WHERE user_id = $1
       RETURNING is_available`,
      [driverUserId]
    );
    if (updated.rowCount !== 1) throw new AppError(404, 'Driver account not found.');

    const cancelled = await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = now()
       WHERE driver_user_id = $1 AND status = 'pending'
       RETURNING trip_id`,
      [driverUserId]
    );
    for (const { trip_id: tripId } of cancelled.rows) {
      await dispatchNextOffer(client, tripId);
    }
    return updated.rows[0];
  });
}

async function getDriverAvailability(driverUserId) {
  const result = await pool.query(
    'SELECT is_available FROM drivers WHERE user_id = $1',
    [driverUserId]
  );
  if (result.rowCount !== 1) throw new AppError(404, 'Driver account not found.');
  return result.rows[0];
}

async function processExpiredOffers() {
  const expired = await pool.query(
    `SELECT DISTINCT trip_id
     FROM trip_offers
     WHERE status = 'pending' AND expires_at <= now()
     ORDER BY trip_id
     LIMIT 100`
  );
  for (const { trip_id: tripId } of expired.rows) {
    await runTransaction(async (client) => {
      const { tripIds } = await lockTripSeries(client, tripId);
      if (!tripIds.includes(tripId)) return;
      const trip = await client.query(
        `SELECT status FROM trips WHERE id = $1 FOR UPDATE`,
        [tripId]
      );
      if (trip.rows[0]?.status !== 'offering') return;
      await client.query(
        `UPDATE trip_offers
         SET status = 'expired', responded_at = now()
         WHERE trip_id = $1 AND status = 'pending' AND expires_at <= now()`,
        [tripId]
      );
      await dispatchNextOffer(client, tripId);
    });
  }
}

module.exports = {
  cancelTrip,
  createTrip,
  getDriverAvailability,
  listDriverOffers,
  listDriverTrips,
  listEligibleDrivers,
  listPendingRequests,
  listTrips,
  processExpiredOffers,
  respondToOffer,
  setDriverAvailability,
  startDriverTrip,
  updateDriverTripStop,
};
