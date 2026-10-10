-- Registrations are not customer-ready workspaces. Preserve the verified
-- first-owner contact for a separately authorised sandbox invitation ceremony.
-- No user, membership, credential, email, or login session is created here.
CREATE TABLE IF NOT EXISTS tenant_initial_owner_onboarding_intents (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  owner_email text NOT NULL,
  owner_name text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_environment'
    CHECK(status IN ('awaiting_environment','pending_operator_approval','invitation_sent','accepted','cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(owner_email=lower(owner_email)),
  CHECK(length(owner_name) BETWEEN 2 AND 120)
);
COMMENT ON TABLE tenant_initial_owner_onboarding_intents IS
  'Pending owner contact only; operator-verified invitation and mandatory MFA remain separate gates.';
