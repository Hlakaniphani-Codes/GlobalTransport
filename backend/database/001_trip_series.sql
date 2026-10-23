ALTER TABLE passengers
  ADD COLUMN IF NOT EXISTS home_suburb TEXT,
  ADD COLUMN IF NOT EXISTS workplace_suburb TEXT;

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS series_id UUID,
  ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'passenger',
  ADD COLUMN IF NOT EXISTS booked_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_late BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ride_requests DROP CONSTRAINT IF EXISTS ride_requests_status_check;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_status_check
  CHECK (status IN ('pending','assigned','completed','cancelled','no_show','missed','expired'));
ALTER TABLE ride_requests DROP CONSTRAINT IF EXISTS ride_requests_booking_source_check;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_booking_source_check
  CHECK (booking_source IN ('passenger','admin'));

CREATE TABLE IF NOT EXISTS trip_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS series_id UUID,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS workplace_name TEXT,
  ADD COLUMN IF NOT EXISTS workplace_address TEXT,
  ADD COLUMN IF NOT EXISTS distance_km NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

DO $$
DECLARE
  existing_trip RECORD;
  assigned_driver_constraint RECORD;
BEGIN
  ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_status_check;
  UPDATE trips SET status = 'offered' WHERE status = 'offering';
  UPDATE trips SET status = 'accepted' WHERE status = 'assigned';
  UPDATE trips SET starts_at = scheduled_at WHERE starts_at IS NULL;

  FOR existing_trip IN
    SELECT id, created_by, created_at
    FROM trips
    WHERE series_id IS NULL
    ORDER BY created_at, id
  LOOP
    INSERT INTO trip_series (created_by, created_at)
    VALUES (existing_trip.created_by, existing_trip.created_at)
    RETURNING id INTO existing_trip.series_id;

    UPDATE trips SET series_id = existing_trip.series_id WHERE id = existing_trip.id;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trips'::regclass AND conname = 'trips_series_id_fkey'
  ) THEN
    ALTER TABLE trips
      ADD CONSTRAINT trips_series_id_fkey
      FOREIGN KEY (series_id) REFERENCES trip_series(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trips'::regclass AND conname = 'trips_driver_user_id_drivers_fkey'
  ) THEN
    ALTER TABLE trips
      ADD CONSTRAINT trips_driver_user_id_drivers_fkey
      FOREIGN KEY (driver_user_id) REFERENCES drivers(user_id) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE trips ALTER COLUMN series_id SET NOT NULL;
ALTER TABLE trips ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE trips
  ADD CONSTRAINT trips_status_check
  CHECK (status IN ('draft','offered','accepted','in_progress','completed','cancelled','unassigned','missed'));

ALTER TABLE trip_stops
  ADD COLUMN IF NOT EXISTS sequence INTEGER,
  ADD COLUMN IF NOT EXISTS skip_reason TEXT;

UPDATE trip_stops SET sequence = stop_order WHERE sequence IS NULL;
ALTER TABLE trip_stops ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE trip_stops DROP CONSTRAINT IF EXISTS trip_stops_status_check;
ALTER TABLE trip_stops
  ADD CONSTRAINT trip_stops_status_check
  CHECK (status IN ('pending','en_route','arrived','completed','skipped'));

ALTER TABLE trip_offers
  ADD COLUMN IF NOT EXISTS series_id UUID,
  ADD COLUMN IF NOT EXISTS position INTEGER,
  ADD COLUMN IF NOT EXISTS window_minutes INTEGER NOT NULL DEFAULT 30;

DO $$
DECLARE
  existing_offer RECORD;
BEGIN
  UPDATE trip_offers offer
  SET series_id = trip.series_id
  FROM trips trip
  WHERE offer.trip_id = trip.id
    AND offer.series_id IS NULL;

  UPDATE trip_offers
  SET position = offer_order
  WHERE position IS NULL;

  UPDATE trip_offers
  SET status = 'expired'
  WHERE status = 'skipped';

  FOR existing_offer IN
    SELECT id
    FROM (
      SELECT id, row_number() OVER (
        PARTITION BY series_id ORDER BY offered_at NULLS LAST, created_at, id
      ) AS pending_order
      FROM trip_offers
      WHERE status = 'pending'
    ) pending_offers
    WHERE pending_order > 1
  LOOP
    UPDATE trip_offers SET status = 'queued' WHERE id = existing_offer.id;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trip_offers'::regclass AND conname = 'trip_offers_series_id_fkey'
  ) THEN
    ALTER TABLE trip_offers
      ADD CONSTRAINT trip_offers_series_id_fkey
      FOREIGN KEY (series_id) REFERENCES trip_series(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trip_offers'::regclass AND conname = 'trip_offers_driver_user_id_drivers_fkey'
  ) THEN
    ALTER TABLE trip_offers
      ADD CONSTRAINT trip_offers_driver_user_id_drivers_fkey
      FOREIGN KEY (driver_user_id) REFERENCES drivers(user_id) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE trip_offers ALTER COLUMN series_id SET NOT NULL;
ALTER TABLE trip_offers ALTER COLUMN position SET NOT NULL;
ALTER TABLE trip_offers ALTER COLUMN status SET DEFAULT 'queued';
ALTER TABLE trip_offers DROP CONSTRAINT IF EXISTS trip_offers_status_check;
ALTER TABLE trip_offers
  ADD CONSTRAINT trip_offers_status_check
  CHECK (status IN ('queued','pending','accepted','declined','expired','cancelled'));

DROP INDEX IF EXISTS trip_offers_one_pending_per_driver_uq;
CREATE UNIQUE INDEX IF NOT EXISTS trip_offers_one_pending_per_series_uq
  ON trip_offers (series_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS trips_status_scheduled_idx ON trips (status, scheduled_at);
CREATE INDEX IF NOT EXISTS trips_series_idx ON trips (series_id);
CREATE INDEX IF NOT EXISTS trips_driver_status_scheduled_idx
  ON trips (driver_user_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS trip_stops_trip_sequence_idx ON trip_stops (trip_id, sequence);
CREATE INDEX IF NOT EXISTS trip_stops_ride_request_idx ON trip_stops (ride_request_id);
CREATE INDEX IF NOT EXISTS trip_offers_driver_status_idx ON trip_offers (driver_user_id, status);
CREATE INDEX IF NOT EXISTS trip_offers_pending_expiry_idx
  ON trip_offers (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ride_requests_status_scheduled_idx
  ON ride_requests (status, scheduled_at);
CREATE INDEX IF NOT EXISTS ride_requests_series_idx ON ride_requests (series_id);
