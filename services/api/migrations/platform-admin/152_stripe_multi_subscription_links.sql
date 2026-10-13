-- One Stripe sandbox customer may have multiple ITSM/RMM subscriptions.
-- No customer is linked or billed by this migration. Existing single-subscription
-- bindings remain readable until they can be migrated under controlled approval.
CREATE TABLE IF NOT EXISTS tenant_stripe_subscription_links (
  stripe_subscription_id text PRIMARY KEY CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  tenant_id uuid NOT NULL REFERENCES tenant_stripe_billing_links(tenant_id) ON DELETE CASCADE,
  product_scope text NOT NULL CHECK (product_scope IN ('itsm','rmm','combined')),
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_scope)
);
CREATE INDEX IF NOT EXISTS tenant_stripe_subscription_links_tenant_idx
  ON tenant_stripe_subscription_links(tenant_id, created_at DESC);
COMMENT ON TABLE tenant_stripe_subscription_links IS
  'Sandbox-only explicit tenant subscription associations; combined subscriptions may include ITSM and RMM. No automatic access is granted.';
