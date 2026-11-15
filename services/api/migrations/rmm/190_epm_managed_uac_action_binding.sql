-- Newtest-only managed UAC action identity; unknown UAC requests remain
-- review-only. The operation code and SHA256 of its *fixed* argument string
-- bind each one-time approval to a specific, pre-registered Windows action.
ALTER TABLE public.rmm_epm_file_requests
  ADD COLUMN IF NOT EXISTS managed_action_code text,
  ADD COLUMN IF NOT EXISTS managed_arguments_sha256 text;

ALTER TABLE public.rmm_epm_file_requests
  DROP CONSTRAINT IF EXISTS rmm_epm_file_requests_request_source_check,
  DROP CONSTRAINT IF EXISTS rmm_epm_autolaunch_explorer_only;

ALTER TABLE public.rmm_epm_file_requests
  ADD CONSTRAINT rmm_epm_file_requests_request_source_check
    CHECK (request_source IN ('explorer','native-uac','managed-uac')),
  ADD CONSTRAINT rmm_epm_autolaunch_explorer_only
    CHECK (NOT auto_launch_on_approval OR request_source IN ('explorer','managed-uac')),
  ADD CONSTRAINT rmm_epm_managed_uac_binding
    CHECK (
      (request_source='managed-uac'
        AND auto_launch_on_approval
        AND managed_action_code IN ('notepad','regedit','services','powershell','msiexec-help')
        AND managed_arguments_sha256 ~ '^[A-F0-9]{64}$')
      OR (request_source!='managed-uac'
        AND managed_action_code IS NULL
        AND managed_arguments_sha256 IS NULL)
    );
