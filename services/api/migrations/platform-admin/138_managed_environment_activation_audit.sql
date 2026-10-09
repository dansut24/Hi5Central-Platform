-- An activation never happens because a tenant was merely prepared.
-- Two distinct operator attestations and durable audit events are required.
CREATE TABLE IF NOT EXISTS managed_environment_activation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bootstrap_request_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('uat','test')),
  action text NOT NULL CHECK (action IN ('approve','activate','suspend')),
  operator_id text NOT NULL CHECK (length(trim(operator_id)) >= 3),
  independent_reviewer_id text NOT NULL CHECK (length(trim(independent_reviewer_id)) >= 3),
  attested_database_instance_id uuid NOT NULL,
  attested_redis_instance_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (operator_id <> independent_reviewer_id)
);

CREATE INDEX IF NOT EXISTS managed_environment_activation_audit_lookup
  ON managed_environment_activation_audit (tenant_id,created_at DESC);

COMMENT ON TABLE managed_environment_activation_audit IS
  'Audited independent activation and suspension of local customer UAT/Test identity; not a control-plane readiness or DNS approval.';
