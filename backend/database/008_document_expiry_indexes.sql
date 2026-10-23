CREATE INDEX IF NOT EXISTS drivers_licence_expiry_idx
  ON drivers (licence_expiry)
  WHERE licence_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS drivers_prdp_expiry_idx
  ON drivers (prdp_expiry)
  WHERE prdp_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicles_licence_disc_expiry_idx
  ON vehicles (licence_disc_expiry)
  WHERE licence_disc_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_events_no_show_created_idx
  ON trip_events (created_at DESC)
  WHERE event_type = 'stop.no_show';
CREATE INDEX IF NOT EXISTS trip_events_attention_flags_idx
  ON trip_events (event_type, created_at DESC)
  WHERE event_type IN ('trip.not_started_overdue', 'trip.running_long_overdue');
