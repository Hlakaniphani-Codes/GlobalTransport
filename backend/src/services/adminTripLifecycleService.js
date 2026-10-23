const { createHash } = require('node:crypto');
const AppError = require('../utils/AppError');
const notificationService = require('./notifications');
const { lockTripSeries, lockStopsById } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
}

function formatTripDate(value) {
  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function containsPassengerData(message, passengers) {
  const normalizedMessage = normalizedText(message);
  const digits = message.replace(/\D/g, '');
  if (/(?:\+?\d[\d ().-]{5,}\d)/.test(message)) return true;
  return passengers.some((passenger) => {
    const personalValues = [
      `${passenger.name ?? ''} ${passenger.surname ?? ''}`,
      passenger.address,
      passenger.suburb,
    ];
    if (passenger.contact_number) {
      const phoneDigits = passenger.contact_number.replace(/\D/g, '');
      if (phoneDigits.length >= 6 && digits.includes(phoneDigits)) return true;
    }
    return personalValues.some((value) => {
      const normalized = normalizedText(value);
      return normalized.length >= 6 && normalizedMessage.includes(normalized);
    });
  });
}

async function selectTripForUpdate(client, tripId) {
  const { tripIds } = await lockTripSeries(client, tripId);
  if (!tripIds.includes(tripId)) throw new AppError(404, 'Trip not found.');
  const result = await client.query(
    `SELECT id, series_id, status, direction, driver_user_id, scheduled_at, starts_at, ends_at,
            started_at, rescheduled_at, change_ack_required
     FROM trips
     WHERE id = $1
     FOR UPDATE`,
    [tripId]
  );
  if (result.rowCount !== 1) throw new AppError(404, 'Trip not found.');
  return result.rows[0];
}

async function notifyTripPassengers(client, tripId, type, title, body, idempotencySuffix) {
  const passengers = await client.query(
    `SELECT DISTINCT passenger_user_id
     FROM trip_stops
     WHERE trip_id = $1`,
    [tripId]
  );
  await Promise.all(passengers.rows.map(({ passenger_user_id: userId }) =>
    notificationService.notify(userId, {
      type,
      title,
      body,
      data: { screen: 'passenger', trip_id: tripId },
      channels: ['push'],
      idempotencyKey: `${type}:${tripId}:${userId}:${idempotencySuffix}`,
    }, client)
  ));
  return passengers.rows.length;
}

async function recordAdminWrite(client, adminId, tripId, action, eventType, metadata) {
  await client.query(
    `INSERT INTO trip_events (trip_id, event_type, actor_user_id, actor_role, metadata)
     VALUES ($1, $2, $3, 'admin', $4)`,
    [tripId, eventType, adminId, metadata]
  );
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'trip', $3, $4)`,
    [adminId, action, tripId, metadata]
  );
}

async function rescheduleTrip(tripId, adminId, input, { clock = () => new Date() } = {}) {
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new TypeError('Trip lifecycle clock must return a valid date.');
  return withTransaction(async (client) => {
    const trip = await selectTripForUpdate(client, tripId);
    if (!['draft', 'unassigned', 'offered', 'accepted'].includes(trip.status)) {
      throw new AppError(409, 'Only draft, offered, unassigned, or accepted trips can be rescheduled.');
    }
    if (trip.started_at) throw new AppError(409, 'A trip that has started cannot be rescheduled.');
    const newScheduledAt = new Date(input.new_scheduled_at);
    if (Number.isNaN(newScheduledAt.getTime()) || newScheduledAt <= now) {
      throw new AppError(400, 'Choose a new trip time in the future.');
    }
    const acceptedDriver = trip.status === 'accepted' && trip.driver_user_id;
    const keepDriver = Boolean(acceptedDriver && input.keep_driver);
    if (newScheduledAt.getTime() === new Date(trip.scheduled_at).getTime()
      && (keepDriver || trip.status === 'unassigned')) {
      return { id: trip.id, status: keepDriver ? 'accepted' : trip.status, rescheduled: false };
    }

    const deltaMs = newScheduledAt.getTime() - new Date(trip.scheduled_at).getTime();
    const lockedStops = await lockStopsById(client, tripId, 'id, sequence, planned_at');
    const stops = { rows: lockedStops.sort((left, right) => left.sequence - right.sequence) };
    if (input.shift_stops && deltaMs !== 0) {
      const orderedStops = [...stops.rows]
        .filter(({ planned_at: value }) => value)
        .sort((left, right) => new Date(right.planned_at) - new Date(left.planned_at));
      if (deltaMs < 0) {
        await client.query(
          'UPDATE trips SET scheduled_at = $2::timestamptz WHERE id = $1',
          [tripId, newScheduledAt.toISOString()]
        );
      }
      for (const stop of orderedStops) {
        await client.query(
          `UPDATE trip_stops
           SET planned_at = planned_at + ($2::bigint * interval '1 millisecond')
           WHERE id = $1`,
          [stop.id, deltaMs]
        );
      }
    } else if (!input.shift_stops && trip.direction === 'home') {
      const firstStop = stops.rows[0];
      const secondStop = stops.rows[1];
      if (!firstStop || (secondStop && newScheduledAt > new Date(secondStop.planned_at))) {
        throw new AppError(400, 'The new first stop time must be no later than the next planned stop.');
      }
      await client.query(
        `UPDATE trip_stops SET planned_at = $2::timestamptz WHERE id = $1`,
        [firstStop.id, newScheduledAt.toISOString()]
      );
    } else if (!input.shift_stops) {
      const lastPlannedAt = stops.rows
        .map(({ planned_at: value }) => value && new Date(value).getTime())
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(lastPlannedAt) && lastPlannedAt < newScheduledAt.getTime()) {
        throw new AppError(400, 'The new trip time is later than the last planned stop. Shift the stops to continue.');
      }
    }
    const nextStatus = keepDriver
      ? 'accepted'
      : trip.status === 'draft' ? 'draft' : 'unassigned';
    const updated = await client.query(
      `UPDATE trips
       SET original_scheduled_at = COALESCE(original_scheduled_at, scheduled_at),
           scheduled_at = $2::timestamptz,
           rescheduled_at = $3::timestamptz,
           starts_at = COALESCE(
             (SELECT planned_at FROM trip_stops WHERE trip_id = $1 ORDER BY sequence LIMIT 1),
             $2::timestamptz
           ),
           ends_at = GREATEST(
             COALESCE(
               (SELECT max(planned_at) FROM trip_stops WHERE trip_id = $1),
               $2::timestamptz
             ),
             $2::timestamptz
           ),
           status = $4,
           driver_user_id = CASE WHEN $5 THEN driver_user_id ELSE NULL END,
           vehicle_id = CASE WHEN $5 THEN vehicle_id ELSE NULL END,
           change_ack_required = $5,
           change_acknowledged_at = NULL,
           updated_at = $3::timestamptz
       WHERE id = $1
       RETURNING id, status, scheduled_at, starts_at, ends_at, driver_user_id`,
      [tripId, newScheduledAt.toISOString(), now.toISOString(), nextStatus, keepDriver]
    );
    await client.query(
      `UPDATE ride_requests
       SET scheduled_at = $2::timestamptz
       WHERE trip_id = $1 AND status = 'assigned'`,
      [tripId, newScheduledAt.toISOString()]
    );
    if (!keepDriver) {
      await client.query(
        `UPDATE trip_offers
         SET status = 'cancelled', responded_at = $2::timestamptz
         WHERE trip_id = $1 AND status IN ('pending','queued')`,
        [tripId, now.toISOString()]
      );
    }
    const scheduleLabel = formatDateTime(newScheduledAt);
    const metadata = {
      previous_scheduled_at: trip.scheduled_at,
      new_scheduled_at: newScheduledAt.toISOString(),
      shift_stops: input.shift_stops,
      driver_kept: keepDriver,
    };
    await recordAdminWrite(client, adminId, tripId, 'trip.rescheduled', 'trip.rescheduled', metadata);
    if (acceptedDriver && keepDriver) {
      await notificationService.notify(acceptedDriver, {
        type: 'trip_changed',
        title: 'Trip changed',
        body: `Trip changed: new time ${scheduleLabel}. Please confirm.`,
        data: { screen: 'driver', trip_id: tripId },
        channels: ['push'],
        idempotencyKey: `trip_rescheduled:driver:${tripId}:${newScheduledAt.toISOString()}`,
      }, client);
    } else if (acceptedDriver) {
      await notificationService.notify(acceptedDriver, {
        type: 'trip_changed',
        title: 'Trip assignment changed',
        body: 'A trip assignment has changed. Check the app for the latest details.',
        data: { screen: 'driver', trip_id: tripId },
        channels: ['push'],
        idempotencyKey: `trip_unassigned:driver:${tripId}:${newScheduledAt.toISOString()}`,
      }, client);
    }
    await notifyTripPassengers(
      client,
      tripId,
      'trip_rescheduled',
      'Your trip time changed',
      `Your trip is now scheduled for ${scheduleLabel}.`,
      newScheduledAt.toISOString()
    );
    return { ...updated.rows[0], rescheduled: true };
  });
}

async function markTripMissed(tripId, adminId, reason, { clock = () => new Date() } = {}) {
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new TypeError('Trip lifecycle clock must return a valid date.');
  return withTransaction(async (client) => {
    const trip = await selectTripForUpdate(client, tripId);
    if (trip.status === 'missed' && trip.closed_reason === reason) {
      return { id: trip.id, status: trip.status, closed_reason: trip.closed_reason, marked: false };
    }
    if (!['draft', 'offered', 'unassigned', 'accepted'].includes(trip.status) || trip.started_at) {
      throw new AppError(409, 'Only a trip that has not started can be marked missed.');
    }
    const updated = await client.query(
      `UPDATE trips
       SET status = 'missed', closed_reason = $2, closed_by = $3,
           closed_at = $4::timestamptz, updated_at = $4::timestamptz
       WHERE id = $1
       RETURNING id, status, closed_reason, closed_by, closed_at`,
      [tripId, reason, adminId, now.toISOString()]
    );
    await client.query(
      `UPDATE ride_requests
       SET status = 'missed', closed_reason = $2
       WHERE trip_id = $1 AND status IN ('assigned','pending')`,
      [tripId, reason]
    );
    await client.query(
      `UPDATE trip_offers
       SET status = 'cancelled', responded_at = $2::timestamptz
       WHERE trip_id = $1 AND status IN ('pending','queued')`,
      [tripId, now.toISOString()]
    );
    const metadata = { reason, closed_at: now.toISOString() };
    await recordAdminWrite(client, adminId, tripId, 'trip.admin_marked_missed', 'trip.admin_marked_missed', metadata);
    await notifyTripPassengers(
      client,
      tripId,
      'trip_missed',
      'Trip not completed',
      `We couldn't complete your trip on ${formatTripDate(trip.scheduled_at)}. Please request again or contact us.`,
      'admin-marked-missed'
    );
    return { ...updated.rows[0], marked: true };
  });
}

