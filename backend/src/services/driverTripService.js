const pool = require('../db');
const AppError = require('../utils/AppError');
const offersService = require('./offers');
const {
  decodeCursor,
  encodeCursor,
  normalizePagination,
  paginationMetadata,
} = require('../utils/pagination');
const {
  lockStopsById,
  lockTripSeries,
  lockTripSet,
} = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

async function listOffers(driverUserId, { cursor, page_size: pageSize } = {}) {
  await offersService.processExpired();
  const pagination = normalizePagination({ page_size: pageSize });
  const decoded = decodeCursor(cursor);
  const values = [driverUserId];
  let cursorCondition = '';
  if (decoded) {
    values.push(decoded.sort_at, decoded.id);
    cursorCondition = 'AND (offer.expires_at, offer.id) > ($2::timestamptz, $3::uuid)';
  }
  values.push(pagination.page_size + 1);
  const limitParameter = `$${values.length}`;
  const result = await pool.query(
    `SELECT offer.id, offer.series_id, offer.expires_at, offer.window_minutes,
            json_agg(json_build_object(
              'trip_id', t.id,
              'direction', t.direction,
              'scheduled_at', t.scheduled_at,
              'starts_at', t.starts_at,
              'workplace_name', t.workplace_name,
              'distance_km', t.distance_km,
              'passenger_count', (
                SELECT count(DISTINCT s.ride_request_id)::int
                FROM trip_stops s
                WHERE s.trip_id = t.id AND s.stop_type = 'pickup'
              ),
              'suburbs', (
                SELECT COALESCE(json_agg(DISTINCT stop.suburb)
                  FILTER (WHERE stop.suburb IS NOT NULL), '[]'::json)
                FROM trip_stops stop WHERE stop.trip_id = t.id
              )
            ) ORDER BY t.scheduled_at) AS trips
     FROM trip_offers offer
     JOIN trips anchor ON anchor.id = offer.trip_id
     JOIN trips t ON t.series_id = offer.series_id AND t.status = 'offered'
     WHERE offer.driver_user_id = $1 AND offer.status = 'pending'
       AND offer.expires_at > now() ${cursorCondition}
     GROUP BY offer.id
     ORDER BY offer.expires_at, offer.id
     LIMIT ${limitParameter}`,
    values
  );
  const hasMore = result.rows.length > pagination.page_size;
  const offers = hasMore ? result.rows.slice(0, pagination.page_size) : result.rows;
  const lastOffer = offers.at(-1);
  return {
    offers,
    next_cursor: hasMore && lastOffer ? encodeCursor(lastOffer.expires_at, lastOffer.id) : null,
  };
}

