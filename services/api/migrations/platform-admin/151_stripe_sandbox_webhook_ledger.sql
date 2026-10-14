-- Stripe webhook receipt ledger: sandbox only, no tenant entitlement changes.
-- Never store raw Stripe payloads, card data, client secrets, or unverified signatures.
CREATE TABLE IF NOT EXISTS stripe_sandbox_webhook_events (
  stripe_event_id text PRIMARY KEY CHECK (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text NOT NULL,
  event_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_invoice_id text,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  resolution text NOT NULL CHECK (resolution IN ('linked', 'unmapped', 'unsupported')),
  amount_paid_pence bigint,
  currency text,
  CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  CHECK (stripe_invoice_id IS NULL OR stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  CHECK (amount_paid_pence IS NULL OR amount_paid_pence >= 0)
);
CREATE INDEX IF NOT EXISTS stripe_sandbox_webhook_events_tenant_idx
  ON stripe_sandbox_webhook_events(tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_sandbox_webhook_events_received_idx
  ON stripe_sandbox_webhook_events(received_at DESC);

COMMENT ON TABLE stripe_sandbox_webhook_events IS
  'Signed sandbox Stripe event receipts only. A linked event is NOT proof of entitlement and is never authoritative for tenant commercial settings.';

-- Default-deny deployment: migrations alone do not activate Stripe webhooks.
