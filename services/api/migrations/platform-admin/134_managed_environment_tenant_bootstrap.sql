-- Internal proof that an operator prepared a *suspended* tenant identity
-- inside the correctly attested UAT/Test database. No users, tokens, jobs,
-- devices, DNS routes or application access are created by this migration.
CREATE TABLE IF NOT EXISTS managed_environment_tenant_bootstrap (
  control_request_id uuid PRIMARY KEY,
  control_tenant_id uuid NOT NULL,
  local_tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('uat','test')),
  database_instance_id uuid NOT NULL,
  expected_hostname text NOT NULL,
  stage text NOT NULL DEFAULT 'identity_prepared'
    CHECK (stage = 'identity_prepared'),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expected_hostname ~ '^[a-z0-9-]+[.]([a-z0-9-]+[.])+[a-z0-9-]+$'),
  UNIQUE (control_tenant_id, environment),
  UNIQUE (expected_hostname)
);

COMMENT ON TABLE managed_environment_tenant_bootstrap IS
  'Only suspended environment-local tenant identities. Identity preparation is NOT release activation, login eligibility, RMM enrolment or DNS approval.';