async function getHome(driverUserId) {
  const [profile, nextTrip, count, offerCount, overdueTrips, changesToConfirm, inProgressTrips] = await Promise.all([
    pool.query(
      `SELECT u.name, d.status, d.is_available,
              COALESCE(d.licence_expiry >= CURRENT_DATE, FALSE) AS licence_valid,
              (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE) AS prdp_valid,
              EXISTS (SELECT 1 FROM vehicles v
                      WHERE v.driver_user_id = d.user_id AND v.status = 'approved'
                        AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)) AS has_approved_vehicle,
              d.licence_expiry, d.prdp_expiry,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN d.licence_expiry IS NULL THEN 'Driver licence expiry not recorded' END,
                CASE WHEN d.licence_expiry < CURRENT_DATE THEN 'Driver licence' END,
                CASE WHEN d.prdp_expiry < CURRENT_DATE THEN 'Professional driving permit' END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM vehicles expired_vehicle
                  WHERE expired_vehicle.driver_user_id = d.user_id
                    AND expired_vehicle.status = 'approved'
                    AND expired_vehicle.licence_disc_expiry < CURRENT_DATE
                ) THEN 'Vehicle licence disc' END
              ], NULL) AS expired_documents
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1`,
      [driverUserId]
    ),
    pool.query(
      `SELECT t.id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
              t.workplace_name, t.workplace_address, t.distance_km, t.status,
              (SELECT count(DISTINCT s.ride_request_id)::int
               FROM trip_stops s
               WHERE s.trip_id = t.id AND s.stop_type = 'pickup') AS passenger_count
       FROM trips t
       LEFT JOIN LATERAL (
         SELECT stop.planned_at
         FROM trip_stops stop
         WHERE stop.trip_id = t.id
         ORDER BY stop.sequence
         LIMIT 1
       ) first_stop ON TRUE
       WHERE t.driver_user_id = $1
         AND (
           (t.status = 'accepted'
             AND now() <= t.ends_at + ($2 * interval '1 minute'))
           OR t.status = 'in_progress'
         )
       ORDER BY (t.status = 'in_progress') DESC,
                COALESCE(first_stop.planned_at, t.starts_at, t.scheduled_at)
       LIMIT 1`,
      [driverUserId, Number(process.env.OVERDUE_GRACE_MINUTES ?? 30)]
    ),
    pool.query(
      `SELECT count(*)::int AS count FROM trips t
       WHERE t.driver_user_id = $1 AND t.status = 'accepted'
         AND COALESCE((
           SELECT stop.planned_at FROM trip_stops stop
           WHERE stop.trip_id = t.id ORDER BY stop.sequence LIMIT 1
         ), t.starts_at, t.scheduled_at) >= now()`,
      [driverUserId]
    ),
    pool.query(
      `SELECT count(*)::int AS count FROM trip_offers
       WHERE driver_user_id = $1 AND status = 'pending' AND expires_at > now()`,
      [driverUserId]
    ),
    pool.query(
      `SELECT t.id, COALESCE(first_stop.planned_at, t.starts_at, t.scheduled_at) AS planned_at,
              (now() <= t.ends_at + ($2 * interval '1 minute')) AS can_still_be_started
       FROM trips t
       LEFT JOIN LATERAL (
         SELECT stop.planned_at FROM trip_stops stop
         WHERE stop.trip_id = t.id ORDER BY stop.sequence LIMIT 1
       ) first_stop ON TRUE
       WHERE t.driver_user_id = $1 AND t.status = 'accepted' AND t.started_at IS NULL
         AND COALESCE(first_stop.planned_at, t.starts_at, t.scheduled_at) < now()
       ORDER BY planned_at`,
      [driverUserId, Number(process.env.OVERDUE_GRACE_MINUTES ?? 30)]
    ),
    pool.query(
      `SELECT id, scheduled_at, starts_at
       FROM trips
       WHERE driver_user_id = $1 AND status IN ('accepted','in_progress')
         AND change_ack_required = TRUE
       ORDER BY COALESCE(starts_at, scheduled_at)`,
      [driverUserId]
    ),
    pool.query(
      `SELECT id, scheduled_at, starts_at
       FROM trips
       WHERE driver_user_id = $1 AND status = 'in_progress'
       ORDER BY COALESCE(starts_at, scheduled_at)`,
      [driverUserId]
    ),
  ]);
  if (profile.rowCount !== 1) throw new AppError(404, 'Driver account not found.');
  const attention = [
    ...overdueTrips.rows.map((trip) => ({
      type: 'overdue_trip',
      trip_id: trip.id,
      planned_time: trip.planned_at,
      can_still_be_started: trip.can_still_be_started,
    })),
    ...changesToConfirm.rows.map((trip) => ({
      type: 'change_to_confirm',
      trip_id: trip.id,
      what_changed: 'The trip schedule changed. Review the latest details and confirm.',
    })),
    ...inProgressTrips.rows.map((trip) => ({
      type: 'in_progress_trip',
      trip_id: trip.id,
      planned_time: trip.starts_at ?? trip.scheduled_at,
    })),
  ];
  return {
    greeting_name: profile.rows[0].name,
    driver_status: profile.rows[0].status,
    is_available: profile.rows[0].is_available,
    can_go_online: profile.rows[0].status === 'approved'
      && profile.rows[0].has_approved_vehicle
      && profile.rows[0].licence_valid
      && profile.rows[0].prdp_valid,
    expired_documents: profile.rows[0].expired_documents,
    next_trip: nextTrip.rows[0] ?? null,
    upcoming_count: count.rows[0].count,
    upcoming_trip_count: count.rows[0].count,
    pending_offers: offerCount.rows[0].count,
    pending_offer_count: offerCount.rows[0].count,
    attention,
  };
}

