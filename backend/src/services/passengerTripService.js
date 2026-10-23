const pool = require('../db');
const AppError = require('../utils/AppError');
const {
  decodeCursor,
  encodeCursor,
  normalizePagination,
  paginationMetadata,
} = require('../utils/pagination');
const { lockTripSeries } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

function stopAddressKey(stop) {
  return `${stop.address ?? ''} ${stop.suburb ?? ''}`
    .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function getStopsBeforeCounts(allStops, ownStops) {
  const groups = [];
  const groupIndexes = new Map();
  for (const stop of allStops) {
    const address = stopAddressKey(stop);
    const previous = groups.at(-1);
    if (previous && previous.stop_type === stop.stop_type && previous.address === address) {
      previous.stop_ids.add(stop.id);
    } else {
      groups.push({ stop_type: stop.stop_type, address, stop_ids: new Set([stop.id]) });
    }
    groupIndexes.set(stop.id, groups.length - 1);
  }
  const before = (stopType) => {
    const stop = ownStops.find((candidate) => candidate.stop_type === stopType);
    return stop ? groupIndexes.get(stop.id) ?? 0 : 0;
  };
  return {
    stops_before_pickup: before('pickup'),
    stops_before_dropoff: before('dropoff'),
  };
}

function buildPassengerEta(allStops, ownStops, now = Date.now()) {
  const groups = [];
  for (const stop of allStops) {
    const address = stopAddressKey(stop);
    const previous = groups.at(-1);
    if (previous && previous.stop_type === stop.stop_type && previous.address === address) {
      previous.stops.push(stop);
    } else {
      groups.push({ stop_type: stop.stop_type, address, stops: [stop] });
    }
  }
  const currentGroup = groups.find((group) =>
    group.stops.some(({ status }) => !['completed', 'skipped'].includes(status))
  );
  const activeStops = currentGroup?.stops.filter(({ status }) =>
    !['completed', 'skipped'].includes(status)
  ) ?? [];
  if (!currentGroup || activeStops.some(({ status }) => status !== 'en_route')) {
    return { ownStops, etaPhaseHint: null, etaUpdatedAt: null };
  }

  const currentStop = activeStops[0];
  const etaAt = currentStop.eta_at ? Date.parse(currentStop.eta_at) : Number.NaN;
  const etaUpdatedAt = currentStop.eta_updated_at
    ? Date.parse(currentStop.eta_updated_at)
    : Number.NaN;
  const etaFresh = Number.isFinite(etaAt)
    && Number.isFinite(etaUpdatedAt)
    && now - etaUpdatedAt <= Number(process.env.ETA_STALE_MINUTES ?? 15) * 60_000;
  const etaIsLate = Number.isFinite(etaAt) && now - etaAt > 5 * 60_000;
  const plannedAt = Date.parse(currentStop.planned_at);
  const projectedOffset = etaFresh && Number.isFinite(plannedAt)
    ? Math.max(0, etaAt - plannedAt)
    : null;
  const currentStopIds = new Set(currentGroup.stops.map(({ id }) => id));
  const lastCurrentSequence = Math.max(...currentGroup.stops.map(({ sequence }) => sequence));
  const enrichedOwnStops = ownStops.map((stop) => {
    const passengerStop = { ...stop };
    delete passengerStop.eta_at;
    delete passengerStop.eta_updated_at;
    delete passengerStop.eta_phase_hint;
    if (stop.stop_type === 'pickup' && currentStopIds.has(stop.id)) {
      return {
        ...passengerStop,
        eta_at: etaFresh && !etaIsLate ? currentStop.eta_at : null,
        eta_updated_at: etaFresh ? currentStop.eta_updated_at : null,
        eta_phase_hint: etaIsLate ? 'little_late' : etaFresh ? 'arriving_at' : 'on_the_way',
      };
    }
    const stopPlannedAt = Date.parse(stop.planned_at);
    return {
      ...passengerStop,
      projected_at: stop.sequence > lastCurrentSequence
        && projectedOffset !== null
        && Number.isFinite(stopPlannedAt)
        ? new Date(stopPlannedAt + projectedOffset).toISOString()
        : null,
    };
  });
  const ownCurrentPickup = ownStops.some((stop) =>
    stop.stop_type === 'pickup' && currentStopIds.has(stop.id)
  );
  const etaPhaseHint = ownCurrentPickup
    ? etaIsLate ? 'little_late' : etaFresh ? 'arriving_at' : 'on_the_way'
    : null;
  return {
    ownStops: enrichedOwnStops,
    etaPhaseHint,
    etaUpdatedAt: ownCurrentPickup && etaFresh ? currentStop.eta_updated_at : null,
  };
}

function getPhase(trip, requestStatus, stops) {
  if (['no_show', 'missed'].includes(requestStatus)
    || trip.status === 'missed'
    || stops.some((stop) => stop.skip_kind === 'no_show')) return 'missed';
  if (trip.status === 'completed'
    || stops.some((stop) => stop.stop_type === 'dropoff' && stop.status === 'completed')) {
    return 'completed';
  }
  const pickup = stops.find((stop) => stop.stop_type === 'pickup');
  if (pickup?.status === 'completed') return 'on_board';
  if (pickup?.status === 'arrived') return 'driver_arrived';
  if (trip.status === 'in_progress' || pickup?.status === 'en_route') return 'driver_on_the_way';
  return 'scheduled';
}

async function queryMine(passengerUserId, scope, cursor, pageSize, page = 1, includePagination = false) {
  const history = scope === 'history';
  const pagination = normalizePagination({ page, page_size: pageSize });
  const decoded = history ? decodeCursor(cursor) : null;
  const statusCondition = history
    ? `t.status IN ('completed','cancelled','missed')`
    : `(t.status = 'in_progress' OR (
        t.status = 'accepted'
        AND COALESCE((
          SELECT first_stop.planned_at
          FROM trip_stops first_stop
          WHERE first_stop.trip_id = t.id
          ORDER BY first_stop.sequence
          LIMIT 1
        ), t.starts_at, t.scheduled_at) >= now()
      )) AND r.status = 'assigned'`;
  const values = [passengerUserId];
  const count = !history && includePagination
    ? await pool.query(
      `SELECT count(*)::int AS total
       FROM trips t
       JOIN ride_requests r ON r.trip_id = t.id AND r.passenger_user_id = $1
       WHERE ${statusCondition}`,
      [passengerUserId]
    )
    : null;
  const currentPage = count
    ? paginationMetadata(count.rows[0].total, pagination).page
    : pagination.page;
  let cursorCondition = '';
  if (decoded) {
    values.push(decoded.sort_at, decoded.id);
    cursorCondition = `AND (COALESCE(t.starts_at, t.scheduled_at), t.id)
      < ($2::timestamptz, $3::uuid)`;
  }
  values.push(pagination.page_size + (history ? 1 : 0));
  const limitParameter = `$${values.length}`;
  const offsetClause = !history && includePagination
    ? `OFFSET $${values.push((currentPage - 1) * pagination.page_size)}`
    : '';
  const result = await pool.query(
    `SELECT t.id, r.id AS ride_request_id, r.status AS ride_request_status,
            t.direction, t.scheduled_at, t.starts_at, t.completed_at, t.ends_at,
           t.rescheduled_at,
           t.workplace_name, t.workplace_address, t.distance_km, t.status,
            t.has_issues, t.delay_minutes,
            split_part(trim(driver.name), ' ', 1) AS driver_first_name,
            vehicle.make AS vehicle_make, vehicle.colour AS vehicle_colour,
            vehicle.registration_number AS vehicle_plate,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', stop.id,
                'sequence', stop.sequence,
                'stop_type', stop.stop_type,
                'address', stop.address,
                'suburb', stop.suburb,
                'planned_at', stop.planned_at + (t.delay_minutes * interval '1 minute'),
                'status', stop.status,
                'arrived_at', stop.arrived_at,
                'completed_at', stop.completed_at,
                'skip_kind', stop.skip_kind
              ) ORDER BY stop.sequence)
              FROM trip_stops stop
              WHERE stop.trip_id = t.id AND stop.passenger_user_id = $1
            ), '[]'::json) AS own_stops,
            (SELECT count(DISTINCT stop.ride_request_id)::int
             FROM trip_stops stop
             WHERE stop.trip_id = t.id AND stop.passenger_user_id = $1
               AND stop.stop_type = 'pickup' AND stop.status = 'completed')
              AS passengers_picked_up,
            (SELECT count(DISTINCT stop.ride_request_id)::int
             FROM trip_stops stop
             WHERE stop.trip_id = t.id AND stop.passenger_user_id = $1
               AND stop.stop_type = 'dropoff' AND stop.status = 'completed')
              AS passengers_dropped_off,
            CASE WHEN r.status = 'no_show' THEN 1 ELSE 0 END AS no_shows,
            (SELECT count(*)::int
             FROM trip_stops stop
             WHERE stop.trip_id = t.id AND stop.passenger_user_id = $1
               AND stop.stop_type = 'dropoff' AND stop.status = 'skipped'
               AND stop.skip_kind IN ('unreachable','address_problem','passenger_declined','other'))
              AS exceptions,
            EXISTS (
              SELECT 1 FROM trip_ratings rating
              WHERE rating.trip_id = t.id AND rating.passenger_user_id = $1
            ) AS has_rated
     FROM trips t
     JOIN ride_requests r ON r.trip_id = t.id AND r.passenger_user_id = $1
     LEFT JOIN users driver ON driver.id = t.driver_user_id
     LEFT JOIN vehicles vehicle ON vehicle.id = t.vehicle_id
     WHERE ${statusCondition} ${cursorCondition}
     ORDER BY COALESCE(t.starts_at, t.scheduled_at) ${history ? 'DESC' : 'ASC'}, t.id ${history ? 'DESC' : 'ASC'}
     LIMIT ${limitParameter} ${offsetClause}`,
    values
  );
  const hasMore = history && result.rows.length > pagination.page_size;
  const trips = hasMore ? result.rows.slice(0, pagination.page_size) : result.rows;
  const lastTrip = trips.at(-1);
  return {
    trips,
    next_cursor: hasMore && lastTrip
      ? encodeCursor(lastTrip.starts_at ?? lastTrip.scheduled_at, lastTrip.id)
      : null,
    ...(count ? {
      pagination: paginationMetadata(count.rows[0].total, {
        ...pagination,
        page: currentPage,
      }),
    } : {}),
  };
}

async function listMine(passengerUserId, scope = 'upcoming') {
  const result = await queryMine(passengerUserId, scope, undefined, 100);
  return result.trips;
}

async function listHistoryPage(passengerUserId, cursor, pageSize = 25) {
  const pagination = normalizePagination({ page_size: pageSize });
  return queryMine(passengerUserId, 'history', cursor, pagination.page_size);
}

async function listUpcomingPage(passengerUserId, input = {}) {
  const pagination = normalizePagination(input);
  return queryMine(
    passengerUserId,
    'upcoming',
    undefined,
    pagination.page_size,
    pagination.page,
    true
  );
}

async function getMine(passengerUserId, tripId) {
  const result = await pool.query(
    `SELECT t.id, r.id AS ride_request_id, r.status AS ride_request_status,
            t.series_id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
            t.workplace_name, t.workplace_address, t.distance_km, t.notes,
            t.status, t.started_at, t.completed_at, t.delay_minutes,
            t.rescheduled_at,
            split_part(trim(driver.name), ' ', 1) AS driver_first_name,
            CASE
              WHEN t.status IN ('accepted','in_progress')
               AND now() >= COALESCE((
                 SELECT first_stop.planned_at
                 FROM trip_stops first_stop
                 WHERE first_stop.trip_id = t.id
                 ORDER BY first_stop.sequence
                 LIMIT 1
               ), t.starts_at) - interval '90 minutes'
               AND now() <= COALESCE(t.ends_at, t.completed_at, t.scheduled_at)
              THEN driver.contact_number
              ELSE NULL
            END AS driver_contact_number,
            vehicle.make AS vehicle_make, vehicle.colour AS vehicle_colour,
            vehicle.registration_number AS vehicle_plate,
            (SELECT pickup.planned_at
             FROM trip_stops pickup
             WHERE pickup.trip_id = t.id AND pickup.passenger_user_id = $1
               AND pickup.stop_type = 'pickup'
             ORDER BY pickup.sequence
             LIMIT 1) AS original_pickup_at,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', stop.id,
                'ride_request_id', stop.ride_request_id,
                'sequence', stop.sequence,
                'stop_type', stop.stop_type,
                'address', stop.address,
                'suburb', stop.suburb,
                'planned_at', stop.planned_at + (t.delay_minutes * interval '1 minute'),
                'status', stop.status,
                'arrived_at', stop.arrived_at,
                'completed_at', stop.completed_at,
                'skip_kind', stop.skip_kind
              ) ORDER BY stop.sequence)
              FROM trip_stops stop
              WHERE stop.trip_id = t.id AND stop.passenger_user_id = $1
            ), '[]'::json) AS own_stops,
            EXISTS (
              SELECT 1 FROM trip_ratings rating
              WHERE rating.trip_id = t.id AND rating.passenger_user_id = $1
            ) AS has_rated,
            (SELECT rating.rating
             FROM trip_ratings rating
             WHERE rating.trip_id = t.id AND rating.passenger_user_id = $1
             LIMIT 1) AS rating
     FROM trips t
     JOIN ride_requests r ON r.trip_id = t.id AND r.passenger_user_id = $1
     LEFT JOIN users driver ON driver.id = t.driver_user_id
     LEFT JOIN vehicles vehicle ON vehicle.id = t.vehicle_id
     WHERE t.id = $2 AND t.status IN ('accepted','in_progress','completed','cancelled','missed')
       AND r.status <> 'cancelled'
       AND EXISTS (
         SELECT 1 FROM trip_stops own_stop
         WHERE own_stop.trip_id = t.id AND own_stop.passenger_user_id = $1
       )`,
    [passengerUserId, tripId]
  );
  if (result.rowCount !== 1) {
    throw new AppError(404, 'Trip not found.');
  }

  const trip = result.rows[0];
  const allStopsResult = await pool.query(
    `SELECT id, sequence, stop_type, address, suburb, planned_at, status,
            eta_at, eta_updated_at
     FROM trip_stops WHERE trip_id = $1 ORDER BY sequence`,
    [tripId]
  );
  const ownStops = trip.own_stops ?? [];
  const adjustedAllStops = allStopsResult.rows.map((stop) => ({
    ...stop,
    planned_at: stop.planned_at
      ? new Date(Date.parse(stop.planned_at) + trip.delay_minutes * 60_000).toISOString()
      : null,
  }));
  const counts = getStopsBeforeCounts(adjustedAllStops, ownStops);
  const eta = trip.status === 'in_progress'
    ? buildPassengerEta(adjustedAllStops, ownStops)
    : { ownStops, etaPhaseHint: null, etaUpdatedAt: null };
  const lateHours = Number.parseFloat(process.env.LATE_CANCELLATION_HOURS || '2');
  const pickupAt = trip.original_pickup_at
    ? Date.parse(trip.original_pickup_at)
    : Number.NaN;
  const cancelMayBeLate = Number.isFinite(pickupAt)
    && (pickupAt - Date.now()) / 3_600_000 < lateHours;
  const rescheduledAt = trip.rescheduled_at ? Date.parse(trip.rescheduled_at) : Number.NaN;
  const changeCancelExemptHours = Number(process.env.CHANGE_CANCEL_EXEMPT_HOURS ?? 24);
  const withinRescheduleExemption = Number.isFinite(rescheduledAt)
    && Date.now() >= rescheduledAt
    && Date.now() <= rescheduledAt + changeCancelExemptHours * 3_600_000;
  return {
    ...trip,
    ...counts,
    own_stops: eta.ownStops,
    eta_phase_hint: eta.etaPhaseHint,
    eta_updated_at: eta.etaUpdatedAt,
    phase: getPhase(trip, trip.ride_request_status, ownStops),
    cancel_may_be_late: cancelMayBeLate && !withinRescheduleExemption,
    can_cancel: ['accepted'].includes(trip.status) && !trip.started_at,
  };
}

async function rateMine(passengerUserId, tripId, input) {
  return withTransaction(async (client) => {
    const { tripIds } = await lockTripSeries(client, tripId);
    if (!tripIds.includes(tripId)) throw new AppError(404, 'Trip not found.');
    const tripResult = await client.query(
      `SELECT t.id, t.driver_user_id, t.status,
              EXISTS (
                SELECT 1 FROM trip_stops pickup
                WHERE pickup.trip_id = t.id AND pickup.passenger_user_id = $2
                  AND pickup.stop_type = 'pickup' AND pickup.status = 'completed'
              ) AS passenger_was_picked_up
       FROM trips t
       WHERE t.id = $1
         AND EXISTS (
           SELECT 1 FROM trip_stops own_stop
           WHERE own_stop.trip_id = t.id AND own_stop.passenger_user_id = $2
         )
       FOR UPDATE`,
      [tripId, passengerUserId]
    );
    if (tripResult.rowCount !== 1) throw new AppError(404, 'Trip not found.');
    const trip = tripResult.rows[0];
    if (trip.status !== 'completed' || !trip.driver_user_id) {
      throw new AppError(409, 'Only completed trips can be rated.');
    }
    if (!trip.passenger_was_picked_up) {
      throw new AppError(409, 'You must have been picked up to rate the trip.');
    }
    const ratingResult = await client.query(
      `INSERT INTO trip_ratings
         (trip_id, passenger_user_id, driver_user_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trip_id, passenger_user_id) DO NOTHING
       RETURNING id, rating, comment, created_at`,
      [tripId, passengerUserId, trip.driver_user_id, input.rating, input.comment ?? null]
    );
    if (ratingResult.rowCount !== 1) {
      throw new AppError(409, 'You have already rated this trip.');
    }
    return ratingResult.rows[0];
  });
}

module.exports = {
  buildPassengerEta,
  getMine,
  listHistoryPage,
  listMine,
  listUpcomingPage,
  rateMine,
};
