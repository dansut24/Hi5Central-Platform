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

-- Mandatory DB-side audit: even a direct authorised change to the approval
-- row must leave an immutable before/after record. No customer routes touched.
CREATE OR REPLACE FUNCTION audit_generic_release_stage_authorisation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO platform_release_generic_approval_audit
      (build_sha,environment,actor_id,action,previous_state,next_state)
    VALUES (OLD.build_sha,OLD.environment,OLD.approved_by,'revoked',
      to_jsonb(OLD),'{}'::jsonb);
    RETURN OLD;
  END IF;
  INSERT INTO platform_release_generic_approval_audit
    (build_sha,environment,actor_id,action,previous_state,next_state)
  VALUES (NEW.build_sha,NEW.environment,NEW.approved_by,
    CASE WHEN NEW.planning_enabled OR NEW.execution_enabled
         THEN 'approved' ELSE 'revoked' END,
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    to_jsonb(NEW));
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER generic_release_stage_approval_audit
AFTER INSERT OR UPDATE OR DELETE ON platform_release_generic_stage_approvals
FOR EACH ROW EXECUTE FUNCTION audit_generic_release_stage_authorisation();
