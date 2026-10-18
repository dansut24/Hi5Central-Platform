-- The running legacy environment-action operator is NOT the API/ITSM
-- deployment-job executor. A customer approval must fail closed unless
-- a separately configured trusted executor has recently reported readiness.
-- This table records operator presence only; it never grants deployment.
CREATE TABLE IF NOT EXISTS platform_application_release_executor_heartbeats (
  worker_id text PRIMARY KEY CHECK (worker_id='managed-vps-api-itsm-v1'),
  capability text NOT NULL CHECK (capability='api-itsm-live-backup-rollback'),
  observed_at timestamptz NOT NULL DEFAULT now()
);
