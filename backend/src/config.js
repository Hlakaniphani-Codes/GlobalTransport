const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} must be configured before the server can start.`);
  }
  return value.trim();
}

function parsePort(value) {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parseRedisUrl(value) {
  const redisUrl = value?.trim();
  if (!redisUrl) return null;
  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL must be a valid Redis connection URL.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must use redis:// or rediss://.');
  }
  return redisUrl;
}

function parseOrigins(value, isProduction) {
  const entries = value?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  if (isProduction && entries.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one exact origin in production.');
  }

  for (const origin of entries) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGINS must be a comma-separated list of exact origins.');
    }
    if (
      origin.includes('*')
      || !['http:', 'https:'].includes(parsed.protocol)
      || parsed.origin !== origin
    ) {
      throw new Error('CORS_ORIGINS must contain exact HTTP or HTTPS origins without paths or wildcards.');
    }
  }
  return entries;
}

function isAllowedCorsOrigin(origin, configuredOrigins, nodeEnv = process.env.NODE_ENV) {
  if (!origin || configuredOrigins.includes(origin)) return true;
  if (nodeEnv === 'production') return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const octets = hostname.split('.').map(Number);
    const isPrivateIpv4 = octets.length === 4
      && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      && (
        octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
      );
    return (
      ['http:', 'https:'].includes(parsed.protocol)
      && parsed.origin === origin
      && (
        ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
        || isPrivateIpv4
        || hostname.endsWith('.local')
      )
    );
  } catch {
    return false;
  }
}

function parsePoolMax(value) {
  const poolMax = Number(value ?? 10);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) {
    throw new Error('DB_POOL_MAX must be an integer between 1 and 100.');
  }
  return poolMax;
}

function parsePoolMin(value, poolMax) {
  const poolMin = Number(value ?? 0);
  if (!Number.isInteger(poolMin) || poolMin < 0 || poolMin > poolMax) {
    throw new Error('DB_POOL_MIN must be a non-negative integer no greater than DB_POOL_MAX.');
  }
  return poolMin;
}

function parsePositiveInteger(value, name, defaultValue) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNoShowWaitMinutes(value) {
  if (value !== undefined && !value.trim()) {
    throw new Error('NO_SHOW_WAIT_MINUTES must be a non-negative integer.');
  }
  const minutes = Number(value ?? 5);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error('NO_SHOW_WAIT_MINUTES must be a non-negative integer.');
  }
  return minutes;
}

function parseNonNegativeInteger(value, name, defaultValue) {
  if (value !== undefined && !value.trim()) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseLifecycleConfig(env) {
  return {
    overdueGraceMinutes: parseNonNegativeInteger(
      env.OVERDUE_GRACE_MINUTES,
      'OVERDUE_GRACE_MINUTES',
      30
    ),
    autoMissAfterMinutes: parseNonNegativeInteger(
      env.AUTO_MISS_AFTER_MINUTES,
      'AUTO_MISS_AFTER_MINUTES',
      60
    ),
    lateWithdrawHours: parseNonNegativeInteger(
      env.LATE_WITHDRAW_HOURS,
      'LATE_WITHDRAW_HOURS',
      12
    ),
    unassignedAlertHours: parseNonNegativeInteger(
      env.UNASSIGNED_ALERT_HOURS,
      'UNASSIGNED_ALERT_HOURS',
      3
    ),
    requestExpireGraceMinutes: parseNonNegativeInteger(
      env.REQUEST_EXPIRE_GRACE_MINUTES,
      'REQUEST_EXPIRE_GRACE_MINUTES',
      15
    ),
    changeCancelExemptHours: parseNonNegativeInteger(
      env.CHANGE_CANCEL_EXEMPT_HOURS,
      'CHANGE_CANCEL_EXEMPT_HOURS',
      24
    ),
    etaStaleMinutes: parseNonNegativeInteger(
      env.ETA_STALE_MINUTES,
      'ETA_STALE_MINUTES',
      15
    ),
  };
}

function parseNotificationConfig(env) {
  const smsProvider = (env.SMS_PROVIDER ?? 'none').trim().toLowerCase();
  if (!['none', 'bulksms', 'clickatell', 'twilio'].includes(smsProvider)) {
    throw new Error('SMS_PROVIDER must be none, bulksms, clickatell or twilio.');
  }
  const credentials = {
    bulksms: ['BULKSMS_USERNAME', 'BULKSMS_PASSWORD'],
    clickatell: ['CLICKATELL_API_KEY'],
    twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  }[smsProvider] ?? [];
  if (credentials.some((name) => !env[name]?.trim())) {
    throw new Error(`All credentials for the selected ${smsProvider} SMS provider must be configured.`);
  }
  return {
    smsProvider,
    offerSmsFallbackSeconds: parseNonNegativeInteger(
      env.OFFER_SMS_FALLBACK_SECONDS,
      'OFFER_SMS_FALLBACK_SECONDS',
      120
    ),
    tripReminderMinutes: parseNonNegativeInteger(
      env.TRIP_REMINDER_MINUTES,
      'TRIP_REMINDER_MINUTES',
      60
    ),
  };
}

function parseWorkerConfig(env) {
  return {
    workerBatchSize: parsePositiveInteger(env.WORKER_BATCH_SIZE, 'WORKER_BATCH_SIZE', 200),
    notificationRetentionDays: parsePositiveInteger(
      env.NOTIFICATION_RETENTION_DAYS,
      'NOTIFICATION_RETENTION_DAYS',
      90
    ),
  };
}

function loadDatabaseConfig(env = process.env) {
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  const databaseSsl = env.DATABASE_SSL ?? 'false';
  if (!['true', 'false'].includes(databaseSsl.toLowerCase())) {
    throw new Error('DATABASE_SSL must be either true or false.');
  }
  const databasePoolMax = parsePoolMax(env.DB_POOL_MAX);
  return {
    databaseUrl,
    databaseSsl: databaseSsl.toLowerCase() === 'true',
    databasePoolMax,
    databasePoolMin: parsePoolMin(env.DB_POOL_MIN, databasePoolMax),
    databaseIdleTimeoutMs: parseNonNegativeInteger(
      env.DB_IDLE_TIMEOUT_MS,
      'DB_IDLE_TIMEOUT_MS',
      30_000
    ),
    databaseConnectTimeoutMs: parsePositiveInteger(
      env.DB_CONNECT_TIMEOUT_MS,
      'DB_CONNECT_TIMEOUT_MS',
      5_000
    ),
    statementTimeoutMs: parsePositiveInteger(
      env.STATEMENT_TIMEOUT_MS,
      'STATEMENT_TIMEOUT_MS',
      15_000
    ),
    idleInTransactionTimeoutMs: parsePositiveInteger(
      env.IDLE_IN_TRANSACTION_TIMEOUT_MS,
      'IDLE_IN_TRANSACTION_TIMEOUT_MS',
      15_000
    ),
  };
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const databaseConfig = loadDatabaseConfig(env);
  const notificationConfig = parseNotificationConfig(env);
  const lifecycleConfig = parseLifecycleConfig(env);

  const jwtSecret = required(env.JWT_SECRET, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }
  const metricsToken = env.METRICS_TOKEN?.trim() || null;
  if (nodeEnv === 'production' && !metricsToken) {
    throw new Error('METRICS_TOKEN must be configured in production.');
  }
  const sentryDsn = env.SENTRY_DSN?.trim() || null;
  if (sentryDsn) {
    let parsedSentryDsn;
    try {
      parsedSentryDsn = new URL(sentryDsn);
    } catch {
      throw new Error('SENTRY_DSN must be a valid HTTP or HTTPS URL.');
    }
    if (!['http:', 'https:'].includes(parsedSentryDsn.protocol) || !parsedSentryDsn.hostname) {
      throw new Error('SENTRY_DSN must be a valid HTTP or HTTPS URL.');
    }
  }

  return {
    nodeEnv,
    port: parsePort(env.PORT),
    requestTimeoutMs: parsePositiveInteger(env.REQUEST_TIMEOUT_MS, 'REQUEST_TIMEOUT_MS', 30_000),
    metricsToken,
    sentryDsn,
    redisUrl: parseRedisUrl(env.REDIS_URL),
    ...databaseConfig,
    slowQueryMs: parseNonNegativeInteger(env.SLOW_QUERY_MS, 'SLOW_QUERY_MS', 200),
    jwtSecret,
    corsOrigins: parseOrigins(env.CORS_ORIGINS, nodeEnv === 'production'),
    noShowWaitMinutes: parseNoShowWaitMinutes(env.NO_SHOW_WAIT_MINUTES),
    ...lifecycleConfig,
    ...notificationConfig,
    ...parseWorkerConfig(env),
  };
}

module.exports = {
  isAllowedCorsOrigin,
  loadConfig,
  loadDatabaseConfig,
  parseLifecycleConfig,
  parseNotificationConfig,
  parseWorkerConfig,
  parseRedisUrl,
};
