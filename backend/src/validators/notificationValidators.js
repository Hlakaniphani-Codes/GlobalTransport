const { z } = require('zod');

const expoTokenSchema = z.string().regex(
  /^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{10,}\]$/,
  'Enter a valid Expo push token.'
);

const deviceSchema = z.object({
  token: expoTokenSchema,
  platform: z.enum(['ios', 'android']),
  device_name: z.string().trim().max(120).optional(),
});

const notificationParamsSchema = z.object({
  id: z.string().uuid(),
});

const deviceTokenParamsSchema = z.object({
  token: expoTokenSchema,
});

const notificationQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
});

const notificationPreferencesSchema = z.object({
  push_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
}).refine(
  (value) => value.push_enabled !== undefined || value.sms_enabled !== undefined,
  'Choose at least one notification preference.'
);

const notificationAdminQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  type: z.string().trim().min(1).max(80).optional(),
});

module.exports = {
  deviceSchema,
  deviceTokenParamsSchema,
  notificationAdminQuerySchema,
  notificationParamsSchema,
  notificationPreferencesSchema,
  notificationQuerySchema,
};