async function listTrips(driverUserId, { scope, page, page_size: pageSize, cursor }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  pageSize = pagination.page_size;
  const history = scope === 'history';
  const decoded = history ? decodeCursor(cursor) : null;
  const statusCondition = history
    ? `t.status IN ('completed','cancelled','missed')`
    : `t.status = 'accepted' AND COALESCE((
        SELECT stop.planned_at FROM trip_stops stop
        WHERE stop.trip_id = t.id ORDER BY stop.sequence LIMIT 1
      ), t.starts_at, t.scheduled_at) >= now()`;
  const values = [driverUserId];
  let cursorCondition = '';
  if (decoded) {
    values.push(decoded.sort_at, decoded.id);
    cursorCondition = `AND (COALESCE(t.starts_at, t.scheduled_at), t.id)
      < ($2::timestamptz, $3::uuid)`;
  }
  if (history) {
    values.push(pageSize + 1);
  } else {
    values.push(pageSize, 0);
  }
  const limitParameter = `$${history ? values.length : values.length - 1}`;
  const offsetClause = history ? '' : `OFFSET $${values.length}`;
  const count = history ? null : await pool.query(
    `SELECT count(*)::int AS total FROM trips t
     WHERE t.driver_user_id = $1 AND ${statusCondition}`,
    [driverUserId]
  );
  const currentPage = history ? 1 : paginationMetadata(count.rows[0].total, pagination).page;
  const result = await pool.query(
    `SELECT t.id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
            t.workplace_name, t.workplace_address, t.distance_km, t.status,
            t.started_at, t.completed_at, t.has_issues,
            v.make AS vehicle_make, v.model AS vehicle_model,
            v.registration_number,
            (SELECT count(DISTINCT s.ride_request_id)::int FROM trip_stops s
             WHERE s.trip_id = t.id AND s.stop_type = 'pickup') AS passenger_count,
            (SELECT count(DISTINCT s.ride_request_id)::int FROM trip_stops s
             WHERE s.trip_id = t.id AND s.stop_type = 'pickup' AND s.status = 'completed')
              AS passengers_picked_up,
            (SELECT count(DISTINCT s.ride_request_id)::int FROM trip_stops s
             WHERE s.trip_id = t.id AND s.stop_type = 'dropoff' AND s.status = 'completed')
              AS passengers_dropped_off,
            (SELECT count(*)::int FROM ride_requests r
             WHERE r.trip_id = t.id AND r.status = 'no_show') AS no_shows,
            (SELECT count(*)::int FROM trip_stops s
             WHERE s.trip_id = t.id AND s.status = 'skipped'
               AND s.skip_kind IN ('unreachable','address_problem','passenger_declined','other'))
              AS exceptions,
            CASE WHEN t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
              THEN floor(extract(epoch FROM (t.completed_at - t.started_at)) / 60)::int
              ELSE NULL END AS duration_minutes
     FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.driver_user_id = $1 AND ${statusCondition} ${cursorCondition}
     ORDER BY COALESCE(t.starts_at, t.scheduled_at) ${history ? 'DESC' : 'ASC'}, t.id ${history ? 'DESC' : 'ASC'}
     LIMIT ${limitParameter} ${offsetClause}`,
    history ? values : [driverUserId, pageSize, (currentPage - 1) * pageSize]
  );
  const hasMore = history && result.rows.length > pageSize;
  const trips = hasMore ? result.rows.slice(0, pageSize) : result.rows;
  const lastTrip = trips.at(-1);
  if (history) {
    return {
      trips,
      next_cursor: hasMore && lastTrip
        ? encodeCursor(lastTrip.starts_at ?? lastTrip.scheduled_at, lastTrip.id)
        : null,
    };
  }
  return {
    trips,
    pagination: paginationMetadata(count.rows[0].total, { ...pagination, page: currentPage }),
  };
}

