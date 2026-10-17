-- Customer self-service ITSM Production rollback control plane.
-- This migration is intentionally metadata-only and does not activate a host.
-- The trusted independent gateway executor must perform the rollback using
-- fenced, host-verified route changes; no tenant admin receives Docker access.

CREATE TABLE platform_release_rollback_compatibility (
  from_build_sha text NOT NULL CHECK(from_build_sha ~ '^[a-f0-9]{40}$'),
  to_build_sha text NOT NULL CHECK(to_build_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL DEFAULT 'blocked' CHECK(state IN ('blocked','approved','revoked')),
  schema_backward_compatible boolean NOT NULL DEFAULT false,
  immutable_images_verified boolean NOT NULL DEFAULT false,
  recovery_snapshot_verified boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  expires_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  PRIMARY KEY(from_build_sha,to_build_sha),
  CHECK(from_build_sha<>to_build_sha),
  CHECK(state<>'approved' OR (
    schema_backward_compatible AND immutable_images_verified
    AND recovery_snapshot_verified
    AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
    AND expires_at>reviewed_at AND length(reason) BETWEEN 20 AND 500
    AND evidence @> '{"schemaChecked":true,"previousImagePulled":true,"recoveryTestPassed":true}'::jsonb
  ))
);
REVOKE ALL ON platform_release_rollback_compatibility FROM PUBLIC;

CREATE TABLE tenant_release_upgrade_holds (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  held_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CHECK(length(reason) BETWEEN 20 AND 1000),
  CHECK(active OR (released_at IS NOT NULL AND released_by IS NOT NULL))
);
CREATE INDEX tenant_release_upgrade_holds_active
 ON tenant_release_upgrade_holds(tenant_id) WHERE active;
REVOKE ALL ON tenant_release_upgrade_holds FROM PUBLIC;

CREATE TABLE tenant_release_customer_rollback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'live' CHECK(environment='live'),
  source_build_sha text NOT NULL CHECK(source_build_sha ~ '^[a-f0-9]{40}$'),
  target_build_sha text NOT NULL CHECK(target_build_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL DEFAULT 'requested' CHECK(state IN (
    'requested','approved','running','verified','failed','cancelled','rejected')),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(reason) BETWEEN 20 AND 1000),
  compatibility_reviewed_at timestamptz NOT NULL,
  source_route_generation bigint,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  host_verified_at timestamptz,
  host_proof jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text NOT NULL DEFAULT '',
  CHECK(source_build_sha<>target_build_sha),
  CHECK(state <> 'verified' OR
    (host_verified_at IS NOT NULL AND completed_at IS NOT NULL
      AND host_proof ? 'routeGeneration' AND host_proof ? 'observedBuildSha')),
  CHECK(state <> 'running' OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_customer_rollback_per_tenant
 ON tenant_release_customer_rollback_requests(tenant_id)
 WHERE state IN ('requested','approved','running');
CREATE INDEX tenant_customer_rollback_history
 ON tenant_release_customer_rollback_requests(tenant_id,requested_at DESC);
REVOKE ALL ON tenant_release_customer_rollback_requests FROM PUBLIC;

CREATE TABLE tenant_release_customer_rollback_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES tenant_release_customer_rollback_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK(event_type IN (
   'requested','approved','started','verified','failed','cancelled','rejected')),
  source_build_sha text NOT NULL CHECK(source_build_sha ~ '^[a-f0-9]{40}$'),
  target_build_sha text NOT NULL CHECK(target_build_sha ~ '^[a-f0-9]{40}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_customer_rollback_events_recent
 ON tenant_release_customer_rollback_events(tenant_id,occurred_at DESC);
REVOKE ALL ON tenant_release_customer_rollback_events FROM PUBLIC;

-- A tenant-wide rollback hold prevents a racing automatic planner, including
-- the existing privileged QA workers, from scheduling or claiming another Live
-- version while a rollback request is pending or being executed.
-- All actors MUST also serialize on the parent tenant row; this trigger locks
-- it BEFORE reading the hold to guard concurrent request/claim transactions.
CREATE OR REPLACE FUNCTION public.hi5_reject_held_tenant_live_rollout()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $h5$
BEGIN
 IF NEW.environment='live'
    AND NEW.status IN ('pending','scheduled','deferred','running') THEN
   PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id FOR UPDATE;
   IF EXISTS (
      SELECT 1 FROM public.tenant_release_upgrade_holds
      WHERE tenant_id=NEW.tenant_id AND active=true
   ) THEN
     RAISE EXCEPTION 'Tenant Production upgrades are held for a customer rollback request';
   END IF;
 END IF;
 RETURN NEW;
END;
$h5$;
REVOKE ALL ON FUNCTION public.hi5_reject_held_tenant_live_rollout() FROM PUBLIC;

CREATE TRIGGER prevent_held_tenant_live_rollout
BEFORE INSERT OR UPDATE OF status ON tenant_release_rollout_jobs
FOR EACH ROW EXECUTE FUNCTION public.hi5_reject_held_tenant_live_rollout();

COMMENT ON TABLE tenant_release_customer_rollback_requests IS
 'Self-service tenant scoped rollback requests only; never implies a completed host rollback.';
COMMENT ON TABLE tenant_release_upgrade_holds IS
 'Per-tenant automatic Live upgrade stop until a verified rollback is accepted and an authorised release hold is lifted.';
