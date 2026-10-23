const { z } = require('zod');

const seriesParamsSchema = z.object({ seriesId: z.string().uuid() });
const offerSchema = z.object({
  driver_ids: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'A driver can only be listed once.'),
  window_minutes: z.number().int().min(1).max(1440).default(30),
});

module.exports = { offerSchema, seriesParamsSchema };
