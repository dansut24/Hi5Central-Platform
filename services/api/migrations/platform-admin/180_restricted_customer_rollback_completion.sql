-- Host-verified completion and safe compensation for the dedicated rollback role.
-- No direct write privilege on release tables is granted to the worker.
CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_complete(
 p_request uuid,p_token uuid,p_fence bigint,p_revision text,
 p_proof jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE q record;j record; mode text;target_pool text;proof_gen bigint;
BEGIN
 PERFORM public.hi5_customer_rollback_assert_fence(p_request,p_token,p_fence,p_revision);
 SELECT * INTO STRICT q FROM public.tenant_release_customer_rollback_requests
 WHERE id=p_request FOR UPDATE;
 IF p_proof IS NULL OR jsonb_typeof(p_proof)<>'object'
   OR p_proof->>'publicApiSha' IS DISTINCT FROM q.target_build_sha
   OR p_proof->>'publicWebSha' IS DISTINCT FROM q.target_build_sha
   OR p_proof->>'hostname' IS DISTINCT FROM
        (SELECT slug||'.hi5central.com' FROM public.tenants WHERE id=q.tenant_id)
   OR p_proof->>'recoveredFromBackup' IS DISTINCT FROM 'true'
   OR p_proof->>'otherCustomersUnchanged' IS DISTINCT FROM 'true'
   OR p_proof->>'uatUnchanged' IS DISTINCT FROM 'true'
   OR p_proof->>'gatewaySourceAndMountMatch' IS DISTINCT FROM 'true'
   OR p_proof->>'priorImagesHealthy' IS DISTINCT FROM 'true'
   OR p_proof->>'sourceRouteGeneration' IS DISTINCT FROM q.source_route_generation::text
   OR p_proof->>'routeGeneration' IS DISTINCT FROM q.source_route_generation::text
   OR p_proof->>'observedBuildSha' IS DISTINCT FROM q.target_build_sha
   OR p_proof->>'workerRevision' IS DISTINCT FROM p_revision
   OR NOT coalesce((p_proof->>'previousSnapshotSha256' ~ '^[a-f0-9]{64}
 THEN RAISE EXCEPTION 'Independently verified complete route/versions/recovery proof is required'; END IF;
 mode:=p_proof->>'restorationMode';
 IF mode NOT IN ('legacy_shared_fallback','previous_versioned_pool')
 THEN RAISE EXCEPTION 'Previous route type missing'; END IF;
 SELECT id,status,build_sha,previous_build_sha INTO j
 FROM public.tenant_release_rollout_jobs
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND previous_build_sha=q.target_build_sha
   AND status='succeeded' ORDER BY completed_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact successful original release changed during rollback'; END IF;
 IF mode='legacy_shared_fallback' THEN
   DELETE FROM public.tenant_runtime_route_attestations
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
   DELETE FROM public.tenant_runtime_assignments
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha
     AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
 ELSE
   target_pool:='h5pool-live-'||left(q.target_build_sha,12);
   IF NOT EXISTS(
     SELECT 1 FROM public.platform_runtime_pools
     WHERE id=target_pool AND environment='live' AND build_sha=q.target_build_sha
       AND state='verified'
   ) THEN RAISE EXCEPTION 'Previously verified versioned pool is unavailable'; END IF;
   UPDATE public.tenant_runtime_assignments SET
     pool_id=target_pool,build_sha=q.target_build_sha,
     generation=(extract(epoch FROM clock_timestamp())*1000)::bigint,
     activated_at=now()
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
   UPDATE public.tenant_runtime_route_attestations SET
     pool_id=target_pool,build_sha=q.target_build_sha,checked_at=now(),state='active'
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
 END IF;
 UPDATE public.tenant_runtime_update_offers SET
   state='blocked',
   last_gate_reason='Customer-approved Production rollback verified. Future upgrades held pending explicit acceptance.',
   updated_at=now()
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND state='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Previously active Production offer changed'; END IF;
 UPDATE public.tenant_release_rollout_jobs SET status='rolled_back',updated_at=now()
 WHERE id=j.id AND status='succeeded';
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact release job changed'; END IF;
 INSERT INTO public.tenant_release_rollout_events
   (job_id,tenant_id,environment,build_sha,event_type,details)
 VALUES(j.id,q.tenant_id,'live',q.source_build_sha,'rolled_back',
   p_proof||jsonb_build_object('requestId',q.id,'reviewedExecutor',p_revision,'leaseFence',p_fence));
 UPDATE public.tenant_release_customer_rollback_requests SET
   state='verified',completed_at=now(),host_verified_at=now(),
   host_proof=p_proof,lease_token=NULL,lease_expires_at=NULL,last_error=''
 WHERE id=q.id AND lease_token=p_token AND lease_fence=p_fence AND state='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback lease expired while persisting verification'; END IF;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'verified',q.source_build_sha,q.target_build_sha,
   p_proof||jsonb_build_object('originalCustomerApprover',q.requested_by,'leaseFence',p_fence));
 INSERT INTO public.platform_admin_audit_events(action,target_type,target_id,metadata)
 VALUES('release.customer_self_service_live_rollback_verified','rollback_request',
   q.id::text,p_proof||jsonb_build_object('tenantId',q.tenant_id,
     'originatingCustomerUserId',q.requested_by,
     'workerRevisionSha',p_revision,'upgradeHoldPreserved',true));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb)
 TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_fail(
 p_request uuid,p_token uuid,p_fence bigint,p_revision text,
 p_error text,p_source_restored boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE q record;
BEGIN
 IF NOT public.hi5_customer_rollback_worker_session_ok() THEN
  RAISE EXCEPTION 'Only the restricted active gateway worker may report rollback failure'; END IF;
 SELECT * INTO q FROM public.tenant_release_customer_rollback_requests
 WHERE id=p_request AND lease_token=p_token AND lease_fence=p_fence
   AND executor_revision_sha=p_revision AND state='running' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback claim changed; cannot mark failed'; END IF;
 -- If the gateway cannot be proved restored, do not close the request or
 -- release its hold: leave it running for staff recovery and audit the error.
 UPDATE public.tenant_release_customer_rollback_requests SET
   last_error=left(coalesce(p_error,'Unverified gateway recovery'),500),
   state=CASE WHEN p_source_restored THEN 'failed' ELSE 'running' END,
   completed_at=CASE WHEN p_source_restored THEN now() ELSE NULL END,
   lease_token=CASE WHEN p_source_restored THEN NULL ELSE lease_token END,
   lease_expires_at=CASE WHEN p_source_restored THEN NULL ELSE lease_expires_at END
 WHERE id=p_request;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'failed',q.source_build_sha,q.target_build_sha,
   jsonb_build_object('error',left(coalesce(p_error,''),500),'sourceRestored',p_source_restored,
     'workerRevision',p_revision,'leaseFence',p_fence,
     'requiresStaffIntervention',NOT p_source_restored));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean)
 TO hi5_release_rollback_executor;
),false)
   OR NOT coalesce((p_proof->>'restoredRouteSha256' ~ '^[a-f0-9]{64}
 THEN RAISE EXCEPTION 'Independently verified complete route/versions/recovery proof is required'; END IF;
 mode:=p_proof->>'restorationMode';
 IF mode NOT IN ('legacy_shared_fallback','previous_versioned_pool')
 THEN RAISE EXCEPTION 'Previous route type missing'; END IF;
 SELECT id,status,build_sha,previous_build_sha INTO j
 FROM public.tenant_release_rollout_jobs
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND previous_build_sha=q.target_build_sha
   AND status='succeeded' ORDER BY completed_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact successful original release changed during rollback'; END IF;
 IF mode='legacy_shared_fallback' THEN
   DELETE FROM public.tenant_runtime_route_attestations
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
   DELETE FROM public.tenant_runtime_assignments
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha
     AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
 ELSE
   target_pool:='h5pool-live-'||left(q.target_build_sha,12);
   IF NOT EXISTS(
     SELECT 1 FROM public.platform_runtime_pools
     WHERE id=target_pool AND environment='live' AND build_sha=q.target_build_sha
       AND state='verified'
   ) THEN RAISE EXCEPTION 'Previously verified versioned pool is unavailable'; END IF;
   UPDATE public.tenant_runtime_assignments SET
     pool_id=target_pool,build_sha=q.target_build_sha,
     generation=(extract(epoch FROM clock_timestamp())*1000)::bigint,
     activated_at=now()
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
   UPDATE public.tenant_runtime_route_attestations SET
     pool_id=target_pool,build_sha=q.target_build_sha,checked_at=now(),state='active'
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
 END IF;
 UPDATE public.tenant_runtime_update_offers SET
   state='blocked',
   last_gate_reason='Customer-approved Production rollback verified. Future upgrades held pending explicit acceptance.',
   updated_at=now()
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND state='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Previously active Production offer changed'; END IF;
 UPDATE public.tenant_release_rollout_jobs SET status='rolled_back',updated_at=now()
 WHERE id=j.id AND status='succeeded';
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact release job changed'; END IF;
 INSERT INTO public.tenant_release_rollout_events
   (job_id,tenant_id,environment,build_sha,event_type,details)
 VALUES(j.id,q.tenant_id,'live',q.source_build_sha,'rolled_back',
   p_proof||jsonb_build_object('requestId',q.id,'reviewedExecutor',p_revision,'leaseFence',p_fence));
 UPDATE public.tenant_release_customer_rollback_requests SET
   state='verified',completed_at=now(),host_verified_at=now(),
   host_proof=p_proof,lease_token=NULL,lease_expires_at=NULL,last_error=''
 WHERE id=q.id AND lease_token=p_token AND lease_fence=p_fence AND state='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback lease expired while persisting verification'; END IF;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'verified',q.source_build_sha,q.target_build_sha,
   p_proof||jsonb_build_object('originalCustomerApprover',q.requested_by,'leaseFence',p_fence));
 INSERT INTO public.platform_admin_audit_events(action,target_type,target_id,metadata)
 VALUES('release.customer_self_service_live_rollback_verified','rollback_request',
   q.id::text,p_proof||jsonb_build_object('tenantId',q.tenant_id,
     'originatingCustomerUserId',q.requested_by,
     'workerRevisionSha',p_revision,'upgradeHoldPreserved',true));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb)
 TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_fail(
 p_request uuid,p_token uuid,p_fence bigint,p_revision text,
 p_error text,p_source_restored boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE q record;
BEGIN
 IF NOT public.hi5_customer_rollback_worker_session_ok() THEN
  RAISE EXCEPTION 'Only the restricted active gateway worker may report rollback failure'; END IF;
 SELECT * INTO q FROM public.tenant_release_customer_rollback_requests
 WHERE id=p_request AND lease_token=p_token AND lease_fence=p_fence
   AND executor_revision_sha=p_revision AND state='running' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback claim changed; cannot mark failed'; END IF;
 -- If the gateway cannot be proved restored, do not close the request or
 -- release its hold: leave it running for staff recovery and audit the error.
 UPDATE public.tenant_release_customer_rollback_requests SET
   last_error=left(coalesce(p_error,'Unverified gateway recovery'),500),
   state=CASE WHEN p_source_restored THEN 'failed' ELSE 'running' END,
   completed_at=CASE WHEN p_source_restored THEN now() ELSE NULL END,
   lease_token=CASE WHEN p_source_restored THEN NULL ELSE lease_token END,
   lease_expires_at=CASE WHEN p_source_restored THEN NULL ELSE lease_expires_at END
 WHERE id=p_request;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'failed',q.source_build_sha,q.target_build_sha,
   jsonb_build_object('error',left(coalesce(p_error,''),500),'sourceRestored',p_source_restored,
     'workerRevision',p_revision,'leaseFence',p_fence,
     'requiresStaffIntervention',NOT p_source_restored));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean)
 TO hi5_release_rollback_executor;
),false)
 THEN RAISE EXCEPTION 'Independently verified complete route/versions/recovery proof is required'; END IF;
 mode:=p_proof->>'restorationMode';
 IF mode NOT IN ('legacy_shared_fallback','previous_versioned_pool')
 THEN RAISE EXCEPTION 'Previous route type missing'; END IF;
 SELECT id,status,build_sha,previous_build_sha INTO j
 FROM public.tenant_release_rollout_jobs
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND previous_build_sha=q.target_build_sha
   AND status='succeeded' ORDER BY completed_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact successful original release changed during rollback'; END IF;
 IF mode='legacy_shared_fallback' THEN
   DELETE FROM public.tenant_runtime_route_attestations
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
   DELETE FROM public.tenant_runtime_assignments
   WHERE tenant_id=q.tenant_id AND environment='live' AND build_sha=q.source_build_sha
     AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
 ELSE
   target_pool:='h5pool-live-'||left(q.target_build_sha,12);
   IF NOT EXISTS(
     SELECT 1 FROM public.platform_runtime_pools
     WHERE id=target_pool AND environment='live' AND build_sha=q.target_build_sha
       AND state='verified'
   ) THEN RAISE EXCEPTION 'Previously verified versioned pool is unavailable'; END IF;
   UPDATE public.tenant_runtime_assignments SET
     pool_id=target_pool,build_sha=q.target_build_sha,
     generation=(extract(epoch FROM clock_timestamp())*1000)::bigint,
     activated_at=now()
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha AND generation=q.source_route_generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production assignment changed'; END IF;
   UPDATE public.tenant_runtime_route_attestations SET
     pool_id=target_pool,build_sha=q.target_build_sha,checked_at=now(),state='active'
   WHERE tenant_id=q.tenant_id AND environment='live'
     AND build_sha=q.source_build_sha;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original customer Production route attestation changed'; END IF;
 END IF;
 UPDATE public.tenant_runtime_update_offers SET
   state='blocked',
   last_gate_reason='Customer-approved Production rollback verified. Future upgrades held pending explicit acceptance.',
   updated_at=now()
 WHERE tenant_id=q.tenant_id AND environment='live'
   AND build_sha=q.source_build_sha AND state='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Previously active Production offer changed'; END IF;
 UPDATE public.tenant_release_rollout_jobs SET status='rolled_back',updated_at=now()
 WHERE id=j.id AND status='succeeded';
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact release job changed'; END IF;
 INSERT INTO public.tenant_release_rollout_events
   (job_id,tenant_id,environment,build_sha,event_type,details)
 VALUES(j.id,q.tenant_id,'live',q.source_build_sha,'rolled_back',
   p_proof||jsonb_build_object('requestId',q.id,'reviewedExecutor',p_revision,'leaseFence',p_fence));
 UPDATE public.tenant_release_customer_rollback_requests SET
   state='verified',completed_at=now(),host_verified_at=now(),
   host_proof=p_proof,lease_token=NULL,lease_expires_at=NULL,last_error=''
 WHERE id=q.id AND lease_token=p_token AND lease_fence=p_fence AND state='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback lease expired while persisting verification'; END IF;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'verified',q.source_build_sha,q.target_build_sha,
   p_proof||jsonb_build_object('originalCustomerApprover',q.requested_by,'leaseFence',p_fence));
 INSERT INTO public.platform_admin_audit_events(action,target_type,target_id,metadata)
 VALUES('release.customer_self_service_live_rollback_verified','rollback_request',
   q.id::text,p_proof||jsonb_build_object('tenantId',q.tenant_id,
     'originatingCustomerUserId',q.requested_by,
     'workerRevisionSha',p_revision,'upgradeHoldPreserved',true));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_complete(uuid,uuid,bigint,text,jsonb)
 TO hi5_release_rollback_executor;

