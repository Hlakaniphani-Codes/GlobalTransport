const express = require('express');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const validateQuery = require('../middleware/validateQuery');
const passengerTripService = require('../services/passengerTripService');
const {
  passengerTripListQuerySchema,
  passengerTripParamsSchema,
  passengerTripRatingSchema,
} = require('../validators/passengerRideValidators');

const router = express.Router();
router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('passenger'));

router.get('/', validateQuery(passengerTripListQuerySchema), async (req, res, next) => {
  try {
    const result = req.validatedQuery.scope === 'history'
      ? await passengerTripService.listHistoryPage(
        req.auth.userId,
        req.validatedQuery.cursor,
        req.validatedQuery.page_size
      )
      : await passengerTripService.listUpcomingPage(
        req.auth.userId,
        req.validatedQuery
      );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:tripId/rating',
  validateParams(passengerTripParamsSchema),
  validate(passengerTripRatingSchema),
  async (req, res, next) => {
    try {
      const rating = await passengerTripService.rateMine(
        req.auth.userId,
        req.validatedParams.tripId,
        req.validatedBody
      );
      res.status(201).json({ rating });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:tripId', validateParams(passengerTripParamsSchema), async (req, res, next) => {
  try {
    const trip = await passengerTripService.getMine(
      req.auth.userId,
      req.validatedParams.tripId
    );
    res.json({ trip });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
