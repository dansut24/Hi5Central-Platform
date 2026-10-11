-- Tenant-scoped, explicit opt-in for one-way Production master-reference updates.
-- Installed independently in Live, UAT and Test; never carries live secrets.
CREATE TABLE IF NOT EXISTS environment_reference_sync_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS environment_reference_sync_baselines (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource text NOT NULL CHECK(resource IN ('people','departments','teams','sites')),
  external_key text NOT NULL,
  field_key text NOT NULL,
  source_digest char(64) NOT NULL,
  target_digest char(64) NOT NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,resource,external_key,field_key)
);
CREATE INDEX IF NOT EXISTS environment_reference_sync_baselines_tenant_idx
  ON environment_reference_sync_baselines(tenant_id,last_synced_at DESC);
CREATE TABLE IF NOT EXISTS environment_reference_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK(environment IN ('uat','test')),
  mode text NOT NULL CHECK(mode IN ('preview','apply')),
  status text NOT NULL CHECK(status IN ('completed','failed')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS environment_reference_sync_runs_tenant_idx
  ON environment_reference_sync_runs(tenant_id,completed_at DESC);