CREATE OR REPLACE FUNCTION public.hi5_customer_rollback_fail(
 p_request uuid,p_token uuid,p_fence bigint,p_revision text,
 p_error text,p_source_restored boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE q record;
BEGIN
 IF NOT public.hi5_customer_rollback_worker_session_ok() THEN
  RAISE EXCEPTION 'Only the restricted active gateway worker may report rollback failure'; END IF;
 SELECT * INTO q FROM public.tenant_release_customer_rollback_requests
 WHERE id=p_request AND lease_token=p_token AND lease_fence=p_fence
   AND executor_revision_sha=p_revision AND state='running' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rollback claim changed; cannot mark failed'; END IF;
 -- If the gateway cannot be proved restored, do not close the request or
 -- release its hold: leave it running for staff recovery and audit the error.
 UPDATE public.tenant_release_customer_rollback_requests SET
   last_error=left(coalesce(p_error,'Unverified gateway recovery'),500),
   state=CASE WHEN p_source_restored THEN 'failed' ELSE 'running' END,
   completed_at=CASE WHEN p_source_restored THEN now() ELSE NULL END,
   lease_token=CASE WHEN p_source_restored THEN NULL ELSE lease_token END,
   lease_expires_at=CASE WHEN p_source_restored THEN NULL ELSE lease_expires_at END
 WHERE id=p_request;
 INSERT INTO public.tenant_release_customer_rollback_events
   (request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)
 VALUES(q.id,q.tenant_id,NULL,'failed',q.source_build_sha,q.target_build_sha,
   jsonb_build_object('error',left(coalesce(p_error,''),500),'sourceRestored',p_source_restored,
     'workerRevision',p_revision,'leaseFence',p_fence,
     'requiresStaffIntervention',NOT p_source_restored));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_customer_rollback_fail(uuid,uuid,bigint,text,text,boolean)
 TO hi5_release_rollback_executor;
