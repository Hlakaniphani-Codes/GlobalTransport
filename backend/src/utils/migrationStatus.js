const fs = require('node:fs');
const path = require('node:path');

const DATABASE_PATH = path.join(__dirname, '..', '..', 'database');
const EXPECTED_MIGRATIONS = fs.readdirSync(DATABASE_PATH)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

function readinessQuery(timeoutMs = 400) {
  return {
    text: `SELECT 1 AS database_ready,
             NOT EXISTS (
               SELECT 1
               FROM unnest($1::text[]) expected(name)
               LEFT JOIN schema_migrations applied USING (name)
               WHERE applied.name IS NULL
             ) AS migrations_applied`,
    values: [EXPECTED_MIGRATIONS],
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  };
}

module.exports = { EXPECTED_MIGRATIONS, readinessQuery };
