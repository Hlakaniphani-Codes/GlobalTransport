CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  province TEXT NOT NULL DEFAULT 'Gauteng',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('driver','passenger','admin')),
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  terms_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email CITEXT,
  contact_number TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_name_uq ON companies (lower(name));

CREATE TABLE IF NOT EXISTS drivers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  id_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','suspended')),
  licence_number TEXT,
  licence_expiry DATE,
  photo_url TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  prdp_number TEXT,
  prdp_expiry DATE,
  is_available BOOLEAN NOT NULL DEFAULT FALSE,
  available_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workplaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  address TEXT,
  suburb TEXT,
  latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  area_id UUID REFERENCES areas(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passengers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  employee_number TEXT NOT NULL,
  workplace TEXT,
  emergency_contact_name TEXT,
  emergency_contact_number TEXT,
  workplace_id UUID REFERENCES workplaces(id) ON DELETE RESTRICT,
  home_suburb TEXT,
  home_latitude DOUBLE PRECISION CHECK (home_latitude BETWEEN -90 AND 90),
  home_longitude DOUBLE PRECISION CHECK (home_longitude BETWEEN -180 AND 180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE passengers
  ADD COLUMN IF NOT EXISTS workplace_id UUID REFERENCES workplaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS home_suburb TEXT,
  ADD COLUMN IF NOT EXISTS home_latitude DOUBLE PRECISION CHECK (home_latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS home_longitude DOUBLE PRECISION CHECK (home_longitude BETWEEN -180 AND 180);

CREATE TABLE IF NOT EXISTS ride_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_user_id UUID NOT NULL REFERENCES passengers(user_id) ON DELETE CASCADE,
  workplace_id UUID NOT NULL REFERENCES workplaces(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('to_work','home')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled')),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year SMALLINT NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  colour TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  seat_count SMALLINT NOT NULL CHECK (seat_count BETWEEN 1 AND 80),
  licence_disc_expiry DATE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','retired')),
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction TEXT NOT NULL CHECK (direction IN ('to_work','home')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'offering'
    CHECK (status IN ('offering','assigned','accepted','in_progress','completed','cancelled','unassigned')),
  driver_user_id UUID REFERENCES users(id),
  vehicle_id UUID REFERENCES vehicles(id),
  created_by UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at >= scheduled_at)
);

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES trips(id) ON DELETE SET NULL;

ALTER TABLE ride_requests
  DROP CONSTRAINT IF EXISTS ride_requests_status_check;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_status_check
  CHECK (status IN ('pending','cancelled','assigned','completed','no_show','missed','expired'));

CREATE TABLE IF NOT EXISTS trip_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ride_request_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE RESTRICT,
  passenger_user_id UUID NOT NULL REFERENCES passengers(user_id) ON DELETE RESTRICT,
  stop_order INTEGER NOT NULL CHECK (stop_order > 0),
  stop_type TEXT NOT NULL CHECK (stop_type IN ('pickup','dropoff')),
  address TEXT NOT NULL,
  suburb TEXT,
  latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  planned_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','arrived','completed')),
  arrived_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, stop_order),
  UNIQUE (trip_id, ride_request_id, stop_type)
);

ALTER TABLE trip_stops
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','arrived','completed')),
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS trip_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  offer_order INTEGER NOT NULL CHECK (offer_order > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','pending','accepted','declined','expired','cancelled','skipped')),
  offered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, driver_user_id),
  UNIQUE (trip_id, offer_order)
);

CREATE UNIQUE INDEX IF NOT EXISTS passengers_workplace_employee_uq ON passengers (lower(workplace), employee_number);
CREATE UNIQUE INDEX IF NOT EXISTS passengers_workplace_id_employee_uq ON passengers (workplace_id, employee_number)
  WHERE workplace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_active_name_prefix_idx ON users (lower(name) text_pattern_ops)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS users_active_surname_prefix_idx ON users (lower(surname) text_pattern_ops)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS users_active_full_name_prefix_idx
  ON users (lower(name || ' ' || surname) text_pattern_ops)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS users_name_prefix_idx ON users (lower(name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS users_surname_prefix_idx ON users (lower(surname) text_pattern_ops);
CREATE INDEX IF NOT EXISTS users_email_prefix_idx ON users (lower(email) text_pattern_ops);
CREATE INDEX IF NOT EXISTS users_contact_prefix_idx ON users (lower(contact_number) text_pattern_ops);
CREATE INDEX IF NOT EXISTS users_full_name_prefix_idx
  ON users (lower(name || ' ' || surname) text_pattern_ops);
CREATE INDEX IF NOT EXISTS drivers_status_idx ON drivers (status);
CREATE INDEX IF NOT EXISTS drivers_pending_created_idx ON drivers (created_at, user_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_registration_number_uq ON vehicles (lower(registration_number));
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_one_live_per_driver_uq ON vehicles (driver_user_id)
  WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS vehicles_status_idx ON vehicles (status);
CREATE INDEX IF NOT EXISTS vehicles_pending_created_idx ON vehicles (created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS vehicles_pending_make_prefix_idx ON vehicles (lower(make) text_pattern_ops)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS vehicles_pending_model_prefix_idx ON vehicles (lower(model) text_pattern_ops)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS vehicles_driver_user_id_idx ON vehicles (driver_user_id);
CREATE INDEX IF NOT EXISTS workplaces_active_company_idx ON workplaces (company_id, name) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS ride_requests_pending_schedule_idx ON ride_requests (scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ride_requests_passenger_created_idx ON ride_requests (passenger_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drivers_available_idx ON drivers (is_available) WHERE is_available = TRUE;
CREATE INDEX IF NOT EXISTS trips_driver_schedule_idx ON trips (driver_user_id, scheduled_at, ends_at)
  WHERE status IN ('accepted','in_progress');
CREATE INDEX IF NOT EXISTS trips_status_schedule_idx ON trips (status, scheduled_at);
CREATE INDEX IF NOT EXISTS trip_stops_trip_order_idx ON trip_stops (trip_id, stop_order);
CREATE INDEX IF NOT EXISTS trip_offers_driver_status_idx ON trip_offers (driver_user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS trip_offers_queued_idx ON trip_offers (trip_id, offer_order)
  WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS trip_offers_one_pending_per_driver_uq
  ON trip_offers (driver_user_id) WHERE status = 'pending';

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS drivers_set_updated_at ON drivers;
CREATE TRIGGER drivers_set_updated_at
  BEFORE UPDATE ON drivers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS companies_set_updated_at ON companies;
CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workplaces_set_updated_at ON workplaces;
CREATE TRIGGER workplaces_set_updated_at
  BEFORE UPDATE ON workplaces
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS passengers_set_updated_at ON passengers;
CREATE TRIGGER passengers_set_updated_at
  BEFORE UPDATE ON passengers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ride_requests_set_updated_at ON ride_requests;
CREATE TRIGGER ride_requests_set_updated_at
  BEFORE UPDATE ON ride_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS vehicles_set_updated_at ON vehicles;
CREATE TRIGGER vehicles_set_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trips_set_updated_at ON trips;
CREATE TRIGGER trips_set_updated_at
  BEFORE UPDATE ON trips
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
