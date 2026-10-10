-- Public signup requests are NOT tenants, memberships, passwords or sessions.
-- Only independently reviewed and email-verified requests can be converted.
CREATE TABLE IF NOT EXISTS managed_public_signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug text NOT NULL,
  company_name text NOT NULL,
  owner_name text NOT NULL,
  owner_email text NOT NULL,
  modules jsonb NOT NULL DEFAULT '{"itsm":true,"selfService":true,"rmm":false}'::jsonb,
  update_mode text NOT NULL CHECK(update_mode IN ('hi5_managed','admin_controlled')),
  customer_uat_opt_in boolean NOT NULL DEFAULT false,
  maintenance_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'awaiting_email'
    CHECK(status IN ('awaiting_email','verified','converted','cancelled','expired','delivery_failed')),
  verification_hash char(64) NOT NULL UNIQUE,
  verification_expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  converted_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(owner_email=lower(owner_email)),
  CHECK(verification_expires_at>requested_at AND verification_expires_at<=requested_at+interval '24 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_public_signup_requests_pending_slug
  ON managed_public_signup_requests(tenant_slug)
  WHERE status IN ('awaiting_email','verified');
CREATE INDEX IF NOT EXISTS managed_public_signup_requests_status
  ON managed_public_signup_requests(status,requested_at DESC);
CREATE TABLE IF NOT EXISTS managed_public_signup_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES managed_public_signup_requests(id),
  action text NOT NULL CHECK(action IN ('requested','verified','converted','cancelled','delivery_failed')),
  actor_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_managed_public_signup_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Public signup audit is append-only'; END $$;
DROP TRIGGER IF EXISTS managed_public_signup_audit_immutable ON managed_public_signup_audit;
CREATE TRIGGER managed_public_signup_audit_immutable
BEFORE UPDATE OR DELETE ON managed_public_signup_audit
FOR EACH ROW EXECUTE FUNCTION prevent_managed_public_signup_audit_mutation();
