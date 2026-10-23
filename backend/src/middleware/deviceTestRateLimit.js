const { rateLimit } = require('express-rate-limit');
const rateLimitStore = require('./rateLimitStore');

const deviceTestRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  keyGenerator: (req) => `user:${req.auth.userId}`,
  store: rateLimitStore.createRateLimitStore('device-test'),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler(req, res) {
    const resetTime = req.rateLimit?.resetTime?.getTime?.() ?? Date.now() + 60 * 60_000;
    res.set('Retry-After', String(Math.max(1, Math.ceil((resetTime - Date.now()) / 1_000))));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'You can send up to 3 test notifications per hour.',
      },
    });
  },
});

module.exports = deviceTestRateLimit;
