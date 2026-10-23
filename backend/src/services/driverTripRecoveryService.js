const AppError = require('../utils/AppError');
const notificationService = require('./notifications');
const { lockStopsById, lockTripSeries } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

const WITHDRAWAL_ALERT_HOURS = Number(process.env.UNASSIGNED_ALERT_HOURS ?? 3);

function nowDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Trip recovery clock must return a valid date.');
  return date;
}

function formatTripDate(value) {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

async function recordAudit(client, actorId, tripId, action, metadata) {
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'trip', $3, $4)`,
    [actorId, action, tripId, metadata]
  );
}

async function recordTripEvent(client, tripId, actorId, eventType, metadata, createdAt) {
  await client.query(
    `INSERT INTO trip_events (trip_id, event_type, actor_user_id, actor_role, metadata, created_at)
     VALUES ($1, $2, $3, 'driver', $4, $5::timestamptz)`,
    [tripId, eventType, actorId, metadata, createdAt]
  );
}

async function notifyPassengers(client, tripId, passengerRows, type, title, body) {
  await Promise.all(passengerRows.map(({ passenger_user_id: userId }) =>
    notificationService.notify(userId, {
      type,
      title,
      body,
      data: { screen: 'passenger', trip_id: tripId },
      channels: ['push'],
      idempotencyKey: `${type}:${tripId}:${userId}`,
    }, client)
  ));
}

async function loadLockedTrip(client, tripId) {
  const { tripIds } = await lockTripSeries(client, tripId);
  if (!tripIds.includes(tripId)) throw new AppError(404, 'Trip not found.');
  const result = await client.query(
    `SELECT trip.id, trip.series_id, trip.driver_user_id, trip.vehicle_id,
            trip.status, trip.scheduled_at, trip.starts_at, trip.ends_at,
            trip.started_at, trip.completed_at, trip.has_issues,
            trip.closed_by, trip.closed_reason,
            trip.change_ack_required, trip.change_acknowledged_at,
            COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at) AS first_stop_at
     FROM trips trip
     LEFT JOIN LATERAL (
       SELECT stop.planned_at
       FROM trip_stops stop
       WHERE stop.trip_id = trip.id
       ORDER BY stop.sequence
       LIMIT 1
     ) first_stop ON TRUE
     WHERE trip.id = $1
     FOR UPDATE OF trip`,
    [tripId]
  );
  if (result.rowCount !== 1) throw new AppError(404, 'Trip not found.');
  return result.rows[0];
}

async function existingWithdrawal(client, tripId, driverUserId) {
  const result = await client.query(
    `SELECT trip_id, driver_user_id, reason_kind, note, scope, late, created_at
     FROM trip_withdrawals
     WHERE trip_id = $1 AND driver_user_id = $2`,
    [tripId, driverUserId]
  );
  return result.rows[0] ?? null;
}

async function markAdminAttention(client, trip, driverUserId, now, metadata) {
  const timeToFirstStop = Date.parse(trip.first_stop_at) - now.getTime();
  if (timeToFirstStop > WITHDRAWAL_ALERT_HOURS * 60 * 60 * 1000) return false;
  await client.query(
    `INSERT INTO trip_events (trip_id, event_type, actor_user_id, actor_role, metadata, created_at)
     SELECT $1, 'trip.unassigned_driver_attention', $2, 'driver', $3, $4::timestamptz
     WHERE NOT EXISTS (
       SELECT 1 FROM trip_events
       WHERE trip_id = $1 AND event_type = 'trip.unassigned_driver_attention'
     )`,
    [trip.id, driverUserId, { ...metadata, starts_at: trip.first_stop_at }, now.toISOString()]
  );
  const passengers = await client.query(
    `SELECT DISTINCT passenger_user_id
     FROM ride_requests
     WHERE trip_id = $1 AND status = 'assigned'`,
    [trip.id]
  );
  await notifyPassengers(
    client,
    trip.id,
    passengers.rows,
    'driver_withdrew_reassigning',
    'Your trip is being reassigned',
    "Your trip is being reassigned. We'll confirm shortly."
  );
  return true;
}

async function withdrawTrip(driverUserId, tripId, input, { clock = () => new Date() } = {}) {
  const now = nowDate(clock);
  const lateHours = Number(process.env.LATE_WITHDRAW_HOURS ?? 12);
  return withTransaction(async (client) => {
    const target = await loadLockedTrip(client, tripId);
    const prior = await existingWithdrawal(client, tripId, driverUserId);
    if (prior && (target.driver_user_id !== driverUserId || target.status !== 'accepted')) {
      return {
        trip: {
          id: target.id,
          status: target.status,
          scheduled_at: target.scheduled_at,
          starts_at: target.starts_at,
          ends_at: target.ends_at,
        },
        trips_withdrawn: 1,
        scope: prior.scope,
      };
    }
    if (target.driver_user_id !== driverUserId) {
      throw new AppError(404, 'Assigned trip not found.');
    }
    if (target.status !== 'accepted' || target.started_at) {
      throw new AppError(409, 'Only an accepted trip that has not started can be withdrawn.');
    }

    const affected = input.scope === 'all_future'
      ? await client.query(
        `SELECT trip.id, trip.series_id, trip.scheduled_at, trip.starts_at, trip.ends_at,
                trip.started_at,
                COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at) AS first_stop_at
         FROM trips trip
         LEFT JOIN LATERAL (
           SELECT stop.planned_at
           FROM trip_stops stop
           WHERE stop.trip_id = trip.id
           ORDER BY stop.sequence
           LIMIT 1
         ) first_stop ON TRUE
         WHERE trip.series_id = $1 AND trip.driver_user_id = $2
           AND trip.status = 'accepted' AND trip.started_at IS NULL
           AND trip.scheduled_at >= $3
         ORDER BY trip.scheduled_at, trip.id
         FOR UPDATE OF trip`,
        [target.series_id, driverUserId, target.scheduled_at]
      )
      : { rows: [target] };

    if (!affected.rows.some(({ id }) => id === tripId)) {
      throw new AppError(409, 'This trip is no longer available to withdraw.');
    }
    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = $2::timestamptz
       WHERE series_id = $1 AND status IN ('pending','queued')`,
      [target.series_id, now.toISOString()]
    );
    const changedTrips = [];
    for (const trip of affected.rows) {
      const series = await client.query(
        `INSERT INTO trip_series (created_by) VALUES ($1) RETURNING id`,
        [driverUserId]
      );
      const late = Date.parse(trip.first_stop_at) - now.getTime() < lateHours * 60 * 60 * 1000;
      const changed = await client.query(
        `UPDATE trips
         SET status = 'unassigned', driver_user_id = NULL, vehicle_id = NULL, series_id = $2
         WHERE id = $1 AND status = 'accepted' AND started_at IS NULL
         RETURNING id, status, scheduled_at, starts_at, ends_at`,
        [trip.id, series.rows[0].id]
      );
      if (changed.rowCount !== 1) continue;
      await client.query(
        `INSERT INTO trip_withdrawals
           (trip_id, driver_user_id, reason_kind, note, scope, late, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          trip.id,
          driverUserId,
          input.reason_kind,
          input.note ?? null,
          input.scope,
          late,
          now.toISOString(),
        ]
      );
      const metadata = {
        reason_kind: input.reason_kind,
        note: input.note ?? null,
        scope: input.scope,
        late,
      };
      await recordTripEvent(client, trip.id, driverUserId, 'trip.driver_withdrew', metadata, now.toISOString());
      await recordAudit(client, driverUserId, trip.id, 'trip.driver_withdrew', metadata);
      await markAdminAttention(client, trip, driverUserId, now, metadata);
      changedTrips.push(changed.rows[0]);
    }
    return {
      trip: changedTrips[0] ?? null,
      trips_withdrawn: changedTrips.length,
      scope: input.scope,
    };
  });
}

async function closeAsMissed(driverUserId, tripId, input, { clock = () => new Date() } = {}) {
  const now = nowDate(clock);
  const overdueGraceMinutes = Number(process.env.OVERDUE_GRACE_MINUTES ?? 30);
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, tripId);
    if (trip.driver_user_id !== driverUserId) throw new AppError(404, 'Assigned trip not found.');
    if (trip.status === 'missed' && trip.closed_by === driverUserId) {
      return { id: trip.id, status: trip.status, closed_reason: trip.closed_reason };
    }
    if (trip.status !== 'accepted' || trip.started_at) {
      throw new AppError(409, 'Only an accepted trip that has not started can be reported as not happened.');
    }
    const overdueAt = Date.parse(trip.ends_at) + overdueGraceMinutes * 60 * 1000;
    if (now.getTime() <= overdueAt) {
      throw new AppError(409, 'This trip can still be started. You can report it as not happened after the planned end and grace period.');
    }
    const updated = await client.query(
      `UPDATE trips
       SET status = 'missed', closed_reason = $2, closed_by = $3,
           closed_at = $4::timestamptz
       WHERE id = $1 AND status = 'accepted' AND started_at IS NULL
       RETURNING id, status, closed_reason, closed_by, closed_at, scheduled_at`,
      [tripId, input.reason_kind, driverUserId, now.toISOString()]
    );
    await client.query(
      `UPDATE ride_requests SET status = 'missed', closed_reason = $2
       WHERE trip_id = $1 AND status = 'assigned'`,
      [tripId, input.reason_kind]
    );
    const metadata = { reason_kind: input.reason_kind, note: input.note ?? null };
    await recordTripEvent(client, tripId, driverUserId, 'trip.reported_not_happened', metadata, now.toISOString());
    await recordAudit(client, driverUserId, tripId, 'trip.reported_not_happened', metadata);
    await client.query(
      `INSERT INTO incidents (trip_id, reported_by, reporter_role, type, description, created_at)
       VALUES ($1, $2, 'driver', 'driver_issue', $3, $4::timestamptz)`,
      [
        tripId,
        driverUserId,
        `Driver reported that the trip did not happen (${input.reason_kind}).${input.note ? ` ${input.note}` : ''}`,
        now.toISOString(),
      ]
    );
    const passengers = await client.query(
      `SELECT DISTINCT passenger_user_id
       FROM ride_requests
       WHERE trip_id = $1 AND status = 'missed'`,
      [tripId]
    );
    await notifyPassengers(
      client,
      tripId,
      passengers.rows,
      'trip_missed',
      'Trip not completed',
      `We couldn't complete your trip on ${formatTripDate(trip.scheduled_at)}. Please request again or contact us.`
    );
    const { id, status, closed_reason: closedReason } = updated.rows[0];
    return { id, status, closed_reason: closedReason };
  });
}

