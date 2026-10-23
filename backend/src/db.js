const { Pool } = require('pg');
const { loadDatabaseConfig } = require('./config');
const logger = require('./utils/logger');
const requestContext = require('./middleware/requestContext');
const metrics = require('./utils/metrics');

const wrappedClient = Symbol('slow-query-instrumented');
const config = loadDatabaseConfig();
const slowQueryMs = Number(process.env.SLOW_QUERY_MS ?? 200);

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  min: config.databasePoolMin,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  connectionTimeoutMillis: config.databaseConnectTimeoutMs,
  statement_timeout: config.statementTimeoutMs,
  idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
  ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (error) => {
  logger.error('Unexpected error on an idle PostgreSQL connection.', {
    code: error.code ?? 'UNKNOWN_ERROR',
  });
});

function normalizeStatement(statement) {
  return String(statement ?? '')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function logSlowQuery(statement, startedAt) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (durationMs < slowQueryMs) return;
  const context = requestContext.storage.getStore();
  const request = context?.request;
  const route = request?.route?.path
    ? `${request.baseUrl}${request.route.path}`
    : request ? 'unmatched' : 'background';
  metrics.observeQueryDuration(durationMs, route);
  logger.warn('Slow database query.', {
    request_id: context?.requestId,
    route,
    duration_ms: durationMs,
    statement: normalizeStatement(statement),
  });
}

function instrumentQuery(queryFn, args, statement) {
  const startedAt = process.hrtime.bigint();
  const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex];
    args[callbackIndex] = (...callbackArgs) => {
      logSlowQuery(statement, startedAt);
      callback(...callbackArgs);
    };
    return queryFn(...args);
  }
  const result = queryFn(...args);
  if (result && typeof result.then === 'function') {
    result.then(
      () => logSlowQuery(statement, startedAt),
      () => logSlowQuery(statement, startedAt)
    ).catch((error) => logger.error('Slow-query instrumentation failed.', {
      code: error.code ?? error.name ?? 'UNKNOWN_ERROR',
    }));
  }
  return result;
}

function wrapClient(client) {
  if (client[wrappedClient]) return client;
  const originalQuery = client.query.bind(client);
  client.query = (...args) => {
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    return instrumentQuery(originalQuery, args, statement);
  };
  client[wrappedClient] = true;
  return client;
}

const originalPoolQuery = pool.query.bind(pool);
pool.query = (...args) => {
  const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  return instrumentQuery(originalPoolQuery, args, statement);
};

const originalConnect = pool.connect.bind(pool);
pool.connect = (callback) => {
  if (typeof callback === 'function') {
    return originalConnect((error, client, release) => {
      callback(error, client ? wrapClient(client) : client, release);
    });
  }
  return originalConnect().then(wrapClient);
};

module.exports = pool;
