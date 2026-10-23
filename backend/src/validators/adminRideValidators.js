const { z } = require('zod');

const requestQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['asc', 'desc']).default('desc'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(['to_work', 'home']).optional(),
  status: z.enum(['pending', 'assigned', 'completed', 'cancelled', 'no_show', 'missed', 'expired']).optional(),
  unassigned_only: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  search: z.string().trim().max(120).default(''),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  path: ['to'],
  message: 'End date must not be before start date.',
});

const cancelRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });

module.exports = {
  cancelRequestSchema,
  requestQuerySchema,
};
