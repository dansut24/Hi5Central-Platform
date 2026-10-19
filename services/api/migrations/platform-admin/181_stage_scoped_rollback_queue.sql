-- Simple rollback queue for Custom UAT and Hi5Central-operated individual/fleet recovery.
-- Never converts customer Production permissions into a new implicit capability.
-- Each fleet operation expands into independently verified single-tenant jobs.
-- Metadata only; the existing gateway worker must be explicitly enabled
-- before any request can be executed.
CREATE TABLE IF NOT EXISTS platform_release_rollback_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid,
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
 environment text NOT NULL CHECK(environment IN ('uat','live','test')),
 source_build_sha text NOT NULL CHECK(source_build_sha ~ '^[a-f0-9]{40}$'),
 target_build_sha text NOT NULL CHECK(target_build_sha ~ '^[a-f0-9]{40}$'),
 source_route_generation bigint NOT NULL CHECK(source_route_generation>0),
 original_release_job_id uuid NOT NULL REFERENCES tenant_release_rollout_jobs(id) ON DELETE RESTRICT,
 requested_via text NOT NULL CHECK(requested_via IN ('custom_customer','hi5central_admin')),
 requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(reason) BETWEEN 20 AND 1000),
 state text NOT NULL DEFAULT 'requested'
   CHECK(state IN ('requested','running','verified','failed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 completed_at timestamptz,
 lease_token uuid,
 lease_fence bigint NOT NULL DEFAULT 0,
 lease_expires_at timestamptz,
 proof jsonb NOT NULL DEFAULT '{}'::jsonb,
 last_error text NOT NULL DEFAULT '',
 CHECK(source_build_sha<>target_build_sha),
 CHECK(requested_via<>'custom_customer' OR environment='uat'),
 CHECK(state<>'running' OR
   (lease_token IS NOT NULL AND lease_fence>0 AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL)),
 CHECK(state<>'verified' OR
   (completed_at IS NOT NULL AND proof ? 'publicApiSha' AND proof ? 'publicWebSha'
    AND proof ? 'routeGeneration'))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_release_one_active_rollback_per_stage
 ON platform_release_rollback_jobs(tenant_id,environment)
 WHERE state IN ('requested','running');
CREATE INDEX IF NOT EXISTS platform_release_rollback_queue
 ON platform_release_rollback_jobs(environment,created_at,id)
 WHERE state='requested';
CREATE INDEX IF NOT EXISTS platform_release_rollback_history
 ON platform_release_rollback_jobs(tenant_id,environment,created_at DESC);

CREATE TABLE IF NOT EXISTS platform_release_rollback_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES platform_release_rollback_jobs(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 event_type text NOT NULL CHECK(event_type IN ('requested','started','verified','failed','cancelled')),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_release_rollback_events_recent
 ON platform_release_rollback_events(tenant_id,occurred_at DESC);

REVOKE ALL ON platform_release_rollback_jobs FROM PUBLIC;
REVOKE ALL ON platform_release_rollback_events FROM PUBLIC;
COMMENT ON TABLE platform_release_rollback_jobs IS
 'Tenant-by-tenant rollback requests. Customer origin only permits Custom UAT. Staff may request an individual or fleet. No host cutover implied.';
