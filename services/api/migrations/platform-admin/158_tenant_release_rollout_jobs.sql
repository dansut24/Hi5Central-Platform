-- Phase 1 durable release schedule. Metadata only. Does NOT modify routing,
-- start containers, or enqueue existing customer tenants on migration.
CREATE TABLE IF NOT EXISTS tenant_release_rollout_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test','uat','live')),
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN
    ('pending','scheduled','running','succeeded','failed','rolled_back','deferred','cancelled')),
  scheduled_at timestamptz NOT NULL,
  release_ref text NOT NULL DEFAULT '',
  previous_build_sha text CHECK (previous_build_sha IS NULL OR previous_build_sha ~ '^[a-f0-9]{40}$'),
  policy_revision bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  routed_generation bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id,environment,build_sha),
  CHECK ((lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'running' OR lease_token IS NOT NULL)
);

-- At most one queued-or-running release may own an environment. Newer
-- releases remain 'pending' until the previous one completes/cancels; this
-- supports tenant ordering without attempting two route switches at once.
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_tenant_environment_rollout
  ON tenant_release_rollout_jobs (tenant_id,environment)
  WHERE status IN ('scheduled','deferred','running');
CREATE INDEX IF NOT EXISTS due_release_rollout_jobs
  ON tenant_release_rollout_jobs(status,scheduled_at,id)
  WHERE status IN ('scheduled','deferred','running');

CREATE TABLE IF NOT EXISTS tenant_release_rollout_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES tenant_release_rollout_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test','uat','live')),
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  event_type text NOT NULL CHECK (event_type IN
    ('scheduled','claimed','lease_expired','deferred','verified','failed',
     'rolled_back','cancelled','paused','resumed')),
  fence bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_release_rollout_event_timeline
  ON tenant_release_rollout_events(tenant_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS tenant_release_rollout_event_by_job
  ON tenant_release_rollout_events(job_id,occurred_at DESC);

-- Global pause remains fail-closed even before any rollout agent is installed.
CREATE TABLE IF NOT EXISTS platform_release_rollout_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton=true),
  paused boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT 'Release activation is disabled until trusted host worker and route rollback pass QA.',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_release_rollout_control(singleton,paused)
VALUES(true,true) ON CONFLICT(singleton) DO NOTHING;
