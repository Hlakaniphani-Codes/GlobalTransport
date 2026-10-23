const express = require('express');
const operationsController = require('../controllers/operationsController');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const validateQuery = require('../middleware/validateQuery');
const {
  requestParamsSchema,
  rideRequestListQuerySchema,
  rideRequestCancelSchema,
  rideRequestCreateSchema,
} = require('../validators/passengerRideValidators');

const router = express.Router();

router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('passenger'));
router.get('/', validateQuery(rideRequestListQuerySchema), operationsController.listMyRideRequests);
router.post('/', validate(rideRequestCreateSchema), operationsController.createRideRequest);
router.post(
  '/:requestId/cancel',
  validateParams(requestParamsSchema),
  validate(rideRequestCancelSchema),
  operationsController.cancelRideRequest
);
router.patch(
  '/:requestId/cancel',
  validateParams(requestParamsSchema),
  operationsController.cancelRideRequest
);

module.exports = router;
