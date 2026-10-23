const { rateLimit } = require('express-rate-limit');
const rateLimitStore = require('./rateLimitStore');

function rateLimitHandler(message) {
  return (req, res) => {
    const resetTime = req.rateLimit?.resetTime?.getTime?.() ?? Date.now() + 60_000;
    res.set('Retry-After', String(Math.max(1, Math.ceil((resetTime - Date.now()) / 1_000))));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message,
      },
    });
  };
}

function createUserRateLimits({
  storeFactory = rateLimitStore.createRateLimitStore,
  generalLimit = 120,
  writeLimit = 30,
} = {}) {
  return {
    general: rateLimit({
      windowMs: 60_000,
      limit: generalLimit,
      keyGenerator: (req) => `user:${req.auth.userId}`,
      store: storeFactory('user-general'),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: rateLimitHandler('Too many requests. Please try again shortly.'),
    }),
    writes: rateLimit({
      windowMs: 60_000,
      limit: writeLimit,
      skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
      keyGenerator: (req) => `user:${req.auth.userId}`,
      store: storeFactory('user-writes'),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: rateLimitHandler('Too many changes. Please try again shortly.'),
    }),
  };
}

const userRateLimits = createUserRateLimits();

module.exports = {
  createUserRateLimits,
  generalUserRateLimit: userRateLimits.general,
  writeUserRateLimit: userRateLimits.writes,
};
