-- EPM risk controls: permit a distinct second technician to approve a
-- critical managed operation. A first approval NEVER sets status=approved.
-- Legacy Newtest records remain unaffected.
ALTER TABLE public.rmm_epm_file_requests
  ADD COLUMN IF NOT EXISTS first_approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS first_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_approval_note text;
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.rmm_epm_file_requests'::regclass
     AND conname='rmm_epm_first_approval_fields_check'
 ) THEN
  ALTER TABLE public.rmm_epm_file_requests
   ADD CONSTRAINT rmm_epm_first_approval_fields_check
   CHECK (
    (first_approved_by_user_id IS NULL AND first_approved_at IS NULL AND first_approval_note IS NULL)
    OR (first_approved_by_user_id IS NOT NULL AND first_approved_at IS NOT NULL
         AND first_approval_note IS NOT NULL AND length(first_approval_note)>=10)
   );
 END IF;
END $$;
