const pool = require('../db');
const AppError = require('../utils/AppError');
const notificationService = require('./notifications');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');
const { lockStopsById, lockTripSeries } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

async function list(filters) {
  const pagination = normalizePagination(filters);
  const conditions = [];
  const values = [];
  const add = (fragment, value) => {
    values.push(value);
    conditions.push(fragment.replace('?', `$${values.length}`));
  };
  if (filters.from) add(`r.scheduled_at >= (?::date::timestamp AT TIME ZONE 'Africa/Johannesburg')`, filters.from);
  if (filters.to) add(`r.scheduled_at < ((?::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')`, filters.to);
  if (filters.direction) add('r.direction = ?', filters.direction);
  if (filters.status) add('r.status = ?', filters.status);
  if (filters.unassigned_only) conditions.push(`r.status = 'pending' AND r.trip_id IS NULL`);
  if (filters.search) {
    values.push(`%${filters.search.trim().replace(/[\\%_]/g, '\\$&').toLowerCase()}%`);
    const parameter = `$${values.length}`;
    conditions.push(`(
      lower(u.name || ' ' || u.surname) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(p.employee_number) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(c.name) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.workplace, w.name)) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.home_suburb, '')) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.workplace_suburb, w.suburb, '')) LIKE ${parameter} ESCAPE E'\\\\'
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const joins = `FROM ride_requests r
    JOIN passengers p ON p.user_id = r.passenger_user_id
    JOIN users u ON u.id = p.user_id
    JOIN workplaces w ON w.id = r.workplace_id
    JOIN companies c ON c.id = w.company_id`;
  const count = await pool.query(
    `SELECT count(*)::int AS total ${joins} ${where}`,
    values
  );
  const total = count.rows[0].total;
  const page = paginationMetadata(total, pagination).page;
  const result = await pool.query(
    `SELECT r.id, r.passenger_user_id, r.direction, r.scheduled_at, r.status,
            r.series_id, r.booking_source, r.booked_by, r.created_at AS booked_at,
            r.cancelled_by, r.cancelled_at, r.cancel_reason, r.cancelled_late,
            u.name AS passenger_name, u.surname AS passenger_surname,
            u.email, u.contact_number, p.employee_number, p.address AS home_address,
            p.home_suburb, COALESCE(p.workplace, w.name) AS workplace_name,
            COALESCE(p.workplace_address, w.address) AS workplace_address,
            COALESCE(p.workplace_suburb, w.suburb) AS workplace_suburb,
            c.name AS company_name,
            booked.name AS booked_by_name, booked.surname AS booked_by_surname,
            cancelled.name AS cancelled_by_name, cancelled.surname AS cancelled_by_surname
     ${joins}
     LEFT JOIN users booked ON booked.id = r.booked_by
     LEFT JOIN users cancelled ON cancelled.id = r.cancelled_by
     ${where}
     ORDER BY r.scheduled_at ${filters.sort === 'asc' ? 'ASC' : 'DESC'}, r.id
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pagination.page_size, (page - 1) * pagination.page_size]
  );
  return {
    ride_requests: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page }),
  };
}

async function cancel(adminId, requestId, reason) {
  return withTransaction(async (client) => {
    const tripLookup = await client.query(
      `SELECT trip_id FROM ride_requests WHERE id = $1`,
      [requestId]
    );
    const tripId = tripLookup.rows[0]?.trip_id;
    if (tripId) {
      const { tripIds } = await lockTripSeries(client, tripId);
      if (!tripIds.includes(tripId)) throw new AppError(409, 'The assigned trip is no longer available.');
      await lockStopsById(client, tripId, 'id');
    }
    const result = await client.query(
      `SELECT r.id, r.status, r.trip_id, t.started_at, t.status AS trip_status,
              t.driver_user_id,
              COALESCE(pickup.planned_at, r.scheduled_at) AS pickup_at
       FROM ride_requests r LEFT JOIN trips t ON t.id = r.trip_id
       LEFT JOIN LATERAL (
         SELECT planned_at FROM trip_stops
         WHERE trip_id = r.trip_id AND ride_request_id = r.id AND stop_type = 'pickup'
         LIMIT 1
       ) pickup ON TRUE
       WHERE r.id = $1 FOR UPDATE OF r`,
      [requestId]
    );
    const request = result.rows[0];
    if (!request) throw new AppError(404, 'Ride request not found.');
    if (!['pending', 'assigned'].includes(request.status) || request.started_at) {
      throw new AppError(409, 'This ride request can no longer be cancelled.');
    }
    if (request.status === 'assigned' && request.driver_user_id
      && ['accepted', 'in_progress'].includes(request.trip_status)) {
      await notificationService.notifyTripPassengers(client, request.trip_id, 'request_cancelled', {
        rideRequestId: requestId,
      });
    }
    const lateHours = Number.parseFloat(process.env.LATE_CANCELLATION_HOURS || '2');
    const cancelledLate = (Date.parse(request.pickup_at) - Date.now()) / 3_600_000 < lateHours;
    const updated = await client.query(
      `UPDATE ride_requests
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
           cancel_reason = $3, cancelled_late = $4
       WHERE id = $1 RETURNING id, status, cancelled_at, cancelled_late`,
      [requestId, adminId, reason, cancelledLate]
    );
    if (request.trip_id) {
      await client.query(
        `UPDATE trip_stops SET status = 'skipped', skip_kind = 'cancelled',
           skip_reason = $2, completed_at = COALESCE(completed_at, now())
         WHERE trip_id = $1 AND ride_request_id = $3 AND status IN ('pending','arrived')`,
        [request.trip_id, reason, requestId]
      );
      await cancelEmptyTrip(client, request.trip_id, adminId);
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'ride_request.cancelled', 'ride_request', $2, $3)`,
      [adminId, requestId, { reason, cancelled_late: updated.rows[0].cancelled_late }]
    );
    return updated.rows[0];
  });
}

async function cancelEmptyTrip(client, tripId, adminId) {
  const remaining = await client.query(
    `SELECT count(DISTINCT ride_request_id)::int AS passenger_count
     FROM trip_stops WHERE trip_id = $1 AND status <> 'skipped'`,
    [tripId]
  );
  if (remaining.rows[0].passenger_count !== 0) return;
  const trip = await client.query(`SELECT series_id FROM trips WHERE id = $1`, [tripId]);
  await client.query(
    `UPDATE trips SET status = 'cancelled', cancelled_at = now(),
       cancelled_by = $2, cancel_reason = 'All passengers cancelled.'
     WHERE id = $1 AND status IN ('draft','offered','accepted','unassigned')`,
    [tripId, adminId]
  );
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'trip.auto_cancelled', 'trip', $2, $3)`,
    [adminId, tripId, { series_id: trip.rows[0]?.series_id }]
  );
}

module.exports = { cancel, list };
