-- Each customer's UAT/Live runtime must be verified independently.
-- These are host-observed, short-lived facts, not browser-supplied claims.
CREATE TABLE IF NOT EXISTS tenant_application_deployment_proofs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK(environment IN ('uat','live')),
  api_sha text NOT NULL CHECK(api_sha ~ '^[a-f0-9]{40}$'),
  itsm_sha text NOT NULL CHECK(itsm_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'verified' CHECK(status IN ('verified','rolled_back')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'trusted_operator_public_probe'
    CHECK(source='trusted_operator_public_probe'),
  PRIMARY KEY(tenant_id,environment)
);
CREATE INDEX IF NOT EXISTS tenant_application_proofs_fresh_idx
  ON tenant_application_deployment_proofs(environment,verified_at DESC)
  WHERE status='verified';
