-- Selective, per-setting UAT -> Live ITSM configuration approvals.
-- No customer operational data, passwords, People, RMM or settings snapshots.
-- The source UAT event is immutable and always checked against the current
-- UAT and Live values before this row may be written.
CREATE TABLE IF NOT EXISTS itsm_configuration_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uat_event_id uuid NOT NULL,
  setting_path text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  status text NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied','reverted')),
  approved_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  reverted_by uuid,
  reverted_at timestamptz,
  UNIQUE (tenant_id,uat_event_id,setting_path),
  CHECK (length(setting_path) BETWEEN 2 AND 220),
  CHECK (octet_length(before_value::text)<3000 AND octet_length(after_value::text)<3000)
);
CREATE INDEX IF NOT EXISTS idx_itsm_configuration_promotions_tenant
  ON itsm_configuration_promotions(tenant_id,applied_at DESC);
