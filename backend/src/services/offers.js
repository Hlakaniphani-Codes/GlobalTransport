const pool = require('../db');
const AppError = require('../utils/AppError');
const notificationService = require('./notifications');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');
const withTransaction = require('../utils/withTransaction');
const { lockSeriesAndTrips } = require('../utils/tripLocking');

async function inTransaction(work) {
  return withTransaction(work);
}

function eligibleDriversCte(driverFilter = '') {
  return `WITH proposed AS (
       SELECT min(COALESCE(t.starts_at, first_stop.planned_at, t.scheduled_at)) AS starts_at,
              max(COALESCE(last_stop.planned_at, t.ends_at)) AS ends_at,
              max((
                SELECT count(DISTINCT pickup.ride_request_id)
                FROM trip_stops pickup
                WHERE pickup.trip_id = t.id AND pickup.stop_type = 'pickup'
              ))::int AS passenger_count
       FROM trips t
       LEFT JOIN LATERAL (
         SELECT planned_at FROM trip_stops
         WHERE trip_id = t.id ORDER BY sequence LIMIT 1
       ) first_stop ON TRUE
       LEFT JOIN LATERAL (
         SELECT planned_at FROM trip_stops
         WHERE trip_id = t.id ORDER BY sequence DESC LIMIT 1
       ) last_stop ON TRUE
       WHERE t.series_id = $1 AND t.status IN ('draft','offered','unassigned')
     ),
     eligible AS (
       SELECT d.user_id, u.name, u.surname, v.id AS vehicle_id,
            v.make, v.model, v.registration_number, v.seat_count,
            d.is_available,
            lower(u.surname) AS sort_surname, lower(u.name) AS sort_name,
            EXISTS (
              SELECT 1 FROM push_tokens token
              WHERE token.user_id = d.user_id AND token.revoked_at IS NULL
            ) AS has_push_device
     FROM drivers d
     JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
     JOIN vehicles v ON v.driver_user_id = d.user_id AND v.status = 'approved'
     CROSS JOIN proposed p
     WHERE d.status = 'approved' AND d.is_available = TRUE
       AND d.licence_expiry >= CURRENT_DATE
       AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
       AND v.seat_count >= COALESCE(p.passenger_count, 0)
       AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
       AND NOT EXISTS (
         SELECT 1
         FROM trips active_trip
         WHERE active_trip.driver_user_id = d.user_id
           AND active_trip.status IN ('accepted','in_progress')
           AND COALESCE(active_trip.starts_at, active_trip.scheduled_at)
             < p.ends_at + interval '15 minutes'
           AND COALESCE(active_trip.ends_at, active_trip.scheduled_at)
             > p.starts_at - interval '15 minutes'
       ) ${driverFilter}
     )`;
}

async function getEligibleDrivers(seriesId, client = pool, driverIds = []) {
  const result = await client.query(
    `${eligibleDriversCte('AND d.user_id = ANY($2::uuid[])')}
     SELECT user_id, name, surname, vehicle_id, make, model,
            registration_number, seat_count, is_available, has_push_device
     FROM eligible
     ORDER BY sort_surname, sort_name, vehicle_id
     LIMIT $3`,
    [seriesId, driverIds, driverIds.length]
  );
  return result.rows;
}

