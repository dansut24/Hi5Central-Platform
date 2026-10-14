-- Deliberately fictitious billing for the two named QA26 tenants only.
-- This table stores mock UI state, NEVER money, Stripe ids, real invoices or entitlements.
-- API validation pins exact tenant slugs and MFA owner/admin roles.
CREATE TABLE IF NOT EXISTS qa26_demo_invoice_states (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_key text NOT NULL CHECK (invoice_key IN ('oct-rmm-itsm','sep-rmm-itsm','oct-rmm','oct-itsm','sep-rmm')),
  status text NOT NULL CHECK (status IN ('paid','payment_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 25),
  paid_at timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,invoice_key),
  CHECK ((status='paid' AND paid_at IS NOT NULL) OR (status='payment_failed' AND paid_at IS NULL))
);
COMMENT ON TABLE qa26_demo_invoice_states IS
  'QA26 only: pretend invoice payment button states; absolutely no Stripe/payment/entitlement side effects.';
