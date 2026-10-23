const { z } = require('zod');

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

const adminWorkplacesQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
});

const companyParamsSchema = z.object({
  companyId: z.string().uuid(),
});

const workplaceParamsSchema = z.object({
  workplaceId: z.string().uuid(),
});

const rideRequestParamsSchema = z.object({
  requestId: z.string().uuid(),
});

const tripParamsSchema = z.object({
  tripId: z.string().uuid(),
});

const driverTripStopParamsSchema = z.object({
  tripId: z.string().uuid(),
  stopId: z.string().uuid(),
});

const tripStopProgressSchema = z.object({
  status: z.enum(['arrived', 'completed']),
});

const companySchema = z.object({
  name: z.string().trim().min(2).max(120),
});

const workplaceSchema = z.object({
  company_id: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().min(5).max(300),
  suburb: z.string().trim().min(2).max(120),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
}).refine(
  (value) => (value.latitude == null) === (value.longitude == null),
  'Enter both coordinates or leave both blank.'
);

const activeSchema = z.object({
  is_active: z.boolean(),
});

const rideRequestSchema = z.object({
  direction: z.enum(['to_work', 'home']),
  scheduled_at: z.iso.datetime({ offset: true }).refine(
    (value) => Date.parse(value) > Date.now() + 60_000,
    'Choose a time at least one minute in the future.'
  ),
});

const eligibleDriversQuerySchema = z.object({
  scheduled_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  passenger_count: z.coerce.number().int().min(1).max(80),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
}).refine(
  (value) => Date.parse(value.ends_at) > Date.parse(value.scheduled_at),
  'Trip end must be later than trip start.'
);

const tripSchema = z.object({
  direction: z.enum(['to_work', 'home']),
  scheduled_at: z.iso.datetime({ offset: true }).refine(
    (value) => Date.parse(value) > Date.now(),
    'Trip start must be in the future.'
  ),
  ends_at: z.iso.datetime({ offset: true }),
  ride_request_ids: z.array(z.string().uuid()).min(1).max(40),
  stop_order: z.array(z.object({
    ride_request_id: z.string().uuid(),
    stop_type: z.enum(['pickup', 'dropoff']),
  })).min(2).max(80),
  candidate_drivers: z.array(z.object({
    driver_user_id: z.string().uuid(),
    vehicle_id: z.string().uuid(),
  })).min(1).max(20),
}).refine(
  (value) => Date.parse(value.ends_at) > Date.parse(value.scheduled_at),
  { path: ['ends_at'], message: 'Trip end must be later than trip start.' }
).refine(
  (value) => new Set(value.ride_request_ids).size === value.ride_request_ids.length,
  { path: ['ride_request_ids'], message: 'A ride request can only be selected once.' }
).refine(
  (value) => new Set(value.candidate_drivers.map(({ driver_user_id }) => driver_user_id)).size
    === value.candidate_drivers.length,
  { path: ['candidate_drivers'], message: 'A driver can only be listed once.' }
).refine(
  (value) => {
    const expected = new Set(value.ride_request_ids.flatMap((id) => [
      `${id}:pickup`,
      `${id}:dropoff`,
    ]));
    const actual = value.stop_order.map(({ ride_request_id, stop_type }) =>
      `${ride_request_id}:${stop_type}`
    );
    return actual.length === expected.size
      && new Set(actual).size === actual.length
      && actual.every((stop) => expected.has(stop));
  },
  { path: ['stop_order'], message: 'Order every selected request pickup and drop-off exactly once.' }
);

const availabilitySchema = z.object({
  is_available: z.boolean(),
});

const offerParamsSchema = z.object({
  offerId: z.string().uuid(),
});

const offerResponseSchema = z.object({
  decision: z.enum(['accept', 'decline']),
});

const driverTripListQuerySchema = z.object({
  scope: z.enum(['upcoming', 'history']).default('upcoming'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});
const driverOfferListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

const stopSkipSchema = z.object({
  kind: z.enum(['no_show', 'unreachable', 'address_problem', 'passenger_declined', 'other']),
  reason: z.string().trim().min(1).max(500),
  client_time: z.iso.datetime({ offset: true }).optional(),
});

const driverTripActionShape = z.object({
  client_time: z.iso.datetime({ offset: true }).optional(),
});
const driverTripActionSchema = driverTripActionShape.default({});

const driverTripCompleteStopSchema = z.object({
  client_time: z.iso.datetime({ offset: true }).optional(),
  passenger_stop_ids: z.array(z.string().uuid()).min(1).max(80).optional(),
}).refine(
  (value) => !value.passenger_stop_ids
    || new Set(value.passenger_stop_ids).size === value.passenger_stop_ids.length,
  { path: ['passenger_stop_ids'], message: 'A passenger stop can only be selected once.' }
).default({});

const tripDelaySchema = driverTripActionShape.extend({
  minutes: z.union([
    z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30),
  ]),
  note: z.string().trim().max(500).optional(),
});
const driverTripEtaSchema = z.object({
  minutes: z.number().int().min(1).max(120),
});

const driverTripWithdrawSchema = z.object({
  reason_kind: z.enum([
    'vehicle_problem',
    'illness_or_emergency',
    'personal',
    'schedule_conflict',
    'other',
  ]),
  note: z.string().trim().max(500).optional(),
  scope: z.enum(['this', 'all_future']).default('this'),
}).refine(
  (value) => value.reason_kind !== 'other' || (value.note?.length ?? 0) >= 5,
  { path: ['note'], message: 'Add a note of at least five characters for Other.' }
);

const driverTripNotHappenedSchema = z.object({
  reason_kind: z.enum([
    'could_not_start',
    'vehicle_problem',
    'passengers_unavailable',
    'cancelled_by_company',
    'other',
  ]),
  note: z.string().trim().max(500).optional(),
}).refine(
  (value) => value.reason_kind !== 'other' || (value.note?.length ?? 0) >= 5,
  { path: ['note'], message: 'Add a note of at least five characters for Other.' }
);

const driverTripEndEarlySchema = z.object({
  reason: z.enum(['vehicle_problem', 'other']),
  note: z.string().trim().max(1000).optional(),
}).refine(
  (value) => value.reason !== 'other' || (value.note?.length ?? 0) >= 5,
  { path: ['note'], message: 'Add a note of at least five characters for Other.' }
);

module.exports = {
  activeSchema,
  adminWorkplacesQuerySchema,
  paginationQuerySchema,
  companyParamsSchema,
  companySchema,
  eligibleDriversQuerySchema,
  availabilitySchema,
  offerParamsSchema,
  offerResponseSchema,
  rideRequestParamsSchema,
  rideRequestSchema,
  driverTripStopParamsSchema,
  driverTripListQuerySchema,
  driverOfferListQuerySchema,
  driverTripActionSchema,
  driverTripCompleteStopSchema,
  driverTripEndEarlySchema,
  driverTripNotHappenedSchema,
  driverTripWithdrawSchema,
  driverTripEtaSchema,
  tripParamsSchema,
  tripSchema,
  tripStopProgressSchema,
  stopSkipSchema,
  tripDelaySchema,
  workplaceParamsSchema,
  workplaceSchema,
};
