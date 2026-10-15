-- Persist per-tenant blackout periods and expected cutover duration.
-- Backward-compatible metadata change. No existing jobs are started and the
-- global platform rollout kill-switch stays paused.
ALTER TABLE tenant_release_preferences
  ADD COLUMN IF NOT EXISTS blackout_periods jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenant_release_preferences
  DROP CONSTRAINT IF EXISTS tenant_release_preferences_blackout_periods_array;
ALTER TABLE tenant_release_preferences
  ADD CONSTRAINT tenant_release_preferences_blackout_periods_array
    CHECK (jsonb_typeof(blackout_periods)='array') NOT VALID;
ALTER TABLE tenant_release_preferences
  VALIDATE CONSTRAINT tenant_release_preferences_blackout_periods_array;
ALTER TABLE tenant_release_rollout_jobs
  ADD COLUMN IF NOT EXISTS expected_duration_minutes integer NOT NULL DEFAULT 15
  CHECK(expected_duration_minutes BETWEEN 1 AND 240);
-- The trusted worker must recheck the active window, blackout and required
-- remaining duration at claim time and again immediately before route switch.
