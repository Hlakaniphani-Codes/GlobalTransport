const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const pool = require('./src/db');
const logger = require('./src/utils/logger');
const { connectRateLimitStore, closeRateLimitStore } = require('./src/middleware/rateLimitStore');
const { errorHandler, notFound } = require('./src/middleware/errorHandler');
const authRoutes = require('./src/routes/authRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const vehicleRoutes = require('./src/routes/vehicleRoutes');
const workplaceRoutes = require('./src/routes/workplaceRoutes');
const rideRequestRoutes = require('./src/routes/rideRequestRoutes');
const passengerTripRoutes = require('./src/routes/passengerTripRoutes');
const driverRoutes = require('./src/routes/driverRoutes');
const incidentRoutes = require('./src/routes/incidentRoutes');
const notificationRoutes = require('./src/routes/notificationRoutes');
const offersService = require('./src/services/offers');
const { isAllowedCorsOrigin, loadConfig } = require('./src/config');
const requestContext = require('./src/middleware/requestContext');
const {
  runNotificationReceiptWorker,
  runOfferExpiryWorker,
} = require('./src/services/offerExpiryWorker');
const notificationService = require('./src/services/notifications');
const tripLifecycleService = require('./src/services/tripLifecycleService');
const { responseBehavior } = require('./src/middleware/responseBehavior');
const { invalidateResponseCache } = require('./src/middleware/responseCache');
const requestTimeout = require('./src/middleware/requestTimeout');
const { readinessQuery } = require('./src/utils/migrationStatus');
const { getWorkerMetrics } = require('./src/utils/workerMetrics');
const {
  isMetricsAuthorized,
  metricsContentType,
  renderMetrics,
  requestMetricsMiddleware,
} = require('./src/utils/metrics');
const { initializeSentry } = require('./src/utils/sentry');

const app = express();
const allowedOrigins = process.env.CORS_ORIGINS
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean) ?? [];
app.set('trust proxy', 1);
app.set('etag', 'weak');
app.use(helmet());
app.use(requestContext);
app.use(requestMetricsMiddleware);
app.use(requestTimeout(Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000)));
app.use(compression({ threshold: 1024 }));
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedCorsOrigin(origin, allowedOrigins));
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(responseBehavior);
app.use('/api/v1', invalidateResponseCache);

