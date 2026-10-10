-- Phase 16: append-only operator evidence for the privileged initial-owner link.
-- This does not authenticate operator identities. That separate control is still
-- required before an external customer pilot can be approved.
CREATE TABLE IF NOT EXISTS managed_owner_invitation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invitation_id uuid NOT NULL REFERENCES managed_environment_invitations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('uat','test')),
  action text NOT NULL CHECK (action IN ('issued','cancelled','delivery_failed')),
  operator_id text NOT NULL CHECK (length(trim(operator_id)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS managed_owner_invitation_audit_lookup
  ON managed_owner_invitation_audit (tenant_id, invitation_id, created_at DESC);

COMMENT ON TABLE managed_owner_invitation_audit IS
  'Operator-attributed first-owner invitation issue, cancellation and delivery failure evidence; actor identities still require independent authentication.';
