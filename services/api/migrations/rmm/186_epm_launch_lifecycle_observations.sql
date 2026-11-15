-- Newtest EPM: record OS process lifecycle, not installation success.
-- This avoids equating redeemed approval with installer completion.
ALTER TABLE rmm_epm_file_requests
  ADD COLUMN IF NOT EXISTS launch_pid integer,
  ADD COLUMN IF NOT EXISTS launch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS launch_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS launch_exit_code bigint,
  ADD COLUMN IF NOT EXISTS launch_end_reason text,
  ADD COLUMN IF NOT EXISTS launch_elapsed_ms integer;

ALTER TABLE rmm_epm_file_requests
  DROP CONSTRAINT IF EXISTS rmm_epm_launch_pid_range;
ALTER TABLE rmm_epm_file_requests
  ADD CONSTRAINT rmm_epm_launch_pid_range
  CHECK (launch_pid IS NULL OR launch_pid BETWEEN 1 AND 2147483647);

ALTER TABLE rmm_epm_file_requests
  DROP CONSTRAINT IF EXISTS rmm_epm_launch_reason_allowed;
ALTER TABLE rmm_epm_file_requests
  ADD CONSTRAINT rmm_epm_launch_reason_allowed
  CHECK (launch_end_reason IS NULL OR launch_end_reason IN
    ('job-empty','timeout','job-query-error','monitor-error','service-stopped'));
