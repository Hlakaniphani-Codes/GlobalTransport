const AppError = require('../utils/AppError');

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(new AppError(403, 'You do not have permission to access this resource.'));
    }

    next();
  };
}

module.exports = requireRole;
