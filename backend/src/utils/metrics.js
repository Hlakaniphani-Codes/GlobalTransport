const { monitorEventLoopDelay } = require('node:perf_hooks');
const { timingSafeEqual } = require('node:crypto');
const {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} = require('prom-client');
const { getWorkerMetrics } = require('./workerMetrics');

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'global_ride_' });

const requests = new Counter({
  name: 'http_requests_total',
  help: 'Completed HTTP requests by route pattern and status class.',
  labelNames: ['route', 'status_class'],
  registers: [registry],
});
const requestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route pattern and status class.',
  labelNames: ['route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});
const inFlightRequests = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently in flight.',
  registers: [registry],
});
const poolTotal = new Gauge({
  name: 'db_pool_total_connections',
  help: 'Total PostgreSQL connections in the application pool.',
  registers: [registry],
});
const poolIdle = new Gauge({
  name: 'db_pool_idle_connections',
  help: 'Idle PostgreSQL connections in the application pool.',
  registers: [registry],
});
const poolWaiting = new Gauge({
  name: 'db_pool_waiting_connections',
  help: 'Requests waiting for a PostgreSQL connection.',
  registers: [registry],
});
const eventLoopLag = new Gauge({
  name: 'event_loop_lag_seconds',
  help: 'Mean event loop delay since the previous metrics scrape.',
  registers: [registry],
});
const queryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'PostgreSQL query duration by route pattern.',
  labelNames: ['route'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15],
  registers: [registry],
});
const workerTickDuration = new Histogram({
  name: 'worker_tick_duration_seconds',
  help: 'Background worker tick duration.',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [registry],
});
const workerLag = new Gauge({
  name: 'worker_oldest_due_job_age_seconds',
  help: 'Age of the oldest unclaimed due notification job.',
  registers: [registry],
});
const notificationJobs = new Gauge({
  name: 'notification_jobs',
  help: 'Notification jobs by status.',
  labelNames: ['status'],
  registers: [registry],
});
const activeOffers = new Gauge({
  name: 'active_offers',
  help: 'Number of currently pending and unexpired offers.',
  registers: [registry],
});
const tripsInProgress = new Gauge({
  name: 'trips_in_progress',
  help: 'Number of trips currently in progress.',
  registers: [registry],
});

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let businessMetricsRefreshedAt = 0;
let businessMetricsRefresh;

function routePattern(req) {
  return req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

function requestMetricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  let recorded = false;
  inFlightRequests.inc();
  function record(statusClass) {
    if (recorded) return;
    recorded = true;
    const route = routePattern(req);
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    requests.inc({ route, status_class: statusClass });
    requestDuration.observe({ route, status_class: statusClass }, durationSeconds);
    inFlightRequests.dec();
  }
  res.once('finish', () => record(`${Math.floor(res.statusCode / 100)}xx`));
  res.once('close', () => record(res.writableEnded
    ? `${Math.floor(res.statusCode / 100)}xx`
    : 'aborted'));
  next();
}

function observeQueryDuration(durationMs, route = 'background') {
  queryDuration.observe({ route }, durationMs / 1_000);
}

function recordWorkerTickMetrics({ durationMs, oldestDueJobAgeSeconds }) {
  workerTickDuration.observe(durationMs / 1_000);
  workerLag.set(oldestDueJobAgeSeconds);
}

async function refreshBusinessMetrics(pool) {
  const now = Date.now();
  if (now - businessMetricsRefreshedAt < 15_000) return;
  if (businessMetricsRefresh) return businessMetricsRefresh;
  businessMetricsRefresh = (async () => {
    const [jobCounts, offers, trips] = await Promise.all([
      pool.query('SELECT status, count(*)::int AS count FROM notification_jobs GROUP BY status'),
      pool.query(
        `SELECT count(*)::int AS count
         FROM trip_offers
         WHERE status = 'pending' AND expires_at > now()`
      ),
      pool.query(
        `SELECT count(*)::int AS count
         FROM trips WHERE status = 'in_progress'`
      ),
    ]);
    notificationJobs.reset();
    for (const row of jobCounts.rows) notificationJobs.set({ status: row.status }, row.count);
    activeOffers.set(offers.rows[0]?.count ?? 0);
    tripsInProgress.set(trips.rows[0]?.count ?? 0);
    businessMetricsRefreshedAt = Date.now();
  })();
  try {
    await businessMetricsRefresh;
  } finally {
    businessMetricsRefresh = undefined;
  }
}

async function renderMetrics(pool) {
  await refreshBusinessMetrics(pool);
  poolTotal.set(pool.totalCount);
  poolIdle.set(pool.idleCount);
  poolWaiting.set(pool.waitingCount);
  eventLoopLag.set(Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1_000_000_000 : 0);
  eventLoopDelay.reset();
  const worker = getWorkerMetrics();
  workerLag.set(worker.oldestDueJobAgeSeconds);
  return registry.metrics();
}

module.exports = {
  isMetricsAuthorized: (authorization, token) => {
    if (!token || !authorization?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  },
  metricsContentType: registry.contentType,
  observeQueryDuration,
  recordWorkerTickMetrics,
  renderMetrics,
  requestMetricsMiddleware,
  routePattern,
};
