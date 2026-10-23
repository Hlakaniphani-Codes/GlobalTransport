const offersService = require('../services/offers');

async function eligibleDrivers(req, res) {
  const result = await offersService.listEligibleDrivers(
    req.validatedParams.seriesId,
    req.validatedQuery
  );
  res.json(result);
}

async function createOffer(req, res) {
  const result = await offersService.create(
    req.validatedParams.seriesId,
    req.validatedBody.driver_ids,
    req.validatedBody.window_minutes,
    req.auth.userId
  );
  res.status(201).json(result);
}

async function listOffers(req, res) {
  const offers = await offersService.listForSeries(req.validatedParams.seriesId);
  res.json({ offers });
}

async function cancelOffers(req, res) {
  await offersService.cancel(req.validatedParams.seriesId, req.auth.userId);
  res.json({ cancelled: true });
}

module.exports = { cancelOffers, createOffer, eligibleDrivers, listOffers };
