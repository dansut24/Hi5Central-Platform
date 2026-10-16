-- Isolated, short-lived ONE-tenant Test release exception while global rollouts remain PAUSED.
-- No permit is created by this migration. Only authorised host staff can arm a
-- permit, for one existing staff-certified, scheduled Test release job.
CREATE TABLE IF NOT EXISTS platform_release_single_test_canary_permits (
  job_id uuid PRIMARY KEY REFERENCES tenant_release_rollout_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  environment text NOT NULL DEFAULT 'test' CHECK (environment='test'),
  tenant_slug text NOT NULL CHECK (tenant_slug ~ '^[a-z0-9-]{3,45}$'),
  state text NOT NULL DEFAULT 'armed' CHECK (state IN ('armed','completed','revoked')),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by uuid NOT NULL,
  armed_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (expires_at>not_before AND expires_at<=not_before+interval '45 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS single_armed_release_test_canary
  ON platform_release_single_test_canary_permits((state))
  WHERE state='armed';
COMMENT ON TABLE platform_release_single_test_canary_permits IS
  'Single-job short-lived Test-only canary exception, global rollout stays paused; never valid for UAT/Production.';
