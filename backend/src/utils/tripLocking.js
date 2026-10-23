async function lockSeriesAndTrips(client, seriesId) {
  const series = await client.query(
    `SELECT id FROM trip_series WHERE id = $1 FOR UPDATE`,
    [seriesId]
  );
  if (series.rowCount !== 1) return [];
  const trips = await client.query(
    `SELECT id FROM trips WHERE series_id = $1 ORDER BY id FOR UPDATE`,
    [seriesId]
  );
  return trips.rows.map(({ id }) => id);
}

async function lockTripSet(client, tripIds) {
  const ids = [...new Set(tripIds)].sort();
  if (ids.length === 0) return [];
  const candidates = await client.query(
    `SELECT id, series_id
     FROM trips
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [ids]
  );
  const seriesIds = [...new Set(
    candidates.rows.map(({ series_id: seriesId }) => seriesId).filter(Boolean)
  )].sort();
  if (seriesIds.length > 0) {
    await client.query(
      `SELECT id FROM trip_series
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [seriesIds]
    );
  }
  const locked = await client.query(
    `SELECT id, series_id
     FROM trips
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [ids]
  );
  const lockedSeriesIds = new Set(
    locked.rows.map(({ series_id: seriesId }) => seriesId).filter(Boolean)
  );
  if ([...lockedSeriesIds].some((seriesId) => !seriesIds.includes(seriesId))) {
    const error = new Error('Trip series changed while acquiring ordered row locks.');
    error.code = '40001';
    throw error;
  }
  return locked.rows.map(({ id }) => id);
}

async function lockTripSeries(client, tripId) {
  const trip = await client.query(
    `SELECT series_id FROM trips WHERE id = $1`,
    [tripId]
  );
  if (trip.rowCount !== 1) return { seriesId: null, tripIds: [] };
  const seriesId = trip.rows[0].series_id;
  if (!seriesId) {
    const standaloneTrip = await client.query(
      `SELECT id FROM trips WHERE id = $1 ORDER BY id FOR UPDATE`,
      [tripId]
    );
    return { seriesId: null, tripIds: standaloneTrip.rows.map(({ id }) => id) };
  }
  const tripIds = await lockSeriesAndTrips(client, seriesId);
  return { seriesId, tripIds };
}

async function lockStopsById(client, tripId, columns) {
  if (typeof columns !== 'string' || !/^[a-z_,\s]+$/.test(columns)) {
    throw new TypeError('Trip-stop lock columns must be a static SQL column list.');
  }
  const result = await client.query(
    `SELECT ${columns}
     FROM trip_stops
     WHERE trip_id = $1
     ORDER BY id
     FOR UPDATE`,
    [tripId]
  );
  return result.rows;
}

async function lockStopSet(client, tripIds, columns) {
  if (typeof columns !== 'string' || !/^[a-z_,\s]+$/.test(columns)) {
    throw new TypeError('Trip-stop lock columns must be a static SQL column list.');
  }
  const ids = [...new Set(tripIds)].sort();
  if (ids.length === 0) return [];
  const result = await client.query(
    `SELECT ${columns}
     FROM trip_stops
     WHERE trip_id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [ids]
  );
  return result.rows;
}

module.exports = {
  lockSeriesAndTrips,
  lockStopsById,
  lockStopSet,
  lockTripSeries,
  lockTripSet,
};