async function reinstateTripPassengers(tripId, adminId, { clock = () => new Date() } = {}) {
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new TypeError('Trip lifecycle clock must return a valid date.');
  return withTransaction(async (client) => {
    const trip = await selectTripForUpdate(client, tripId);
    if (!['missed', 'cancelled', 'unassigned'].includes(trip.status)) {
      throw new AppError(409, 'Passengers can only be reinstated from a missed, cancelled, or unassigned trip.');
    }
    const restored = await client.query(
      `UPDATE ride_requests request
       SET status = 'pending', trip_id = NULL, closed_reason = NULL,
           cancelled_at = NULL, cancelled_by = NULL, cancelled_late = FALSE,
           cancel_reason = NULL
       WHERE request.id IN (
         SELECT DISTINCT stop.ride_request_id
         FROM trip_stops stop
         WHERE stop.trip_id = $1
       )
         AND request.scheduled_at > $2::timestamptz
         AND (
           request.status IN ('missed','assigned')
           OR (request.status = 'cancelled'
             AND request.cancelled_by IS DISTINCT FROM request.passenger_user_id)
         )
       RETURNING request.id`,
      [tripId, now.toISOString()]
    );
    if (restored.rowCount > 0) {
      const metadata = { reinstated_request_ids: restored.rows.map(({ id }) => id) };
      await recordAdminWrite(
        client,
        adminId,
        tripId,
        'trip.passengers_reinstated',
        'trip.passengers_reinstated',
        metadata
      );
    }
    return { trip_id: tripId, reinstated_count: restored.rowCount, reinstated_request_ids: restored.rows.map(({ id }) => id) };
  });
}

