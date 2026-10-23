const { z } = require('zod');

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid date.');
const tripCreateSchema = z.object({
  direction: z.enum(['to_work', 'home']),
  dates: z.array(dateSchema).min(1).max(31),
  target_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  workplace_name: z.string().trim().min(1).max(160),
  workplace_address: z.string().trim().min(1).max(300),
  distance_km: z.number().min(0).max(99999.9).optional(),
  notes: z.string().trim().max(2000).optional(),
  stops: z.array(z.object({
    ride_request_id: z.string().uuid(),
    stop_type: z.enum(['pickup', 'dropoff']),
    sequence: z.number().int().min(1),
    planned_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })).min(2).max(160),
}).refine((value) => new Set(value.dates).size === value.dates.length, {
  path: ['dates'],
  message: 'Choose each trip date only once.',
}).refine((value) => value.direction !== 'to_work' || Boolean(value.target_time), {
  path: ['target_time'],
  message: 'Set the workplace arrival time for trips going to work.',
}).refine((value) => {
  const requestIds = new Set(value.stops.map(({ ride_request_id }) => ride_request_id));
  const counts = new Map();
  for (const stop of value.stops) {
    const pair = counts.get(stop.ride_request_id) ?? [];
    pair.push(stop.stop_type);
    counts.set(stop.ride_request_id, pair);
  }
  return [...counts.values()].every((types) =>
    types.length === 2 && types.includes('pickup') && types.includes('dropoff')
  ) && requestIds.size * 2 === value.stops.length
    && value.stops.every((stop, index) =>
      stop.sequence === index + 1
    );
}, {
  path: ['stops'],
  message: 'Each passenger must have one ordered pick-up and drop-off stop.',
}).refine((value) => value.stops.every((stop, index) =>
  index === 0 || value.stops[index - 1].planned_time <= stop.planned_time
), {
  path: ['stops'],
  message: 'Stop times must follow the stop order.',
});
const tripDatePreviewSchema = z.object({
  direction: z.enum(['to_work', 'home']),
  dates: z.array(dateSchema).min(1).max(31),
  request_ids: z.array(z.string().uuid()).min(1).max(40),
}).refine((value) => new Set(value.dates).size === value.dates.length, {
  path: ['dates'],
  message: 'Choose each trip date only once.',
}).refine((value) => new Set(value.request_ids).size === value.request_ids.length, {
  path: ['request_ids'],
  message: 'Choose each passenger request only once.',
});

const tripListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['draft', 'offered', 'accepted', 'in_progress', 'completed', 'cancelled', 'unassigned', 'missed']).optional(),
  direction: z.enum(['to_work', 'home']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  driver_id: z.string().uuid().optional(),
  search: z.string().trim().max(120).default(''),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  path: ['to'],
  message: 'End date must not be before start date.',
});

const tripPatchSchema = z.object({
  scheduled_at: z.iso.datetime({ offset: true }).refine(
    (value) => Date.parse(value) > Date.now(),
    'Choose a trip time in the future.'
  ).optional(),
  stops: z.array(z.object({
    id: z.string().uuid(),
    sequence: z.number().int().min(1),
    planned_at: z.iso.datetime({ offset: true }),
  })).min(2).max(160).optional(),
  workplace_name: z.string().trim().min(1).max(160).optional(),
  workplace_address: z.string().trim().min(1).max(300).optional(),
  distance_km: z.number().min(0).max(99999.9).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide trip details to update.')
  .refine((value) => !value.stops || value.stops.every((stop, index) =>
    index === 0 || Date.parse(value.stops[index - 1].planned_at) <= Date.parse(stop.planned_at)
  ), {
    path: ['stops'],
    message: 'Stop times must follow the stop order.',
  });

const tripCancelSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const tripRescheduleSchema = z.object({
  new_scheduled_at: z.iso.datetime({ offset: true }).refine(
    (value) => Date.parse(value) > Date.now(),
    'Choose a new trip time in the future.'
  ),
  shift_stops: z.boolean().default(true),
  keep_driver: z.boolean().default(false),
});
const tripMarkMissedSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
const tripNotifyPassengersSchema = z.discriminatedUnion('template', [
  z.object({
    template: z.literal('delayed'),
    minutes: z.number().int().min(1).max(1440),
  }),
  z.object({ template: z.literal('rescheduled') }),
  z.object({ template: z.literal('cancelled') }),
  z.object({
    template: z.literal('custom'),
    message: z.string().trim().min(1).max(160),
  }),
]);
const removePassengerSchema = z.object({
  ride_request_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  kind: z.enum(['no_show', 'cancelled']),
});

module.exports = {
  removePassengerSchema,
  tripCancelSchema,
  tripCreateSchema,
  tripDatePreviewSchema,
  tripListQuerySchema,
  tripMarkMissedSchema,
  tripNotifyPassengersSchema,
  tripPatchSchema,
  tripRescheduleSchema,
};
