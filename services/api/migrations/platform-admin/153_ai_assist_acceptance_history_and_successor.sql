-- Preserve each UAT acceptance even when a newer application build supersedes it.
-- Retains old accepted test evidence for audit without changing Live tenant settings.
CREATE TABLE IF NOT EXISTS tenant_ai_release_acceptance_history (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tested_build_sha text NOT NULL CHECK(tested_build_sha ~ '^[a-f0-9]{40}$'),
  uat_configuration_hash text NOT NULL CHECK(uat_configuration_hash ~ '^[a-f0-9]{64}$'),
  evidence text NOT NULL,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,tested_build_sha,uat_configuration_hash)
);
INSERT INTO tenant_ai_release_acceptance_history
  (tenant_id,tested_build_sha,uat_configuration_hash,evidence,accepted_by,accepted_at)
SELECT tenant_id,tested_build_sha,uat_configuration_hash,evidence,accepted_by,accepted_at
FROM tenant_ai_release_acceptances
ON CONFLICT DO NOTHING;
-- Register the latest Production-compatible code capability for both components.
INSERT INTO platform_build_configuration_capabilities(build_sha,component,capability_key)
VALUES
  ('9fb2fb5dba0516add7b2bea7cbb52554a7224ebf','api','itsm.ai_assist'),
  ('9fb2fb5dba0516add7b2bea7cbb52554a7224ebf','itsm','itsm.ai_assist')
ON CONFLICT DO NOTHING;
