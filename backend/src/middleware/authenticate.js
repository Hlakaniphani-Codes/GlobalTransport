const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError');

const roles = new Set(['driver', 'passenger', 'admin']);

function authenticate(req, res, next) {
  const authorization = req.get('authorization');
  const match = authorization && authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return next(new AppError(401, 'Authentication required.'));
  }

  if (!process.env.JWT_SECRET) {
    return next(new Error('JWT_SECRET must be configured before authenticating requests.'));
  }

  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET);
    if (
      typeof payload !== 'object' ||
      typeof payload.id !== 'string' ||
      !roles.has(payload.role)
    ) {
      return next(new AppError(401, 'Invalid or expired token.'));
    }

    req.auth = { userId: payload.id, role: payload.role };
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token.'));
  }
}

module.exports = authenticate;
