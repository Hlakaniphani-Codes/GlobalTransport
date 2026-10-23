ALTER TABLE notification_jobs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS notifications_read_retention_idx
  ON notifications (read_at, id)
  WHERE read_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_tokens_revoked_retention_idx
  ON push_tokens (revoked_at, id)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_jobs_notification_pending_idx
  ON notification_jobs (notification_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notification_jobs_notification_finished_idx
  ON notification_jobs (notification_id, id)
  WHERE status IN ('sent','failed','skipped');

CREATE INDEX IF NOT EXISTS notification_jobs_finished_at_idx
  ON notification_jobs (finished_at, id)
  WHERE status IN ('sent','failed','skipped');
