DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'ride_requests'::regclass
      AND conname = 'ride_requests_series_id_fkey'
  ) THEN
    ALTER TABLE ride_requests
      ADD CONSTRAINT ride_requests_series_id_fkey
      FOREIGN KEY (series_id) REFERENCES trip_series(id) NOT VALID;
  END IF;
END;
$$;
