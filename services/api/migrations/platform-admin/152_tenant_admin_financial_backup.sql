-- Optional commercial and verified operational metadata. No fake backups or invoices.
ALTER TABLE tenant_commercial_settings
  ADD COLUMN IF NOT EXISTS rmm_device_price_pence integer
    CHECK (rmm_device_price_pence IS NULL OR rmm_device_price_pence >= 0);
ALTER TABLE tenant_commercial_settings
  ADD COLUMN IF NOT EXISTS base_monthly_price_pence integer
    CHECK (base_monthly_price_pence IS NULL OR base_monthly_price_pence >= 0);
ALTER TABLE tenant_commercial_settings
  ADD COLUMN IF NOT EXISTS next_invoice_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_tenant_backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK(environment IN ('live','uat','test')),
  status text NOT NULL CHECK(status IN ('verified','failed','pending')),
  completed_at timestamptz NOT NULL,
  size_bytes bigint CHECK(size_bytes IS NULL OR size_bytes >= 0),
  verified_at timestamptz,
  checksum_sha256 text CHECK(checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'),
  source text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status <> 'verified' OR (verified_at IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_backups_latest
  ON platform_tenant_backup_records(tenant_id,environment,completed_at DESC)
  WHERE status='verified';

-- Issued invoices must originate from a verified billing integration or
-- audited import, not estimated UI calculations.
CREATE TABLE IF NOT EXISTS platform_tenant_invoice_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  external_invoice_id text NOT NULL,
  issued_at timestamptz NOT NULL,
  due_at timestamptz,
  currency text NOT NULL,
  total_pence bigint NOT NULL CHECK(total_pence >= 0),
  status text NOT NULL CHECK(status IN ('draft','issued','paid','overdue','void')),
  source text NOT NULL CHECK(length(source)>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,external_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_invoices_latest
  ON platform_tenant_invoice_records(tenant_id,issued_at DESC);
