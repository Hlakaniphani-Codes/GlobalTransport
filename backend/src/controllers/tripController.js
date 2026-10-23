const tripService = require('../services/tripService');
const tripAdminService = require('../services/tripAdminService');
const adminTripLifecycleService = require('../services/adminTripLifecycleService');
const driverTripService = require('../services/driverTripService');
const driverTripExecutionService = require('../services/driverTripExecutionService');
const driverTripRecoveryService = require('../services/driverTripRecoveryService');
const offersService = require('../services/offers');

async function listPendingRequests(req, res) {
  const result = await tripService.listPendingRequests(req.validatedQuery);
  res.json(result);
}

async function listEligibleDrivers(req, res) {
  const result = await tripService.listEligibleDrivers(req.validatedQuery);
  res.json(result);
}

async function createTrip(req, res) {
  const result = await tripAdminService.createTrips(req.auth.userId, req.validatedBody);
  res.status(201).json(result);
}

async function previewTripDates(req, res) {
  const result = await tripAdminService.previewTripDates(req.validatedBody);
  res.json(result);
}

async function listTrips(req, res) {
  const result = await tripAdminService.listTrips(req.validatedQuery);
  res.json(result);
}

async function listLiveTrips(req, res) {
  const result = await tripAdminService.listLiveTrips(req.validatedQuery);
  res.json(result);
}

async function getTrip(req, res) {
  const trip = await tripAdminService.getTrip(req.validatedParams.tripId);
  res.json({ trip });
}

async function updateTrip(req, res) {
  const trip = await tripAdminService.updateTrip(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ trip });
}

async function rescheduleAdminTrip(req, res) {
  const trip = await adminTripLifecycleService.rescheduleTrip(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ trip });
}

async function markTripMissed(req, res) {
  const trip = await adminTripLifecycleService.markTripMissed(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody.reason
  );
  res.json({ trip });
}

async function reinstateTripPassengers(req, res) {
  const result = await adminTripLifecycleService.reinstateTripPassengers(
    req.validatedParams.tripId,
    req.auth.userId
  );
  res.json(result);
}

async function notifyTripPassengers(req, res) {
  const result = await adminTripLifecycleService.notifyPassengers(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody
  );
  res.json(result);
}

async function cancelAdminTrip(req, res) {
  const trip = await tripAdminService.cancelTrip(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody.reason
  );
  res.json({ trip });
}

async function removePassenger(req, res) {
  const result = await tripAdminService.removePassenger(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody
  );
  res.json(result);
}

async function reassignTrip(req, res) {
  const trip = await tripAdminService.reassignTrip(
    req.validatedParams.tripId,
    req.auth.userId
  );
  res.json({ trip });
}

async function forceCompleteTrip(req, res) {
  const trip = await tripAdminService.forceComplete(
    req.validatedParams.tripId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ trip });
}

async function cancelTrip(req, res) {
  const trip = await tripService.cancelTrip(req.validatedParams.tripId, req.auth.userId);
  res.json({ trip });
}

async function getAvailability(req, res) {
  const availability = await driverTripService.getHome(req.auth.userId);
  res.json(availability);
}

async function setAvailability(req, res) {
  const availability = await driverTripService.setAvailability(
    req.auth.userId,
    req.validatedBody.is_available
  );
  res.json(availability);
}

async function listOffers(req, res) {
  const result = await driverTripService.listOffers(req.auth.userId, req.validatedQuery);
  res.json(result);
}

async function listDriverTrips(req, res) {
  const result = await driverTripService.listTrips(req.auth.userId, req.validatedQuery);
  res.json(result);
}

async function getDriverTrip(req, res) {
  const trip = await driverTripExecutionService.getTrip(
    req.auth.userId,
    req.validatedParams.tripId
  );
  res.json({ trip });
}

async function startDriverTrip(req, res) {
  const trip = await driverTripExecutionService.startTrip(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedBody?.client_time
  );
  res.json({ trip });
}

async function updateDriverTripStop(req, res, action) {
  const result = await driverTripExecutionService.updateStop(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedParams.stopId,
    action,
    req.validatedBody
  );
  res.json(result);
}

async function arriveDriverTripStop(req, res) {
  await updateDriverTripStop(req, res, 'arrive');
}

async function setDriverTripStopEta(req, res) {
  const trip = await driverTripExecutionService.setStopEta(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedParams.stopId,
    req.validatedBody.minutes
  );
  res.json({ trip });
}

async function completeDriverTripStop(req, res) {
  await updateDriverTripStop(req, res, 'complete');
}

async function skipDriverTripStop(req, res) {
  await updateDriverTripStop(req, res, 'skip');
}

async function completeDriverTrip(req, res) {
  const trip = await driverTripExecutionService.completeTrip(
    req.auth.userId,
    req.validatedParams.tripId
  );
  res.json({ trip });
}

async function reportDriverTripDelay(req, res) {
  const trip = await driverTripExecutionService.reportDelay(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedBody
  );
  res.json({ trip });
}

async function withdrawDriverTrip(req, res) {
  const result = await driverTripRecoveryService.withdrawTrip(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedBody
  );
  res.json(result);
}

async function reportDriverTripNotHappened(req, res) {
  const trip = await driverTripRecoveryService.closeAsMissed(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedBody
  );
  res.json({ trip });
}

async function endDriverTripEarly(req, res) {
  const trip = await driverTripRecoveryService.endEarly(
    req.auth.userId,
    req.validatedParams.tripId,
    req.validatedBody
  );
  res.json({ trip });
}

async function acknowledgeDriverTripChange(req, res) {
  const result = await driverTripRecoveryService.acknowledgeChange(
    req.auth.userId,
    req.validatedParams.tripId
  );
  res.json({ trip: result });
}

async function respondToOffer(req, res) {
  const result = await offersService.respond(
    req.validatedParams.offerId,
    req.auth.userId,
    req.validatedBody.decision
  );
  res.json(result);
}

module.exports = {
  cancelTrip,
  createTrip,
  previewTripDates,
  rescheduleAdminTrip,
  markTripMissed,
  reinstateTripPassengers,
  notifyTripPassengers,
  getAvailability,
  getTrip,
  getDriverTrip,
  updateTrip,
  cancelAdminTrip,
  removePassenger,
  reassignTrip,
  listEligibleDrivers,
  listLiveTrips,
  listOffers,
  listDriverTrips,
  listPendingRequests,
  listTrips,
  respondToOffer,
  setAvailability,
  startDriverTrip,
  updateDriverTripStop,
  arriveDriverTripStop,
  setDriverTripStopEta,
  completeDriverTripStop,
  forceCompleteTrip,
  skipDriverTripStop,
  completeDriverTrip,
  reportDriverTripDelay,
  withdrawDriverTrip,
  reportDriverTripNotHappened,
  endDriverTripEarly,
  acknowledgeDriverTripChange,
};
