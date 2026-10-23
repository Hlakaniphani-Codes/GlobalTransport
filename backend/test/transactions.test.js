const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/db');
const withTransaction = require('../src/utils/withTransaction');

test('withTransaction retries deadlocks and releases every client', async () => {
  const originalConnect = pool.connect;
  const calls = [];
  let attempt = 0;
  pool.connect = async () => {
    attempt += 1;
    return {
      query: async (statement) => {
        calls.push({ attempt, statement });
        if (statement === 'UPDATE trips' && attempt === 1) {
          throw Object.assign(new Error('deadlock'), { code: '40P01' });
        }
        return { rows: [] };
      },
      release: () => calls.push({ attempt, released: true }),
    };
  };

  try {
    const result = await withTransaction(
      (client) => client.query('UPDATE trips'),
      { retries: 1 }
    );
    assert.deepEqual(result, { rows: [] });
    assert.equal(attempt, 2);
    assert.equal(calls.filter(({ statement }) => statement === 'BEGIN').length, 2);
    assert.equal(calls.filter(({ statement }) => statement === 'ROLLBACK').length, 1);
    assert.equal(calls.filter(({ statement }) => statement === 'COMMIT').length, 1);
    assert.equal(calls.filter(({ released }) => released).length, 2);
  } finally {
    pool.connect = originalConnect;
  }
});

test('withTransaction does not retry non-serialization failures', async () => {
  const originalConnect = pool.connect;
  let attempts = 0;
  let releases = 0;
  pool.connect = async () => {
    attempts += 1;
    return {
      query: async (statement) => {
        if (statement === 'INSERT') {
          throw Object.assign(new Error('unique violation'), { code: '23505' });
        }
        return { rows: [] };
      },
      release: () => { releases += 1; },
    };
  };

  try {
    await assert.rejects(
      withTransaction((client) => client.query('INSERT'), { retries: 3 }),
      (error) => error.code === '23505'
    );
    assert.equal(attempts, 1);
    assert.equal(releases, 1);
  } finally {
    pool.connect = originalConnect;
  }
});
