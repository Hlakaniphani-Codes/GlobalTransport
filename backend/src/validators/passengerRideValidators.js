const { z } = require('zod');

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid date.');

const repeatSchema = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, 'Choose each weekday only once.'),
  until: localDateSchema,
});

const MAX_BOOKING_ADVANCE_DAYS = 7;
const JOHANNESBURG_OFFSET_MS = 2 * 60 * 60 * 1000;

function latestBookingDate(nowMs) {
  const latestDate = new Date(nowMs + JOHANNESBURG_OFFSET_MS);
  latestDate.setUTCDate(latestDate.getUTCDate() + MAX_BOOKING_ADVANCE_DAYS);
  return latestDate.toISOString().slice(0, 10);
}

const rideRequestCreateSchema = z.object({
  direction: z.enum(['to_work', 'home']),
  date: localDateSchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid 24-hour time.'),
  repeat: repeatSchema.optional(),
}).superRefine((value, context) => {
  const dateMs = Date.parse(`${value.date}T00:00:00.000Z`);
  const nowMs = Date.now();
  const bookingLimitDate = latestBookingDate(nowMs);
  const scheduledAt = Date.parse(`${value.date}T${value.time}:00+02:00`);
  if (scheduledAt <= nowMs) {
    context.addIssue({
      code: 'custom',
      path: ['time'],
      message: 'Choose a future date and time.',
    });
  }
  if (value.date > bookingLimitDate) {
    context.addIssue({
      code: 'custom',
      path: ['date'],
      message: 'Choose a date and time within the next 7 days.',
    });
  }

  if (value.repeat) {
    const untilMs = Date.parse(`${value.repeat.until}T00:00:00.000Z`);
    const daysApart = Math.floor((untilMs - dateMs) / 86_400_000);
    if (daysApart < 0 || daysApart > MAX_BOOKING_ADVANCE_DAYS || value.repeat.until > bookingLimitDate) {
      context.addIssue({
        code: 'custom',
        path: ['repeat', 'until'],
        message: 'The repeat end date must be within the next 7 days.',
      });
    }
  }
});

const rideRequestCancelSchema = z.object({
  scope: z.enum(['this', 'series']),
});

const requestParamsSchema = z.object({ requestId: z.string().uuid() });
const rideRequestListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
const passengerTripParamsSchema = z.object({ tripId: z.string().uuid() });
const passengerTripListQuerySchema = z.object({
  scope: z.enum(['upcoming', 'history']).default('upcoming'),
  cursor: z.string().max(512).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
const passengerTripRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

module.exports = {
  passengerTripParamsSchema,
  passengerTripListQuerySchema,
  passengerTripRatingSchema,
  requestParamsSchema,
  rideRequestListQuerySchema,
  rideRequestCancelSchema,
  rideRequestCreateSchema,
};
