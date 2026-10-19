-- Dedicated customer rollback worker: DB-enforced, default-off, tenant-only.
-- This migration creates a NOLOGIN role with EXECUTE-only permissions on
-- functions that verify a genuine customer request and reviewed compatibility.
-- A separate authorised secret-provisioning step must enable its LOGIN.
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hi5_release_rollback_executor') THEN
   CREATE ROLE hi5_release_rollback_executor NOLOGIN NOINHERIT;
 END IF;
END $roles$;
REVOKE ALL ON SCHEMA public FROM hi5_release_rollback_executor;
GRANT USAGE ON SCHEMA public TO hi5_release_rollback_executor;

ALTER TABLE tenant_release_customer_rollback_requests
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_fence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS executor_revision_sha text
    CHECK(executor_revision_sha IS NULL OR executor_revision_sha ~ '^[a-f0-9]{40}$');
ALTER TABLE tenant_release_customer_rollback_requests
  ADD CONSTRAINT customer_rollback_running_requires_fence
  CHECK(state<>'running' OR
    (lease_token IS NOT NULL AND lease_fence>0 AND
      lease_expires_at IS NOT NULL AND executor_revision_sha IS NOT NULL));
CREATE INDEX IF NOT EXISTS customer_rollback_pending_work
 ON tenant_release_customer_rollback_requests(requested_at,id)
 WHERE state='requested';

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_worker_session_ok()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
 SELECT session_user='hi5_release_rollback_executor'
   AND EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
      WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
        AND l.mode='ExclusiveLock' AND l.granted
        AND l.classid=hashtext('hi5central-release-gateway')::oid
        AND l.objid=hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile')::oid
        AND l.objsubid=2
   )
$function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_worker_session_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_worker_session_ok()
 TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_worker_heartbeat(p_revision text,p_state text,p_error text DEFAULT '')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