async function endEarly(driverUserId, tripId, input, { clock = () => new Date() } = {}) {
  const now = nowDate(clock);
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, tripId);
    if (trip.driver_user_id !== driverUserId) throw new AppError(404, 'Assigned trip not found.');
    if (trip.status === 'completed' && trip.closed_by === driverUserId && trip.closed_reason) {
      const event = await client.query(
        `SELECT metadata
         FROM trip_events
         WHERE trip_id = $1 AND actor_user_id = $2 AND event_type = 'trip.ended_early'
         ORDER BY created_at DESC
         LIMIT 1`,
        [tripId, driverUserId]
      );
      const affectedRequestCount = Number(event.rows[0]?.metadata?.affected_request_count ?? 0);
      return {
        id: trip.id,
        status: trip.status,
        has_issues: trip.has_issues,
        completed_at: trip.completed_at,
        closed_reason: trip.closed_reason,
        closed_by: trip.closed_by,
        affected_request_count: affectedRequestCount,
      };
    }
    if (trip.status !== 'in_progress') {
      throw new AppError(409, 'Only an in-progress trip can be ended early.');
    }
    await lockStopsById(client, tripId, 'id');
    const affected = await client.query(
      `SELECT request.id, request.passenger_user_id
       FROM ride_requests request
       WHERE request.trip_id = $1 AND request.status = 'assigned'
         AND NOT EXISTS (
           SELECT 1 FROM trip_stops stop
           WHERE stop.trip_id = $1 AND stop.ride_request_id = request.id
             AND stop.stop_type = 'dropoff' AND stop.status = 'completed'
         )
       FOR UPDATE OF request`,
      [tripId]
    );
    const updated = await client.query(
      `UPDATE trips
       SET status = 'completed', has_issues = TRUE, completed_at = $2::timestamptz,
           closed_reason = $3, closed_by = $4, closed_at = $2::timestamptz
       WHERE id = $1 AND status = 'in_progress'
       RETURNING id, status, has_issues, completed_at, closed_reason, closed_by`,
      [tripId, now.toISOString(), input.reason, driverUserId]
    );
    await client.query(
      `UPDATE trip_stops
       SET status = 'skipped', skip_kind = 'other', skip_reason = $2,
           completed_at = COALESCE(completed_at, $3::timestamptz)
       WHERE trip_id = $1 AND status NOT IN ('completed','skipped')`,
      [tripId, input.note?.trim() || input.reason, now.toISOString()]
    );
    if (affected.rowCount) {
      await client.query(
        `UPDATE ride_requests
         SET status = 'pending', trip_id = NULL, closed_reason = NULL
         WHERE id = ANY($1::uuid[])`,
        [affected.rows.map(({ id }) => id)]
      );
    }
    const incident = await client.query(
      `INSERT INTO incidents (trip_id, reported_by, reporter_role, type, description, created_at)
       VALUES ($1, $2, 'driver', $3, $4, $5::timestamptz)
       RETURNING id`,
      [
        tripId,
        driverUserId,
        input.reason,
        `Trip ended early.${input.note ? ` ${input.note}` : ''}`,
        now.toISOString(),
      ]
    );
    const metadata = {
      reason: input.reason,
      note: input.note ?? null,
      incident_id: incident.rows[0].id,
      affected_request_count: affected.rowCount,
    };
    await recordTripEvent(client, tripId, driverUserId, 'trip.ended_early', metadata, now.toISOString());
    await recordAudit(client, driverUserId, tripId, 'trip.ended_early', metadata);
    await notifyPassengers(
      client,
      tripId,
      affected.rows,
      'trip_ended_early',
      'Trip ended early',
      'The trip ended early. Your ride request has been returned to dispatch.'
    );
    return {
      ...updated.rows[0],
      affected_request_count: affected.rowCount,
    };
  });
}

