-- Desired state for Hi5Central-owned Self Service client; never grants an
-- arbitrary installer URL, unsigned exception, or estate-wide entitlement.
CREATE TABLE IF NOT EXISTS rmm_device_self_service (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_device_id uuid NOT NULL REFERENCES rmm_agent_devices(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  release_version text NOT NULL DEFAULT '0.2.0',
  portal_sha256 char(64) NOT NULL,
  patch_host_sha256 char(64) NOT NULL,
  last_job_id uuid,
  last_dispatched_at timestamptz,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_device_id),
  CONSTRAINT self_service_portal_sha CHECK (portal_sha256 ~ '^[A-F0-9]{64}$'),
  CONSTRAINT self_service_patch_sha CHECK (patch_host_sha256 ~ '^[A-F0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS rmm_device_self_service_enabled_idx
  ON rmm_device_self_service(tenant_id,agent_device_id,last_dispatched_at)
  WHERE enabled = true;
