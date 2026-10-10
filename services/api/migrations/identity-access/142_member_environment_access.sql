-- Live tenant memberships are the identity authority. Owner has implicit
-- Test and UAT access; all other users need explicit environment grants.
CREATE TABLE IF NOT EXISTS tenant_member_environment_access (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test','uat')),
  granted boolean NOT NULL DEFAULT false,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id,environment)
);
CREATE INDEX IF NOT EXISTS tenant_member_environment_access_user_idx
  ON tenant_member_environment_access(user_id,environment)
  WHERE granted;
