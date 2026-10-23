const notificationService = require('./notifications');
const withTransaction = require('../utils/withTransaction');

function lifecycleConfig(env = process.env) {
  return {
    autoMissAfterMinutes: Number(env.AUTO_MISS_AFTER_MINUTES ?? 60),
    requestExpireGraceMinutes: Number(env.REQUEST_EXPIRE_GRACE_MINUTES ?? 15),
    unassignedAlertHours: Number(env.UNASSIGNED_ALERT_HOURS ?? 3),
  };
}

function formatDateTime(value) {
  const date = new Date(value);
  const dateText = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Johannesburg',
  }).format(date);
  const timeText = new Intl.DateTimeFormat('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Johannesburg',
  }).format(date);
  return { dateText, timeText };
}

async function notifyTripPassengers(client, tripId, type, body) {
  const passengers = await client.query(
    `SELECT DISTINCT passenger_user_id
     FROM ride_requests
     WHERE trip_id = $1 AND status = 'missed'`,
    [tripId]
  );
  await Promise.all(passengers.rows.map(({ passenger_user_id: userId }) =>
    notificationService.notify(userId, {
      type,
      title: "We couldn't complete your trip",
      body,
      data: { screen: 'passenger', trip_id: tripId },
      channels: ['push'],
      idempotencyKey: `${type}:${tripId}:${userId}`,
    }, client)
  ));
}

async function lockDueTripSeries(client, condition, values) {
  const candidates = await client.query(
    `SELECT DISTINCT series_id
     FROM trips
     WHERE ${condition}
     ORDER BY series_id`,
    values
  );
  const seriesIds = candidates.rows.map(({ series_id: seriesId }) => seriesId);
  if (seriesIds.length === 0) return;
  await client.query(
    `SELECT id FROM trip_series
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [seriesIds]
  );
}

async function closeNeverStartedAccepted(client, now, minutes) {
  await lockDueTripSeries(
    client,
    `status = 'accepted' AND started_at IS NULL
     AND ends_at <= $1::timestamptz - ($2 * interval '1 minute')`,
    [now, minutes]
  );
  const due = await client.query(
    `SELECT trip.id, trip.driver_user_id, trip.scheduled_at, trip.ends_at
     FROM trips trip
     WHERE trip.status = 'accepted' AND trip.started_at IS NULL
       AND trip.ends_at <= $1::timestamptz - ($2 * interval '1 minute')
     ORDER BY trip.id
     FOR UPDATE SKIP LOCKED`,
    [now, minutes]
  );
  for (const trip of due.rows) {
    const closed = await client.query(
      `UPDATE trips
       SET status = 'missed', closed_reason = 'no_activity',
           closed_at = $2::timestamptz, closed_by = NULL
       WHERE id = $1 AND status = 'accepted' AND started_at IS NULL
       RETURNING id`,
      [trip.id, now]
    );
    if (closed.rowCount !== 1) continue;
    await client.query(
      `UPDATE ride_requests
       SET status = 'missed', closed_reason = 'no_activity'
       WHERE trip_id = $1 AND status = 'assigned'`,
      [trip.id]
    );
    await client.query(
      `INSERT INTO trip_events (trip_id, event_type, actor_role, metadata, created_at)
       VALUES ($1, 'trip.missed', 'system', $2, $3::timestamptz)`,
      [trip.id, { closed_reason: 'no_activity' }, now]
    );
    await notificationService.notify(trip.driver_user_id, {
      type: 'trip_missed',
      title: 'Trip closed',
      body: 'This trip was closed because it did not start. Contact dispatch if this is wrong.',
      data: { screen: 'driver', trip_id: trip.id },
      channels: ['push'],
      idempotencyKey: `trip_missed:${trip.id}:${trip.driver_user_id}`,
    }, client);
    const { dateText } = formatDateTime(trip.scheduled_at);
    await notifyTripPassengers(
      client,
      trip.id,
      'trip_missed',
      `We couldn't complete your trip on ${dateText}. Please request again or contact us.`
    );
  }
  return due.rowCount;
}

