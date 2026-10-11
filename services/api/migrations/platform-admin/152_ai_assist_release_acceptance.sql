-- Scoped AI Assist application/configuration dependency metadata.
-- This does not update any tenant settings, release routes or application images.
CREATE TABLE IF NOT EXISTS tenant_ai_release_acceptances (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tested_build_sha text NOT NULL CHECK(tested_build_sha ~ '^[0-9a-f]{40}$'),
  uat_configuration_hash text NOT NULL CHECK(uat_configuration_hash ~ '^[0-9a-f]{64}$'),
  evidence text NOT NULL CHECK(length(evidence) BETWEEN 20 AND 3000),
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
-- Extend the capability registry to support two components for one setting.
-- Existing data is preserved; the old primary key was path_prefix alone.
ALTER TABLE platform_configuration_capability_requirements
  DROP CONSTRAINT IF EXISTS platform_configuration_capability_requirements_pkey;
ALTER TABLE platform_configuration_capability_requirements
  ADD CONSTRAINT platform_configuration_capability_requirements_pkey
  PRIMARY KEY(path_prefix,component);
-- An AI Assist toggle requires BOTH API and ITSM UI runtime capabilities.
INSERT INTO platform_configuration_capability_requirements
  (path_prefix,capability_key,component,description)
VALUES
  (ARRAY['itsm','aiAssistant'],'itsm.ai_assist','api','AI Assist API runtime'),
  (ARRAY['itsm','aiAssistant'],'itsm.ai_assist','itsm','AI Assist technician UI')
ON CONFLICT (path_prefix,component) DO NOTHING;
INSERT INTO platform_build_configuration_capabilities (build_sha,component,capability_key)
VALUES
  ('27a8974dc337dcb255c9f561e7954281453d60f6','api','itsm.ai_assist'),
  ('27a8974dc337dcb255c9f561e7954281453d60f6','itsm','itsm.ai_assist')
ON CONFLICT DO NOTHING;
