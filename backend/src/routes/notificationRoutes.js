const express = require('express');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const validateQuery = require('../middleware/validateQuery');
const notificationController = require('../controllers/notificationController');
const deviceTestRateLimit = require('../middleware/deviceTestRateLimit');
const {
  deviceSchema,
  deviceTokenParamsSchema,
  notificationParamsSchema,
  notificationPreferencesSchema,
  notificationQuerySchema,
} = require('../validators/notificationValidators');

const router = express.Router();
router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('driver', 'passenger'));

router.post('/devices', validate(deviceSchema), notificationController.registerDevice);
router.post('/devices/test', deviceTestRateLimit, notificationController.sendTestNotification);
router.delete(
  '/devices/:token',
  validateParams(deviceTokenParamsSchema),
  notificationController.deleteDevice
);
router.get(
  '/notifications',
  validateQuery(notificationQuerySchema),
  notificationController.listNotifications
);
router.post('/notifications/read-all', notificationController.markAllRead);
router.post(
  '/notifications/:id/read',
  validateParams(notificationParamsSchema),
  notificationController.markRead
);
router.get('/me/notification-preferences', notificationController.getPreferences);
router.patch(
  '/me/notification-preferences',
  validate(notificationPreferencesSchema),
  notificationController.updatePreferences
);

module.exports = router;