async function listEligibleDrivers(seriesId, input = {}) {
  const pagination = normalizePagination(input);
  const result = await pool.query(
    `${eligibleDriversCte()}
     SELECT totals.total,
            page.user_id, page.name, page.surname, page.vehicle_id, page.make,
            page.model, page.registration_number, page.seat_count,
            page.is_available, page.has_push_device
     FROM (SELECT count(*)::int AS total FROM eligible) totals
     LEFT JOIN LATERAL (
       SELECT user_id, name, surname, vehicle_id, make, model,
              registration_number, seat_count, is_available, has_push_device,
              sort_surname, sort_name
       FROM eligible
       ORDER BY sort_surname, sort_name, vehicle_id
       LIMIT $2
       OFFSET GREATEST(0, LEAST(
         ($3 - 1) * $2,
         ((totals.total - 1) / $2) * $2
       ))
     ) page ON TRUE`,
    [seriesId, pagination.page_size, pagination.page]
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

async function audit(client, actorId, action, seriesId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'trip_series', $3, $4)`,
    [actorId, action, seriesId, metadata]
  );
}

async function advance(client, seriesId, actorId = null) {
  const tripIds = await lockSeriesAndTrips(client, seriesId);
  if (tripIds.length === 0) throw new AppError(404, 'Trip series not found.');

  const expired = await client.query(
    `UPDATE trip_offers
     SET status = 'expired', responded_at = now()
     WHERE series_id = $1 AND status = 'pending' AND expires_at <= now()
     RETURNING id, driver_user_id`,
    [seriesId]
  );
  for (const offer of expired.rows ?? []) {
    await notificationService.notifyOfferStatus(
      client,
      offer.id,
      'offer_expired',
      'Trip offer expired',
      'A trip offer has expired.'
    );
  }
  const pending = await client.query(
    `SELECT id FROM trip_offers
     WHERE series_id = $1 AND status = 'pending' AND expires_at > now()
     LIMIT 1`,
    [seriesId]
  );
  if (pending.rowCount === 1) return pending.rows[0].id;

  const queued = await client.query(
    `SELECT id, driver_user_id, vehicle_id, position, window_minutes
     FROM trip_offers
     WHERE series_id = $1 AND status = 'queued'
     ORDER BY position
     FOR UPDATE`,
    [seriesId]
  );
  const eligibleDrivers = await getEligibleDrivers(
    seriesId,
    client,
    queued.rows.map(({ driver_user_id: driverId }) => driverId)
  );
  const eligible = new Map(
    eligibleDrivers.map((driver) => [`${driver.user_id}:${driver.vehicle_id}`, driver])
  );
  for (const offer of queued.rows) {
    if (!eligible.has(`${offer.driver_user_id}:${offer.vehicle_id}`)) {
      await client.query(
        `UPDATE trip_offers SET status = 'cancelled', responded_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [offer.id]
      );
      continue;
    }
    const promoted = await client.query(
      `UPDATE trip_offers
       SET status = 'pending', offered_at = now(),
           expires_at = now() + (window_minutes * interval '1 minute')
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [offer.id]
    );
    if (promoted.rowCount === 1) {
      await notificationService.notifyOfferPending(client, offer.id);
      return offer.id;
    }
  }

  await client.query(
    `UPDATE trips SET status = 'unassigned', driver_user_id = NULL, vehicle_id = NULL
     WHERE series_id = $1 AND status = 'offered'`,
    [seriesId]
  );
  await audit(client, actorId, 'trip_series.unassigned', seriesId);
  return null;
}

async function create(seriesId, driverIds, windowMinutes, adminId) {
  return inTransaction(async (client) => {
    const tripIds = await lockSeriesAndTrips(client, seriesId);
    if (tripIds.length === 0) throw new AppError(404, 'Trip series not found.');
    const trips = await client.query(
      `SELECT id, status
       FROM trips
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [tripIds]
    );
    if (trips.rowCount === 0) throw new AppError(404, 'Trip series not found.');
    if (trips.rows.some(({ status }) => !['draft', 'unassigned'].includes(status))) {
      throw new AppError(409, 'Only draft or unassigned trips can be offered.');
    }
    const eligible = await getEligibleDrivers(seriesId, client, driverIds);
    const byDriver = new Map(eligible.map((driver) => [driver.user_id, driver]));
    if (driverIds.some((driverId) => !byDriver.has(driverId))) {
      throw new AppError(409, 'One or more selected drivers are no longer eligible.');
    }

    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = now()
       WHERE series_id = $1 AND status IN ('pending','queued')`,
      [seriesId]
    );
    for (const [index, driverId] of driverIds.entries()) {
      const driver = byDriver.get(driverId);
      await client.query(
        `INSERT INTO trip_offers
           (trip_id, series_id, driver_user_id, vehicle_id, offer_order,
            position, status, window_minutes)
         VALUES ($1, $2, $3, $4, $5, $5, 'queued', $6)`,
        [trips.rows[0].id, seriesId, driverId, driver.vehicle_id, index + 1, windowMinutes]
      );
    }
    await client.query(
      `UPDATE trips SET status = 'offered'
       WHERE series_id = $1 AND status IN ('draft','unassigned')`,
      [seriesId]
    );
    const firstOffer = await advance(client, seriesId, adminId);
    await audit(client, adminId, 'trip_series.offered', seriesId, {
      driver_ids: driverIds,
      window_minutes: windowMinutes,
    });
    return { series_id: seriesId, pending_offer_id: firstOffer };
  });
}

async function expireOffer(client, offer) {
  if (offer.status !== 'pending') return false;
  const expired = await client.query(
    `UPDATE trip_offers SET status = 'expired', responded_at = now()
     WHERE id = $1 AND status = 'pending' AND expires_at <= now()`,
    [offer.id]
  );
  if (expired.rowCount !== 1) return false;
  await notificationService.notifyOfferStatus(
    client,
    offer.id,
    'offer_expired',
    'Trip offer expired',
    'A trip offer has expired.'
  );
  await advance(client, offer.series_id);
  return true;
}

async function respond(offerId, driverId, decision) {
  const result = await inTransaction(async (client) => {
    const seriesResult = await client.query(
      `SELECT series_id, trip_id FROM trip_offers WHERE id = $1`,
      [offerId]
    );
    if (seriesResult.rowCount !== 1) {
      throw new AppError(404, 'Pending trip offer not found.');
    }
    const tripIds = await lockSeriesAndTrips(client, seriesResult.rows[0].series_id);
    if (!tripIds.includes(seriesResult.rows[0].trip_id)) {
      throw new AppError(409, 'This trip offer is no longer available.');
    }
    const offerResult = await client.query(
      `SELECT id, series_id, driver_user_id, vehicle_id, status, expires_at
       FROM trip_offers WHERE id = $1 FOR UPDATE`,
      [offerId]
    );
    const offer = offerResult.rows[0];
    if (!offer || offer.driver_user_id !== driverId || offer.status !== 'pending') {
      throw new AppError(404, 'Pending trip offer not found.');
    }
    if (await expireOffer(client, offer)) {
      return { expired: true };
    }
    if (decision === 'decline') {
      await client.query(
        `UPDATE trip_offers SET status = 'declined', responded_at = now() WHERE id = $1`,
        [offerId]
      );
      await client.query(
        `INSERT INTO trip_events
           (trip_id, event_type, actor_user_id, actor_role, metadata)
         VALUES ($1, 'trip_offer.declined', $2, 'driver', $3)`,
        [seriesResult.rows[0].trip_id, driverId, { offer_id: offerId }]
      );
      await advance(client, offer.series_id, driverId);
      return { declined: true, series_id: offer.series_id };
    }

    const eligible = await getEligibleDrivers(offer.series_id, client, [driverId]);
    if (!eligible.some((driver) =>
      driver.user_id === driverId && driver.vehicle_id === offer.vehicle_id
    )) {
      await client.query(
        `UPDATE trip_offers SET status = 'cancelled', responded_at = now() WHERE id = $1`,
        [offerId]
      );
      await advance(client, offer.series_id, driverId);
      return { unavailable: true };
    }
    await client.query(
      `UPDATE trip_offers SET status = 'accepted', responded_at = now() WHERE id = $1`,
      [offerId]
    );
    const otherOffers = await client.query(
      `SELECT id, driver_user_id FROM trip_offers
       WHERE series_id = $1 AND id <> $2 AND status IN ('queued','pending')`,
      [offer.series_id, offerId]
    );
    await client.query(
      `UPDATE trip_offers SET status = 'cancelled', responded_at = now()
       WHERE series_id = $1 AND status IN ('queued','pending')`,
      [offer.series_id]
    );
    await client.query(
      `UPDATE trips
       SET status = 'accepted', driver_user_id = $1, vehicle_id = $2
       WHERE series_id = $3 AND status = 'offered'`,
      [driverId, offer.vehicle_id, offer.series_id]
    );
    await Promise.all(otherOffers.rows.map(({ id }) =>
      notificationService.notifyOfferStatus(
        client,
        id,
        'offer_taken',
        'Trip offer no longer available',
        'This trip offer is no longer available.'
      )
    ));
    await notificationService.notifyAssignedSeriesPassengers(client, offer.series_id);
    await audit(client, driverId, 'trip_series.accepted', offer.series_id);
    return { accepted: true, series_id: offer.series_id };
  });
  if (result.expired) throw new AppError(409, 'This trip offer has expired.');
  if (result.unavailable) {
    throw new AppError(409, 'You are no longer eligible for this trip offer.');
  }
  return result;
}

async function cancel(seriesId, adminId) {
  return inTransaction(async (client) => {
    const tripIds = await lockSeriesAndTrips(client, seriesId);
    if (tripIds.length === 0) throw new AppError(404, 'Trip series not found.');
    const result = await client.query(
      `SELECT count(*) FILTER (WHERE status = 'offered')::int AS offered_count
       FROM trips WHERE id = ANY($1::uuid[])`,
      [tripIds]
    );
    if (result.rows[0].offered_count === 0) {
      throw new AppError(409, 'This trip series has no active offers to cancel.');
    }
    await client.query(
      `UPDATE trip_offers SET status = 'cancelled', responded_at = now()
       WHERE series_id = $1 AND status IN ('pending','queued')`,
      [seriesId]
    );
    await client.query(
      `UPDATE trips SET status = 'draft'
       WHERE series_id = $1 AND status = 'offered'`,
      [seriesId]
    );
    await audit(client, adminId, 'trip_series.offers_cancelled', seriesId);
  });
}

async function listForSeries(seriesId) {
  await inTransaction((client) => advance(client, seriesId));
  const result = await pool.query(
    `SELECT offer.id, offer.driver_user_id, offer.vehicle_id, offer.position,
            offer.status, offer.offered_at, offer.expires_at, offer.responded_at,
            offer.window_minutes, driver.name AS driver_name,
            driver.surname AS driver_surname,
            vehicle.registration_number,
            EXISTS (
              SELECT 1 FROM push_tokens token
              WHERE token.user_id = offer.driver_user_id AND token.revoked_at IS NULL
            ) AS has_push_device
     FROM trip_offers offer
     JOIN users driver ON driver.id = offer.driver_user_id
     JOIN vehicles vehicle ON vehicle.id = offer.vehicle_id
     WHERE offer.series_id = $1 ORDER BY offer.position`,
    [seriesId]
  );
  return result.rows;
}

async function processExpired() {
  const result = await pool.query(
    `SELECT id, series_id
     FROM trip_offers
     WHERE status = 'pending' AND expires_at <= now()
     ORDER BY expires_at LIMIT 100`
  );
  for (const offer of result.rows) {
    await inTransaction(async (client) => {
      await lockSeriesAndTrips(client, offer.series_id);
      const locked = await client.query(
        `SELECT id, series_id, driver_user_id, status, expires_at
         FROM trip_offers WHERE id = $1 FOR UPDATE`,
        [offer.id]
      );
      if (locked.rows[0]) await expireOffer(client, locked.rows[0]);
    });
  }
}

module.exports = {
  cancel,
  create,
  getEligibleDrivers,
  listEligibleDrivers,
  listForSeries,
  processExpired,
  respond,
};
