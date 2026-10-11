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
-- An AI Assist toggle requires the API and ITSM UI to support the same
-- application capability before it can be enabled in Production.
INSERT INTO platform_configuration_capability_requirements
  (path_prefix,capability_key,component,description)
VALUES
  (ARRAY['itsm','aiAssistant'],'itsm.ai_assist','api','AI Assist API runtime'),
  (ARRAY['itsm','aiAssistant','ui'],'itsm.ai_assist','itsm','AI Assist technician UI')
ON CONFLICT (path_prefix) DO NOTHING;
-- The UI prerequisite applies to the parent aiAssistant setting too. Make
-- component requirement rows a separate explicit prefix only if path matches;
-- use two-component registries with a single exact path metadata probe.
INSERT INTO platform_build_configuration_capabilities (build_sha,component,capability_key)
VALUES
  ('27a8974dc337dcb255c9f561e7954281453d60f6','api','itsm.ai_assist'),
  ('27a8974dc337dcb255c9f561e7954281453d60f6','itsm','itsm.ai_assist')
ON CONFLICT DO NOTHING;
