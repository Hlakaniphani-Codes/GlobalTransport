ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS closed_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS change_ack_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS change_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;

ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_status_check;
ALTER TABLE trips
  ADD CONSTRAINT trips_status_check
  CHECK (status IN ('draft','offered','accepted','in_progress','completed','cancelled','unassigned','missed'));

ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_ends_at_check;
ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_check;

ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE ride_requests DROP CONSTRAINT IF EXISTS ride_requests_status_check;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_status_check
  CHECK (status IN ('pending','assigned','completed','cancelled','no_show','missed','expired'));

UPDATE trips trip
SET ends_at = GREATEST(
  trip.scheduled_at,
  COALESCE((
    SELECT stop.planned_at
    FROM trip_stops stop
    WHERE stop.trip_id = trip.id AND stop.planned_at IS NOT NULL
    ORDER BY stop.sequence DESC
    LIMIT 1
  ), trip.scheduled_at)
)
WHERE trip.ends_at IS DISTINCT FROM GREATEST(
  trip.scheduled_at,
  COALESCE((
    SELECT stop.planned_at
    FROM trip_stops stop
    WHERE stop.trip_id = trip.id AND stop.planned_at IS NOT NULL
    ORDER BY stop.sequence DESC
    LIMIT 1
  ), trip.scheduled_at)
);

ALTER TABLE trips
  ADD CONSTRAINT trips_ends_at_check CHECK (ends_at >= scheduled_at);

CREATE TABLE IF NOT EXISTS trip_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_user_id UUID NOT NULL REFERENCES drivers(user_id),
  reason_kind TEXT NOT NULL CHECK (
    reason_kind IN ('vehicle_problem','illness_or_emergency','personal','schedule_conflict','other')
  ),
  note TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('this','all_future')),
  late BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_withdrawals_driver_created_idx
  ON trip_withdrawals (driver_user_id, created_at);

CREATE INDEX IF NOT EXISTS trips_status_ends_idx ON trips (status, ends_at);
CREATE INDEX IF NOT EXISTS trips_driver_status_ends_idx
  ON trips (driver_user_id, status, ends_at);
CREATE INDEX IF NOT EXISTS ride_requests_status_scheduled_idx
  ON ride_requests (status, scheduled_at);

CREATE OR REPLACE FUNCTION sync_trip_ends_at_from_stops()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_trip_id UUID;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.trip_id <> NEW.trip_id) THEN
    affected_trip_id := OLD.trip_id;
    UPDATE trips trip
    SET ends_at = GREATEST(trip.scheduled_at, COALESCE((
      SELECT stop.planned_at
      FROM trip_stops stop
      WHERE stop.trip_id = affected_trip_id AND stop.planned_at IS NOT NULL
      ORDER BY stop.sequence DESC
      LIMIT 1
    ), trip.scheduled_at))
    WHERE trip.id = affected_trip_id;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    affected_trip_id := NEW.trip_id;
    UPDATE trips trip
    SET ends_at = GREATEST(trip.scheduled_at, COALESCE((
      SELECT stop.planned_at
      FROM trip_stops stop
      WHERE stop.trip_id = affected_trip_id AND stop.planned_at IS NOT NULL
      ORDER BY stop.sequence DESC
      LIMIT 1
    ), trip.scheduled_at))
    WHERE trip.id = affected_trip_id;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trip_stops_sync_ends_at ON trip_stops;
CREATE TRIGGER trip_stops_sync_ends_at
AFTER INSERT OR UPDATE OF trip_id, sequence, planned_at OR DELETE ON trip_stops
FOR EACH ROW EXECUTE FUNCTION sync_trip_ends_at_from_stops();