async function getTrip(driverUserId, tripId) {
  const result = await pool.query(
    `SELECT t.id, t.series_id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
            t.workplace_name, t.workplace_address, t.distance_km, t.notes, t.status,
            t.started_at, t.completed_at,
            v.id AS vehicle_id, v.make AS vehicle_make, v.model AS vehicle_model,
            v.registration_number, v.seat_count
     FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.id = $1 AND t.driver_user_id = $2
       AND t.status IN ('accepted','in_progress','completed')`,
    [tripId, driverUserId]
  );
  if (result.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
  const [stops, passengers] = await Promise.all([
    pool.query(
      `SELECT s.id, s.sequence, s.stop_type, s.address, s.suburb, s.planned_at,
              s.status, s.arrived_at, s.completed_at, s.skip_reason,
              u.name AS passenger_name, u.surname AS passenger_surname,
              u.contact_number
       FROM trip_stops s
       JOIN users u ON u.id = s.passenger_user_id
       WHERE s.trip_id = $1 ORDER BY s.sequence`,
      [tripId]
    ),
    pool.query(
      `SELECT count(DISTINCT ride_request_id)::int AS count
       FROM trip_stops WHERE trip_id = $1 AND stop_type = 'pickup'`,
      [tripId]
    ),
  ]);
  return { ...result.rows[0], stops: stops.rows, passenger_count: passengers.rows[0].count };
}

async function startTrip(driverUserId, tripId) {
  return withTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
    const trip = await client.query(
      `SELECT t.id, t.status, COALESCE(t.starts_at, t.scheduled_at) AS starts_at
       FROM trips t WHERE t.id = $1 AND t.driver_user_id = $2 FOR UPDATE`,
      [tripId, driverUserId]
    );
    if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
    if (trip.rows[0].status !== 'accepted') {
      throw new AppError(409, 'This trip cannot be started in its current status.');
    }
    const startWindow = Number.parseInt(process.env.TRIP_START_WINDOW_MINUTES || '90', 10);
    const startsAt = Date.parse(trip.rows[0].starts_at);
    if (Date.now() < startsAt - startWindow * 60_000 || Date.now() > startsAt) {
      throw new AppError(409, 'This trip can only be started within the start window.');
    }
    const updated = await client.query(
      `UPDATE trips SET status = 'in_progress', started_at = now()
       WHERE id = $1 AND status = 'accepted'
       RETURNING id, status, started_at`,
      [tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.started', 'trip', $2, '{}'::jsonb)`,
      [driverUserId, tripId]
    );
    return updated.rows[0];
  });
}

