const logger = require('../utils/logger');

function requestTimeout(timeoutMs = 30_000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      logger.warn('Request exceeded its time limit.', {
        request_id: req.id,
        route: req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched',
      });
      res.set('Retry-After', '5');
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The request took too long. Please try again shortly.',
        },
      });
    }, timeoutMs);
    timer.unref();
    res.once('finish', () => clearTimeout(timer));
    res.once('close', () => clearTimeout(timer));
    next();
  };
}

module.exports = requestTimeout;