async function acknowledgeChange(driverUserId, tripId, { clock = () => new Date() } = {}) {
  const now = nowDate(clock);
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, tripId);
    if (trip.driver_user_id !== driverUserId) throw new AppError(404, 'Assigned trip not found.');
    if (!['accepted', 'in_progress'].includes(trip.status)) {
      throw new AppError(409, 'Trip changes can only be confirmed for an upcoming or active trip.');
    }
    if (!trip.change_ack_required && trip.change_acknowledged_at) {
      return { id: trip.id, change_ack_required: false, change_acknowledged_at: trip.change_acknowledged_at };
    }
    if (!trip.change_ack_required) {
      return { id: trip.id, change_ack_required: false, change_acknowledged_at: null };
    }
    const updated = await client.query(
      `UPDATE trips
       SET change_ack_required = FALSE, change_acknowledged_at = $2::timestamptz
       WHERE id = $1 AND change_ack_required = TRUE
       RETURNING id, change_ack_required, change_acknowledged_at`,
      [tripId, now.toISOString()]
    );
    await recordTripEvent(client, tripId, driverUserId, 'trip.change_acknowledged', {}, now.toISOString());
    await recordAudit(client, driverUserId, tripId, 'trip.change_acknowledged', {});
    return updated.rows[0];
  });
}

module.exports = { acknowledgeChange, closeAsMissed, endEarly, withdrawTrip };
