const express = require('express');
const tripController = require('../controllers/tripController');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const validateQuery = require('../middleware/validateQuery');
const {
  availabilitySchema,
  driverOfferListQuerySchema,
  offerParamsSchema,
  driverTripStopParamsSchema,
  driverTripListQuerySchema,
  driverTripActionSchema,
  driverTripCompleteStopSchema,
  tripParamsSchema,
  stopSkipSchema,
  tripDelaySchema,
  driverTripEtaSchema,
  driverTripWithdrawSchema,
  driverTripNotHappenedSchema,
  driverTripEndEarlySchema,
} = require('../validators/operationsValidators');

const router = express.Router();

router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('driver'));
router.get('/availability', tripController.getAvailability);
router.patch(
  '/availability',
  validate(availabilitySchema),
  tripController.setAvailability
);
router.get('/offers', validateQuery(driverOfferListQuerySchema), tripController.listOffers);
router.get('/home', tripController.getAvailability);
router.get('/trips', validateQuery(driverTripListQuerySchema), tripController.listDriverTrips);
router.get(
  '/trips/:tripId',
  validateParams(tripParamsSchema),
  tripController.getDriverTrip
);
router.post(
  '/trips/:tripId/withdraw',
  validateParams(tripParamsSchema),
  validate(driverTripWithdrawSchema),
  tripController.withdrawDriverTrip
);
router.post(
  '/trips/:tripId/report-not-happened',
  validateParams(tripParamsSchema),
  validate(driverTripNotHappenedSchema),
  tripController.reportDriverTripNotHappened
);
router.post(
  '/trips/:tripId/end-early',
  validateParams(tripParamsSchema),
  validate(driverTripEndEarlySchema),
  tripController.endDriverTripEarly
);
router.post(
  '/trips/:tripId/acknowledge-change',
  validateParams(tripParamsSchema),
  tripController.acknowledgeDriverTripChange
);
router.post(
  '/trips/:tripId/start',
  validateParams(tripParamsSchema),
  validate(driverTripActionSchema),
  tripController.startDriverTrip
);
router.post(
  '/trips/:tripId/stops/:stopId/arrive',
  validateParams(driverTripStopParamsSchema),
  validate(driverTripActionSchema),
  tripController.arriveDriverTripStop
);
router.post(
  '/trips/:tripId/stops/:stopId/eta',
  validateParams(driverTripStopParamsSchema),
  validate(driverTripEtaSchema),
  tripController.setDriverTripStopEta
);
router.post(
  '/trips/:tripId/stops/:stopId/complete',
  validateParams(driverTripStopParamsSchema),
  validate(driverTripCompleteStopSchema),
  tripController.completeDriverTripStop
);
router.post(
  '/trips/:tripId/stops/:stopId/skip',
  validateParams(driverTripStopParamsSchema),
  validate(stopSkipSchema),
  tripController.skipDriverTripStop
);
router.post(
  '/trips/:tripId/complete',
  validateParams(tripParamsSchema),
  tripController.completeDriverTrip
);
router.post(
  '/trips/:tripId/delay',
  validateParams(tripParamsSchema),
  validate(tripDelaySchema),
  tripController.reportDriverTripDelay
);
router.post(
  '/offers/:offerId/accept',
  validateParams(offerParamsSchema),
  (req, res, next) => {
    req.validatedBody = { decision: 'accept' };
    next();
  },
  tripController.respondToOffer
);
router.post(
  '/offers/:offerId/decline',
  validateParams(offerParamsSchema),
  (req, res, next) => {
    req.validatedBody = { decision: 'decline' };
    next();
  },
  tripController.respondToOffer
);

module.exports = router;
