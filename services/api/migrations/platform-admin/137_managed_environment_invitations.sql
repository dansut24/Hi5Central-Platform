-- Invitations are environment-local only. The managed runtime is created
-- suspended and this migration inserts NO activation approvals or invitations.
-- Only explicitly approved, active sandbox tenants may redeem invitations.
CREATE TABLE IF NOT EXISTS managed_environment_access_approvals (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  bootstrap_request_id uuid NOT NULL UNIQUE
    REFERENCES managed_environment_tenant_bootstrap(control_request_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('approved','revoked')),
  approved_by text NOT NULL CHECK (length(trim(approved_by)) >= 3),
  approved_at timestamptz NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS managed_environment_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','analyst','requester')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS managed_environment_invitations_lookup
  ON managed_environment_invitations (tenant_id, email, expires_at)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS managed_environment_one_pending_invitation
  ON managed_environment_invitations (tenant_id,email)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

COMMENT ON TABLE managed_environment_access_approvals IS
  'Activation gate only: no approvals inserted automatically. Requires independent operator review, active tenant and matching bootstrap.';
COMMENT ON TABLE managed_environment_invitations IS
  'One-time invitations local to UAT/Test runtime; redemption never issues an authenticated session and requires separate MFA challenge.';
