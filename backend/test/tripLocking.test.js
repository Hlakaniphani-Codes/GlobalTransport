const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  lockSeriesAndTrips,
  lockStopsById,
  lockTripSeries,
  lockTripSet,
} = require('../src/utils/tripLocking');

test('trip-series lock acquisition follows series, trip ID, then offer order', async () => {
  const statements = [];
  const client = {
    query: async (query) => {
      statements.push(query);
      if (query.includes('SELECT series_id FROM trips')) {
        return { rowCount: 1, rows: [{ series_id: 'series-id' }] };
      }
      if (query.includes('FROM trip_series')) {
        return { rowCount: 1, rows: [{ id: 'series-id' }] };
      }
      if (query.includes('FROM trips')) {
        return { rowCount: 2, rows: [{ id: 'trip-a' }, { id: 'trip-b' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const locked = await lockTripSeries(client, 'trip-a');
  await client.query('SELECT id FROM trip_offers WHERE series_id = $1 FOR UPDATE', ['series-id']);

  assert.deepEqual(locked, { seriesId: 'series-id', tripIds: ['trip-a', 'trip-b'] });
  assert.match(statements[1], /FROM trip_series[\s\S]*FOR UPDATE/);
  assert.match(statements[2], /FROM trips[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
  assert.match(statements[3], /FROM trip_offers[\s\S]*FOR UPDATE/);
});

test('series lock helper handles a missing series without locking trips', async () => {
  const statements = [];
  const client = {
    query: async (query) => {
      statements.push(query);
      return { rowCount: 0, rows: [] };
    },
  };

  assert.deepEqual(await lockSeriesAndTrips(client, 'missing-series'), []);
  assert.equal(statements.length, 1);
});

test('trip-stop row locks are acquired in ascending ID order', async () => {
  let statement;
  const client = {
    query: async (query) => {
      statement = query;
      return { rowCount: 0, rows: [] };
    },
  };

  await lockStopsById(client, 'trip-id', 'id, sequence');
  assert.match(statement, /FROM trip_stops[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
  await assert.rejects(
    lockStopsById(client, 'trip-id', 'id; DELETE FROM trips'),
    /static SQL column list/
  );
});

test('multi-trip locking sorts series before all trip rows and rejects moved rows', async () => {
  const statements = [];
  const client = {
    query: async (query) => {
      statements.push(query);
      if (query.includes('FROM trips') && query.includes('ORDER BY id') && !query.includes('FOR UPDATE')) {
        return {
          rowCount: 2,
          rows: [
            { id: 'trip-a', series_id: 'series-b' },
            { id: 'trip-b', series_id: 'series-a' },
          ],
        };
      }
      if (query.includes('FROM trips') && query.includes('FOR UPDATE')) {
        return {
          rowCount: 2,
          rows: [
            { id: 'trip-a', series_id: 'series-b' },
            { id: 'trip-b', series_id: 'series-a' },
          ],
        };
      }
      return { rowCount: 2, rows: [{ id: 'series-a' }, { id: 'series-b' }] };
    },
  };

  assert.deepEqual(await lockTripSet(client, ['trip-b', 'trip-a']), ['trip-a', 'trip-b']);
  assert.match(statements[1], /FROM trip_series[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
  assert.match(statements[2], /FROM trips[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
});