app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN?.trim();
  if (!token) {
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Metrics access is not configured.' },
    });
  }
  if (!isMetricsAuthorized(req.get('authorization'), token)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' },
    });
  }
  const body = await renderMetrics(pool);
  res.set('Content-Type', metricsContentType);
  return res.status(200).send(body);
});

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
  const worker = getWorkerMetrics();
  const heartbeatAgeMs = worker.completedAt
    ? Date.now() - Date.parse(worker.completedAt)
    : Number.POSITIVE_INFINITY;
  let databaseReady = false;
  let migrationsApplied = false;
  let readinessTimer;
  try {
    const result = await Promise.race([
      pool.query(readinessQuery()),
      new Promise((resolve, reject) => {
        readinessTimer = setTimeout(() => {
          reject(Object.assign(new Error('Readiness database check exceeded 500 ms.'), {
            code: 'HEALTH_CHECK_TIMEOUT',
          }));
        }, 400);
      }),
    ]);
    databaseReady = result.rows[0]?.database_ready === 1;
    migrationsApplied = result.rows[0]?.migrations_applied === true;
  } catch (error) {
    logger.warn('Readiness database check failed.', {
      request_id: req.id,
      code: error.code || error.name || 'UNKNOWN_ERROR',
    });
  } finally {
    clearTimeout(readinessTimer);
  }
  const workerHealthy = heartbeatAgeMs >= 0 && heartbeatAgeMs < 120_000;
  if (databaseReady && migrationsApplied && workerHealthy) {
    return res.status(200).json({ status: 'ready' });
  }
  logger.warn('Application readiness check failed.', {
    request_id: req.id,
    database_ready: databaseReady,
    migrations_applied: migrationsApplied,
    worker_heartbeat_age_ms: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
  });
  return res.status(503).json({
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is not ready to accept requests.',
    },
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.warn('Health check database query failed.', {
      request_id: req.id,
      code: error.code || error.name || 'UNKNOWN_ERROR',
    });
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/vehicles', vehicleRoutes);
app.use('/api/v1/workplaces', workplaceRoutes);
app.use('/api/v1/ride-requests', rideRequestRoutes);
app.use('/api/v1/rides/requests', rideRequestRoutes);
app.use('/api/v1/rides/trips', passengerTripRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/incidents', incidentRoutes);
app.use('/api/v1', notificationRoutes);
app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  async function startServer() {
    let config;
    let sentryClient;
    try {
      config = loadConfig();
    } catch (error) {
      logger.error('Server startup configuration is invalid.', {
        message: error.message,
      });
      process.exitCode = 1;
      return;
    }

    try {
      sentryClient = initializeSentry(config.sentryDsn);
    } catch (error) {
      logger.error('Sentry initialization failed.', {
        code: error.code || error.name || 'UNKNOWN_ERROR',
      });
      await pool.end();
      process.exitCode = 1;
      return;
    }

    if (config.redisUrl) {
      try {
        await connectRateLimitStore(config.redisUrl);
      } catch (error) {
        logger.error('Redis rate-limit store is unavailable; server startup was stopped.', {
          code: error.code || error.name || 'UNKNOWN_ERROR',
        });
        await Promise.all([pool.end(), sentryClient?.close(5_000)]);
        process.exitCode = 1;
        return;
      }
    } else if (config.nodeEnv === 'production') {
      logger.warn('Rate limits use process-local memory. Configure REDIS_URL before running multiple instances.');
    }

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      logger.error('Server startup failed while preparing the database.', error.code || error.name);
      await Promise.all([pool.end(), closeRateLimitStore(), sentryClient?.close(5_000)]);
      process.exitCode = 1;
      return;
    }

    let shuttingDown = false;
    let server;
    let lastRetentionDate = null;
    async function runDailyRetention() {
      const today = new Date().toISOString().slice(0, 10);
      if (lastRetentionDate === today) return;
      const result = await notificationService.processDataRetention({
        retentionDays: config.notificationRetentionDays,
      });
      if (result) lastRetentionDate = today;
    }
    const runWorkerTick = () => runOfferExpiryWorker(
      pool,
      () => offersService.processExpired(),
      () => Promise.all([
        notificationService.processDueJobs(config.workerBatchSize),
        notificationService.processScheduledNotifications(),
        runDailyRetention(),
      ]),
      () => tripLifecycleService.processLifecycle(),
      () => notificationService.getWorkerLag()
    )
      .catch((error) => logger.error('Trip offer expiry worker failed.', error.code || error.name));
    void runWorkerTick();
    const offerExpiryTimer = setInterval(() => {
      void runWorkerTick();
    }, 30_000);
    offerExpiryTimer.unref();
    const receiptTimer = setInterval(() => {
      runNotificationReceiptWorker(pool, () => notificationService.processReceipts());
    }, 60_000);
    receiptTimer.unref();
    server = app.listen(config.port, '0.0.0.0', () => {
      logger.info('Server is accepting requests.', { port: config.port });
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.on('error', (error) => {
      logger.error('Server failed to listen.', error.code || error.name);
      process.exitCode = 1;
    });

    async function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(offerExpiryTimer);
      clearInterval(receiptTimer);
      logger.info('Server shutdown started.', { signal });
      server.close(async (error) => {
        if (error) logger.error('HTTP server shutdown failed.', error.code || error.name);
        try {
          const [, , sentryFlushed] = await Promise.all([
            pool.end(),
            closeRateLimitStore(),
            sentryClient?.close(5_000),
          ]);
          if (sentryFlushed === false) {
            logger.warn('Sentry did not flush all events before the shutdown deadline.');
          }
          logger.info('Server shutdown complete.');
        } catch (poolError) {
          logger.error('Database or Redis rate-limit store shutdown failed.', poolError.code || poolError.name);
          process.exitCode = 1;
        }
      });
    }

    function handleFatalProcessError(event, reason) {
      const context = requestContext.storage.getStore();
      logger.error('Fatal process error; graceful shutdown started.', {
        event,
        code: reason?.code || reason?.name || 'UNKNOWN_ERROR',
        request_id: context?.requestId,
        route: context?.request?.route?.path
          ? `${context.request.baseUrl}${context.request.route.path}`
          : context?.request?.path,
      });
      process.exitCode = 1;
      void shutdown(event).catch((error) => {
        logger.error('Graceful shutdown after a fatal process error failed.', {
          code: error.code || error.name || 'UNKNOWN_ERROR',
        });
      });
    }

    process.on('uncaughtException', (error) => handleFatalProcessError('uncaughtException', error));
    process.on('unhandledRejection', (reason) => handleFatalProcessError('unhandledRejection', reason));
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  }

  void startServer().catch((error) => {
    logger.error('Server startup failed unexpectedly.', {
      code: error.code || error.name || 'UNKNOWN_ERROR',
    });
    process.exitCode = 1;
  });
}

module.exports = app;
