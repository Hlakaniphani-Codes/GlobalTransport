const pool = require('../db');
const AppError = require('../utils/AppError');
const notificationService = require('./notifications');
const { lockStopsById, lockTripSeries } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

const FINAL_STOP_STATUSES = new Set(['completed', 'skipped']);
const STOP_GROUP_SKIP_KINDS = new Set([
  'unreachable',
  'address_problem',
  'passenger_declined',
  'other',
]);
const ETA_QUICK_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

function etaIsFresh(updatedAt, now = Date.now()) {
  return Boolean(updatedAt)
    && now - Date.parse(updatedAt) <= Number(process.env.ETA_STALE_MINUTES ?? 15) * 60_000;
}

function shouldNotifyEta(stop, minutes, now = Date.now()) {
  if (!stop.eta_notified_for) return true;
  const previousEta = Date.parse(stop.eta_notified_for);
  const previousNotification = stop.eta_notified_at ? Date.parse(stop.eta_notified_at) : Number.NaN;
  const nextEta = now + minutes * 60_000;
  return Math.abs(nextEta - previousEta) >= 5 * 60_000
    && (!Number.isFinite(previousNotification) || now - previousNotification >= 5 * 60_000);
}

function addressKey(stop) {
  return `${stop.address ?? ''} ${stop.suburb ?? ''}`
    .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function groupStops(stops) {
  const groups = [];
  for (const stop of stops) {
    const key = `${stop.stop_type}:${addressKey(stop)}`;
    const previous = groups.at(-1);
    if (previous?.key === key) {
      previous.stops.push(stop);
    } else {
      groups.push({ key, id: stop.id, stops: [stop] });
    }
  }
  return groups;
}

function allFinal(group) {
  return group.stops.every(({ status }) => FINAL_STOP_STATUSES.has(status));
}

function waitSeconds(arrivedAt, now = Date.now()) {
  if (!arrivedAt) return 0;
  return Math.max(0, Math.floor((now - Date.parse(arrivedAt)) / 1000));
}

function buildExecutionState(trip, stops, now = Date.now()) {
  const stopGroups = groupStops(stops).map((stopGroup, index, groups) => {
    const { stops: members } = stopGroup;
    const activeMembers = members.filter(({ status }) => !FINAL_STOP_STATUSES.has(status));
    const status = activeMembers.length === 0
      ? members.every(({ status: memberStatus }) => memberStatus === 'completed') ? 'completed' : 'skipped'
      : activeMembers.some(({ status: memberStatus }) => memberStatus === 'arrived') ? 'arrived'
        : activeMembers.some(({ status: memberStatus }) => memberStatus === 'en_route') ? 'en_route'
          : 'pending';
    const current = groups.findIndex((candidate) => !allFinal(candidate)) === index;
    const arrivedAt = members.map(({ arrived_at: time }) => time).filter(Boolean).sort()[0] ?? null;
    const completedAt = members.map(({ completed_at: time }) => time).filter(Boolean).sort().at(-1) ?? null;
    const etaStop = activeMembers.find(({ eta_at: value }) => value)
      ?? activeMembers[0];
    const group = {
      id: stopGroup.id,
      sequence: members[0].sequence,
      stop_type: members[0].stop_type,
      address: members[0].address,
      suburb: members[0].suburb,
      planned_at: members[0].planned_at,
      arrived_at: arrivedAt,
      completed_at: completedAt,
      wait_seconds: Math.max(...members.map(({ arrived_at: time }) => waitSeconds(time, now))),
      eta_at: current && trip.status === 'in_progress' ? etaStop?.eta_at ?? null : null,
      eta_updated_at: current && trip.status === 'in_progress' ? etaStop?.eta_updated_at ?? null : null,
      eta_is_fresh: current && trip.status === 'in_progress'
        ? etaIsFresh(etaStop?.eta_updated_at, now)
        : false,
      status,
      stops: members.map((stop) => ({
        ...stop,
        wait_seconds: waitSeconds(stop.arrived_at, now),
        allowed_actions: {
          no_show: current
            && stop.stop_type === 'pickup'
            && stop.status === 'arrived'
            && waitSeconds(stop.arrived_at, now) >= Number(process.env.NO_SHOW_WAIT_MINUTES ?? 5) * 60,
        },
      })),
      allowed_actions: {
        arrive: current && activeMembers.some(({ status: memberStatus }) => memberStatus === 'en_route'),
        complete: current && activeMembers.some(({ status: memberStatus }) => memberStatus === 'arrived'),
        skip: current
          && members[0].stop_type === 'dropoff'
          && activeMembers.some(({ status: memberStatus }) => memberStatus === 'arrived'),
      },
    };
    return group;
  });
  const currentGroup = stopGroups.find((group) => !allFinal({ stops: group.stops }));
  const firstStop = stops[0];
  const startWindowMinutes = Number.parseInt(process.env.TRIP_START_WINDOW_MINUTES || '90', 10);
  const overdueGraceMinutes = Number(process.env.OVERDUE_GRACE_MINUTES ?? 30);
  const startAt = firstStop?.planned_at ? Date.parse(firstStop.planned_at) : Date.parse(trip.starts_at);
  const latestStartAt = Date.parse(trip.ends_at ?? trip.scheduled_at)
    + overdueGraceMinutes * 60_000;
  const canStart = trip.status === 'accepted'
    && !trip.change_ack_required
    && Number.isFinite(startAt)
    && now >= startAt - startWindowMinutes * 60_000
    && now <= latestStartAt;
  const startReason = trip.status !== 'accepted'
    ? 'This trip is not ready to start.'
    : !Number.isFinite(startAt)
      ? 'The first stop time is unavailable. Contact your dispatcher.'
      : trip.change_ack_required
        ? 'Confirm the trip changes before starting.'
      : !Number.isFinite(latestStartAt)
        ? 'The planned end time is unavailable. Contact your dispatcher.'
      : now < startAt - startWindowMinutes * 60_000
        ? `You can start this trip ${startWindowMinutes} minutes before the first stop.`
        : now > latestStartAt
          ? 'This trip can no longer be started. Report that it did not happen.'
          : null;
  const canReportNotHappened = trip.status === 'accepted'
    && !trip.started_at
    && now > latestStartAt;
  const groupsWithContact = stopGroups.map((group) => ({
    ...group,
    stops: group.stops.map((stop) => ({
      ...stop,
      contact_number: trip.status === 'in_progress'
        && group.id === currentGroup?.id
        && group.stop_type === 'pickup'
        && ['en_route', 'arrived'].includes(group.status)
        && ['en_route', 'arrived'].includes(stop.status)
        ? stop.contact_number
        : null,
    })),
  }));
  return {
    ...trip,
    stops: groupsWithContact.flatMap(({ stops: members }) => members),
    stop_groups: groupsWithContact,
    current_stop_group_id: currentGroup?.id ?? null,
    allowed_next_actions: {
      start: canStart,
      start_reason: startReason,
      report_not_happened: canReportNotHappened,
      acknowledge_change: trip.status === 'accepted' && trip.change_ack_required === true,
      arrive: Boolean(currentGroup?.allowed_actions.arrive),
      complete: Boolean(currentGroup?.allowed_actions.complete),
      skip: Boolean(currentGroup?.allowed_actions.skip),
      report_no_show: Boolean(currentGroup?.stops.some(({ allowed_actions: actions }) => actions.no_show)),
      report_dropoff_exception: Boolean(currentGroup?.allowed_actions.skip),
      delay: ['accepted', 'in_progress'].includes(trip.status),
    },
    eta_quick_options: ETA_QUICK_OPTIONS,
  };
}

async function loadTrip(queryable, driverUserId, tripId) {
  const tripResult = await queryable.query(
    `SELECT t.id, t.series_id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
            t.workplace_name, t.workplace_address, t.distance_km, t.notes, t.status,
            t.started_at, t.completed_at, t.has_issues, t.delay_minutes, t.delay_reported_at,
            t.closed_reason, t.closed_by, t.closed_at, t.change_ack_required,
            t.change_acknowledged_at,
            v.id AS vehicle_id, v.make AS vehicle_make, v.model AS vehicle_model,
            v.registration_number, v.seat_count
     FROM trips t
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.id = $1 AND t.driver_user_id = $2
       AND t.status IN ('accepted','in_progress','completed','cancelled','missed')`,
    [tripId, driverUserId]
  );
  if (tripResult.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
  const [stopResult, passengerResult, eventResult] = await Promise.all([
    queryable.query(
      `SELECT s.id, s.sequence, s.stop_type, s.address, s.suburb, s.planned_at,
              s.status, s.en_route_at, s.arrived_at, s.completed_at,
              s.skip_kind, s.skip_reason, s.eta_at, s.eta_updated_at,
              s.eta_notified_at, s.eta_notified_for,
              u.name AS passenger_name, u.surname AS passenger_surname,
              u.contact_number, s.ride_request_id
       FROM trip_stops s
       JOIN users u ON u.id = s.passenger_user_id
       WHERE s.trip_id = $1 ORDER BY s.sequence`,
      [tripId]
    ),
    queryable.query(
      `SELECT count(DISTINCT ride_request_id)::int AS count
       FROM trip_stops WHERE trip_id = $1 AND stop_type = 'pickup'`,
      [tripId]
    ),
    queryable.query(
      `SELECT id, stop_id, event_type, actor_role, client_time, metadata, created_at
       FROM trip_events WHERE trip_id = $1 ORDER BY created_at, id`,
      [tripId]
    ),
  ]);
  return {
    ...buildExecutionState(
      { ...tripResult.rows[0], passenger_count: passengerResult.rows[0].count },
      stopResult.rows
    ),
    events: eventResult.rows,
  };
}

async function recordEvent(client, tripId, eventType, driverUserId, stopId, clientTime, metadata) {
  await client.query(
    `INSERT INTO trip_events
       (trip_id, stop_id, event_type, actor_user_id, actor_role, client_time, metadata)
     VALUES ($1, $2, $3, $4, 'driver', $5, $6)`,
    [tripId, stopId ?? null, eventType, driverUserId, clientTime ?? null, metadata ?? {}]
  );
}

async function recordAudit(client, driverUserId, tripId, action, metadata) {
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'trip', $3, $4)`,
    [driverUserId, action, tripId, metadata ?? {}]
  );
}

async function loadLockedTrip(client, driverUserId, tripId) {
  const { tripIds } = await lockTripSeries(client, tripId);
  if (!tripIds.includes(tripId)) throw new AppError(404, 'Assigned trip not found.');
  const trip = await client.query(
    `SELECT id, status, direction, starts_at, scheduled_at, ends_at, started_at,
            has_issues, change_ack_required
     FROM trips WHERE id = $1 AND driver_user_id = $2 FOR UPDATE`,
    [tripId, driverUserId]
  );
  if (trip.rowCount !== 1) throw new AppError(404, 'Assigned trip not found.');
  return trip.rows[0];
}

async function loadLockedStops(client, tripId) {
  const rows = await lockStopsById(
    client,
    tripId,
    `id, ride_request_id, sequence, stop_type, address, suburb, planned_at,
     status, en_route_at, arrived_at, completed_at, skip_kind, skip_reason,
     eta_at, eta_updated_at, eta_notified_at, eta_notified_for`
  );
  return rows.sort((left, right) => left.sequence - right.sequence);
}

async function setStopEta(driverUserId, tripId, stopId, minutes) {
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, driverUserId, tripId);
    if (trip.status !== 'in_progress') {
      throw new AppError(409, 'Start the trip before setting an arrival time.');
    }
    const stops = await loadLockedStops(client, tripId);
    const selected = stops.find(({ id }) => id === stopId);
    if (!selected) throw new AppError(404, 'Trip stop not found.');
    const groups = groupStops(stops);
    const group = groups.find(({ stops: members }) => members.some(({ id }) => id === stopId));
    const currentGroup = groups.find((candidate) => !allFinal(candidate));
    const activeMembers = group?.stops.filter(({ status }) => !FINAL_STOP_STATUSES.has(status)) ?? [];
    const isEnRoute = activeMembers.length > 0 && activeMembers.every(({ status }) => status === 'en_route');
    if (!currentGroup || currentGroup.id !== group?.id || !isEnRoute) {
      throw new AppError(409, 'An arrival time can only be set for the current stop while it is on the way.');
    }

    const now = Date.now();
    const notifyPassengers = shouldNotifyEta(activeMembers[0], minutes, now);
    const stopIds = group.stops.map(({ id }) => id);
    const updated = await client.query(
      `UPDATE trip_stops
       SET eta_at = now() + ($2 * interval '1 minute'),
           eta_updated_at = now(),
           eta_notified_at = CASE WHEN $3 THEN now() ELSE eta_notified_at END,
           eta_notified_for = CASE
             WHEN $3 THEN now() + ($2 * interval '1 minute')
             ELSE eta_notified_for
           END
       WHERE id = ANY($1::uuid[])
       RETURNING eta_at`,
      [stopIds, minutes, notifyPassengers]
    );
    const etaAt = updated.rows[0]?.eta_at ?? new Date(now + minutes * 60_000);
    await recordEvent(client, tripId, 'eta_set', driverUserId, group.id, null, { minutes });
    if (notifyPassengers) {
      await notificationService.notifyTripPassengers(client, tripId, 'driver_eta', {
        stopId: group.id,
        rideRequestIds: group.stops.map(({ ride_request_id: requestId }) => requestId),
        etaAt,
        idempotencySuffix: Math.floor(now / (5 * 60_000)),
      });
    }
    const current = await loadTrip(client, driverUserId, tripId);
    return current;
  });
}

async function addNextGroupOrComplete(client, trip, stops, driverUserId, clientTime) {
  const groups = groupStops(stops);
  const activeGroup = groups.find((group) => !allFinal(group));
  if (!activeGroup) {
    const completed = await client.query(
      `UPDATE trips SET status = 'completed', completed_at = COALESCE(completed_at, now())
       WHERE id = $1 AND status = 'in_progress'
       RETURNING id, status, completed_at`,
      [trip.id]
    );
    await client.query(
      `UPDATE ride_requests SET status = 'completed'
       WHERE trip_id = $1 AND status = 'assigned'`,
      [trip.id]
    );
    if (completed.rowCount === 1) {
      await recordEvent(client, trip.id, 'trip.completed', driverUserId, null, clientTime, {
        has_issues: trip.has_issues === true,
      });
      await recordAudit(client, driverUserId, trip.id, 'trip.completed', {
        has_issues: trip.has_issues === true,
      });
    }
    return;
  }
  const remaining = activeGroup.stops.filter(({ status }) => !FINAL_STOP_STATUSES.has(status));
  if (remaining.every(({ status }) => status === 'pending')) {
    const stopIds = remaining.map(({ id }) => id);
    await client.query(
      `UPDATE trip_stops SET status = 'en_route', en_route_at = COALESCE(en_route_at, now())
       WHERE id = ANY($1::uuid[])`,
      [stopIds]
    );
    await recordEvent(client, trip.id, 'stop_group.en_route', driverUserId, activeGroup.id, clientTime, {
      stop_ids: stopIds,
    });
  }
}

async function startTrip(driverUserId, tripId, clientTime) {
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, driverUserId, tripId);
    if (trip.status === 'in_progress') {
      return loadTrip(client, driverUserId, tripId);
    }
    if (trip.status !== 'accepted') {
      throw new AppError(409, 'This trip cannot be started in its current status.');
    }
    if (trip.change_ack_required) {
      throw new AppError(409, 'Confirm the trip changes before starting.');
    }
    const stops = await loadLockedStops(client, tripId);
    const firstStopAt = stops[0]?.planned_at ? Date.parse(stops[0].planned_at) : Date.parse(trip.starts_at);
    const startWindow = Number.parseInt(process.env.TRIP_START_WINDOW_MINUTES || '90', 10);
    const overdueGrace = Number(process.env.OVERDUE_GRACE_MINUTES ?? 30);
    const now = Date.now();
    const latestStartAt = Date.parse(trip.ends_at) + overdueGrace * 60_000;
    if (!Number.isFinite(firstStopAt) || !Number.isFinite(latestStartAt)) {
      throw new AppError(409, 'The first stop time is unavailable. Contact your dispatcher.');
    }
    if (now < firstStopAt - startWindow * 60_000) {
      throw new AppError(409, `This trip can be started ${startWindow} minutes before its first stop.`);
    }
    if (now > latestStartAt) {
      throw new AppError(409, 'This trip can no longer be started. Report that it did not happen.');
    }
    await client.query(
      `UPDATE trips SET status = 'in_progress', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'accepted'`,
      [tripId]
    );
    const firstGroup = groupStops(stops).find((candidate) => !allFinal(candidate));
    if (!firstGroup) throw new AppError(409, 'This trip has no stops to start.');
    const ids = firstGroup.stops.filter(({ status }) => status === 'pending').map(({ id }) => id);
    if (ids.length) {
      await client.query(
        `UPDATE trip_stops SET status = 'en_route', en_route_at = COALESCE(en_route_at, now())
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await recordEvent(client, tripId, 'stop_group.en_route', driverUserId, firstGroup.id, clientTime, {
        stop_ids: ids,
      });
    }
    await recordEvent(client, tripId, 'trip.started', driverUserId, null, clientTime, {
      first_stop_group_id: firstGroup.id,
    });
    await recordAudit(client, driverUserId, tripId, 'trip.started', {});
    if (firstGroup.stops[0].stop_type === 'pickup') {
      await notificationService.notifyTripPassengers(client, tripId, 'driver_on_the_way', {
        stopId: firstGroup.id,
        rideRequestIds: firstGroup.stops.map(({ ride_request_id: requestId }) => requestId),
      });
    }
    const current = await loadTrip(client, driverUserId, tripId);
    return current;
  });
}

