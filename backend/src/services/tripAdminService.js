const { createHash, randomUUID } = require('node:crypto');
const pool = require('../db');
const AppError = require('../utils/AppError');
const offersService = require('./offers');
const notificationService = require('./notifications');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');
const { lockStopsById, lockTripSeries } = require('../utils/tripLocking');
const withTransaction = require('../utils/withTransaction');

function localDateTime(date, time) {
  return `${date}T${time}:00+02:00`;
}

function normalizeStopAddress(address, suburb) {
  return `${address ?? ''} ${suburb ?? ''}`
    .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function addEtaMetrics(stop, now = Date.now()) {
  const etaAt = stop.eta_at ? Date.parse(stop.eta_at) : Number.NaN;
  const updatedAt = stop.eta_updated_at ? Date.parse(stop.eta_updated_at) : Number.NaN;
  const plannedAt = stop.planned_at ? Date.parse(stop.planned_at) : Number.NaN;
  return {
    ...stop,
    eta_age_minutes: Number.isFinite(updatedAt)
      ? Math.max(0, Math.floor((now - updatedAt) / 60_000))
      : null,
    eta_minutes_late: Number.isFinite(etaAt) && Number.isFinite(plannedAt)
      ? Math.max(0, Math.ceil((etaAt - plannedAt) / 60_000))
      : null,
    eta_is_late: Number.isFinite(etaAt) && Number.isFinite(plannedAt)
      && etaAt - plannedAt > 10 * 60_000,
  };
}

async function lockTripSeriesAndSelect(client, tripId, columns) {
  const { tripIds } = await lockTripSeries(client, tripId);
  if (!tripIds.includes(tripId)) throw new AppError(404, 'Trip not found.');
  return client.query(
    `SELECT ${columns} FROM trips WHERE id = $1 FOR UPDATE`,
    [tripId]
  );
}

async function createTrips(adminId, input) {
  return withTransaction(async (client) => {
    const requestIds = [...new Set(input.stops.map(({ ride_request_id }) => ride_request_id))];
    const baseResult = await client.query(
      `SELECT r.id, r.passenger_user_id, r.workplace_id, r.direction, r.scheduled_at,
              p.address, p.home_suburb, p.workplace_suburb,
              COALESCE(p.workplace, w.name) AS workplace_name,
              COALESCE(p.workplace_address, w.address, p.workplace, w.name) AS workplace_address
       FROM ride_requests r
       JOIN passengers p ON p.user_id = r.passenger_user_id
       JOIN workplaces w ON w.id = r.workplace_id
       WHERE r.id = ANY($1::uuid[]) AND r.status = 'pending' AND r.trip_id IS NULL
         AND r.direction = $2
       FOR UPDATE OF r`,
      [requestIds, input.direction]
    );
    if (baseResult.rowCount !== requestIds.length) {
      throw new AppError(409, 'One or more ride requests are no longer available.');
    }
    const baseById = new Map(baseResult.rows.map((request) => [request.id, request]));
    for (const stop of input.stops) {
      if (!baseById.has(stop.ride_request_id)) {
        throw new AppError(400, 'Every stop must belong to a selected ride request.');
      }
    }
    const orderByRequest = new Map();
    for (const stop of input.stops) {
      const order = orderByRequest.get(stop.ride_request_id) ?? {};
      order[stop.stop_type] = stop.sequence;
      orderByRequest.set(stop.ride_request_id, order);
    }
    if ([...orderByRequest.values()].some(({ pickup, dropoff }) => pickup >= dropoff)) {
      throw new AppError(400, 'Each passenger pick-up must come before their drop-off.');
    }
    const timesByRequest = new Map();
    for (const stop of input.stops) {
      const times = timesByRequest.get(stop.ride_request_id) ?? {};
      times[stop.stop_type] = stop.planned_time;
      timesByRequest.set(stop.ride_request_id, times);
    }
    if ([...timesByRequest.values()].some(({ pickup, dropoff }) => pickup >= dropoff)) {
      throw new AppError(400, 'Each passenger pick-up time must be before their drop-off time.');
    }
    for (let index = 1; index < input.stops.length; index += 1) {
      const previous = input.stops[index - 1];
      const current = input.stops[index];
      if (previous.stop_type !== current.stop_type) continue;
      const getAddress = (stop) => {
        const request = baseById.get(stop.ride_request_id);
        const isHome = (input.direction === 'to_work' && stop.stop_type === 'pickup')
          || (input.direction === 'home' && stop.stop_type === 'dropoff');
        return isHome
          ? normalizeStopAddress(request.address, request.home_suburb)
          : normalizeStopAddress(request.workplace_address, request.workplace_suburb);
      };
      if (getAddress(previous) === getAddress(current)
        && previous.planned_time !== current.planned_time) {
        throw new AppError(400, 'Passengers in the same stop group must share a planned time.');
      }
    }
    if (input.stops.some((stop, index) =>
      index > 0 && input.stops[index - 1].planned_time > stop.planned_time
    )) {
      throw new AppError(400, 'Stop times must follow the stop order.');
    }

    const seriesId = randomUUID();
    await client.query(
      `INSERT INTO trip_series (id, created_by) VALUES ($1, $2)`,
      [seriesId, adminId]
    );
    const skippedDates = [];
    const createdTrips = [];
    for (const date of input.dates) {
      const matches = await client.query(
        `SELECT r.id, r.passenger_user_id, r.workplace_id
         FROM ride_requests r
         WHERE r.passenger_user_id = ANY($1::uuid[])
           AND r.direction = $2 AND r.status = 'pending' AND r.trip_id IS NULL
           AND r.scheduled_at >= ($3::date::timestamp AT TIME ZONE 'Africa/Johannesburg')
           AND r.scheduled_at < (($3::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
         ORDER BY r.passenger_user_id, r.workplace_id,
                  CASE WHEN r.id = ANY($4::uuid[]) THEN 0 ELSE 1 END,
                  r.created_at, r.id
         FOR UPDATE`,
        [
          [...new Set(baseResult.rows.map(({ passenger_user_id }) => passenger_user_id))],
          input.direction,
          date,
          requestIds,
        ]
      );
      const pairKey = (passengerId, workplaceId) => `${passengerId}:${workplaceId}`;
      const requiredPairs = new Set(baseResult.rows.map((request) =>
        pairKey(request.passenger_user_id, request.workplace_id)
      ));
      const matchByPassengerAndWorkplace = new Map();
      for (const row of matches.rows) {
        const key = pairKey(row.passenger_user_id, row.workplace_id);
        if (!requiredPairs.has(key)) continue;
        const existingMatch = matchByPassengerAndWorkplace.get(key);
        if (!existingMatch || requestIds.includes(row.id)) {
          matchByPassengerAndWorkplace.set(key, row.id);
        }
      }
      if (matchByPassengerAndWorkplace.size !== requiredPairs.size) {
        skippedDates.push({
          date,
          reason: 'A selected passenger has no matching pending request for the selected workplace.',
        });
        continue;
      }

      const idMap = new Map(baseResult.rows.map((request) => [
        request.id,
        matchByPassengerAndWorkplace.get(pairKey(
          request.passenger_user_id,
          request.workplace_id
        )),
      ]));
      const stops = input.stops.map((stop) => ({
        ...stop,
        ride_request_id: idMap.get(stop.ride_request_id),
      }));
      const firstStopAt = localDateTime(date, stops[0].planned_time);
      const targetAt = input.direction === 'to_work'
        ? localDateTime(date, input.target_time)
        : firstStopAt;
      for (const stop of input.stops) {
        if (input.direction === 'to_work'
          && stop.stop_type === 'dropoff'
          && stop.planned_time !== input.target_time) {
          throw new AppError(400, 'Workplace stops must be scheduled at the target time.');
        }
        if (input.direction === 'to_work'
          && stop.stop_type === 'pickup'
          && stop.planned_time >= input.target_time) {
          throw new AppError(400, 'Every pick-up must be before the workplace target time.');
        }
      }
      if (input.stops.some((stop, index) =>
        index > 0 && input.stops[index - 1].planned_time > stop.planned_time
      )) {
        throw new AppError(400, 'Stop times must follow the stop order.');
      }
      const plannedTimes = stops.map(({ planned_time: time }) => Date.parse(localDateTime(date, time)));
      const latestStopMs = Math.max(...plannedTimes);
      const endsAt = new Date(latestStopMs).toISOString();
      const tripId = randomUUID();
      await client.query(
        `INSERT INTO trips
           (id, series_id, direction, scheduled_at, starts_at, ends_at,
            workplace_name, workplace_address, distance_km, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)`,
        [
          tripId,
          seriesId,
          input.direction,
          targetAt,
          firstStopAt,
          endsAt,
          input.workplace_name,
          input.workplace_address,
          input.distance_km ?? null,
          input.notes ?? null,
          adminId,
        ]
      );

      for (const stop of stops) {
        const request = baseResult.rows.find((row) =>
          idMap.get(row.id) === stop.ride_request_id
        );
        const atWork = input.direction === 'to_work'
          ? stop.stop_type === 'dropoff'
          : stop.stop_type === 'pickup';
        const address = atWork ? request.workplace_address : request.address;
        const suburb = atWork ? request.workplace_suburb : request.home_suburb;
        await client.query(
          `INSERT INTO trip_stops
             (trip_id, ride_request_id, passenger_user_id, stop_order, sequence,
              stop_type, address, suburb, planned_at)
           VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
          [
            tripId,
            stop.ride_request_id,
            request.passenger_user_id,
            stop.sequence,
            stop.stop_type,
            address,
            suburb,
            localDateTime(date, stop.planned_time),
          ]
        );
        await client.query(
          `UPDATE ride_requests SET status = 'assigned', trip_id = $1
           WHERE id = $2 AND status = 'pending'`,
          [tripId, stop.ride_request_id]
        );
      }
      createdTrips.push({ id: tripId, series_id: seriesId, date, status: 'draft' });
    }
    if (createdTrips.length === 0) {
      throw new AppError(
        409,
        'No trips could be created. Each selected passenger needs a pending request for the selected workplace on at least one selected date.'
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip_series.created', 'trip_series', $2, $3)`,
      [adminId, seriesId, { trip_ids: createdTrips.map(({ id }) => id) }]
    );
    return { series_id: seriesId, trips: createdTrips, skipped_dates: skippedDates };
  });
}

async function previewTripDates(input) {
  const selected = await pool.query(
    `SELECT id, passenger_user_id, workplace_id
     FROM ride_requests
     WHERE id = ANY($1::uuid[]) AND direction = $2
       AND status = 'pending' AND trip_id IS NULL`,
    [input.request_ids, input.direction]
  );
  if (selected.rowCount !== input.request_ids.length) {
    throw new AppError(409, 'One or more selected ride requests are no longer available. Refresh the requests and try again.');
  }

  const passengerIds = [...new Set(selected.rows.map(({ passenger_user_id }) => passenger_user_id))];
  const workplaceIds = [...new Set(selected.rows.map(({ workplace_id }) => workplace_id))];
  const requiredPairs = new Set(selected.rows.map(({ passenger_user_id, workplace_id }) =>
    `${passenger_user_id}:${workplace_id}`
  ));
  const selectedRequestIdByPair = new Map(selected.rows.map((request) => [
    `${request.passenger_user_id}:${request.workplace_id}`,
    request.id,
  ]));
  const dateBounds = [...input.dates].sort();
  const candidates = await pool.query(
    `SELECT r.passenger_user_id, r.workplace_id,
            (r.scheduled_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS local_date
     FROM ride_requests r
     WHERE r.passenger_user_id = ANY($1::uuid[])
       AND r.workplace_id = ANY($2::uuid[])
       AND r.direction = $3 AND r.status = 'pending' AND r.trip_id IS NULL
       AND r.scheduled_at >= ($4::date::timestamp AT TIME ZONE 'Africa/Johannesburg')
       AND r.scheduled_at < (($5::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
       AND (r.scheduled_at AT TIME ZONE 'Africa/Johannesburg')::date = ANY($6::date[])`,
    [passengerIds, workplaceIds, input.direction, dateBounds[0], dateBounds.at(-1), input.dates]
  );
  const availablePairsByDate = new Map(input.dates.map((date) => [date, new Set()]));
  for (const candidate of candidates.rows) {
    const pair = `${candidate.passenger_user_id}:${candidate.workplace_id}`;
    if (requiredPairs.has(pair)) {
      availablePairsByDate.get(candidate.local_date)?.add(pair);
    }
  }

  return {
    dates: input.dates.map((date) => {
      const matchedPairs = availablePairsByDate.get(date)?.size ?? 0;
      return {
        date,
        available: matchedPairs === requiredPairs.size,
        matched_request_groups: matchedPairs,
        required_request_groups: requiredPairs.size,
        missing_request_groups: requiredPairs.size - matchedPairs,
        missing_request_ids: [...requiredPairs]
          .filter((pair) => !availablePairsByDate.get(date)?.has(pair))
          .map((pair) => selectedRequestIdByPair.get(pair)),
      };
    }),
  };
}

async function listTrips(filters) {
  const pagination = normalizePagination(filters);
  const conditions = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.status) add('t.status = ?', filters.status);
  if (filters.direction) add('t.direction = ?', filters.direction);
  if (filters.driver_id) add('t.driver_user_id = ?', filters.driver_id);
  if (filters.from) add(`t.scheduled_at >= (?::date::timestamp AT TIME ZONE 'Africa/Johannesburg')`, filters.from);
  if (filters.to) add(`t.scheduled_at < ((?::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')`, filters.to);
  if (filters.search) {
    values.push(`${filters.search.trim().replace(/[\\%_]/g, '\\$&').toLowerCase()}%`);
    const parameter = `$${values.length}`;
    conditions.push(`(
      t.id::text LIKE ${parameter}
      OR lower(t.workplace_name) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(u.name || ' ' || u.surname) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(v.registration_number) LIKE ${parameter} ESCAPE E'\\\\'
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await pool.query(
    `SELECT count(*)::int AS total
     FROM trips t
     LEFT JOIN users u ON u.id = t.driver_user_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     ${where}`,
    values
  );
  const total = count.rows[0].total;
  const page = paginationMetadata(total, pagination).page;
  const result = await pool.query(
    `SELECT t.id, t.series_id, t.direction, t.scheduled_at, t.starts_at,
            t.ends_at, t.status, t.workplace_name, t.distance_km,
            u.name AS driver_name, u.surname AS driver_surname,
            v.registration_number,
            (SELECT count(DISTINCT stop.ride_request_id)::int
             FROM trip_stops stop WHERE stop.trip_id = t.id) AS passenger_count
     FROM trips t
     LEFT JOIN users u ON u.id = t.driver_user_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     ${where}
     ORDER BY t.scheduled_at DESC, t.id
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pagination.page_size, (page - 1) * pagination.page_size]
  );
  return {
    trips: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page }),
  };
}

