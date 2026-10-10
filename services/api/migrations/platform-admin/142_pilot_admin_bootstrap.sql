-- Phase 19: one-time, independently approved initial Platform Admin invitation.
-- This scope is created only in the separately deployed private pilot DB;
-- its UUID is the signed identity binding, NOT an automatic authorisation.
CREATE TABLE IF NOT EXISTS pilot_admin_bootstrap_scope (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton=true),
  scope_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pilot_admin_bootstrap_scope(singleton) VALUES(true)
  ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS pilot_admin_bootstrap_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id uuid NOT NULL REFERENCES pilot_admin_bootstrap_scope(scope_id),
  email text NOT NULL,
  display_name text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  issued_by text NOT NULL,
  reviewed_by text NOT NULL,
  actor_evidence_sha256 char(64) NOT NULL UNIQUE,
  reviewer_evidence_sha256 char(64) NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK(email=lower(email)),
  CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '24 hours'),
  CHECK(issued_by<>reviewed_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS pilot_admin_bootstrap_one_open
 ON pilot_admin_bootstrap_invitations(scope_id)
 WHERE revoked_at IS NULL AND accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS pilot_admin_bootstrap_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id uuid NOT NULL,
  invitation_id uuid NOT NULL REFERENCES pilot_admin_bootstrap_invitations(id),
  action text NOT NULL CHECK(action IN('issued','delivery_failed','cancelled','accepted')),
  operator_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION refuse_pilot_admin_bootstrap_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Pilot Admin bootstrap audit is append-only.';
END $$;
DROP TRIGGER IF EXISTS pilot_admin_bootstrap_audit_immutable ON pilot_admin_bootstrap_audit;
CREATE TRIGGER pilot_admin_bootstrap_audit_immutable
 BEFORE UPDATE OR DELETE ON pilot_admin_bootstrap_audit
 FOR EACH ROW EXECUTE FUNCTION refuse_pilot_admin_bootstrap_audit_mutation();
