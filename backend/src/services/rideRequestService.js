const { randomUUID } = require('node:crypto');
const pool = require('../db');
const AppError = require('../utils/AppError');
const { getRepeatDates } = require('./rideDateUtils');
const { decodeCursor, encodeCursor, normalizePagination } = require('../utils/pagination');
const { lockStopSet, lockTripSet } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

const REQUEST_OUTCOME_REASONS = {
  no_activity: 'The trip did not start.',
  no_trip: 'No trip could be arranged before your requested time.',
  expired_unassigned: 'No driver was assigned in time.',
  could_not_start: 'The trip could not be started.',
  vehicle_problem: 'The trip could not go ahead because of a vehicle problem.',
  passengers_unavailable: 'The trip could not go ahead because passengers were unavailable.',
  cancelled_by_company: 'The trip was cancelled by the company.',
  illness_or_emergency: 'The driver could not continue because of an emergency.',
  personal: 'The driver could not continue for personal reasons.',
  schedule_conflict: 'The driver could not continue because of a schedule conflict.',
  other: 'The trip was closed after an issue was reported.',
};

async function create(passengerUserId, input) {
  const dates = getRepeatDates(input);
  if (dates.length === 0) {
    throw new AppError(400, 'No ride dates match the selected weekdays.');
  }

  const seriesId = input.repeat ? randomUUID() : null;
  return withTransaction(async (client) => {
    const passenger = await client.query(
      `SELECT p.workplace_id
       FROM passengers p
       JOIN workplaces w ON w.id = p.workplace_id
       JOIN companies c ON c.id = w.company_id
       WHERE p.user_id = $1 AND p.workplace_id IS NOT NULL
         AND w.is_active = TRUE AND c.is_active = TRUE
       FOR SHARE OF p, w, c`,
      [passengerUserId]
    );
    if (passenger.rowCount !== 1) {
      throw new AppError(409, 'Your workplace is not active. Contact Global Ride Transport.');
    }

    if (seriesId) {
      await client.query(
        `INSERT INTO trip_series (id, created_by) VALUES ($1, $2)`,
        [seriesId, passengerUserId]
      );
    }

    const created = [];
    for (const date of dates) {
      const result = await client.query(
        `INSERT INTO ride_requests
           (passenger_user_id, workplace_id, direction, scheduled_at, series_id, booking_source)
         SELECT p.user_id, p.workplace_id, $2, $3::timestamptz, $4, 'passenger'
         FROM passengers p
         WHERE p.user_id = $1
         RETURNING id, direction, scheduled_at, status, series_id, created_at`,
        [passengerUserId, input.direction, `${date}T${input.time}:00+02:00`, seriesId]
      );
      created.push(result.rows[0]);
    }
    return created;
  });
}

