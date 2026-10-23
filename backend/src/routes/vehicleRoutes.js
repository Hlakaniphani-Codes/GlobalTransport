const express = require('express');
const reviewController = require('../controllers/reviewController');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const {
  vehicleParamsSchema,
  vehicleSubmissionSchema,
} = require('../validators/reviewValidators');

const router = express.Router();

router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('driver'));
router.get('/mine', reviewController.listMine);
router.patch(
  '/:vehicleId/resubmit',
  validateParams(vehicleParamsSchema),
  validate(vehicleSubmissionSchema),
  reviewController.resubmitVehicle
);
router.post('/', validate(vehicleSubmissionSchema), reviewController.submitVehicle);

module.exports = router;
