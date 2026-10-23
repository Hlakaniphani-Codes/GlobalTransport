const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const rateLimitStore = require('./rateLimitStore');

function createAuthRateLimits({
  storeFactory = rateLimitStore.createRateLimitStore,
  accountLimit = 10,
  ipLimit = 300,
} = {}) {
  const handler = (req, res) => {
    const resetTime = req.rateLimit?.resetTime?.getTime?.() ?? Date.now() + 60_000;
    res.set('Retry-After', String(Math.max(1, Math.ceil((resetTime - Date.now()) / 1_000))));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Please try again later.',
      },
    });
  };
  return [
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: accountLimit,
      keyGenerator: (req) => {
        const email = String(req.body?.email ?? '').trim().toLowerCase();
        return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
      },
      store: storeFactory('auth-account'),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler,
    }),
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: ipLimit,
      keyGenerator: (req) => ipKeyGenerator(req.ip),
      store: storeFactory('auth-ip'),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler,
    }),
  ];
}

module.exports = createAuthRateLimits();
module.exports.createAuthRateLimits = createAuthRateLimits;