async function listMine(passengerUserId, cursor, pageSize = 25) {
  const pagination = normalizePagination({ page_size: pageSize });
  const decoded = decodeCursor(cursor);
  const values = [passengerUserId];
  let cursorCondition = '';
  if (decoded) {
    values.push(decoded.sort_at, decoded.id);
    cursorCondition = 'AND (r.scheduled_at, r.id) < ($2::timestamptz, $3::uuid)';
  }
  values.push(pagination.page_size + 1);
  const limitParameter = `$${values.length}`;
  const result = await pool.query(
    `SELECT r.id, r.direction, r.scheduled_at, r.status, r.series_id,
            r.closed_reason,
            to_char(r.scheduled_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date_of_ride,
            to_char(r.scheduled_at AT TIME ZONE 'Africa/Johannesburg', 'HH24:MI') AS time_of_day,
            CASE WHEN r.series_id IS NULL THEN NULL ELSE ARRAY(
              SELECT series_days.weekday
              FROM (
                SELECT DISTINCT
                  EXTRACT(ISODOW FROM series_request.scheduled_at AT TIME ZONE 'Africa/Johannesburg')::int AS weekday
                FROM ride_requests series_request
                WHERE series_request.series_id = r.series_id
                  AND series_request.passenger_user_id = r.passenger_user_id
              ) series_days
              ORDER BY series_days.weekday
            ) END AS repeat_weekdays,
            r.created_at, r.cancelled_at, r.cancelled_late,
            r.cancel_reason, r.cancelled_by, r.booking_source,
            COALESCE(p.workplace, w.name) AS workplace_name,
            c.name AS company_name
     FROM ride_requests r
     JOIN passengers p ON p.user_id = r.passenger_user_id
     JOIN workplaces w ON w.id = r.workplace_id
     JOIN companies c ON c.id = w.company_id
     WHERE r.passenger_user_id = $1 ${cursorCondition}
     ORDER BY r.scheduled_at DESC, r.id DESC
     LIMIT ${limitParameter}`,
    values
  );
  const hasMore = result.rows.length > pagination.page_size;
  const rows = hasMore ? result.rows.slice(0, pagination.page_size) : result.rows;
  const rideRequests = rows.map((request) => {
    const needsRecovery = ['missed', 'expired'].includes(request.status);
    const canRequestAgain = needsRecovery || request.status === 'cancelled';
    const weekdays = request.repeat_weekdays ?? [];
    return {
      ...request,
      outcome_reason: needsRecovery
        ? REQUEST_OUTCOME_REASONS[request.closed_reason] ?? 'This trip did not happen.'
        : null,
      request_again: canRequestAgain
        ? {
          direction: request.direction,
          date: request.date_of_ride,
          time_of_day: request.time_of_day,
          repeat_pattern: request.series_id && weekdays.length > 0 ? { weekdays } : null,
        }
        : null,
    };
  });
    const lastRequest = rows.at(-1);
    return {
      ride_requests: rideRequests,
      next_cursor: hasMore && lastRequest
        ? encodeCursor(lastRequest.scheduled_at, lastRequest.id)
        : null,
    };
}

