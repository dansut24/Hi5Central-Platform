-- Request queue only: no tenant data is copied and no sandbox is activated
-- by inserting a request. A separate audited operator must provision and
-- verify isolation before tenant_environment_instances can become ready.
CREATE TABLE IF NOT EXISTS tenant_environment_provision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('uat', 'test')),
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'claimed', 'completed', 'failed', 'cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  error_message text NOT NULL DEFAULT '',
  FOREIGN KEY (tenant_id, environment)
    REFERENCES tenant_environment_instances(tenant_id, environment)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_env_one_active_provision_request
  ON tenant_environment_provision_requests (tenant_id, environment)
  WHERE state IN ('requested', 'claimed');

CREATE INDEX IF NOT EXISTS tenant_env_provision_request_history_idx
  ON tenant_environment_provision_requests (tenant_id, environment, requested_at DESC);

COMMENT ON TABLE tenant_environment_provision_requests IS
  'Operator request queue; completion never independently authorises routing, storage or session access.';