async function updateStop(driverUserId, tripId, stopId, action, input = {}) {
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, driverUserId, tripId);
    const stops = await loadLockedStops(client, tripId);
    const selected = stops.find(({ id }) => id === stopId);
    if (!selected) throw new AppError(404, 'Trip stop not found.');
    if (trip.status !== 'in_progress') {
      const alreadyApplied = action === 'complete' && selected.status === 'completed'
        || action === 'arrive' && ['arrived', 'completed', 'skipped'].includes(selected.status)
        || action === 'skip' && selected.status === 'skipped' && selected.skip_kind === input.kind;
      if (alreadyApplied) {
        return loadTrip(client, driverUserId, tripId);
      }
      throw new AppError(409, 'Start the trip before updating its stops.');
    }
    const groups = groupStops(stops);
    const group = groups.find(({ stops: members }) => members.some(({ id }) => id === stopId));
    const currentGroup = groups.find((candidate) => !allFinal(candidate));
    if (!currentGroup || currentGroup.id !== group.id) {
      if (action === 'complete' && selected.status === 'completed'
        || action === 'arrive' && ['arrived', 'completed', 'skipped'].includes(selected.status)
        || action === 'skip' && selected.status === 'skipped' && selected.skip_kind === input.kind) {
        return loadTrip(client, driverUserId, tripId);
      }
      throw new AppError(409, 'Complete or skip the current stop group before continuing.');
    }
    const activeMembers = group.stops.filter(({ status }) => !FINAL_STOP_STATUSES.has(status));
    if (stops.slice(0, stops.findIndex(({ id }) => id === group.id))
      .some(({ status }) => !FINAL_STOP_STATUSES.has(status))) {
      throw new AppError(409, 'Complete or skip the previous stop before continuing.');
    }
    if (action === 'arrive') {
      if (activeMembers.every(({ status }) => status === 'arrived')) {
        return loadTrip(client, driverUserId, tripId);
      }
      if (activeMembers.some(({ status }) => !['en_route', 'arrived'].includes(status))) {
        throw new AppError(409, 'This stop group is not on the way yet.');
      }
      const ids = activeMembers.filter(({ status }) => status === 'en_route').map(({ id }) => id);
      await client.query(
        `UPDATE trip_stops
         SET status = 'arrived', arrived_at = COALESCE(arrived_at, now()),
             eta_at = NULL, eta_updated_at = NULL,
             eta_notified_at = NULL, eta_notified_for = NULL
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await recordEvent(client, tripId, 'stop_group.arrived', driverUserId, group.id, input.client_time, {
        stop_ids: ids,
      });
      await recordAudit(client, driverUserId, tripId, 'trip_stop_group.arrived', { stop_ids: ids });
      if (group.stops[0].stop_type === 'pickup') {
        await notificationService.notifyTripPassengers(client, tripId, 'driver_arrived', {
          stopId: group.id,
          rideRequestIds: group.stops.map(({ ride_request_id: requestId }) => requestId),
        });
      }
    } else if (action === 'complete') {
      const requestedIds = input.passenger_stop_ids ?? activeMembers
        .filter(({ status }) => status === 'arrived')
        .map(({ id }) => id);
      const requested = requestedIds.map((id) => group.stops.find((stop) => stop.id === id));
      if (!requested.length || requested.some((stop) => !stop)) {
        throw new AppError(400, 'Selected passenger stops must belong to the current stop group.');
      }
      if (requested.every((stop) => stop.status === 'completed')) {
        return loadTrip(client, driverUserId, tripId);
      }
      if (requested.some((stop) =>
        stop.stop_type !== selected.stop_type || !['arrived', 'completed'].includes(stop.status)
      )) {
        throw new AppError(409, 'Only arrived passengers in the current stop group can be completed.');
      }
      const ids = requested.filter(({ status }) => status === 'arrived').map(({ id }) => id);
      await client.query(
        `UPDATE trip_stops
         SET status = 'completed', completed_at = COALESCE(completed_at, now()),
             eta_at = NULL, eta_updated_at = NULL,
             eta_notified_at = NULL, eta_notified_for = NULL
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await recordEvent(client, tripId, 'stop_group.completed', driverUserId, group.id, input.client_time, {
        stop_ids: ids,
      });
      await recordAudit(client, driverUserId, tripId, 'trip_stop_group.completed', { stop_ids: ids });
    } else if (action === 'skip') {
      const kind = input.kind;
      if (!input.reason?.trim()) throw new AppError(400, 'A reason is required to skip a stop.');
      if (kind === 'no_show') {
        if (selected.stop_type !== 'pickup') {
          throw new AppError(400, 'Passenger not here can only be recorded at a pick-up.');
        }
        if (selected.status === 'skipped' && selected.skip_kind === kind) {
          return loadTrip(client, driverUserId, tripId);
        }
        if (selected.status !== 'arrived') {
          throw new AppError(409, 'The driver must arrive before recording a no-show.');
        }
        const requiredWait = Number(process.env.NO_SHOW_WAIT_MINUTES ?? 5) * 60;
        if (waitSeconds(selected.arrived_at) < requiredWait) {
          const minutesRemaining = Math.ceil((requiredWait - waitSeconds(selected.arrived_at)) / 60);
          throw new AppError(
            409,
            `Wait ${minutesRemaining} more minute${minutesRemaining === 1 ? '' : 's'} before recording a no-show.`
          );
        }
        const matchingDropoff = stops.find((stop) =>
          stop.ride_request_id === selected.ride_request_id && stop.stop_type === 'dropoff'
        );
        const skippedIds = [selected.id, matchingDropoff?.id].filter(Boolean);
        await client.query(
          `UPDATE trip_stops
           SET status = 'skipped', skip_kind = 'no_show', skip_reason = $2,
               completed_at = COALESCE(completed_at, now()),
               eta_at = NULL, eta_updated_at = NULL,
               eta_notified_at = NULL, eta_notified_for = NULL
           WHERE id = ANY($1::uuid[])`,
          [skippedIds, input.reason.trim()]
        );
        await client.query(
          `UPDATE ride_requests SET status = 'no_show'
           WHERE id = $1 AND trip_id = $2 AND status = 'assigned'`,
          [selected.ride_request_id, tripId]
        );
        await recordEvent(client, tripId, 'stop.no_show', driverUserId, selected.id, input.client_time, {
          dropoff_stop_id: matchingDropoff?.id ?? null,
          reason: input.reason.trim(),
        });
        await recordAudit(client, driverUserId, tripId, 'trip_stop.no_show', {
          stop_ids: skippedIds,
          reason: input.reason.trim(),
        });
        await notificationService.notifyTripPassengers(client, tripId, 'no_show_recorded', {
          stopId: selected.id,
          rideRequestId: selected.ride_request_id,
        });
      } else {
        if (!STOP_GROUP_SKIP_KINDS.has(kind) || selected.stop_type !== 'dropoff') {
          throw new AppError(400, 'This skip reason is only available for a drop-off.');
        }
        const pending = activeMembers.filter(({ status }) => status === 'arrived');
        if (pending.length === 0 || activeMembers.some(({ status }) => status !== 'arrived')) {
          throw new AppError(409, 'Arrive at the drop-off before recording an exception.');
        }
        const ids = pending.map(({ id }) => id);
        await client.query(
          `UPDATE trip_stops
           SET status = 'skipped', skip_kind = $2, skip_reason = $3,
               completed_at = COALESCE(completed_at, now()),
               eta_at = NULL, eta_updated_at = NULL,
               eta_notified_at = NULL, eta_notified_for = NULL
           WHERE id = ANY($1::uuid[])`,
          [ids, kind, input.reason.trim()]
        );
        await client.query('UPDATE trips SET has_issues = TRUE WHERE id = $1', [tripId]);
        await recordEvent(client, tripId, 'stop_group.exception', driverUserId, group.id, input.client_time, {
          stop_ids: ids,
          kind,
          reason: input.reason.trim(),
        });
        await recordAudit(client, driverUserId, tripId, 'trip_stop_group.exception', {
          stop_ids: ids,
          kind,
          reason: input.reason.trim(),
        });
      }
    } else {
      throw new AppError(400, 'Unsupported stop action.');
    }
    const updatedTrip = { ...trip };
    if (action === 'skip' && input.kind !== 'no_show') updatedTrip.has_issues = true;
    const refreshedStops = await loadLockedStops(client, tripId);
    await addNextGroupOrComplete(client, updatedTrip, refreshedStops, driverUserId, input.client_time);
    const finalStops = await loadLockedStops(client, tripId);
    const nextGroup = groupStops(finalStops).find((candidate) => !allFinal(candidate));
    if (nextGroup?.stops[0].stop_type === 'pickup'
      && nextGroup.stops[0].status === 'en_route') {
      await notificationService.notifyTripPassengers(client, tripId, 'driver_on_the_way', {
        stopId: nextGroup.id,
        rideRequestIds: nextGroup.stops.map(({ ride_request_id: requestId }) => requestId),
      });
    } else if (!nextGroup) {
      await notificationService.notifyTripPassengers(client, tripId, 'trip_completed');
    }
    const current = await loadTrip(client, driverUserId, tripId);
    return current;
  });
}

