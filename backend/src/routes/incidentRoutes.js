const express = require('express');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const { generalUserRateLimit, writeUserRateLimit } = require('../middleware/userRateLimit');
const validate = require('../middleware/validate');
const incidentController = require('../controllers/incidentController');
const { incidentCreateSchema } = require('../validators/incidentValidators');

const router = express.Router();
router.use(authenticate, generalUserRateLimit, writeUserRateLimit, requireRole('driver', 'passenger'));
router.post('/', validate(incidentCreateSchema), incidentController.create);

module.exports = router;