async function closeExpiredUnassigned(client, now) {
  await lockDueTripSeries(
    client,
    `status IN ('draft','unassigned') AND ends_at <= $1::timestamptz`,
    [now]
  );
  const due = await client.query(
    `SELECT id, series_id, scheduled_at
     FROM trips
     WHERE status IN ('draft','unassigned') AND ends_at <= $1::timestamptz
     ORDER BY id
     FOR UPDATE SKIP LOCKED`,
    [now]
  );
  for (const trip of due.rows) {
    const closed = await client.query(
      `UPDATE trips
       SET status = 'cancelled', closed_reason = 'expired_unassigned',
           closed_at = $2::timestamptz, closed_by = NULL
       WHERE id = $1 AND status IN ('draft','unassigned')
       RETURNING id`,
      [trip.id, now]
    );
    if (closed.rowCount !== 1) continue;
    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = $2::timestamptz
       WHERE trip_id = $1 AND status IN ('pending','queued')`,
      [trip.id, now]
    );
    await client.query(
      `UPDATE ride_requests
       SET status = 'missed', closed_reason = 'expired_unassigned'
       WHERE trip_id = $1 AND status = 'assigned'`,
      [trip.id]
    );
    await client.query(
      `INSERT INTO trip_events (trip_id, event_type, actor_role, metadata, created_at)
       VALUES ($1, 'trip.expired_unassigned', 'system', $2, $3::timestamptz)`,
      [trip.id, { closed_reason: 'expired_unassigned' }, now]
    );
    const { dateText } = formatDateTime(trip.scheduled_at);
    await notifyTripPassengers(
      client,
      trip.id,
      'trip_missed',
      `We couldn't complete your trip on ${dateText}. Please request again or contact us.`
    );
  }
  return due.rowCount;
}

async function expireUnmatchedRequests(client, now, graceMinutes) {
  const due = await client.query(
    `SELECT id, passenger_user_id, scheduled_at
     FROM ride_requests
     WHERE status = 'pending' AND trip_id IS NULL
       AND scheduled_at <= $1::timestamptz - ($2 * interval '1 minute')
     ORDER BY scheduled_at, id
     FOR UPDATE SKIP LOCKED`,
    [now, graceMinutes]
  );
  for (const request of due.rows) {
    const expired = await client.query(
      `UPDATE ride_requests
       SET status = 'expired', closed_reason = 'no_trip'
       WHERE id = $1 AND status = 'pending' AND trip_id IS NULL
       RETURNING id`,
      [request.id]
    );
    if (expired.rowCount !== 1) continue;
    await notificationService.notify(request.passenger_user_id, {
      type: 'request_expired',
      title: 'No trip was arranged',
      body: `We couldn't arrange a trip for ${formatDateTime(request.scheduled_at).dateText}, ${formatDateTime(request.scheduled_at).timeText}. Please request again.`,
      data: { screen: 'passenger_requests' },
      channels: ['push'],
      idempotencyKey: `request_expired:${request.id}:${request.passenger_user_id}`,
    }, client);
  }
  return due.rowCount;
}

async function createUnassignedAttention(client, now, hours) {
  const attention = await client.query(
    `WITH upcoming AS (
       SELECT trip.id, COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at) AS starts_at
       FROM trips trip
       LEFT JOIN LATERAL (
         SELECT stop.planned_at
         FROM trip_stops stop
         WHERE stop.trip_id = trip.id
         ORDER BY stop.sequence
         LIMIT 1
       ) first_stop ON TRUE
       WHERE trip.status IN ('draft','offered','unassigned')
         AND trip.driver_user_id IS NULL
         AND COALESCE(first_stop.planned_at, trip.starts_at, trip.scheduled_at)
           BETWEEN $1::timestamptz AND $1::timestamptz + ($2 * interval '1 hour')
     )
     INSERT INTO trip_events (trip_id, event_type, actor_role, metadata, created_at)
     SELECT upcoming.id, 'trip.unassigned_driver_attention', 'system',
            jsonb_build_object('starts_at', upcoming.starts_at), $1::timestamptz
     FROM upcoming
     WHERE NOT EXISTS (
       SELECT 1 FROM trip_events event
       WHERE event.trip_id = upcoming.id
         AND event.event_type = 'trip.unassigned_driver_attention'
     )
     RETURNING trip_id, metadata`,
    [now, hours]
  );
  return attention.rows;
}

async function processLifecycle({ clock = () => new Date(), config = lifecycleConfig() } = {}) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Lifecycle clock must return a valid Date.');
  }
  return withTransaction(async (client) => {
    const closedMissed = await closeNeverStartedAccepted(
      client,
      now.toISOString(),
      config.autoMissAfterMinutes
    );
    const closedUnassigned = await closeExpiredUnassigned(client, now.toISOString());
    const expiredRequests = await expireUnmatchedRequests(
      client,
      now.toISOString(),
      config.requestExpireGraceMinutes
    );
    const adminAttention = await createUnassignedAttention(
      client,
      now.toISOString(),
      config.unassignedAlertHours
    );
    return {
      missed_trips: closedMissed,
      expired_unassigned_trips: closedUnassigned,
      expired_requests: expiredRequests,
      admin_attention: adminAttention.length,
    };
  });
}

module.exports = { lifecycleConfig, processLifecycle };
