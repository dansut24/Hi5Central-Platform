-- A shared Production/UAT gateway cannot be safely reconfigured by two
-- independent tenant release jobs simultaneously. Enforce this invariant in
-- PostgreSQL even if workers have different processes, hosts or queue leases.
-- Each tenant's job remains queued; neither job is discarded.
--
-- Test workers currently have tenant-specific canary scheduling and are
-- migrated separately. Production and UAT require shared gateway exclusion.
-- Metadata only: never starts/deploys/enqueues a release.
CREATE UNIQUE INDEX IF NOT EXISTS release_single_running_shared_gateway
  ON tenant_release_rollout_jobs (environment)
  WHERE status='running' AND environment IN ('uat','live');

-- Durable gateway-owner evidence. The job lease/fence is checked again by
-- every privileged host activation and after each completed cutover.
CREATE TABLE IF NOT EXISTS platform_release_gateway_owners (
  gateway text PRIMARY KEY CHECK(gateway IN ('test','uat','live')),
  job_id uuid NOT NULL REFERENCES tenant_release_rollout_jobs(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lease_fence bigint NOT NULL CHECK(lease_fence > 0),
  worker_id text NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 120),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_owner_job_unique UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS release_gateway_owner_tenant
  ON platform_release_gateway_owners(tenant_id,gateway);

-- Worker heartbeat is distinct from individual deployment events. The UI can
-- show if a runner is polling even when it has no jobs; never infer liveness
-- simply because an old release succeeded.
CREATE TABLE IF NOT EXISTS platform_release_worker_heartbeats (
  worker_id text PRIMARY KEY CHECK(length(worker_id) BETWEEN 1 AND 120),
  gateway text NOT NULL CHECK(gateway IN ('test','uat','live')),
  version_sha text CHECK(version_sha IS NULL OR version_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL CHECK(state IN ('idle','busy','paused','error')),
  current_job_id uuid REFERENCES tenant_release_rollout_jobs(id) ON DELETE SET NULL,
  last_poll_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_release_worker_heartbeat_recent
  ON platform_release_worker_heartbeats(last_poll_at DESC);
