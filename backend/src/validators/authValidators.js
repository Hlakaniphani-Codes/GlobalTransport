const { z } = require('zod');
const { normalizeSouthAfricanContactNumber } = require('../utils/contactNumber');
const { isValidSouthAfricanId } = require('../utils/saId');

const emailSchema = z
  .string()
  .trim()
  .email('Enter a valid email address.')
  .transform((email) => email.toLowerCase());

const contactNumberSchema = z
  .string()
  .trim()
  .transform(normalizeSouthAfricanContactNumber)
  .refine((number) => number !== null, 'Enter a valid South African contact number.');

const requiredText = (field) => z.string().trim().min(1, `${field} is required.`);
const passwordSchema = z
  .string()
  .trim()
  .min(8, 'Password must be at least 8 characters.');

const driverRegistrationSchema = z.object({
  name: requiredText('Name'),
  surname: requiredText('Surname'),
  address: requiredText('Address'),
  contact_number: contactNumberSchema,
  email: emailSchema,
  id_number: z
    .string()
    .trim()
    .refine(isValidSouthAfricanId, 'Enter a valid 13-digit South African ID number.'),
  password: passwordSchema,
  terms_accepted: z.literal(true),
});

const passengerRegistrationSchema = z.object({
  name: requiredText('Name'),
  surname: requiredText('Surname'),
  address: requiredText('Address'),
  home_suburb: requiredText('Home suburb').max(120),
  workplace_suburb: requiredText('Workplace suburb').max(120),
  employee_number: requiredText('Employee number'),
  workplace: requiredText('Workplace').max(160, 'Workplace must be 160 characters or fewer.'),
  contact_number: contactNumberSchema,
  email: emailSchema,
  password: passwordSchema,
  terms_accepted: z.literal(true),
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const changePasswordSchema = z.object({
  current_password: passwordSchema,
  new_password: passwordSchema,
});
const deleteAccountSchema = z.object({
  current_password: passwordSchema,
});

module.exports = {
  changePasswordSchema,
  deleteAccountSchema,
  contactNumberSchema,
  driverRegistrationSchema,
  emailSchema,
  loginSchema,
  passengerRegistrationSchema,
  passwordSchema,
  requiredText,
};
