-- Secure EPM failure telemetry for controlled Windows elevation pilot.
-- Store only fixed stage identifiers and numeric Win32 codes, never tokens, secrets or passwords.
ALTER TABLE rmm_epm_file_requests
    ADD COLUMN IF NOT EXISTS launch_failure_stage text,
    ADD COLUMN IF NOT EXISTS launch_failure_code integer,
    ADD COLUMN IF NOT EXISTS launch_failure_at timestamptz;

ALTER TABLE rmm_epm_file_requests
    DROP CONSTRAINT IF EXISTS rmm_epm_failure_code_bounds;
ALTER TABLE rmm_epm_file_requests
    ADD CONSTRAINT rmm_epm_failure_code_bounds
    CHECK (launch_failure_code IS NULL OR launch_failure_code BETWEEN 0 AND 65535);
