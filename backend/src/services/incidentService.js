const pool = require('../db');
const AppError = require('../utils/AppError');
const withTransaction = require('../utils/withTransaction');
const notificationService = require('./notifications');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');

async function create(userId, role, input) {
  return withTransaction(async (client) => {
    if (input.trip_id) {
      const ownership = role === 'driver'
        ? await client.query(
          `SELECT id FROM trips
           WHERE id = $1 AND driver_user_id = $2
             AND status IN ('accepted','in_progress') FOR SHARE`,
          [input.trip_id, userId]
        )
        : await client.query(
          `SELECT t.id
           FROM trips t
           JOIN ride_requests r ON r.trip_id = t.id
           WHERE t.id = $1 AND r.passenger_user_id = $2
             AND t.status IN ('accepted','in_progress')
           LIMIT 1 FOR SHARE OF t`,
          [input.trip_id, userId]
        );
      if (ownership.rowCount !== 1) {
        throw new AppError(404, 'Active trip not found for this account.');
      }
    }

    const incident = await client.query(
      `INSERT INTO incidents (trip_id, reported_by, reporter_role, type, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, trip_id, type, description, status, created_at`,
      [input.trip_id ?? null, userId, role, input.type, input.description]
    );
    if (input.trip_id) {
      await client.query(
        `INSERT INTO trip_events
           (trip_id, event_type, actor_user_id, actor_role, client_time, metadata)
         VALUES ($1, 'incident.reported', $2, $3, $4, $5)`,
        [
          input.trip_id,
          userId,
          role,
          input.client_time ?? null,
          { incident_id: incident.rows[0].id, type: input.type },
        ]
      );
    }
    return incident.rows[0];
  });
}

