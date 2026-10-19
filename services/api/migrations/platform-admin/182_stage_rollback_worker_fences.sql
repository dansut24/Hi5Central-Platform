-- Use the existing stage-restricted release identities and the existing
-- physical shared-gateway advisory lock. No new database superuser, no
-- second standing release-control service, and no customer Live permission.
--
-- These functions are the ONLY queue-claim/completion authority for stage
-- workers. There are NO direct table-write grants to the worker identities.

CREATE OR REPLACE FUNCTION public.hi5_stage_rollback_session_ok(p_stage text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT p_stage IN ('uat','live')
 AND session_user=('hi5_release_executor_'||p_stage)
 AND EXISTS(
  SELECT 1 FROM pg_catalog.pg_locks l
  WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
   AND l.mode='ExclusiveLock' AND l.granted
   AND l.classid=hashtext('hi5central-release-gateway')::oid
   AND l.objid=hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile')::oid
   AND l.objsubid=2
 )
$$;
REVOKE ALL ON FUNCTION public.hi5_stage_rollback_session_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_stage_rollback_session_ok(text)
 TO hi5_release_executor_uat,hi5_release_executor_live;

CREATE OR REPLACE FUNCTION public.hi5_stage_rollback_claim(p_stage text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE request_row record; token uuid;
BEGIN
 IF NOT public.hi5_stage_rollback_session_ok(p_stage) THEN
  RAISE EXCEPTION 'Only the assigned restricted stage worker holding the shared gateway lock can claim a rollback'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'));
 SELECT r.*,t.slug,p.update_mode,a.build_sha AS installed_sha,
   a.pool_id AS installed_pool,a.generation AS installed_generation
 INTO request_row
 FROM public.platform_release_rollback_jobs r
 JOIN public.tenants t ON t.id=r.tenant_id AND t.status='active'
 JOIN public.tenant_release_preferences p ON p.tenant_id=r.tenant_id
 JOIN public.tenant_runtime_assignments a
    ON a.tenant_id=r.tenant_id AND a.environment=r.environment
 JOIN public.tenant_runtime_route_attestations att
    ON att.tenant_id=r.tenant_id AND att.environment=r.environment
 JOIN public.tenant_release_rollout_jobs j ON j.id=r.original_release_job_id
 WHERE r.environment=p_stage AND r.state='requested'
   AND (r.requested_via='hi5central_admin'
       OR (r.requested_via='custom_customer' AND p_stage='uat'
           AND p.update_mode='admin_controlled'))
   AND (p_stage<>'uat' OR p.update_mode='admin_controlled')
   AND a.build_sha=r.source_build_sha
   AND a.generation=r.source_route_generation
   AND att.pool_id=a.pool_id AND att.build_sha=a.build_sha
   AND att.state='active' AND att.public_host=
         t.slug||CASE WHEN p_stage='live' THEN '' ELSE '-uat' END||'.hi5central.com'
   AND att.checked_at>now()-interval '15 minutes'
   AND j.tenant_id=r.tenant_id AND j.environment=r.environment
   AND j.build_sha=r.source_build_sha AND j.previous_build_sha=r.target_build_sha
   AND j.status='succeeded' AND j.completed_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.tenant_release_rollout_events e
    WHERE e.job_id=j.id AND e.event_type='verified'
      AND e.details->>'previousSha'=r.target_build_sha
      AND length(e.details->>'backup')>20)
   AND NOT EXISTS(SELECT 1 FROM public.tenant_release_rollout_jobs active_job
    WHERE active_job.tenant_id=r.tenant_id AND active_job.environment=p_stage
      AND active_job.status IN ('pending','scheduled','deferred','running'))
   AND (p_stage<>'live' OR EXISTS(
    SELECT 1 FROM public.tenant_release_upgrade_holds h
    WHERE h.tenant_id=r.tenant_id AND h.active))
 ORDER BY r.created_at,r.id
 FOR UPDATE OF r SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 token:=gen_random_uuid();
 UPDATE public.platform_release_rollback_jobs SET
  state='running',started_at=now(),lease_token=token,
  lease_fence=lease_fence+1,lease_expires_at=now()+interval '30 minutes'
 WHERE id=request_row.id AND state='requested'
 RETURNING lease_fence INTO STRICT request_row.lease_fence;
 INSERT INTO public.platform_release_rollback_events
 (request_id,tenant_id,actor_user_id,event_type,details)
 VALUES(request_row.id,request_row.tenant_id,NULL,'started',
  jsonb_build_object('stage',p_stage,'originalReleaseJobId',request_row.original_release_job_id,
   'leaseFence',request_row.lease_fence));
 RETURN jsonb_build_object(
  'id',request_row.id,'tenantId',request_row.tenant_id,'tenantSlug',request_row.slug,
  'environment',p_stage,'fromSha',request_row.source_build_sha,
  'toSha',request_row.target_build_sha,'generation',request_row.source_route_generation,
  'originalJobId',request_row.original_release_job_id,
  'leaseToken',token,'leaseFence',request_row.lease_fence);
END $$;
REVOKE ALL ON FUNCTION public.hi5_stage_rollback_claim(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_stage_rollback_claim(text)
 TO hi5_release_executor_uat,hi5_release_executor_live;

CREATE OR REPLACE FUNCTION public.hi5_stage_rollback_assert(
 p_id uuid,p_token uuid,p_fence bigint,p_stage text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE row_state record;
BEGIN
 IF NOT public.hi5_stage_rollback_session_ok(p_stage) THEN
  RAISE EXCEPTION 'Rollback stage identity or physical gateway lock lost'; END IF;
 SELECT r.*,a.build_sha AS installed_sha,a.generation AS installed_generation
  INTO row_state FROM public.platform_release_rollback_jobs r
  JOIN public.tenant_runtime_assignments a
   ON a.tenant_id=r.tenant_id AND a.environment=r.environment
  WHERE r.id=p_id AND r.environment=p_stage;
 IF NOT FOUND OR row_state.state<>'running'
  OR row_state.lease_token IS DISTINCT FROM p_token
  OR row_state.lease_fence<>p_fence
  OR row_state.lease_expires_at<=now()
  OR row_state.installed_sha IS DISTINCT FROM row_state.source_build_sha
  OR row_state.installed_generation IS DISTINCT FROM row_state.source_route_generation
 THEN RAISE EXCEPTION 'Rollback lease, source build or generation is invalid'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.hi5_stage_rollback_assert(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_stage_rollback_assert(uuid,uuid,bigint,text)
 TO hi5_release_executor_uat,hi5_release_executor_live;

CREATE OR REPLACE FUNCTION public.hi5_stage_rollback_complete(
 p_id uuid,p_token uuid,p_fence bigint,p_stage text,p_proof jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE r record;pool_name text;hostname text;fresh_generation bigint;
BEGIN
 PERFORM public.hi5_stage_rollback_assert(p_id,p_token,p_fence,p_stage);
 SELECT rj.*,t.slug INTO STRICT r FROM public.platform_release_rollback_jobs rj
 JOIN public.tenants t ON t.id=rj.tenant_id WHERE rj.id=p_id FOR UPDATE OF rj;
 hostname:=r.slug||CASE WHEN p_stage='live' THEN '' ELSE '-uat' END||'.hi5central.com';
 IF p_proof IS NULL OR jsonb_typeof(p_proof)<>'object'
  OR p_proof->>'publicApiSha' IS DISTINCT FROM r.target_build_sha
  OR p_proof->>'publicWebSha' IS DISTINCT FROM r.target_build_sha
  OR p_proof->>'hostname' IS DISTINCT FROM hostname
  OR p_proof->>'sourceSha' IS DISTINCT FROM r.source_build_sha
  OR p_proof->>'targetSha' IS DISTINCT FROM r.target_build_sha
  OR p_proof->>'routeGeneration' IS DISTINCT FROM r.source_route_generation::text
  OR p_proof->>'otherCustomersUnchanged' IS DISTINCT FROM 'true'
  OR p_proof->>'gatewaySourceAndMountMatch' IS DISTINCT FROM 'true'
  OR p_proof->>'priorImagesHealthy' IS DISTINCT FROM 'true'
  OR p_proof->>'verifiedStage' IS DISTINCT FROM p_stage
 THEN RAISE EXCEPTION 'Host-level exact tenant public API, frontend and isolation proof missing'; END IF;
 pool_name:='h5pool-'||p_stage||'-'||left(r.target_build_sha,12);
 IF NOT EXISTS(SELECT 1 FROM public.platform_runtime_pools
  WHERE id=pool_name AND build_sha=r.target_build_sha AND environment=p_stage
   AND state='verified') THEN
  RAISE EXCEPTION 'Previous immutable pool is not registered and host-verified'; END IF;
 fresh_generation:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
 UPDATE public.tenant_runtime_assignments SET pool_id=pool_name,
  build_sha=r.target_build_sha,generation=fresh_generation,activated_at=now()
 WHERE tenant_id=r.tenant_id AND environment=p_stage
  AND build_sha=r.source_build_sha AND generation=r.source_route_generation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant assignment changed during rollback'; END IF;
 UPDATE public.tenant_runtime_route_attestations
 SET pool_id=pool_name,build_sha=r.target_build_sha,
     public_host=hostname,state='active',checked_at=now()
 WHERE tenant_id=r.tenant_id AND environment=p_stage
  AND build_sha=r.source_build_sha;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant route attestation changed during rollback'; END IF;
 UPDATE public.tenant_release_rollout_jobs SET
   status='rolled_back',updated_at=now()
 WHERE id=r.original_release_job_id AND tenant_id=r.tenant_id
  AND environment=p_stage AND status='succeeded'
  AND build_sha=r.source_build_sha AND previous_build_sha=r.target_build_sha;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original verified release no longer eligible'; END IF;
 INSERT INTO public.tenant_release_rollout_events
  (job_id,tenant_id,environment,build_sha,event_type,details)
 VALUES(r.original_release_job_id,r.tenant_id,p_stage,r.source_build_sha,
  'rolled_back',p_proof||jsonb_build_object('requestId',r.id));
 IF p_stage='live' THEN
  UPDATE public.tenant_runtime_update_offers SET
    state='blocked',updated_at=now(),
    last_gate_reason='Hi5Central administrator rollback verified; future Production upgrades held.'
  WHERE tenant_id=r.tenant_id AND environment='live'
    AND build_sha=r.source_build_sha AND state='active';
 ELSE
  UPDATE public.tenant_runtime_update_offers SET
    state='blocked',updated_at=now(),
    last_gate_reason='Custom UAT rollback independently verified; this version is no longer accepted for Production promotion.'
  WHERE tenant_id=r.tenant_id AND environment='uat'
    AND build_sha=r.source_build_sha
    AND state IN ('uat_testing','uat_accepted','active');
 END IF;
 UPDATE public.platform_release_rollback_jobs SET
  state='verified',completed_at=now(),lease_token=NULL,
  lease_expires_at=NULL,proof=p_proof||jsonb_build_object('newRouteGeneration',fresh_generation),
  last_error=''
 WHERE id=p_id AND state='running' AND lease_token=p_token AND lease_fence=p_fence;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback completion lease changed'; END IF;
 INSERT INTO public.platform_release_rollback_events
  (request_id,tenant_id,actor_user_id,event_type,details)
 VALUES(r.id,r.tenant_id,NULL,'verified',
  p_proof||jsonb_build_object('newRouteGeneration',fresh_generation));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.hi5_stage_rollback_complete(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_stage_rollback_complete(uuid,uuid,bigint,text,jsonb)
 TO hi5_release_executor_uat,hi5_release_executor_live;

CREATE OR REPLACE FUNCTION public.hi5_stage_rollback_fail(
 p_id uuid,p_token uuid,p_fence bigint,p_stage text,
 p_error text,p_original_restored boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
 IF NOT public.hi5_stage_rollback_session_ok(p_stage) THEN
  RAISE EXCEPTION 'Rollback failure is restricted to the stage gateway owner'; END IF;
 SELECT * INTO STRICT r FROM public.platform_release_rollback_jobs
 WHERE id=p_id AND environment=p_stage AND state='running'
   AND lease_token=p_token AND lease_fence=p_fence FOR UPDATE;
 UPDATE public.platform_release_rollback_jobs SET
   state=CASE WHEN p_original_restored THEN 'failed' ELSE 'running' END,
   lease_token=CASE WHEN p_original_restored THEN NULL ELSE lease_token END,
   lease_expires_at=CASE WHEN p_original_restored THEN NULL ELSE lease_expires_at END,
   completed_at=CASE WHEN p_original_restored THEN now() ELSE NULL END,
   last_error=left(coalesce(p_error,'Unverified gateway recovery'),500)
 WHERE id=p_id;
 INSERT INTO public.platform_release_rollback_events
 (request_id,tenant_id,actor_user_id,event_type,details)
 VALUES(p_id,r.tenant_id,NULL,'failed',
  jsonb_build_object('error',left(coalesce(p_error,''),500),
    'originalRestored',p_original_restored,
    'requiresOperatorReview',NOT p_original_restored));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.hi5_stage_rollback_fail(uuid,uuid,bigint,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_stage_rollback_fail(uuid,uuid,bigint,text,text,boolean)
 TO hi5_release_executor_uat,hi5_release_executor_live;
