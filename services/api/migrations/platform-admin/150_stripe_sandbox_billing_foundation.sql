-- Sandbox-only Stripe billing foundation. No products, charges or subscriptions are created.
-- Mapping deliberately does not update tenant_commercial_settings until webhook reconciliation is implemented.
CREATE TABLE IF NOT EXISTS tenant_stripe_billing_links (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  CHECK (stripe_subscription_id IS NULL OR stripe_customer_id IS NOT NULL)
);

-- These snapshots represent a future invoice basis, not a charge instruction.
-- Nothing in this migration automatically creates or bills a snapshot.
CREATE TABLE IF NOT EXISTS tenant_rmm_billing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_period_start date NOT NULL,
  as_of timestamptz NOT NULL,
  eligible_since timestamptz NOT NULL,
  total_devices integer NOT NULL CHECK (total_devices >= 0),
  billable_devices integer NOT NULL CHECK (billable_devices >= 0),
  module_disabled_devices integer NOT NULL CHECK (module_disabled_devices >= 0),
  disabled_devices integer NOT NULL CHECK (disabled_devices >= 0),
  stale_devices integer NOT NULL CHECK (stale_devices >= 0),
  never_checked_in_devices integer NOT NULL CHECK (never_checked_in_devices >= 0),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, billing_period_start),
  CHECK (EXTRACT(DAY FROM billing_period_start) = 1),
  CHECK (billable_devices + module_disabled_devices + disabled_devices + stale_devices + never_checked_in_devices = total_devices),
  CHECK (eligible_since <= as_of)
);
CREATE INDEX IF NOT EXISTS tenant_rmm_billing_snapshots_period_idx
  ON tenant_rmm_billing_snapshots(billing_period_start DESC, tenant_id);