async function list(filters) {
  const pagination = normalizePagination(filters);
  const conditions = [];
  const values = [];
  if (filters.status) {
    if (filters.status === 'active') {
      conditions.push("i.status <> 'resolved'");
    } else {
      values.push(filters.status);
      conditions.push(`i.status = $${values.length}`);
    }
  }
  if (filters.type) {
    values.push(filters.type);
    conditions.push(`i.type = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM incidents i ${where}`,
    values
  );
  const total = count.rows[0].total;
  const page = paginationMetadata(total, pagination).page;
  const result = await pool.query(
    `SELECT i.id, i.trip_id, i.reported_by, i.reporter_role, i.type,
            i.description, i.status, i.created_at, i.acknowledged_by,
            i.acknowledged_at, i.resolved_by, i.resolved_at, i.resolution_note,
            reporter.name AS reporter_name, reporter.surname AS reporter_surname
     FROM incidents i
     JOIN users reporter ON reporter.id = i.reported_by
     ${where}
     ORDER BY CASE WHEN i.type = 'emergency' AND i.status <> 'resolved' THEN 0 ELSE 1 END,
              CASE WHEN i.status = 'open' THEN 0 WHEN i.status = 'acknowledged' THEN 1 ELSE 2 END,
              i.created_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pagination.page_size, (page - 1) * pagination.page_size]
  );
  return {
    incidents: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page }),
  };
}

async function acknowledge(incidentId, adminId) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE incidents
       SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
       WHERE id = $1 AND status = 'open'
       RETURNING id, status, acknowledged_by, acknowledged_at`,
      [incidentId, adminId]
    );
    if (result.rowCount === 0) {
      const current = await client.query(
        `SELECT id, status, acknowledged_by, acknowledged_at
         FROM incidents WHERE id = $1 FOR UPDATE`,
        [incidentId]
      );
      if (current.rowCount !== 1) throw new AppError(404, 'Incident not found.');
      if (current.rows[0].status === 'resolved') {
        throw new AppError(409, 'Resolved incidents cannot be acknowledged.');
      }
      return current.rows[0];
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'incident.acknowledged', 'incident', $2, '{}'::jsonb)`,
      [adminId, incidentId]
    );
    return result.rows[0];
  });
}

async function resolve(incidentId, adminId, note) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE incidents
       SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3
       WHERE id = $1 AND status <> 'resolved'
       RETURNING id, status, resolved_by, resolved_at, resolution_note`,
      [incidentId, adminId, note]
    );
    if (result.rowCount === 0) {
      const current = await client.query(
        `SELECT id, status, resolved_by, resolved_at, resolution_note
         FROM incidents WHERE id = $1 FOR UPDATE`,
        [incidentId]
      );
      if (current.rowCount !== 1) throw new AppError(404, 'Incident not found.');
      return current.rows[0];
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'incident.resolved', 'incident', $2, $3)`,
      [adminId, incidentId, { note }]
    );
    return result.rows[0];
  });
}

async function getNeedsAttention() {
  const [
    documents, incidents, overdueTrips, issueTrips, noShows, incidentCounts, failedNotifications,
    unassignedTrips, overdueNeverStartedTrips, recentWithdrawals, waitingForConfirmation,
    recentMissedTrips, recentExpiredRequests, runningLateTrips, recentDeclinedOffers,
  ] = await Promise.all([
    pool.query(
      `SELECT document_type, driver_user_id, vehicle_id, expires_at, expired,
              driver_name, driver_surname
       FROM (
         SELECT 'driver_licence' AS document_type, d.user_id AS driver_user_id,
                NULL::uuid AS vehicle_id, d.licence_expiry AS expires_at,
                d.licence_expiry < CURRENT_DATE AS expired,
                u.name AS driver_name, u.surname AS driver_surname
         FROM drivers d JOIN users u ON u.id = d.user_id
         WHERE d.licence_expiry IS NOT NULL AND d.licence_expiry <= CURRENT_DATE + 30
         UNION ALL
         SELECT 'prdp' AS document_type, d.user_id, NULL::uuid, d.prdp_expiry,
                d.prdp_expiry < CURRENT_DATE,
                u.name, u.surname
         FROM drivers d JOIN users u ON u.id = d.user_id
         WHERE d.prdp_expiry IS NOT NULL AND d.prdp_expiry <= CURRENT_DATE + 30
         UNION ALL
         SELECT 'vehicle_licence_disc', v.driver_user_id, v.id, v.licence_disc_expiry,
                v.licence_disc_expiry < CURRENT_DATE,
                u.name, u.surname
         FROM vehicles v JOIN users u ON u.id = v.driver_user_id
         WHERE v.licence_disc_expiry IS NOT NULL
           AND v.licence_disc_expiry <= CURRENT_DATE + 30
       ) document
       ORDER BY expires_at, driver_surname, driver_name
       LIMIT 100`
    ),
    pool.query(
      `SELECT id, trip_id, type, status, created_at
       FROM incidents WHERE status <> 'resolved'
       ORDER BY CASE WHEN type = 'emergency' THEN 0 ELSE 1 END, created_at
       LIMIT 100`
    ),
    pool.query(
      `SELECT DISTINCT ON (t.id) t.id AS trip_id, t.status, e.event_type, e.created_at
       FROM trip_events e JOIN trips t ON t.id = e.trip_id
       WHERE e.event_type IN ('trip.not_started_overdue','trip.running_long_overdue')
         AND t.status IN ('accepted','in_progress')
       ORDER BY t.id, e.created_at DESC
       LIMIT 100`
    ),
    pool.query(
      `SELECT id AS trip_id, completed_at, has_issues
       FROM trips WHERE status = 'completed' AND has_issues = TRUE
       ORDER BY completed_at DESC LIMIT 100`
    ),
    pool.query(
      `SELECT e.trip_id, e.stop_id, e.created_at, e.metadata,
              u.name AS passenger_name, u.surname AS passenger_surname
       FROM trip_events e
       LEFT JOIN trip_stops s ON s.id = e.stop_id
       LEFT JOIN users u ON u.id = s.passenger_user_id
       WHERE e.event_type = 'stop.no_show'
         AND e.created_at >= now() - interval '7 days'
       ORDER BY e.created_at DESC
       LIMIT 100`
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open_incident_count,
              count(*) FILTER (WHERE type = 'emergency' AND status <> 'resolved')::int
                AS open_emergency_count
       FROM incidents`
    ),
    notificationService.failedLast24HoursCount(),
    pool.query(
      `SELECT DISTINCT ON (trip.id) trip.id AS trip_id, trip.status,
              COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at) AS starts_at,
              event.created_at AS flagged_at
       FROM trip_events event
       JOIN trips trip ON trip.id = event.trip_id
       LEFT JOIN LATERAL (
         SELECT stop.planned_at
         FROM trip_stops stop
         WHERE stop.trip_id = trip.id
         ORDER BY stop.sequence
         LIMIT 1
       ) first_stop ON TRUE
       WHERE event.event_type = 'trip.unassigned_driver_attention'
         AND trip.status IN ('draft','offered','unassigned')
         AND trip.driver_user_id IS NULL
         AND COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at)
           BETWEEN now() AND now() + ($1 * interval '1 hour')
       ORDER BY trip.id, event.created_at DESC
       LIMIT 100`,
      [Number(process.env.UNASSIGNED_ALERT_HOURS ?? 3)]
    ),
    pool.query(
      `SELECT trip.id AS trip_id, trip.status, trip.scheduled_at, trip.ends_at,
              trip.driver_user_id
       FROM trips trip
       WHERE trip.status = 'accepted' AND trip.started_at IS NULL
         AND trip.ends_at + ($1 * interval '1 minute') < now()
       ORDER BY trip.ends_at
       LIMIT 100`,
      [Number(process.env.OVERDUE_GRACE_MINUTES ?? 30)]
    ),
    pool.query(
      `SELECT withdrawal.trip_id, withdrawal.driver_user_id, withdrawal.reason_kind,
              withdrawal.note, withdrawal.scope, withdrawal.late, withdrawal.created_at,
              trip.scheduled_at
       FROM trip_withdrawals withdrawal
       JOIN trips trip ON trip.id = withdrawal.trip_id
       WHERE withdrawal.created_at >= now() - interval '24 hours'
       ORDER BY withdrawal.late DESC, withdrawal.created_at DESC
       LIMIT 100`
    ),
    pool.query(
      `SELECT id AS trip_id, scheduled_at, driver_user_id, change_acknowledged_at
       FROM trips
       WHERE status IN ('accepted','in_progress') AND change_ack_required = TRUE
       ORDER BY scheduled_at
       LIMIT 100`
    ),
    pool.query(
      `SELECT id AS trip_id, scheduled_at, closed_reason, closed_at, closed_by
       FROM trips
       WHERE status = 'missed' AND closed_at >= now() - interval '7 days'
       ORDER BY closed_at DESC
       LIMIT 100`
    ),
    pool.query(
      `SELECT id AS request_id, passenger_user_id, direction, scheduled_at, closed_reason
       FROM ride_requests
       WHERE status = 'expired'
         AND scheduled_at + ($1 * interval '1 minute')
           BETWEEN now() - interval '24 hours' AND now()
       ORDER BY scheduled_at DESC
       LIMIT 100`,
      [Number(process.env.REQUEST_EXPIRE_GRACE_MINUTES ?? 15)]
    ),
    pool.query(
      `SELECT trip.id AS trip_id, stop.id AS stop_id,
              stop.eta_at, stop.eta_updated_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (stop.eta_at - stop.planned_at)) / 60))::int
                AS minutes_late,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stop.eta_updated_at)) / 60))::int
                AS eta_age_minutes
       FROM trips trip
       JOIN LATERAL (
         SELECT id, planned_at, eta_at, eta_updated_at
         FROM trip_stops
         WHERE trip_id = trip.id AND status = 'en_route' AND eta_at IS NOT NULL
         ORDER BY sequence
         LIMIT 1
       ) stop ON TRUE
       WHERE trip.status = 'in_progress'
         AND stop.eta_at > stop.planned_at + interval '10 minutes'
       ORDER BY stop.eta_at DESC
       LIMIT 100`
    ),
    pool.query(
       `SELECT trip.id AS trip_id, trip.direction, trip.scheduled_at,
               offer.responded_at, driver.name AS driver_name,
               driver.surname AS driver_surname
        FROM trip_offers offer
        JOIN trips trip ON trip.id = offer.trip_id
        JOIN users driver ON driver.id = offer.driver_user_id
        WHERE offer.status = 'declined'
          AND offer.responded_at >= now() - interval '24 hours'
        ORDER BY offer.responded_at DESC
        LIMIT 100`
    ),
  ]);
  return {
    documents: documents.rows,
    open_incidents: incidents.rows,
    overdue_trips: overdueTrips.rows,
    completed_with_issues: issueTrips.rows,
    recent_no_shows: noShows.rows,
    unassigned_trips: unassignedTrips.rows,
    overdue_never_started_trips: overdueNeverStartedTrips.rows,
    recent_withdrawals: recentWithdrawals.rows,
    trips_waiting_for_driver_confirmation: waitingForConfirmation.rows,
    recent_missed_trips: recentMissedTrips.rows,
    recent_expired_requests: recentExpiredRequests.rows,
    running_late_trips: runningLateTrips.rows,
    recent_declined_offers: recentDeclinedOffers.rows,
    failed_notifications_last_24_hours: failedNotifications,
    ...incidentCounts.rows[0],
  };
}

module.exports = { acknowledge, create, getNeedsAttention, list, resolve };
