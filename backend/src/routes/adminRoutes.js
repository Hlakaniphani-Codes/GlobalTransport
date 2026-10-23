const express = require('express');
const authController = require('../controllers/authController');
const operationsController = require('../controllers/operationsController');
const reviewController = require('../controllers/reviewController');
const authenticate = require('../middleware/authenticate');
const authRateLimit = require('../middleware/authRateLimit');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const validateQuery = require('../middleware/validateQuery');
const tripController = require('../controllers/tripController');
const offerController = require('../controllers/offerController');
const incidentController = require('../controllers/incidentController');
const notificationController = require('../controllers/notificationController');
const { loginSchema } = require('../validators/authValidators');
const {
  approvedDriversQuerySchema,
  driverParamsSchema,
  driverDirectoryQuerySchema,
  driverDocumentsSchema,
  pendingApplicationsQuerySchema,
  passengerParamsSchema,
  passengerPatchSchema,
  passengerDirectoryQuerySchema,
  reviewDecisionSchema,
  vehicleOnboardingSchema,
  vehicleParamsSchema,
} = require('../validators/reviewValidators');
const {
  activeSchema,
  adminWorkplacesQuerySchema,
  companyParamsSchema,
  companySchema,
  eligibleDriversQuerySchema,
  paginationQuerySchema,
  rideRequestParamsSchema,
  tripParamsSchema,
  workplaceParamsSchema,
  workplaceSchema,
} = require('../validators/operationsValidators');
const {
  forceCompleteSchema,
  incidentParamsSchema,
  incidentQuerySchema,
  incidentResolutionSchema,
} = require('../validators/incidentValidators');
const { offerSchema, seriesParamsSchema } = require('../validators/offerValidators');
const {
  tripCreateSchema,
  tripDatePreviewSchema,
  tripMarkMissedSchema,
  tripNotifyPassengersSchema,
  tripRescheduleSchema,
} = require('../validators/tripSeriesValidators');
const {
  removePassengerSchema,
  tripCancelSchema,
  tripListQuerySchema,
  tripPatchSchema,
} = require('../validators/tripSeriesValidators');
const {
  cancelRequestSchema,
  requestQuerySchema,
} = require('../validators/adminRideValidators');
const { notificationAdminQuerySchema } = require('../validators/notificationValidators');
const { responseCacheMiddleware } = require('../middleware/responseCache');

const router = express.Router();

router.post(
  '/auth/login',
  authRateLimit,
  validate(loginSchema),
  authController.adminLogin
);

