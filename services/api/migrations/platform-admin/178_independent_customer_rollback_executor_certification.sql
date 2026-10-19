-- Rollback execution admission is SEPARATE from a customer rollback request.
-- Neither a deploy flag nor a customer signature may authorise live gateway
-- writes without a staff-reviewed, time-bounded, exact worker revision.
-- Deliberately no rows or host credentials are seeded by this migration.
CREATE TABLE platform_release_customer_rollback_executor_certifications (
  revision_sha text PRIMARY KEY CHECK(revision_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL DEFAULT 'blocked' CHECK(state IN ('blocked','approved','revoked')),
  worker_role text NOT NULL DEFAULT 'hi5_release_rollback_executor'
    CHECK(worker_role='hi5_release_rollback_executor'),
  gateway_fence_tested boolean NOT NULL DEFAULT false,
  restricted_role_tested boolean NOT NULL DEFAULT false,
  customer_only_route_tested boolean NOT NULL DEFAULT false,
  failure_compensation_tested boolean NOT NULL DEFAULT false,
  public_version_verified boolean NOT NULL DEFAULT false,
  audit_completion_tested boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  expires_at timestamptz,
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK(state<>'approved' OR (
    gateway_fence_tested AND restricted_role_tested
    AND customer_only_route_tested AND failure_compensation_tested
    AND public_version_verified AND audit_completion_tested
    AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
    AND expires_at>reviewed_at AND length(reason) BETWEEN 20 AND 500
    AND evidence @> '{"independentHostTest":true,"customerIsolationTest":true}'::jsonb
  ))
);
REVOKE ALL ON platform_release_customer_rollback_executor_certifications FROM PUBLIC;
COMMENT ON TABLE platform_release_customer_rollback_executor_certifications IS
  'Unseeded independent staff review of one exact rollback executor revision. A customer request cannot enable the host worker, and host workers cannot approve their own revision.';

-- The existing rollback compatibility reviews remain independently required,
-- and the privileged control API must check BOTH approvals before creating a
-- customer request. This change grants no new privilege to any service user.
