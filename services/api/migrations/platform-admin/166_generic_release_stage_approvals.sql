-- Generic Dev -> tenant release scheduling: explicit per-build/per-stage
-- administrator authorisation. Additive and entirely OFF by default.
-- Never unpauses global rollout workers, starts containers or changes routes.
CREATE TABLE IF NOT EXISTS platform_release_generic_stage_approvals (
  build_sha text NOT NULL
    REFERENCES platform_certified_application_releases(build_sha),
  environment text NOT NULL CHECK (environment IN ('test','uat','live')),
  planning_enabled boolean NOT NULL DEFAULT false,
  execution_enabled boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  expires_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (build_sha,environment),
  CHECK (
    NOT planning_enabled OR (
      approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND expires_at IS NOT NULL AND expires_at > approved_at
      AND jsonb_typeof(evidence)='object' AND evidence <> '{}'::jsonb
    )
  ),
  CHECK (NOT execution_enabled OR planning_enabled)
);

-- Snapshot of administrator decisions for operational review. The future
-- Platform Admin approval endpoint must write here in the same transaction.
CREATE TABLE IF NOT EXISTS platform_release_generic_approval_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  build_sha text NOT NULL
    REFERENCES platform_certified_application_releases(build_sha),
  environment text NOT NULL CHECK (environment IN ('test','uat','live')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('approved','revoked','expired','updated')),
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generic_release_approval_audit_recent
  ON platform_release_generic_approval_audit (occurred_at DESC);

-- No APPROVAL rows are seeded by this migration. All generic scheduling and
-- execution remain denied until separate authorised administrator action.
