const { z } = require('zod');

const incidentTypes = ['emergency', 'vehicle_problem', 'passenger_issue', 'driver_issue', 'other'];

const incidentParamsSchema = z.object({
  incidentId: z.string().uuid(),
});

const incidentCreateSchema = z.object({
  trip_id: z.string().uuid().optional(),
  type: z.enum(incidentTypes),
  description: z.string().trim().min(1).max(2000),
  client_time: z.iso.datetime({ offset: true }).optional(),
});

const incidentQuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
  type: z.enum(incidentTypes).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

const incidentResolutionSchema = z.object({
  note: z.string().trim().min(1).max(1000),
});

const forceCompleteSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  release_remaining: z.boolean(),
});

module.exports = {
  forceCompleteSchema,
  incidentCreateSchema,
  incidentParamsSchema,
  incidentQuerySchema,
  incidentResolutionSchema,
};
