const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const DATABASE_UNAVAILABLE_CODES = new Set([
  '53300',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isDatabaseUnavailable(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const code = error.code;
  return DATABASE_UNAVAILABLE_CODES.has(code)
    || (typeof code === 'string' && code.startsWith('08'))
    || error.message === 'timeout exceeded when trying to connect';
}

function notFound(req, res, next) {
  next(new AppError(404, 'The requested resource was not found.'));
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const safeError = error && (typeof error === 'object' || typeof error === 'function')
    ? error
    : new Error(typeof error === 'string' ? error : 'An unknown error was thrown.');

  if (safeError instanceof AppError) {
    const codes = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      429: 'RATE_LIMITED',
      503: 'SERVICE_UNAVAILABLE',
    };
    if (safeError.statusCode === 503) res.set('Retry-After', '5');
    return res.status(safeError.statusCode).json({
      error: {
        code: codes[safeError.statusCode] || 'INTERNAL_SERVER_ERROR',
        message: safeError.message,
      },
    });
  }

  if (safeError.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Request body must contain valid JSON.' },
    });
  }
  if (safeError.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
    });
  }

  if (isDatabaseUnavailable(safeError)) {
    logger.warn('Database connection is temporarily unavailable.', {
      request_id: req.id,
      code: safeError.code ?? 'CONNECTION_TIMEOUT',
    });
    res.set('Retry-After', '5');
    return res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Please try again shortly.',
      },
    });
  }

  logger.error('Unhandled API error.', {
    code: typeof safeError.code === 'string' ? safeError.code : 'UNKNOWN_ERROR',
    error_name: typeof safeError.name === 'string' ? safeError.name : 'UNKNOWN_ERROR',
    request_id: req.id,
  });
  return res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected server error occurred.' },
  });
}

module.exports = { errorHandler, notFound };
