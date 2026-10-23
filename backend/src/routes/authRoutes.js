const express = require('express');
const authController = require('../controllers/authController');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');
const {
  changePasswordSchema,
  deleteAccountSchema,
  driverRegistrationSchema,
  loginSchema,
  passengerRegistrationSchema,
} = require('../validators/authValidators');
const authRateLimit = require('../middleware/authRateLimit');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');

const router = express.Router();

router.post(
  '/register/driver',
  authRateLimit,
  validate(driverRegistrationSchema),
  authController.registerDriver
);
router.post(
  '/register/passenger',
  authRateLimit,
  validate(passengerRegistrationSchema),
  authController.registerPassenger
);
router.post('/login', authRateLimit, validate(loginSchema), authController.login);
router.use(authenticate, generalUserRateLimit, writeUserRateLimit);
router.get('/me', authController.me);
router.post(
  '/change-password',
  requireRole('driver', 'passenger'),
  validate(changePasswordSchema),
  authController.changePassword
);
router.post(
  '/delete-account',
  requireRole('driver', 'passenger'),
  validate(deleteAccountSchema),
  authController.deleteAccount
);

module.exports = router;
