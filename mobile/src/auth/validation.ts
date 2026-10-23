import type { UserRole } from '@/auth/AuthContext';

export type AuthFieldName =
  | 'name'
  | 'surname'
  | 'address'
  | 'home_suburb'
  | 'workplace_suburb'
  | 'contact_number'
  | 'email'
  | 'id_number'
  | 'employee_number'
  | 'workplace'
  | 'password'
  | 'confirm_password';

export type FieldErrors = Partial<Record<AuthFieldName, string>>;

export function isValidSouthAfricanPhone(value: string): boolean {
  return /^(?:\+27|0)[1-9]\d{8}$/.test(value.replace(/[\s()-]/g, ''));
}

export function normalizeSouthAfricanPhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, '');
  return compact.startsWith('0') ? `+27${compact.slice(1)}` : compact;
}

export function isValidSouthAfricanId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;

  const shortYear = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const validDate = [1900 + shortYear, 2000 + shortYear].some((year) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });

  if (!validDate) return false;

  const digits = [...value].map(Number);
  const oddSum = digits
    .slice(0, 12)
    .filter((_, index) => index % 2 === 0)
    .reduce((sum, digit) => sum + digit, 0);
  const evenSum = String(
    Number(digits.slice(0, 12).filter((_, index) => index % 2 === 1).join('')) * 2
  )
    .split('')
    .reduce((sum, digit) => sum + Number(digit), 0);

  return (oddSum + evenSum + digits[12]) % 10 === 0;
}

type RegistrationValues = Record<AuthFieldName, string>;

export function validateRegistration(
  role: Extract<UserRole, 'driver' | 'passenger'>,
  values: RegistrationValues
): FieldErrors {
  const errors: FieldErrors = {};

  for (const field of ['name', 'surname', 'address'] as const) {
    if (!values[field].trim()) {
      errors[field] = `${field[0].toUpperCase()}${field.slice(1)} is required.`;
    }
  }

  if (role === 'passenger') {
    if (!values.employee_number.trim()) errors.employee_number = 'Employee number is required.';
    if (!values.workplace.trim()) {
      errors.workplace = 'Company or workplace name is required.';
    } else if (values.workplace.trim().length > 160) {
      errors.workplace = 'Company or workplace name must be 160 characters or fewer.';
    }
    if (!values.home_suburb.trim()) errors.home_suburb = 'Home suburb is required.';
    if (!values.workplace_suburb.trim()) errors.workplace_suburb = 'Workplace suburb is required.';
  }

  if (!isValidSouthAfricanPhone(values.contact_number)) {
    errors.contact_number = 'Enter a valid South African contact number.';
  }

  const email = values.email.trim();
  if (!email) {
    errors.email = 'Email is required.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }

  if (role === 'driver' && !isValidSouthAfricanId(values.id_number.trim())) {
    errors.id_number = 'Enter a valid 13-digit South African ID number.';
  }

  const password = values.password.trim();
  if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }
  if (!values.confirm_password.trim()) {
    errors.confirm_password = 'Confirm password is required.';
  } else if (password !== values.confirm_password.trim()) {
    errors.confirm_password = 'Passwords do not match.';
  }

  return errors;
}

export function validateLogin(emailValue: string, passwordValue: string): FieldErrors {
  const errors: FieldErrors = {};
  const email = emailValue.trim();

  if (!email) {
    errors.email = 'Email is required.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (passwordValue.trim().length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }

  return errors;
}
