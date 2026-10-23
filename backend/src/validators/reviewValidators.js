const { z } = require('zod');
const { contactNumberSchema, emailSchema } = require('./authValidators');

const driverParamsSchema = z.object({ userId: z.string().uuid() });
const vehicleParamsSchema = z.object({ vehicleId: z.string().uuid() });
const passengerParamsSchema = z.object({ id: z.string().uuid() });

const passengerPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  surname: z.string().trim().min(1).max(120).optional(),
  email: emailSchema.optional(),
  contact_number: contactNumberSchema.optional(),
  address: z.string().trim().min(1).max(300).optional(),
  home_suburb: z.string().trim().min(1).max(120).optional(),
  workplace: z.string().trim().min(1).max(160).optional(),
  workplace_address: z.string().trim().min(1).max(300).optional(),
  workplace_suburb: z.string().trim().min(1).max(120).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one passenger detail to update.');

const reviewDecisionSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejection_reason: z.string().trim().max(500).optional(),
});

const driverDocumentsSchema = z.object({
  licence_number: z.string().trim().min(1).max(80),
  licence_expiry: z.iso.date(),
  prdp_expiry: z.iso.date().nullable().optional(),
});

const approvedDriversQuerySchema = z.object({
  search: z.string().trim().min(2).max(120),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

const pendingApplicationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(120).default('').refine(
    (value) => value.length === 0 || value.length >= 2,
    'Search must contain at least 2 characters.'
  ),
});

const passengerDirectoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).default('').refine(
    (value) => value.length === 0 || value.length >= 2,
    'Search must contain at least 2 characters.'
  ),
});

const driverDirectoryQuerySchema = passengerDirectoryQuerySchema;

const vehicleDetailsSchema = z.object({
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
  colour: z.string().trim().min(1).max(40),
  registration_number: z.string().trim().min(3).max(20).transform((value) => value.toUpperCase()),
  seat_count: z.number().int().min(1).max(80),
});

const vehicleSubmissionSchema = vehicleDetailsSchema;
const vehicleOnboardingSchema = vehicleDetailsSchema.extend({
  driver_user_id: z.string().uuid(),
});

module.exports = {
  driverParamsSchema,
  passengerParamsSchema,
  passengerPatchSchema,
  approvedDriversQuerySchema,
  pendingApplicationsQuerySchema,
  passengerDirectoryQuerySchema,
  driverDirectoryQuerySchema,
  reviewDecisionSchema,
  driverDocumentsSchema,
  vehicleParamsSchema,
  vehicleSubmissionSchema,
  vehicleOnboardingSchema,
};
