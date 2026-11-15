-- EPM Newtest: opt-in automatic start only for a user-selected, verified EXE.
-- Existing approvals and unknown-target native UAC reviews stay non-executable.
ALTER TABLE public.rmm_epm_file_requests
  ADD COLUMN IF NOT EXISTS auto_launch_on_approval boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rmm_epm_autolaunch_explorer_only'
      AND conrelid='public.rmm_epm_file_requests'::regclass
  ) THEN
    ALTER TABLE public.rmm_epm_file_requests
      ADD CONSTRAINT rmm_epm_autolaunch_explorer_only
      CHECK (NOT auto_launch_on_approval OR request_source='explorer');
  END IF;
END $$;