async function listLiveTrips(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query("SELECT count(*)::int AS total FROM trips t WHERE t.status = 'in_progress'"),
    pool.query(
    `SELECT t.id, t.direction, t.scheduled_at, t.started_at, t.workplace_name,
            t.delay_minutes, t.has_issues,
            driver.name AS driver_name, driver.surname AS driver_surname,
            vehicle.registration_number,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', stop.id,
                'sequence', stop.sequence,
                'ride_request_id', stop.ride_request_id,
                'stop_type', stop.stop_type,
                'address', stop.address,
                'suburb', stop.suburb,
                'status', stop.status,
                'planned_at', stop.planned_at,
                'eta_at', stop.eta_at,
                'eta_updated_at', stop.eta_updated_at
              ) ORDER BY stop.sequence)
              FROM trip_stops stop
              WHERE stop.trip_id = t.id AND stop.status IN ('en_route','arrived')
            ), '[]'::json) AS active_stops,
            (SELECT count(DISTINCT request.id)::int
             FROM ride_requests request
             WHERE request.trip_id = t.id AND request.status = 'no_show') AS no_shows,
            (SELECT count(DISTINCT stop.ride_request_id)::int
             FROM trip_stops stop
             WHERE stop.trip_id = t.id AND stop.stop_type = 'dropoff'
               AND stop.status = 'skipped'
               AND stop.skip_kind IN ('unreachable','address_problem','passenger_declined','other'))
              AS exceptions,
            (SELECT count(*)::int
             FROM incidents incident
             WHERE incident.trip_id = t.id AND incident.status <> 'resolved')
              AS open_incidents,
            COALESCE((
              SELECT max(event.created_at)
              FROM trip_events event WHERE event.trip_id = t.id
            ), t.started_at, t.scheduled_at) AS last_update_at
     FROM trips t
     LEFT JOIN users driver ON driver.id = t.driver_user_id
     LEFT JOIN vehicles vehicle ON vehicle.id = t.vehicle_id
     WHERE t.status = 'in_progress'
     ORDER BY t.started_at, t.id
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);

  return {
    trips: result.rows.map((trip) => {
    const activeStops = trip.active_stops ?? [];
    const first = activeStops[0];
    const liveTrip = { ...trip };
    delete liveTrip.active_stops;
    if (!first) return { ...liveTrip, current_stop_group: null };

    const key = `${first.stop_type}:${normalizeStopAddress(first.address, first.suburb)}`;
    const groupStops = [];
    for (const stop of activeStops) {
      if (`${stop.stop_type}:${normalizeStopAddress(stop.address, stop.suburb)}` !== key) break;
      groupStops.push(stop);
    }
    const etaStop = groupStops.find(({ eta_at }) => eta_at) ?? first;
    const etaMetrics = addEtaMetrics(etaStop);
    return {
      ...liveTrip,
      current_stop_group: {
        sequence: first.sequence,
        stop_type: first.stop_type,
        address: first.address,
        suburb: first.suburb,
        status: groupStops.every(({ status }) => status === 'arrived') ? 'arrived' : 'en_route',
        passenger_count: new Set(groupStops.map(({ ride_request_id }) => ride_request_id)).size,
        eta_at: etaStop.eta_at ?? null,
        eta_updated_at: etaStop.eta_updated_at ?? null,
        eta_age_minutes: etaMetrics.eta_age_minutes,
        eta_minutes_late: etaMetrics.eta_minutes_late,
        eta_is_late: etaMetrics.eta_is_late,
      },
    };
    }),
    pagination: paginationMetadata(count.rows[0].total, pagination),
  };
}

async function getTrip(tripId) {
  const result = await pool.query(
    `SELECT t.id, t.series_id, t.direction, t.scheduled_at, t.starts_at, t.ends_at,
            t.status, t.workplace_name, t.workplace_address, t.distance_km, t.notes,
            t.has_issues, t.delay_minutes, t.started_at, t.completed_at,
            t.original_scheduled_at, t.rescheduled_at, t.closed_reason,
            t.closed_at, t.closed_by, t.change_ack_required,
            t.change_acknowledged_at,
            driver.name AS driver_name, driver.surname AS driver_surname,
            driver.contact_number AS driver_contact_number,
            v.make AS vehicle_make, v.model AS vehicle_model,
            v.registration_number, v.seat_count
     FROM trips t
     LEFT JOIN users driver ON driver.id = t.driver_user_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.id = $1`,
    [tripId]
  );
  if (result.rowCount !== 1) throw new AppError(404, 'Trip not found.');
  const trip = result.rows[0];
  const [stops, passengers, offers, events, ratings, withdrawals] = await Promise.all([
    pool.query(
      `SELECT s.id, s.sequence, s.stop_type, s.address, s.suburb,
              s.planned_at, s.status, s.arrived_at, s.completed_at,
              s.skip_kind, s.skip_reason, s.eta_at, s.eta_updated_at,
              s.eta_notified_at, s.eta_notified_for,
              u.id AS passenger_user_id, u.name AS passenger_name,
              u.surname AS passenger_surname, u.contact_number,
              r.id AS ride_request_id, r.booking_source, r.created_at AS booked_at,
              r.cancelled_by, r.cancelled_at, r.cancel_reason, r.cancelled_late,
              booked.name AS booked_by_name, booked.surname AS booked_by_surname,
              cancelled.name AS cancelled_by_name, cancelled.surname AS cancelled_by_surname
       FROM trip_stops s
       JOIN ride_requests r ON r.id = s.ride_request_id
       JOIN users u ON u.id = s.passenger_user_id
       LEFT JOIN users booked ON booked.id = r.booked_by
       LEFT JOIN users cancelled ON cancelled.id = r.cancelled_by
       WHERE s.trip_id = $1 ORDER BY s.sequence`,
      [tripId]
    ),
    pool.query(
      `SELECT r.id AS ride_request_id, r.passenger_user_id,
              u.name AS passenger_name, u.surname AS passenger_surname,
              u.contact_number, p.employee_number,
              r.booking_source, r.created_at AS booked_at,
              booked.id AS booked_by, booked.name AS booked_by_name,
              booked.surname AS booked_by_surname,
              r.status AS request_status, r.cancelled_by, r.cancelled_at,
              r.cancel_reason, r.cancelled_late,
              cancelled.name AS cancelled_by_name,
              cancelled.surname AS cancelled_by_surname,
              max(s.address) FILTER (WHERE s.stop_type = 'pickup') AS pickup_address,
              max(s.suburb) FILTER (WHERE s.stop_type = 'pickup') AS pickup_suburb,
              max(s.planned_at) FILTER (WHERE s.stop_type = 'pickup') AS pickup_planned_at,
              max(s.status) FILTER (WHERE s.stop_type = 'pickup') AS pickup_status,
              max(s.address) FILTER (WHERE s.stop_type = 'dropoff') AS dropoff_address,
              max(s.suburb) FILTER (WHERE s.stop_type = 'dropoff') AS dropoff_suburb,
              max(s.planned_at) FILTER (WHERE s.stop_type = 'dropoff') AS dropoff_planned_at,
              max(s.status) FILTER (WHERE s.stop_type = 'dropoff') AS dropoff_status
       FROM trip_stops s
       JOIN ride_requests r ON r.id = s.ride_request_id
       JOIN passengers p ON p.user_id = r.passenger_user_id
       JOIN users u ON u.id = r.passenger_user_id
       LEFT JOIN users booked ON booked.id = r.booked_by
       LEFT JOIN users cancelled ON cancelled.id = r.cancelled_by
       WHERE s.trip_id = $1
       GROUP BY r.id, r.passenger_user_id, u.name, u.surname, u.contact_number,
                p.employee_number, r.booking_source, r.created_at, booked.id,
                booked.name, booked.surname, r.status, r.cancelled_by,
                r.cancelled_at, r.cancel_reason, r.cancelled_late,
                cancelled.name, cancelled.surname
       ORDER BY u.surname, u.name`,
      [tripId]
    ),
    offersService.listForSeries(trip.series_id),
    pool.query(
      `SELECT id, stop_id, event_type, actor_user_id, actor_role,
              client_time, metadata, created_at
       FROM trip_events WHERE trip_id = $1 ORDER BY created_at, id`,
      [tripId]
    ),
    pool.query(
      `SELECT rating.id, rating.passenger_user_id, rating.rating,
              rating.comment, rating.created_at,
              passenger.name AS passenger_name, passenger.surname AS passenger_surname
       FROM trip_ratings rating
       JOIN users passenger ON passenger.id = rating.passenger_user_id
       WHERE rating.trip_id = $1 ORDER BY rating.created_at, rating.id`,
      [tripId]
    ),
    pool.query(
      `SELECT withdrawal.id, withdrawal.driver_user_id, withdrawal.reason_kind,
              withdrawal.note, withdrawal.scope, withdrawal.late, withdrawal.created_at,
              driver.name AS driver_name, driver.surname AS driver_surname
       FROM trip_withdrawals withdrawal
       JOIN users driver ON driver.id = withdrawal.driver_user_id
       WHERE withdrawal.trip_id = $1
       ORDER BY withdrawal.created_at DESC, withdrawal.id`,
      [tripId]
    ),
  ]);
  return {
    ...trip,
    stops: stops.rows.map((stop) => addEtaMetrics(stop)),
    passengers: passengers.rows,
    offers,
    events: events.rows,
    ratings: ratings.rows,
    withdrawals: withdrawals.rows,
  };
}

async function forceComplete(tripId, adminId, { reason, release_remaining: releaseRemaining }) {
  return withTransaction(async (client) => {
    const tripResult = await lockTripSeriesAndSelect(client, tripId, 'id, status');
    if (tripResult.rowCount !== 1) throw new AppError(404, 'Trip not found.');
    if (tripResult.rows[0].status !== 'in_progress') {
      throw new AppError(409, 'Only an in-progress trip can be force-completed.');
    }
    await lockStopsById(client, tripId, 'id');
    const requests = await client.query(
      `SELECT r.id, r.status,
              bool_or(s.stop_type = 'dropoff' AND s.status = 'completed') AS dropped_off
       FROM ride_requests r
       JOIN trip_stops s ON s.ride_request_id = r.id AND s.trip_id = $1
       GROUP BY r.id`,
      [tripId]
    );
    await client.query(
      `UPDATE trip_stops
       SET status = 'skipped', skip_kind = 'other',
           skip_reason = $2, completed_at = COALESCE(completed_at, now())
       WHERE trip_id = $1 AND status NOT IN ('completed','skipped')`,
      [tripId, reason]
    );
    for (const request of requests.rows) {
      if (request.status !== 'assigned') continue;
      if (releaseRemaining && !request.dropped_off) {
        await client.query(
          `UPDATE ride_requests SET status = 'pending', trip_id = NULL
           WHERE id = $1 AND status = 'assigned'`,
          [request.id]
        );
      } else {
        await client.query(
          `UPDATE ride_requests SET status = 'completed'
           WHERE id = $1 AND status = 'assigned'`,
          [request.id]
        );
      }
    }
    const updated = await client.query(
      `UPDATE trips
       SET status = 'completed', completed_at = now(), has_issues = TRUE
       WHERE id = $1
       RETURNING id, status, completed_at, has_issues`,
      [tripId]
    );
    await client.query(
      `INSERT INTO trip_events
         (trip_id, event_type, actor_user_id, actor_role, metadata)
       VALUES ($1, 'trip.force_completed', $2, 'admin', $3)`,
      [tripId, adminId, { reason, release_remaining: releaseRemaining }]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.force_completed', 'trip', $2, $3)`,
      [adminId, tripId, { reason, release_remaining: releaseRemaining }]
    );
    return updated.rows[0];
  });
}

