const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const logger = require('../utils/logger');

const storage = new AsyncLocalStorage();

function requestContext(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-ID', req.id);
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('API request completed.', {
      request_id: req.id,
      method: req.method,
      route: req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched',
      status: res.statusCode,
      duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    });
  });
  storage.run({ request: req, requestId: req.id }, next);
}

requestContext.storage = storage;

module.exports = requestContext;
