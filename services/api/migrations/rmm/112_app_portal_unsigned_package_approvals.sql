-- Owner-authorised, hash-pinned exception for unsigned MSI/EXE App Portal packages.
-- Never authorises arbitrary URLs or silently overrides Windows signature failures.
CREATE TABLE IF NOT EXISTS rmm_app_portal_unsigned_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES rmm_app_portal_apps(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES rmm_app_portal_revisions(id) ON DELETE CASCADE,
  package_sha256 char(64) NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT appportal_unsigned_approval_sha CHECK (package_sha256 ~ '^[A-F0-9]{64}$'),
  CONSTRAINT appportal_unsigned_approval_reason CHECK (length(trim(reason)) BETWEEN 12 AND 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS rmm_app_portal_unsigned_approval_active_idx
  ON rmm_app_portal_unsigned_approvals (tenant_id, revision_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rmm_app_portal_unsigned_approval_tenant_idx
  ON rmm_app_portal_unsigned_approvals (tenant_id, app_id, approved_at DESC);
