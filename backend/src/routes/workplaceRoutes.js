const express = require('express');
const operationsController = require('../controllers/operationsController');
const validateQuery = require('../middleware/validateQuery');
const { responseCacheMiddleware } = require('../middleware/responseCache');
const { paginationQuerySchema } = require('../validators/operationsValidators');

const router = express.Router();

router.use(responseCacheMiddleware);
router.get('/', validateQuery(paginationQuerySchema), operationsController.listPublicWorkplaces);

module.exports = router;
