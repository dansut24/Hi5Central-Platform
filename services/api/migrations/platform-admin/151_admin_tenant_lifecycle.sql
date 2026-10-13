-- Platform Admin tenant lifecycle: access revocation, reversible archive and
-- review-only data operations. Never cascade/delete customer data in a request.
CREATE TABLE IF NOT EXISTS platform_tenant_lifecycle (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active','suspended','archived','purge_requested')),
  previous_tenant_status text,
  archived_at timestamptz,
  restore_deadline timestamptz,
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 30 AND 365),
  reason text NOT NULL DEFAULT '',
  legal_hold boolean NOT NULL DEFAULT false,
  purge_requested_at timestamptz,
  purge_requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lifecycle_state IN ('archived','purge_requested')) =
    (archived_at IS NOT NULL AND restore_deadline IS NOT NULL)),
  CHECK (lifecycle_state <> 'purge_requested' OR purge_requested_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_lifecycle_state
  ON platform_tenant_lifecycle(lifecycle_state,restore_deadline);

CREATE TABLE IF NOT EXISTS platform_tenant_data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_type text NOT NULL CHECK (request_type IN ('export','import','purge')),
  status text NOT NULL DEFAULT 'awaiting_review'
    CHECK (status IN ('awaiting_review','approved','processing','completed','rejected','cancelled','failed')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  -- No customer payloads, arbitrary URLs, files, or credentials in this table.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_tenant_data_requests_tenant
  ON platform_tenant_data_requests(tenant_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_tenant_purge_open
  ON platform_tenant_data_requests(tenant_id)
  WHERE request_type='purge' AND status IN ('awaiting_review','approved','processing');
-- This migration intentionally does not populate rows or alter existing
-- tenants; tenants without a lifecycle row are treated as active/unmanaged.