router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('admin'));
router.use(responseCacheMiddleware);
router.get('/dashboard/summary', operationsController.dashboardSummary);
router.get('/needs-attention', operationsController.needsAttention);
router.get(
  '/notifications',
  validateQuery(notificationAdminQuerySchema),
  notificationController.adminList
);
router.get(
  '/incidents',
  validateQuery(incidentQuerySchema),
  incidentController.adminList
);
router.post(
  '/incidents/:incidentId/acknowledge',
  validateParams(incidentParamsSchema),
  incidentController.adminAcknowledge
);
router.post(
  '/incidents/:incidentId/resolve',
  validateParams(incidentParamsSchema),
  validate(incidentResolutionSchema),
  incidentController.adminResolve
);
router.get('/companies', validateQuery(paginationQuerySchema), operationsController.listCompanies);
router.post('/companies', validate(companySchema), operationsController.createCompany);
router.patch(
  '/companies/:companyId/active',
  validateParams(companyParamsSchema),
  validate(activeSchema),
  operationsController.setCompanyActive
);
router.get('/workplaces', validateQuery(adminWorkplacesQuerySchema), operationsController.listWorkplaces);
router.post('/workplaces', validate(workplaceSchema), operationsController.createWorkplace);
router.patch(
  '/workplaces/:workplaceId/active',
  validateParams(workplaceParamsSchema),
  validate(activeSchema),
  operationsController.setWorkplaceActive
);
router.get(
  '/ride-requests',
  validateQuery(requestQuerySchema),
  operationsController.listAdminRideRequests
);
router.post(
  '/ride-requests/:requestId/cancel',
  validateParams(rideRequestParamsSchema),
  validate(cancelRequestSchema),
  operationsController.cancelAdminRideRequest
);
router.patch(
  '/passengers/:id',
  validateParams(passengerParamsSchema),
  validate(passengerPatchSchema),
  reviewController.updatePassenger
);
router.get(
  '/passengers',
  validateQuery(passengerDirectoryQuerySchema),
  reviewController.listPassengers
);
router.get('/trip-requests', validateQuery(paginationQuerySchema), tripController.listPendingRequests);
router.get(
  '/eligible-drivers',
  validateQuery(eligibleDriversQuerySchema),
  tripController.listEligibleDrivers
);
router.get('/trips', validateQuery(tripListQuerySchema), tripController.listTrips);
router.get('/trips/live', validateQuery(paginationQuerySchema), tripController.listLiveTrips);
router.post('/trips/preview', validate(tripDatePreviewSchema), tripController.previewTripDates);
router.post('/trips', validate(tripCreateSchema), tripController.createTrip);
router.get(
  '/trips/:tripId',
  validateParams(tripParamsSchema),
  tripController.getTrip
);
router.patch(
  '/trips/:tripId',
  validateParams(tripParamsSchema),
  validate(tripPatchSchema),
  tripController.updateTrip
);
router.post(
  '/trips/:tripId/reschedule',
  validateParams(tripParamsSchema),
  validate(tripRescheduleSchema),
  tripController.rescheduleAdminTrip
);
router.post(
  '/trips/:tripId/mark-missed',
  validateParams(tripParamsSchema),
  validate(tripMarkMissedSchema),
  tripController.markTripMissed
);
router.post(
  '/trips/:tripId/reinstate-passengers',
  validateParams(tripParamsSchema),
  tripController.reinstateTripPassengers
);
router.post(
  '/trips/:tripId/notify-passengers',
  validateParams(tripParamsSchema),
  validate(tripNotifyPassengersSchema),
  tripController.notifyTripPassengers
);
router.post(
  '/trips/:tripId/cancel',
  validateParams(tripParamsSchema),
  validate(tripCancelSchema),
  tripController.cancelAdminTrip
);
router.post(
  '/trips/:tripId/force-complete',
  validateParams(tripParamsSchema),
  validate(forceCompleteSchema),
  tripController.forceCompleteTrip
);
router.post(
  '/trips/:tripId/remove-passenger',
  validateParams(tripParamsSchema),
  validate(removePassengerSchema),
  tripController.removePassenger
);
router.post(
  '/trips/:tripId/reassign',
  validateParams(tripParamsSchema),
  tripController.reassignTrip
);
router.get(
  '/series/:seriesId/eligible-drivers',
  validateParams(seriesParamsSchema),
  validateQuery(paginationQuerySchema),
  offerController.eligibleDrivers
);
router.post(
  '/series/:seriesId/offer',
  validateParams(seriesParamsSchema),
  validate(offerSchema),
  offerController.createOffer
);
router.get(
  '/series/:seriesId/offers',
  validateParams(seriesParamsSchema),
  offerController.listOffers
);
router.post(
  '/series/:seriesId/offers/cancel',
  validateParams(seriesParamsSchema),
  offerController.cancelOffers
);
router.get('/drivers', validateQuery(paginationQuerySchema), reviewController.listDrivers);
router.get(
  '/drivers/directory',
  validateQuery(driverDirectoryQuerySchema),
  reviewController.listDriverDirectory
);
router.get(
  '/drivers/applications',
  validateQuery(pendingApplicationsQuerySchema),
  reviewController.listPendingDriverApplications
);
router.get(
  '/drivers/approved',
  validateQuery(approvedDriversQuerySchema),
  reviewController.listApprovedDrivers
);
router.patch(
  '/drivers/:userId/review',
  validateParams(driverParamsSchema),
  validate(reviewDecisionSchema),
  reviewController.reviewDriver
);
router.patch(
  '/drivers/:userId/documents',
  validateParams(driverParamsSchema),
  validate(driverDocumentsSchema),
  reviewController.updateDriverDocuments
);
router.get('/vehicles/pending', validateQuery(paginationQuerySchema), reviewController.listPendingVehicles);
router.get(
  '/vehicles/applications',
  validateQuery(pendingApplicationsQuerySchema),
  reviewController.listPendingVehicleApplications
);
router.get('/vehicles', validateQuery(paginationQuerySchema), reviewController.listVehicles);
router.patch(
  '/vehicles/:vehicleId/review',
  validateParams(vehicleParamsSchema),
  validate(reviewDecisionSchema),
  reviewController.reviewVehicle
);
router.post('/vehicles', validate(vehicleOnboardingSchema), reviewController.onboardVehicle);

module.exports = router;