async function updateStop(driverUserId, tripId, stopId, action, reason) {
  return withTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
    const trip = await client.query(
      `SELECT status FROM trips WHERE id = $1 AND driver_user_id = $2 FOR UPDATE`,
      [tripId, driverUserId]
    );
    if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
    if (trip.rows[0].status !== 'in_progress') {
      throw new AppError(409, 'Start the trip before updating its stops.');
    }
    const stops = {
      rows: await lockStopsById(
        client,
        tripId,
        'id, sequence, status, stop_type, address, suburb'
      ),
    };
    stops.rows.sort((left, right) => left.sequence - right.sequence);
    let index = stops.rows.findIndex(({ id }) => id === stopId);
    if (index < 0) throw new AppError(404, 'Trip stop not found.');
    const selectedStop = stops.rows[index];
    const stopAddress = (stop) => `${stop.address ?? ''} ${stop.suburb ?? ''}`
      .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const targetIndexes = [index];
    while (index > 0
      && stops.rows[index - 1].stop_type === selectedStop.stop_type
      && stopAddress(stops.rows[index - 1]) === stopAddress(selectedStop)) {
      index -= 1;
      targetIndexes.unshift(index);
    }
    let nextIndex = targetIndexes.at(-1) + 1;
    while (nextIndex < stops.rows.length
      && stops.rows[nextIndex].stop_type === selectedStop.stop_type
      && stopAddress(stops.rows[nextIndex]) === stopAddress(selectedStop)) {
      targetIndexes.push(nextIndex);
      nextIndex += 1;
    }
    const stop = stops.rows[index];
    const targetGroup = targetIndexes.map((targetIndex) => stops.rows[targetIndex]);
    if (stops.rows.slice(0, index).some(({ status }) => !['completed', 'skipped'].includes(status))) {
      throw new AppError(409, 'Complete or skip the previous stop before continuing.');
    }
    const nextStatus = { arrive: 'arrived', complete: 'completed', skip: 'skipped' }[action];
    const expected = { arrive: 'pending', complete: 'arrived', skip: ['pending', 'arrived'] }[action];
    if (targetGroup.some((groupStop) =>
      Array.isArray(expected) ? !expected.includes(groupStop.status) : groupStop.status !== expected
    )) {
      throw new AppError(409, 'This stop cannot be updated in its current status.');
    }
    if (action === 'skip' && !reason?.trim()) {
      throw new AppError(400, 'A reason is required to skip a stop.');
    }
    const updated = await client.query(
      `UPDATE trip_stops
       SET status = $1,
           arrived_at = CASE WHEN $1 = 'arrived' THEN now() ELSE arrived_at END,
           completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END,
           skip_reason = CASE WHEN $1 = 'skipped' THEN $2 ELSE skip_reason END
       WHERE id = ANY($3::uuid[]) AND trip_id = $4
       RETURNING id, sequence, stop_type, status, arrived_at, completed_at, skip_reason`,
      [nextStatus, reason?.trim() || null, targetGroup.map(({ id }) => id), tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'trip_stop_group', $3, $4)`,
      [driverUserId, `trip_stop_group.${nextStatus}`, stop.id, {
        trip_id: tripId,
        sequence: stop.sequence,
        stop_ids: targetGroup.map(({ id }) => id),
        reason: action === 'skip' ? reason.trim() : null,
      }]
    );
    return { stops: updated.rows };
  });
}

async function completeTrip(driverUserId, tripId) {
  return withTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
    const trip = await client.query(
      `SELECT id, status FROM trips
       WHERE id = $1 AND driver_user_id = $2 FOR UPDATE`,
      [tripId, driverUserId]
    );
    if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
    if (trip.rows[0].status !== 'in_progress') {
      throw new AppError(409, 'Only an in-progress trip can be completed.');
    }
    const pending = await client.query(
      `SELECT count(*)::int AS count FROM trip_stops
       WHERE trip_id = $1 AND status NOT IN ('completed','skipped')`,
      [tripId]
    );
    if (pending.rows[0].count > 0) {
      throw new AppError(409, 'Complete or skip every stop before completing the trip.');
    }
    const updated = await client.query(
      `UPDATE trips SET status = 'completed', completed_at = now()
       WHERE id = $1 AND status = 'in_progress'
       RETURNING id, status, completed_at`,
      [tripId]
    );
    await client.query(
      `UPDATE ride_requests SET status = 'completed'
       WHERE trip_id = $1 AND status = 'assigned'`,
      [tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.completed', 'trip', $2, '{}'::jsonb)`,
      [driverUserId, tripId]
    );
    return updated.rows[0];
  });
}

