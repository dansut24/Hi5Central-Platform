-- Time-limited cross-environment login, redeemable once by authenticated
-- Hi5Central environment services. No credentials or passwords are copied.
CREATE TABLE IF NOT EXISTS tenant_environment_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK(environment IN ('test','uat')),
  token_hash text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_environment_handoffs_active_idx
  ON tenant_environment_handoffs(tenant_id,user_id,expires_at)
  WHERE used_at IS NULL;
