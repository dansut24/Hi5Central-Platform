-- QA26-only, fictional upgrades/trial extensions and read-only billing delegates.
-- Never represents a Stripe customer, entitlement or charge.
CREATE TABLE IF NOT EXISTS qa26_demo_account_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  example_itsm boolean NOT NULL,
  example_rmm boolean NOT NULL,
  fake_paid_plan boolean NOT NULL DEFAULT false,
  extension_days integer NOT NULL DEFAULT 0 CHECK (extension_days IN (0,14)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (example_itsm OR example_rmm)
);
CREATE TABLE IF NOT EXISTS qa26_demo_billing_delegates (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS qa26_demo_reminder_log (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('day14_checkin','day30_expired','extension_granted')),
  fake_sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,kind)
);
COMMENT ON TABLE qa26_demo_account_state IS 'Purely fake QA26 UI trial and module upgrade state. Not commercial status, not access entitlements.';
COMMENT ON TABLE qa26_demo_billing_delegates IS 'QA26 fake billing-only permissions. Does not modify tenant_memberships or platform roles.';
COMMENT ON TABLE qa26_demo_reminder_log IS 'Simulated email events ONLY. No email may be sent by this table or associated QA26 endpoints.';
