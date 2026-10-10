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

-- Ordinary database writers must not rewrite the operator evidence after it
-- has been committed. Database administrators can still perform privileged
-- maintenance, so independent custody/retention remains a pilot prerequisite.
CREATE OR REPLACE FUNCTION reject_managed_owner_invitation_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Managed owner invitation audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS managed_owner_invitation_audit_immutable
  ON managed_owner_invitation_audit;
CREATE TRIGGER managed_owner_invitation_audit_immutable
  BEFORE UPDATE OR DELETE ON managed_owner_invitation_audit
  FOR EACH ROW EXECUTE FUNCTION reject_managed_owner_invitation_audit_mutation();
