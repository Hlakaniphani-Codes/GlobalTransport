const reviewService = require('../services/reviewService');

async function listDrivers(req, res) {
  const result = await reviewService.listPendingDrivers(req.validatedQuery);
  res.json(result);
}

async function listDriverDirectory(req, res) {
  const result = await reviewService.listDriverDirectory(req.validatedQuery);
  res.json(result);
}

async function listPendingDriverApplications(req, res) {
  const result = await reviewService.listPendingDriverApplications(req.validatedQuery);
  res.json({ drivers: result.applications, pagination: result.pagination });
}

async function reviewDriver(req, res) {
  const driver = await reviewService.reviewDriver(
    req.validatedParams.userId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ driver });
}

async function updateDriverDocuments(req, res) {
  const driver = await reviewService.updateDriverDocuments(
    req.validatedParams.userId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ driver });
}

async function updatePassenger(req, res) {
  const passenger = await reviewService.updatePassenger(
    req.validatedParams.id,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ passenger });
}

async function listPassengers(req, res) {
  const result = await reviewService.listPassengers(req.validatedQuery);
  res.json(result);
}

async function listVehicles(req, res) {
  const result = await reviewService.listVehicles(req.validatedQuery);
  res.json(result);
}

async function listPendingVehicles(req, res) {
  const result = await reviewService.listPendingVehicles(req.validatedQuery);
  res.json(result);
}

async function listPendingVehicleApplications(req, res) {
  const result = await reviewService.listPendingVehicleApplications(req.validatedQuery);
  res.json({ vehicles: result.applications, pagination: result.pagination });
}

async function reviewVehicle(req, res) {
  const vehicle = await reviewService.reviewVehicle(
    req.validatedParams.vehicleId,
    req.auth.userId,
    req.validatedBody
  );
  res.json({ vehicle });
}

async function listApprovedDrivers(req, res) {
  const result = await reviewService.listApprovedDrivers(
    req.validatedQuery.search,
    req.validatedQuery
  );
  res.json(result);
}

async function onboardVehicle(req, res) {
  const vehicle = await reviewService.onboardVehicle(req.auth.userId, req.validatedBody);
  res.status(201).json({ vehicle });
}

async function submitVehicle(req, res) {
  const vehicle = await reviewService.submitVehicle(req.auth.userId, req.validatedBody);
  res.status(201).json({ vehicle });
}

async function resubmitVehicle(req, res) {
  const vehicle = await reviewService.resubmitVehicle(
    req.auth.userId,
    req.validatedParams.vehicleId,
    req.validatedBody
  );
  res.json({ vehicle });
}

async function listMine(req, res) {
  const vehicles = await reviewService.listDriverVehicles(req.auth.userId);
  res.json({ vehicles });
}

module.exports = {
  onboardVehicle,
  listApprovedDrivers,
  listDrivers,
  listDriverDirectory,
  listPendingDriverApplications,
  listPassengers,
  listMine,
  listVehicles,
  listPendingVehicles,
  listPendingVehicleApplications,
  reviewDriver,
  updateDriverDocuments,
  updatePassenger,
  reviewVehicle,
  resubmitVehicle,
  submitVehicle,
};