async function cancelTrip(tripId, adminId, reason) {
  return withTransaction(async (client) => {
    const result = await lockTripSeriesAndSelect(
      client,
      tripId,
      'id, series_id, status, driver_user_id'
    );
    const trip = result.rows[0];
    if (!trip) throw new AppError(404, 'Trip not found.');
    await lockStopsById(client, tripId, 'id');
    if (['cancelled', 'completed'].includes(trip.status)) {
      throw new AppError(409, 'This trip can no longer be cancelled.');
    }
    if (trip.status === 'in_progress') {
      throw new AppError(
        409,
        'This trip is already in progress. Force-complete it with a reason and choose whether to release passengers who have not been dropped off.'
      );
    }
    if (trip.driver_user_id && trip.status === 'accepted') {
      await notificationService.notifyTripPassengers(client, tripId, 'trip_cancelled');
      await notificationService.notifyDriverTrip(
        client,
        trip.driver_user_id,
        tripId,
        'trip_cancelled',
        'Trip assignment changed',
        'A trip assignment has changed. Check the app for the latest details.'
      );
    }
    const offeredSiblings = await client.query(
      `SELECT count(*)::int AS count FROM trips
       WHERE series_id = $1 AND id <> $2 AND status = 'offered'`,
      [trip.series_id, tripId]
    );
    if (offeredSiblings.rows[0].count === 0) {
      await client.query(
        `UPDATE trip_offers SET status = 'cancelled', responded_at = now()
         WHERE series_id = $1 AND status IN ('pending','queued')`,
        [trip.series_id]
      );
    }
    await client.query(
      `UPDATE ride_requests SET status = 'pending', trip_id = NULL
       WHERE trip_id = $1 AND status = 'assigned'`,
      [tripId]
    );
    await client.query(
      `UPDATE trip_stops SET status = 'skipped', skip_kind = 'cancelled',
         skip_reason = $2, completed_at = COALESCE(completed_at, now())
       WHERE trip_id = $1 AND status IN ('pending','arrived')`,
      [tripId, reason]
    );
    const updated = await client.query(
      `UPDATE trips SET status = 'cancelled', driver_user_id = NULL, vehicle_id = NULL,
         cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
       WHERE id = $1 RETURNING id, series_id, status, cancelled_at, cancelled_by, cancel_reason`,
      [tripId, adminId, reason]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.cancelled', 'trip', $2, $3)`,
      [adminId, tripId, { reason, series_id: trip.series_id }]
    );
    return updated.rows[0];
  });
}

