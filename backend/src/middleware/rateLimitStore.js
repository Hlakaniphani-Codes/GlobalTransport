const logger = require('../utils/logger');

let redisClient;
let redisReady;
let Redis;
let RedisStore;
let optionalDependencyError;

function configureRedis(redisUrl) {
  if (!redisUrl || redisClient) return;
  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch {
    return;
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) return;
  try {
    Redis ??= require('ioredis');
    RedisStore ??= require('rate-limit-redis').RedisStore;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    optionalDependencyError = error;
    return;
  }
  redisClient = new Redis(redisUrl, {
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
  });
  redisClient.on('error', (error) => {
    logger.error('Redis rate-limit store connection error.', {
      code: error.code ?? error.name ?? 'UNKNOWN_ERROR',
    });
  });
}

configureRedis(process.env.REDIS_URL?.trim());

function createRateLimitStore(namespace) {
  if (!redisClient) return undefined;
  return new RedisStore({
    prefix: `global-ride:rate-limit:${namespace}:`,
    sendCommand: (...args) => redisClient.call(...args),
  });
}

async function connectRateLimitStore(redisUrl) {
  if (!redisUrl) return;
  configureRedis(redisUrl);
  if (optionalDependencyError) {
    throw new Error('REDIS_URL requires the optional ioredis and rate-limit-redis packages to be installed.');
  }
  if (!redisClient) throw new Error('REDIS_URL could not initialize the Redis rate-limit store.');
  if (redisReady) return redisReady;
  redisReady = redisClient.connect().catch((error) => {
    redisReady = undefined;
    redisClient.disconnect();
    redisClient = undefined;
    throw error;
  });
  return redisReady;
}

async function closeRateLimitStore() {
  if (!redisClient || redisClient.status === 'end') return;
  await redisClient.quit();
  redisClient = undefined;
  redisReady = undefined;
}

module.exports = {
  closeRateLimitStore,
  connectRateLimitStore,
  createRateLimitStore,
};