BEGIN
 IF session_user<>'hi5_release_rollback_executor'
   OR p_revision !~ '^[a-f0-9]{40}$'
   OR p_state NOT IN ('idle','busy','error','paused')
   OR char_length(p_error)>500
 THEN RAISE EXCEPTION 'Dedicated rollback worker identity, revision or state denied'; END IF;
 INSERT INTO public.platform_release_worker_heartbeats
   (worker_id,gateway,state,version_sha,current_job_id,last_poll_at,last_error)
 VALUES ('customer-rollback-live','live',p_state,p_revision,NULL,now(),coalesce(p_error,''))
 ON CONFLICT(worker_id) DO UPDATE SET
   state=excluded.state,version_sha=excluded.version_sha,
   current_job_id=NULL,last_poll_at=now(),updated_at=now(),
   last_error=excluded.last_error;
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_worker_heartbeat(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_worker_heartbeat(text,text,text) TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_assert_fence(
 p_request uuid,p_token uuid,p_fence bigint,p_revision text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE r record;
BEGIN
 IF NOT public.hi5_customer_rollback_worker_session_ok() THEN
  RAISE EXCEPTION 'No valid restricted gateway rollback owner session'; END IF;
 SELECT q.*,t.status AS tenant_status,p.update_mode,
        a.build_sha AS installed_sha,a.generation,a.pool_id,
        h.active AS held,
        c.state AS compat_state,c.reviewed_at AS compat_reviewed_at,c.expires_at AS compat_expires_at
   INTO r
 FROM public.tenant_release_customer_rollback_requests q
 JOIN public.tenants t ON t.id=q.tenant_id
 JOIN public.tenant_release_preferences p ON p.tenant_id=q.tenant_id
 JOIN public.tenant_release_upgrade_holds h ON h.tenant_id=q.tenant_id
 LEFT JOIN public.tenant_runtime_assignments a
   ON a.tenant_id=q.tenant_id AND a.environment='live'
 LEFT JOIN public.platform_release_rollback_compatibility c
   ON c.from_build_sha=q.source_build_sha AND c.to_build_sha=q.target_build_sha
 WHERE q.id=p_request;
 IF NOT FOUND OR r.state<>'running' OR r.lease_token IS DISTINCT FROM p_token
   OR r.lease_fence<>p_fence OR r.lease_expires_at<=now()
   OR r.executor_revision_sha IS DISTINCT FROM p_revision
   OR r.tenant_status<>'active' OR r.update_mode<>'admin_controlled'
   OR r.held IS DISTINCT FROM true
   OR r.installed_sha IS DISTINCT FROM r.source_build_sha
   OR r.generation IS DISTINCT FROM r.source_route_generation
   OR r.compat_state IS DISTINCT FROM 'approved'
   OR r.compat_expires_at<=now()
   OR r.compat_reviewed_at IS DISTINCT FROM r.compatibility_reviewed_at
   OR NOT EXISTS(
    SELECT 1 FROM public.platform_release_customer_rollback_executor_certifications x
    WHERE x.revision_sha=p_revision AND x.state='approved'
      AND x.expires_at>now() AND x.reviewed_by IS NOT NULL
      AND x.gateway_fence_tested AND x.restricted_role_tested
      AND x.customer_only_route_tested AND x.failure_compensation_tested
      AND x.public_version_verified AND x.audit_completion_tested
      AND x.evidence @> '{"independentHostTest":true,"customerIsolationTest":true}'::jsonb)
 THEN RAISE EXCEPTION 'Customer rollback request/hold/release/generation/certification fence invalid'; END IF;
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_assert_fence(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_assert_fence(uuid,uuid,bigint,text)
 TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_claim(p_revision text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE q record; t record; j record; cert record; snapshot text; pool_row record;
        token uuid; fence bigint;
BEGIN
 IF NOT public.hi5_customer_rollback_worker_session_ok() OR p_revision !~ '^[a-f0-9]{40}$'
 THEN RAISE EXCEPTION 'Customer rollback claim requires restricted host gateway session'; END IF;
 SELECT * INTO cert FROM public.platform_release_customer_rollback_executor_certifications
 WHERE revision_sha=p_revision AND state='approved' AND expires_at>now()
  AND reviewed_by IS NOT NULL AND gateway_fence_tested AND restricted_role_tested
  AND customer_only_route_tested AND failure_compensation_tested
  AND public_version_verified AND audit_completion_tested
  AND evidence @> '{"independentHostTest":true,"customerIsolationTest":true}'::jsonb;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback worker is not independently certified'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'));
 SELECT * INTO q FROM public.tenant_release_customer_rollback_requests
 WHERE state='requested' AND environment='live'
 ORDER BY requested_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT t.id,t.slug,t.status,p.update_mode,h.active,
        a.build_sha AS current_sha,a.generation,a.pool_id,
        ra.build_sha AS route_sha,ra.public_host,ra.state AS route_state,ra.checked_at
   INTO t
 FROM public.tenants t
 JOIN public.tenant_release_preferences p ON p.tenant_id=t.id
 JOIN public.tenant_release_upgrade_holds h ON h.tenant_id=t.id
 JOIN public.tenant_runtime_assignments a ON a.tenant_id=t.id AND a.environment='live'
 JOIN public.tenant_runtime_route_attestations ra ON ra.tenant_id=t.id AND ra.environment='live'
 WHERE t.id=q.tenant_id FOR UPDATE OF t;
 IF NOT FOUND OR t.status<>'active' OR t.update_mode<>'admin_controlled'
  OR t.active IS DISTINCT FROM true
  OR t.current_sha<>q.source_build_sha OR t.generation<>q.source_route_generation
  OR t.route_sha<>q.source_build_sha OR t.route_state<>'active'
  OR t.public_host<>t.slug||'.hi5central.com'
  OR t.checked_at<now()-interval '15 minutes'
  OR EXISTS(SELECT 1 FROM public.tenant_release_rollout_jobs
     WHERE tenant_id=q.tenant_id AND environment='live'
       AND status IN ('pending','scheduled','deferred','running'))
 THEN RAISE EXCEPTION 'Customer rollback tenant and route are not safely eligible'; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM public.platform_release_rollback_compatibility c
  WHERE c.from_build_sha=q.source_build_sha AND c.to_build_sha=q.target_build_sha
    AND c.state='approved' AND c.schema_backward_compatible
    AND c.immutable_images_verified AND c.recovery_snapshot_verified
    AND c.reviewed_by IS NOT NULL AND c.reviewed_at=q.compatibility_reviewed_at
    AND c.expires_at>now()
    AND c.evidence @> '{"schemaChecked":true,"previousImagePulled":true,"recoveryTestPassed":true}'::jsonb)
 THEN RAISE EXCEPTION 'Rollback exact build pair has no valid independent compatibility review'; END IF;
 SELECT j.id,j.status,j.build_sha,j.previous_build_sha,j.completed_at
 INTO j FROM public.tenant_release_rollout_jobs j
 WHERE j.tenant_id=q.tenant_id AND j.environment='live'
   AND j.build_sha=q.source_build_sha AND j.previous_build_sha=q.target_build_sha
   AND j.status='succeeded' AND j.completed_at IS NOT NULL
 ORDER BY j.completed_at DESC LIMIT 1 FOR UPDATE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'No verified source release to restore'; END IF;
 SELECT e.details->>'backup' INTO snapshot
 FROM public.tenant_release_rollout_events e
 WHERE e.job_id=j.id AND e.event_type='verified'
   AND e.details->>'previousSha'=q.target_build_sha
 ORDER BY e.id DESC LIMIT 1;
 IF snapshot IS NULL
   OR snapshot !~ '^release-live-[0-9]{10,18}-[a-z0-9-]+$'
   OR snapshot NOT LIKE '%-'||replace(t.public_host,'.','-')
 THEN RAISE EXCEPTION 'Immutable prior gateway snapshot proof missing'; END IF;
 token:=gen_random_uuid();fence:=q.lease_fence+1;
 UPDATE public.tenant_release_customer_rollback_requests SET
   state='running',started_at=now(),lease_token=token,
   lease_fence=fence,lease_expires_at=now()+interval '10 minutes',
   executor_revision_sha=p_revision,last_error=''
 WHERE id=q.id AND state='requested';
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'started',q.source_build_sha,q.target_build_sha,
   jsonb_build_object('leaseFence',fence,'workerRevision',p_revision,
     'originalCustomerApprover',q.requested_by,
     'sourceRouteGeneration',q.source_route_generation));
 RETURN jsonb_build_object(
   'requestId',q.id,'tenantId',q.tenant_id,'slug',t.slug,'host',t.public_host,
   'sourceSha',q.source_build_sha,'targetSha',q.target_build_sha,
   'generation',q.source_route_generation,'poolId',t.pool_id,
   'originalJobId',j.id,'snapshot',snapshot,
   'leaseToken',token,'leaseFence',fence,'workerRevision',p_revision);
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_claim(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_claim(text) TO hi5_release_rollback_executor;
