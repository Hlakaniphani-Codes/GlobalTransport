CREATE INDEX IF NOT EXISTS notification_jobs_pending_due_idx
  ON notification_jobs (next_attempt_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS trips_live_started_idx
  ON trips (started_at, id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS trips_change_ack_schedule_idx
  ON trips (scheduled_at, id)
  WHERE status IN ('accepted', 'in_progress') AND change_ack_required = TRUE;

CREATE INDEX IF NOT EXISTS trip_stops_trip_passenger_type_sequence_idx
  ON trip_stops (trip_id, passenger_user_id, stop_type, sequence);

CREATE INDEX IF NOT EXISTS trip_withdrawals_recent_idx
  ON trip_withdrawals (created_at DESC, late);

CREATE INDEX IF NOT EXISTS trip_offers_declined_recent_idx
  ON trip_offers (responded_at DESC, id)
  WHERE status = 'declined';