async function removePassenger(tripId, adminId, input) {
  return withTransaction(async (client) => {
    const tripResult = await lockTripSeriesAndSelect(
      client,
      tripId,
      'id, status, driver_user_id'
    );
    if (!tripResult.rows[0]) throw new AppError(404, 'Trip not found.');
    await lockStopsById(client, tripId, 'id');
    if (!['draft', 'offered', 'accepted', 'in_progress', 'unassigned'].includes(tripResult.rows[0].status)) {
      throw new AppError(409, 'A passenger cannot be removed from this trip.');
    }
    const request = await client.query(
      `SELECT r.id, r.passenger_user_id, r.status,
              coalesce(pickup.planned_at, r.scheduled_at) AS pickup_at
       FROM ride_requests r
       JOIN trip_stops pickup ON pickup.trip_id = $1
         AND pickup.ride_request_id = r.id AND pickup.stop_type = 'pickup'
       WHERE r.id = $2 AND r.trip_id = $1
       FOR UPDATE OF r`,
      [tripId, input.ride_request_id]
    );
    if (request.rowCount !== 1) throw new AppError(404, 'Passenger request not found on this trip.');
    if (request.rows[0].status === 'cancelled') {
      return {
        trip_id: tripId,
        ride_request_id: input.ride_request_id,
        cancelled_late: request.rows[0].cancelled_late,
      };
    }
    if (request.rows[0].status !== 'assigned') {
      throw new AppError(409, 'Only an assigned passenger can be removed from this trip.');
    }

    if (tripResult.rows[0].driver_user_id
      && ['accepted', 'in_progress'].includes(tripResult.rows[0].status)) {
      await notificationService.notifyTripPassengers(client, tripId, 'request_cancelled', {
        rideRequestId: input.ride_request_id,
      });
    }
    const lateHours = Number.parseFloat(process.env.LATE_CANCELLATION_HOURS || '2');
    const late = (Date.parse(request.rows[0].pickup_at) - Date.now()) / 3_600_000 < lateHours;
    await client.query(
      `UPDATE trip_stops SET status = 'skipped', skip_kind = 'cancelled',
         skip_reason = $3, completed_at = COALESCE(completed_at, now())
       WHERE trip_id = $1 AND ride_request_id = $2 AND status IN ('pending','arrived')`,
      [tripId, input.ride_request_id, input.reason]
    );
    await client.query(
      `UPDATE ride_requests
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
           cancel_reason = $3, cancelled_late = $4
       WHERE id = $1`,
      [input.ride_request_id, adminId, input.reason, late]
    );
    const remaining = await client.query(
      `SELECT count(DISTINCT ride_request_id)::int AS count
       FROM trip_stops WHERE trip_id = $1 AND status <> 'skipped'`,
      [tripId]
    );
    if (tripResult.rows[0].status === 'accepted') {
      if (remaining.rows[0].count > 0) {
        await client.query(
          `UPDATE trips
           SET change_ack_required = TRUE, change_acknowledged_at = NULL
           WHERE id = $1 AND status = 'accepted'`,
          [tripId]
        );
      }
      await client.query(
        `INSERT INTO trip_events (trip_id, event_type, actor_user_id, actor_role, metadata)
         VALUES ($1, 'trip.admin_edited', $2, 'admin', $3)`,
        [tripId, adminId, { changed_fields: ['passengers'], ride_request_id: input.ride_request_id }]
      );
      await notificationService.notify(tripResult.rows[0].driver_user_id, {
        type: 'trip_changed',
        title: 'Trip changed',
        body: 'Your trip passenger list changed. Please confirm the latest details in the app.',
        data: { screen: 'driver', trip_id: tripId },
        channels: ['push'],
        idempotencyKey: `trip_changed:driver:${tripId}:passenger:${input.ride_request_id}`,
      }, client);
    }
    if (remaining.rows[0].count === 0) {
      await client.query(
        `UPDATE trips SET status = 'cancelled', cancelled_at = now(),
           cancelled_by = $2, cancel_reason = 'All passengers were removed.'
         WHERE id = $1`,
        [tripId, adminId]
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.passenger_removed', 'trip', $2, $3)`,
      [adminId, tripId, {
        ride_request_id: input.ride_request_id,
        reason: input.reason,
        kind: input.kind,
        cancelled_late: late,
      }]
    );
    return { trip_id: tripId, ride_request_id: input.ride_request_id, cancelled_late: late };
  });
}

async function reassignTrip(tripId, adminId) {
  return withTransaction(async (client) => {
    const tripResult = await lockTripSeriesAndSelect(
      client,
      tripId,
      'id, series_id, driver_user_id, status'
    );
    const trip = tripResult.rows[0];
    if (!trip) throw new AppError(404, 'Trip not found.');
    if (!['accepted', 'offered', 'unassigned'].includes(trip.status)) {
      throw new AppError(409, 'This trip cannot be reassigned in its current status.');
    }
    if (trip.status === 'accepted' && trip.driver_user_id) {
      await notificationService.notifyDriverTrip(
        client,
        trip.driver_user_id,
        tripId,
        'trip_changed',
        'Trip assignment changed',
        'A trip assignment has changed. Check the app for the latest details.'
      );
    }
    const newSeriesId = randomUUID();
    await client.query(
      `INSERT INTO trip_series (id, created_by) VALUES ($1, $2)`,
      [newSeriesId, adminId]
    );
    await client.query(
      `UPDATE trip_offers
       SET trip_id = sibling.id
       FROM LATERAL (
         SELECT id FROM trips
         WHERE series_id = $2 AND id <> $1
         ORDER BY scheduled_at LIMIT 1
       ) sibling
       WHERE trip_offers.series_id = $2 AND trip_offers.trip_id = $1`,
      [tripId, trip.series_id]
    );
    const updated = await client.query(
      `UPDATE trips
       SET series_id = $1, status = 'draft', driver_user_id = NULL,
           vehicle_id = NULL
       WHERE id = $2
       RETURNING id, series_id, status, driver_user_id, vehicle_id`,
      [newSeriesId, tripId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'trip.reassigned', 'trip', $2, $3)`,
      [adminId, tripId, {
        previous_series_id: trip.series_id,
        series_id: newSeriesId,
        previous_driver_user_id: trip.driver_user_id,
      }]
    );
    return updated.rows[0];
  });
}

async function updateTrip(tripId, adminId, input) {
  await withTransaction(async (client) => {
    const result = await lockTripSeriesAndSelect(
      client,
      tripId,
      `id, series_id, status, direction, scheduled_at, starts_at, ends_at,
       driver_user_id, workplace_name, workplace_address, distance_km, notes,
       change_ack_required`
    );
    const trip = result.rows[0];
    if (!trip) throw new AppError(404, 'Trip not found.');
    if (!['draft', 'unassigned', 'accepted'].includes(trip.status)) {
      throw new AppError(409, 'Only draft, unassigned, or accepted trips can be edited.');
    }
    const firstEditedStop = input.stops?.find(({ sequence }) => sequence === 1);
    const scheduledAt = trip.direction === 'home' && firstEditedStop
      ? firstEditedStop.planned_at
      : input.scheduled_at ?? trip.scheduled_at;
    const scheduleChanged = Date.parse(scheduledAt) !== Date.parse(trip.scheduled_at);
    const changedFields = Object.keys(input).filter((field) => {
      if (field === 'stops') return false;
      if (field === 'scheduled_at') return scheduleChanged;
      return input[field] !== trip[field];
    });
    let stopChanged = false;
    let stopEdits = input.stops;
    if (input.stops || scheduleChanged) {
      const existing = {
        rows: await lockStopsById(
          client,
          tripId,
          'id, ride_request_id, stop_type, sequence, address, suburb, planned_at'
        ),
      };
      existing.rows.sort((left, right) => left.sequence - right.sequence);
      if (input.stops && (input.stops.length !== existing.rowCount
        || new Set(input.stops.map(({ id }) => id)).size !== existing.rowCount
        || input.stops.some(({ id }) => !existing.rows.some((stop) => stop.id === id))
        || input.stops.some((stop, index) => stop.sequence !== index + 1))) {
        throw new AppError(400, 'Update every trip stop exactly once in a continuous order.');
      }
      stopEdits = input.stops ?? existing.rows.map((stop) => ({
        id: stop.id,
        sequence: stop.sequence,
        planned_at: new Date(
          Date.parse(stop.planned_at)
            + Date.parse(scheduledAt) - Date.parse(trip.scheduled_at)
        ).toISOString(),
      }));
      const orderedEdits = [...stopEdits].sort((left, right) => left.sequence - right.sequence);
      if (orderedEdits.some((stop, index) => stop.sequence !== index + 1)) {
        throw new AppError(400, 'Update every trip stop exactly once in a continuous order.');
      }
      if (orderedEdits.some((stop, index) =>
        index > 0 && Date.parse(orderedEdits[index - 1].planned_at) > Date.parse(stop.planned_at)
      )) {
        throw new AppError(400, 'Stop times must follow the stop order.');
      }
      const stopById = new Map(existing.rows.map((stop) => [stop.id, stop]));
      for (let index = 1; index < orderedEdits.length; index += 1) {
        const previous = orderedEdits[index - 1];
        const current = orderedEdits[index];
        const previousStop = stopById.get(previous.id);
        const currentStop = stopById.get(current.id);
        if (previousStop.stop_type === currentStop.stop_type
          && normalizeStopAddress(previousStop.address, previousStop.suburb)
            === normalizeStopAddress(currentStop.address, currentStop.suburb)
          && Date.parse(previous.planned_at) !== Date.parse(current.planned_at)) {
          throw new AppError(400, 'Passengers in the same stop group must share a planned time.');
        }
      }
      const pickupSequence = new Map();
      const pickupTime = new Map();
      for (const item of orderedEdits) {
        const stop = stopById.get(item.id);
        const isWorkplaceStop = trip.direction === 'to_work' && stop.stop_type === 'dropoff';
        if (isWorkplaceStop && Date.parse(item.planned_at) !== Date.parse(scheduledAt)) {
          throw new AppError(400, 'Workplace stops must be scheduled at the target time.');
        }
        if (trip.direction === 'to_work'
          && stop.stop_type === 'pickup'
          && Date.parse(item.planned_at) >= Date.parse(scheduledAt)) {
          throw new AppError(400, 'Every pick-up must be before the workplace target time.');
        }
        if (stop.stop_type === 'pickup') {
          pickupSequence.set(stop.ride_request_id, item.sequence);
          pickupTime.set(stop.ride_request_id, Date.parse(item.planned_at));
        }
        if (stop.stop_type === 'dropoff') {
          const pickup = pickupSequence.get(stop.ride_request_id);
          if (pickup === undefined || pickup >= item.sequence) {
            throw new AppError(400, 'Each passenger pick-up must come before their drop-off.');
          }
          if (pickupTime.get(stop.ride_request_id) >= Date.parse(item.planned_at)) {
            throw new AppError(400, 'Each passenger pick-up time must be before their drop-off time.');
          }
        }
      }
      stopChanged = orderedEdits.some((item) => {
        const previous = stopById.get(item.id);
        return previous.sequence !== item.sequence
          || Date.parse(previous.planned_at) !== Date.parse(item.planned_at);
      });
      stopEdits = orderedEdits;
    }
    if (scheduleChanged) {
      await client.query(
        `UPDATE trips
         SET original_scheduled_at = COALESCE(original_scheduled_at, scheduled_at),
             rescheduled_at = now()
         WHERE id = $1`,
        [tripId]
      );
    }
    if (scheduleChanged && Date.parse(scheduledAt) < Date.parse(trip.scheduled_at)) {
      await client.query(
        `UPDATE trips
         SET scheduled_at = $2::timestamptz
         WHERE id = $1`,
        [tripId, scheduledAt]
      );
    }
    if (stopChanged) {
      await client.query(
        `UPDATE trip_stops
         SET sequence = sequence + 1000, stop_order = stop_order + 1000
         WHERE trip_id = $1`,
        [tripId]
      );
    }
    if (stopChanged || (scheduleChanged && stopEdits?.length)) {
      const edits = [...stopEdits].sort((left, right) =>
        Date.parse(right.planned_at) - Date.parse(left.planned_at)
      );
      for (const item of edits) {
        await client.query(
          `UPDATE trip_stops
           SET sequence = $1, stop_order = $1, planned_at = $2
           WHERE id = $3`,
          [item.sequence, item.planned_at, item.id]
        );
      }
    }
    if (scheduleChanged && Date.parse(scheduledAt) > Date.parse(trip.scheduled_at)) {
      await client.query(
        `UPDATE trips
         SET scheduled_at = $2::timestamptz
         WHERE id = $1`,
        [tripId, scheduledAt]
      );
    }
    const values = [];
    const assignments = [];
    for (const field of ['workplace_name', 'workplace_address', 'distance_km', 'notes']) {
      if (input[field] === undefined) continue;
      if (input[field] === trip[field]) continue;
      values.push(input[field]);
      assignments.push(`${field} = $${values.length}`);
    }
    if (assignments.length) {
      values.push(tripId);
      await client.query(
        `UPDATE trips SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $${values.length}`,
        values
      );
    }
    if (scheduleChanged) {
      await client.query(
        `UPDATE ride_requests SET scheduled_at = $2::timestamptz
         WHERE trip_id = $1 AND status = 'assigned'`,
        [tripId, scheduledAt]
      );
    }
    if (stopChanged || scheduleChanged) {
      await client.query(
        `UPDATE trips
         SET starts_at = (SELECT planned_at FROM trip_stops
                          WHERE trip_id = $1 ORDER BY sequence LIMIT 1),
             ends_at = COALESCE(
               (SELECT max(planned_at) FROM trip_stops WHERE trip_id = $1),
               scheduled_at
             )
         WHERE id = $1`,
        [tripId]
      );
    }
    if (trip.status === 'accepted' && (changedFields.length > 0 || stopChanged)) {
      await client.query(
        `UPDATE trips
         SET change_ack_required = TRUE, change_acknowledged_at = NULL
         WHERE id = $1`,
        [tripId]
      );
    }
    if (changedFields.length > 0 || stopChanged) {
      const metadata = {
        changed_fields: [...changedFields, ...(stopChanged ? ['stops'] : [])],
        series_id: trip.series_id,
      };
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'trip.updated', 'trip', $2, $3)`,
        [adminId, tripId, metadata]
      );
      if (trip.status === 'accepted' && trip.driver_user_id) {
        const changeKey = createHash('sha256')
          .update(JSON.stringify({ changed_fields: metadata.changed_fields, input }))
          .digest('hex');
        await client.query(
          `INSERT INTO trip_events (trip_id, event_type, actor_user_id, actor_role, metadata)
           VALUES ($1, 'trip.admin_edited', $2, 'admin', $3)`,
          [tripId, adminId, metadata]
        );
        await notificationService.notify(trip.driver_user_id, {
          type: 'trip_changed',
          title: 'Trip changed',
          body: scheduleChanged
            ? `Trip changed: new time ${new Intl.DateTimeFormat('en-ZA', {
              dateStyle: 'medium',
              timeStyle: 'short',
              hourCycle: 'h23',
              timeZone: 'Africa/Johannesburg',
            }).format(new Date(scheduledAt))}. Please confirm.`
            : 'Your trip has changed. Please confirm the latest details in the app.',
          data: { screen: 'driver', trip_id: tripId },
          channels: ['push'],
          idempotencyKey: `trip_changed:driver:${tripId}:${changeKey}`,
        }, client);
        await notificationService.notifyTripPassengers(client, tripId, 'trip_changed', {
          idempotencySuffix: changeKey,
        });
      }
    }
  });
  return getTrip(tripId);
}

module.exports = {
  cancelTrip,
  createTrips,
  forceComplete,
  getTrip,
  listLiveTrips,
  previewTripDates,
  listTrips,
  reassignTrip,
  removePassenger,
  updateTrip,
};
