ALTER TABLE trip_stops
  ADD COLUMN IF NOT EXISTS eta_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eta_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eta_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eta_notified_for TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS trip_stops_trip_status_idx
  ON trip_stops (trip_id, status);

CREATE OR REPLACE FUNCTION clear_trip_stop_eta_on_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('arrived', 'completed', 'skipped') THEN
    NEW.eta_at := NULL;
    NEW.eta_updated_at := NULL;
    NEW.eta_notified_at := NULL;
    NEW.eta_notified_for := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trip_stops_clear_eta_on_progress ON trip_stops;
CREATE TRIGGER trip_stops_clear_eta_on_progress
BEFORE UPDATE OF status ON trip_stops
FOR EACH ROW EXECUTE FUNCTION clear_trip_stop_eta_on_progress();