async function cancel(passengerUserId, requestId, scope = 'this') {
  return withTransaction(async (client) => {
    const sourceResult = await client.query(
      `SELECT id, series_id
       FROM ride_requests
       WHERE id = $1 AND passenger_user_id = $2`,
      [requestId, passengerUserId]
    );
    if (sourceResult.rowCount !== 1) {
      throw new AppError(404, 'Ride request not found.');
    }

    const source = sourceResult.rows[0];
    const candidates = scope === 'series' && source.series_id
      ? await client.query(
        `SELECT id, trip_id
         FROM ride_requests
         WHERE passenger_user_id = $1 AND series_id = $2
           AND status IN ('pending','assigned')
         ORDER BY id`,
        [passengerUserId, source.series_id]
      )
      : await client.query(
        `SELECT id, trip_id
         FROM ride_requests
         WHERE id = $1 AND passenger_user_id = $2
           AND status IN ('pending','assigned')`,
        [requestId, passengerUserId]
      );
    if (candidates.rowCount === 0) {
      throw new AppError(409, 'This ride request can no longer be cancelled.');
    }
    const candidateTripIds = candidates.rows
      .map(({ trip_id: tripId }) => tripId)
      .filter(Boolean);
    const lockedTripIds = new Set(await lockTripSet(client, candidateTripIds));
    await lockStopSet(client, candidateTripIds, 'id');
    const requestsResult = await client.query(
      `SELECT r.id, r.scheduled_at, r.trip_id, t.started_at, t.rescheduled_at
       FROM ride_requests r
       LEFT JOIN trips t ON t.id = r.trip_id
       WHERE r.id = ANY($1::uuid[]) AND r.passenger_user_id = $2
         AND r.status IN ('pending','assigned')
       ORDER BY r.id
       FOR UPDATE OF r`,
      [candidates.rows.map(({ id }) => id), passengerUserId]
    );
    if (requestsResult.rowCount === 0) {
      throw new AppError(409, 'This ride request can no longer be cancelled.');
    }
    if (requestsResult.rows.some(({ trip_id: tripId }) =>
      tripId && !lockedTripIds.has(tripId)
    )) {
      const error = new Error('Ride request assignments changed while acquiring ordered row locks.');
      error.code = '40001';
      throw error;
    }
    if (requestsResult.rows.some(({ started_at }) => started_at)) {
      throw new AppError(409, 'A ride request cannot be cancelled after its trip has started.');
    }

    const lateHours = Number.parseFloat(process.env.LATE_CANCELLATION_HOURS || '2');
    const changeCancelExemptHours = Number(process.env.CHANGE_CANCEL_EXEMPT_HOURS ?? 24);
    const now = Date.now();
    const cancelled = [];
    const tripIds = new Set();
    for (const request of requestsResult.rows) {
      let pickupAt = request.scheduled_at;
      if (request.trip_id) {
        tripIds.add(request.trip_id);
        const pickup = await client.query(
          `SELECT planned_at
           FROM trip_stops
           WHERE trip_id = $1 AND ride_request_id = $2 AND stop_type = 'pickup'
           LIMIT 1`,
          [request.trip_id, request.id]
        );
        if (pickup.rows[0]?.planned_at) pickupAt = pickup.rows[0].planned_at;
      }
      const rescheduledAt = request.rescheduled_at ? Date.parse(request.rescheduled_at) : Number.NaN;
      const changedTripExempt = Number.isFinite(rescheduledAt)
        && now >= rescheduledAt
        && now <= rescheduledAt + changeCancelExemptHours * 3_600_000;
      const cancelledLate = !changedTripExempt
        && (Date.parse(pickupAt) - now) / 3_600_000 < lateHours;
      const updated = await client.query(
        `UPDATE ride_requests
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
             cancel_reason = 'Passenger cancelled ride request.',
             cancelled_late = $3
         WHERE id = $1
         RETURNING id, status, cancelled_at, cancelled_late`,
        [request.id, passengerUserId, cancelledLate]
      );
      cancelled.push(updated.rows[0]);
      if (request.trip_id) {
        await client.query(
          `UPDATE trip_stops
           SET status = 'skipped', skip_kind = 'cancelled',
               skip_reason = 'Passenger cancelled ride request.', completed_at = COALESCE(completed_at, now())
           WHERE trip_id = $1 AND ride_request_id = $2
             AND status IN ('pending','arrived')`,
          [request.trip_id, request.id]
        );
      }
    }

    for (const tripId of tripIds) {
      const passengers = await client.query(
        `SELECT count(DISTINCT ride_request_id)::int AS count
         FROM trip_stops
         WHERE trip_id = $1 AND status <> 'skipped'`,
        [tripId]
      );
      if (passengers.rows[0].count === 0) {
        await client.query(
          `UPDATE trips
           SET status = 'cancelled', cancelled_at = now(),
               cancelled_by = $2, cancel_reason = 'All passengers cancelled.'
           WHERE id = $1 AND started_at IS NULL
             AND status IN ('draft','offered','accepted','unassigned')`,
          [tripId, passengerUserId]
        );
      }
    }
    return cancelled;
  });
}

async function listPending() {
  const result = await pool.query(
    `SELECT r.id, r.direction, r.scheduled_at, r.status, r.created_at,
            u.id AS passenger_user_id, u.name AS passenger_name,
            u.surname AS passenger_surname, u.contact_number,
            p.address AS home_address, p.home_suburb,
            p.home_latitude, p.home_longitude, p.employee_number,
            w.id AS workplace_id, COALESCE(p.workplace, w.name) AS workplace_name,
            COALESCE(p.workplace_address, w.address) AS workplace_address,
            p.workplace_suburb,
            w.latitude AS workplace_latitude, w.longitude AS workplace_longitude,
            c.name AS company_name
     FROM ride_requests r
     JOIN passengers p ON p.user_id = r.passenger_user_id
     JOIN users u ON u.id = p.user_id
     JOIN workplaces w ON w.id = r.workplace_id
     JOIN companies c ON c.id = w.company_id
     WHERE r.status = 'pending'
     ORDER BY r.scheduled_at ASC
     LIMIT 200`
  );
  return result.rows;
}

module.exports = { cancel, create, listMine, listPending };