async function reportDelay(driverUserId, tripId, input) {
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, driverUserId, tripId);
    if (!['accepted', 'in_progress'].includes(trip.status)) {
      throw new AppError(409, 'A delay can only be reported for an upcoming or active trip.');
    }
    const current = await client.query(
      `SELECT delay_minutes FROM trips WHERE id = $1`,
      [tripId]
    );
    if (current.rows[0].delay_minutes === input.minutes) {
      return loadTrip(client, driverUserId, tripId);
    }
    await client.query(
      `UPDATE trips SET delay_minutes = $2, delay_reported_at = now() WHERE id = $1`,
      [tripId, input.minutes]
    );
    await recordEvent(client, tripId, 'trip.delay_reported', driverUserId, null, input.client_time, {
      minutes: input.minutes,
      note: input.note?.trim() || null,
    });
    await recordAudit(client, driverUserId, tripId, 'trip.delay_reported', {
      minutes: input.minutes,
      note: input.note?.trim() || null,
    });
    await notificationService.notifyTripPassengers(client, tripId, 'driver_running_late', {
      minutes: input.minutes,
    });
    return loadTrip(client, driverUserId, tripId);
  });
}

async function completeTrip(driverUserId, tripId) {
  return withTransaction(async (client) => {
    const trip = await loadLockedTrip(client, driverUserId, tripId);
    if (trip.status === 'completed') {
      return loadTrip(client, driverUserId, tripId);
    }
    throw new AppError(409, 'Trips complete automatically when all stops are finished.');
  });
}

module.exports = {
  completeTrip,
  getTrip: (driverUserId, tripId) => loadTrip(pool, driverUserId, tripId),
  reportDelay,
  setStopEta,
  startTrip,
  updateStop,
  etaIsFresh,
  shouldNotifyEta,
};
