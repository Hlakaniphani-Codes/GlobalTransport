const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/db');
const logger = require('../src/utils/logger');

async function migrate() {
  let client;
  try {
    const databasePath = path.join(__dirname, '..', 'database');
    const schema = await fs.readFile(path.join(databasePath, 'schema.sql'), 'utf8');
    const migrations = (await fs.readdir(databasePath))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(schema);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    for (const migration of migrations) {
      const recorded = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [migration]
      );
      if (recorded.rowCount > 0) continue;
      const sql = await fs.readFile(path.join(databasePath, migration), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration]);
      logger.info(`Applied database migration ${migration}.`);
    }
    await client.query('COMMIT');
    logger.info('Database schema is up to date.');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be closed after a database failure.
      }
    }
    logger.error('Database migration failed.', error.code || error.name || 'UNKNOWN_ERROR');
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}

migrate();