async function setAvailability(driverUserId, isAvailable) {
  return withTransaction(async (client) => {
    let lockedTripIds = new Set();
    let pendingSeriesIds = [];
    if (!isAvailable) {
      const pending = await client.query(
        `SELECT DISTINCT trip.id, trip.series_id
         FROM trip_offers offer
         JOIN trips trip ON trip.id = offer.trip_id
         WHERE offer.driver_user_id = $1 AND offer.status = 'pending'
         ORDER BY trip.id`,
        [driverUserId]
      );
      lockedTripIds = new Set(await lockTripSet(
        client,
        pending.rows.map(({ id }) => id)
      ));
      pendingSeriesIds = [...new Set(
        pending.rows.map(({ series_id: seriesId }) => seriesId).filter(Boolean)
      )].sort();
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [driverUserId]);
    const driver = await client.query(
      `SELECT d.status, d.licence_expiry, d.prdp_expiry,
              EXISTS (SELECT 1 FROM vehicles v
                      WHERE v.driver_user_id = d.user_id AND v.status = 'approved'
                        AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)) AS has_vehicle,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN d.licence_expiry < CURRENT_DATE THEN 'Driver licence' END,
                CASE WHEN d.prdp_expiry < CURRENT_DATE THEN 'Professional driving permit' END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM vehicles expired_vehicle
                  WHERE expired_vehicle.driver_user_id = d.user_id
                    AND expired_vehicle.status = 'approved'
                    AND expired_vehicle.licence_disc_expiry < CURRENT_DATE
                ) THEN 'Vehicle licence disc' END
              ], NULL) AS expired_documents
       FROM drivers d WHERE d.user_id = $1 FOR UPDATE`,
      [driverUserId]
    );
    if (driver.rowCount !== 1) throw new AppError(404, 'Driver account not found.');
    const documentExpiry = await client.query(
      `SELECT d.licence_expiry < CURRENT_DATE AS licence_expired,
              d.prdp_expiry < CURRENT_DATE AS prdp_expired,
              d.licence_expiry IS NULL AS licence_missing
       FROM drivers d WHERE d.user_id = $1`,
      [driverUserId]
    );
    const expiry = documentExpiry.rows[0];
    if (isAvailable && (driver.rows[0].status !== 'approved' || !driver.rows[0].has_vehicle
      || expiry.licence_expired || expiry.prdp_expired || expiry.licence_missing)) {
      const expired = driver.rows[0].expired_documents;
      if (expired.length > 0) {
        throw new AppError(409, `Renew the following documents before going online: ${expired.join(', ')}.`);
      }
      throw new AppError(409, 'Driver and vehicle must be approved to go online.');
    }
    const update = await client.query(
      `UPDATE drivers SET is_available = $2 WHERE user_id = $1
       RETURNING is_available`,
      [driverUserId, isAvailable]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'driver.availability_changed', 'driver', $1, $2)`,
      [driverUserId, { is_available: isAvailable }]
    );
    if (!isAvailable) {
      const current = await client.query(
        `SELECT DISTINCT trip.id, trip.series_id
         FROM trip_offers offer
         JOIN trips trip ON trip.id = offer.trip_id
         WHERE offer.driver_user_id = $1 AND offer.status = 'pending'
         ORDER BY trip.id`,
        [driverUserId]
      );
      if (current.rows.some(({ id }) => !lockedTripIds.has(id))) {
        const error = new Error('Pending trip offers changed while acquiring ordered row locks.');
        error.code = '40001';
        throw error;
      }
      for (const seriesId of pendingSeriesIds) {
        await client.query(
          `UPDATE trip_offers SET status = 'cancelled', responded_at = now()
           WHERE series_id = $1 AND driver_user_id = $2 AND status = 'pending'`,
          [seriesId, driverUserId]
        );
        await offersService.advance(client, seriesId, driverUserId);
      }
    }
    return update.rows[0];
  });
}

module.exports = {
  completeTrip,
  getHome,
  getTrip,
  listOffers,
  listTrips,
  setAvailability,
  startTrip,
  updateStop,
};