async function notifyPassengers(tripId, adminId, input) {
  return withTransaction(async (client) => {
    const trip = await selectTripForUpdate(client, tripId);
    const passengers = await client.query(
      `SELECT DISTINCT stop.passenger_user_id,
              u.name, u.surname, u.contact_number, stop.address, stop.suburb
       FROM trip_stops stop
       JOIN users u ON u.id = stop.passenger_user_id
       WHERE stop.trip_id = $1`,
      [tripId]
    );
    const message = input.template === 'delayed'
      ? `Your trip is delayed by ${input.minutes} minutes.`
      : input.template === 'rescheduled'
        ? `Your trip is now scheduled for ${formatDateTime(trip.scheduled_at)}.`
        : input.template === 'cancelled'
          ? 'Your trip has been cancelled by the transport team.'
          : input.message;
    if (input.template === 'custom' && containsPassengerData(message, passengers.rows)) {
      throw new AppError(400, 'The message must not contain passenger names or contact details.');
    }
    const messageHash = createHash('sha256').update(`${input.template}:${message}`).digest('hex');
    const prior = await client.query(
      `SELECT id
       FROM trip_events
       WHERE trip_id = $1 AND event_type = 'trip.passengers_notified'
         AND metadata->>'message_hash' = $2
       LIMIT 1`,
      [tripId, messageHash]
    );
    if (prior.rowCount > 0) {
      return {
        trip_id: tripId,
        notified_count: new Set(passengers.rows.map(({ passenger_user_id: id }) => id)).size,
        already_notified: true,
      };
    }
    const notifiedCount = await notifyTripPassengers(
      client,
      tripId,
      'admin_message',
      'Trip update',
      message,
      messageHash
    );
    const metadata = {
      template: input.template,
      message,
      message_hash: messageHash,
      notified_count: notifiedCount,
    };
    await recordAdminWrite(
      client,
      adminId,
      tripId,
      'trip.passengers_notified',
      'trip.passengers_notified',
      metadata
    );
    return { trip_id: tripId, notified_count: notifiedCount, already_notified: false };
  });
}

module.exports = {
  markTripMissed,
  notifyPassengers,
  reinstateTripPassengers,
  rescheduleTrip,
};
