-- Additive control-plane release certification and scheduler checkpoint.
-- Migration alone does not enable customer deployments or modify routes.
-- An approved Dev build must have verifiable CI/security/migration evidence
-- AND a separate human Platform Admin approval before tenant fanout.
CREATE TABLE IF NOT EXISTS platform_certified_application_releases (
  build_sha text PRIMARY KEY CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','revoked')),
  ci_run_url text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (
    approved_by IS NOT NULL AND approved_at IS NOT NULL
    AND length(ci_run_url) BETWEEN 24 AND 350
    AND ci_run_url ~ '^https://github[.]com/[^/]+/[^/]+/actions/runs/[0-9]+$'
    AND evidence @> '{"build":true,"ci":true,"security":true,"migrations":true,"smoke":true}'::jsonb
  ))
);
CREATE INDEX IF NOT EXISTS certified_application_releases_ready
  ON platform_certified_application_releases (approved_at,build_sha)
  WHERE status='approved';

-- This row is a scheduler journal, not a customer route assignment.
-- One row per build; resumed scans are idempotent after worker restarts.
CREATE TABLE IF NOT EXISTS platform_release_fanout_checkpoints (
  build_sha text PRIMARY KEY REFERENCES platform_certified_application_releases(build_sha),
  last_scan_at timestamptz,
  last_tenant_count integer NOT NULL DEFAULT 0,
  last_queued_count integer NOT NULL DEFAULT 0,
  last_blocked_count integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_release_fanout_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  build_sha text NOT NULL REFERENCES platform_certified_application_releases(build_sha),
  event_type text NOT NULL CHECK(event_type IN
    ('approved','revoked','scan','failed')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_release_fanout_events_recent
 ON platform_release_fanout_events(occurred_at DESC);
