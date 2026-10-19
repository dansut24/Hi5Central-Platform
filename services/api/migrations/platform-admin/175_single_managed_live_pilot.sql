-- Default-deny one Managed Production customer pilot while the fleet is globally paused.
-- A named platform owner/admin must arm an exact existing scheduled job through
-- the authenticated platform-control API. No tenant is automatically permitted.
CREATE TABLE IF NOT EXISTS platform_release_single_live_pilot_permits (
  job_id uuid PRIMARY KEY REFERENCES tenant_release_rollout_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  environment text NOT NULL DEFAULT 'live' CHECK(environment='live'),
  state text NOT NULL DEFAULT 'armed' CHECK(state IN ('armed','completed','revoked')),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 20 AND 500),
  armed_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK(expires_at>not_before AND expires_at<=not_before+interval '45 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS one_armed_live_release_pilot
  ON platform_release_single_live_pilot_permits((state)) WHERE state='armed';
COMMENT ON TABLE platform_release_single_live_pilot_permits IS
'Explicit one-customer Managed Live pilot permit while fleet globally paused. Never valid for Custom Production, UAT or Test. At most one armed permit, max 45min, audited staff action.';

-- Least-privileged stage worker identities may only read the permit decision.
-- RLS prevents Test/UAT identities from ever seeing an authorised Live pilot.
ALTER TABLE platform_release_single_live_pilot_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_release_single_live_pilot_permits FROM PUBLIC;
GRANT SELECT ON platform_release_single_live_pilot_permits
  TO hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
DROP POLICY IF EXISTS h5c_release_pilot_live_read ON platform_release_single_live_pilot_permits;
CREATE POLICY h5c_release_pilot_live_read ON platform_release_single_live_pilot_permits
 FOR SELECT TO hi5_release_executor_live USING(environment='live');
-- No INSERT/UPDATE/DELETE for release workers. Admin API uses the established
-- trusted control database identity and performs all staff/audit checks.
