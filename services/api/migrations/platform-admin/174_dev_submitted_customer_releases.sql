-- Single central, audited Dev-authored release submissions.
-- This is metadata only; submissions cannot certify builds or queue workers.
CREATE TABLE IF NOT EXISTS platform_dev_release_submissions (
 build_sha text PRIMARY KEY CHECK (build_sha ~ '^[0-9a-f]{40}$'),
 notes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(notes)='object' AND pg_column_size(notes)<=65536),
 ci_run_url text,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','rejected','approved')),
 dev_author_id uuid NOT NULL,
 dev_author_slug text NOT NULL CHECK (dev_author_slug='dev'),
 edited_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz,
 reviewed_at timestamptz,
 reviewed_by uuid,
 rejection_reason text,
 CHECK ((status IN ('submitted','approved') AND submitted_at IS NOT NULL AND ci_run_url IS NOT NULL)
    OR status IN ('draft','rejected'))
);
CREATE INDEX IF NOT EXISTS platform_dev_release_submissions_recent
 ON platform_dev_release_submissions(edited_at DESC);
CREATE TABLE IF NOT EXISTS platform_dev_release_handoff_nonces(
 nonce uuid PRIMARY KEY,
 received_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform_dev_release_submissions IS
 'Only Dev authors modify drafts; only Platform Admin approves/rejects submitted immutable notes. No tenant rollout is triggered until explicit approval.';
