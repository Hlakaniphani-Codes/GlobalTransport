ALTER TABLE trip_stops
  ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skip_kind TEXT;

ALTER TABLE trip_stops
  DROP CONSTRAINT IF EXISTS trip_stops_status_check;
ALTER TABLE trip_stops
  ADD CONSTRAINT trip_stops_status_check
  CHECK (status IN ('pending','en_route','arrived','completed','skipped'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trip_stops'::regclass
      AND conname = 'trip_stops_skip_kind_check'
  ) THEN
    ALTER TABLE trip_stops
      ADD CONSTRAINT trip_stops_skip_kind_check
      CHECK (skip_kind IN ('no_show','unreachable','address_problem','passenger_declined','cancelled','other'));
  END IF;
END;
$$;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS has_issues BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delay_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delay_reported_at TIMESTAMPTZ;

ALTER TABLE ride_requests
  DROP CONSTRAINT IF EXISTS ride_requests_status_check;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_status_check
  CHECK (status IN ('pending','assigned','completed','cancelled','no_show','missed','expired'));

CREATE TABLE IF NOT EXISTS trip_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id UUID NULL REFERENCES trip_stops(id),
  event_type TEXT NOT NULL,
  actor_user_id UUID NULL REFERENCES users(id),
  actor_role TEXT,
  client_time TIMESTAMPTZ NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_events_trip_created_idx
  ON trip_events (trip_id, created_at);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NULL REFERENCES trips(id),
  reported_by UUID NOT NULL REFERENCES users(id),
  reporter_role TEXT,
  type TEXT NOT NULL CHECK (type IN ('emergency','vehicle_problem','passenger_issue','driver_issue','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID NULL REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL REFERENCES users(id),
  resolved_at TIMESTAMPTZ NULL,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS incidents_status_created_idx
  ON incidents (status, created_at);

CREATE TABLE IF NOT EXISTS trip_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  passenger_user_id UUID NOT NULL REFERENCES passengers(user_id),
  driver_user_id UUID NOT NULL REFERENCES drivers(user_id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, passenger_user_id)
);
