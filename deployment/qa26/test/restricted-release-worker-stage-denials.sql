-- Run ONLY in an isolated schema-only PostgreSQL 17 database, as superuser,
-- after applying restricted-release-workers.sql. ROLLBACK prevents fixture
-- persistence. Never execute directly against real customer Production.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.platform_runtime_pools
 (id,environment,build_sha,api_target,web_target,state,verified_at)
VALUES
 ('h5pool-test-101010101010','test',repeat('1',40),'qa-test-api:3001','qa-test-web:80','verified',now()),
 ('h5pool-uat-202020202020','uat',repeat('2',40),'qa-uat-api:3001','qa-uat-web:80','verified',now()),
 ('h5pool-live-303030303030','live',repeat('3',40),'qa-live-api:3001','qa-live-web:80','verified',now())
ON CONFLICT (id) DO NOTHING;
SET SESSION AUTHORIZATION hi5_release_executor_test;
DO $stage_test$
DECLARE visible_env text; denied boolean:=false; changed integer;
BEGIN
 SELECT string_agg(DISTINCT environment,',' ORDER BY environment)
   INTO visible_env FROM public.platform_runtime_pools
   WHERE id IN ('h5pool-test-101010101010','h5pool-uat-202020202020','h5pool-live-303030303030');
 IF visible_env<>'test' THEN RAISE EXCEPTION 'Test role read another stage: %',visible_env; END IF;
 BEGIN
   INSERT INTO public.platform_runtime_pools
     (id,environment,build_sha,api_target,web_target,state,verified_at)
   VALUES ('h5pool-live-404040404040','live',repeat('4',40),'x:3001','x:80','verified',now());
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'Test role inserted Live pool'; END IF;
 UPDATE public.platform_runtime_pools SET state='failed'
   WHERE id='h5pool-live-303030303030';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'Test role updated Live pool'; END IF;
 IF has_table_privilege(current_user,'public.platform_release_rollout_control','UPDATE') THEN
   RAISE EXCEPTION 'Test executor has unpause permission';
 END IF;
 RAISE NOTICE 'PASS Test RLS read/write and no global pause UPDATE';
END $stage_test$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hi5_release_executor_uat;
DO $stage_uat$
DECLARE denied boolean:=false;changed integer;
BEGIN
 BEGIN
  INSERT INTO public.platform_runtime_pools
    (id,environment,build_sha,api_target,web_target,state,verified_at)
  VALUES ('h5pool-live-505050505050','live',repeat('5',40),'x:3001','x:80','verified',now());
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'UAT role inserted Live pool directly'; END IF;
 UPDATE public.platform_runtime_pools SET state='failed'
   WHERE id='h5pool-live-303030303030';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'UAT role updated Live pool'; END IF;
 denied:=false;
 BEGIN
  PERFORM public.hi5_release_prepare_live_after_uat(
   '11111111-1111-4111-8111-111111111111'::uuid,
   '22222222-2222-4222-8222-222222222222'::uuid,1);
 EXCEPTION WHEN raise_exception THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'UAT staged Live without a real lease'; END IF;
 RAISE NOTICE 'PASS UAT direct Live write denial and fenced cross-stage function';
END $stage_uat$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hi5_release_executor_live;
DO $stage_live$
DECLARE changed integer;
BEGIN
 UPDATE public.platform_runtime_pools SET state='failed'
   WHERE id='h5pool-test-101010101010';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'Live role updated Test pool'; END IF;
 IF has_table_privilege(current_user,'public.platform_release_rollout_control','UPDATE') THEN
   RAISE EXCEPTION 'Live executor has global pause UPDATE';
 END IF;
 RAISE NOTICE 'PASS Live cannot write Test stage or global pause';
END $stage_live$;
RESET SESSION AUTHORIZATION;
DO $planner_check$
BEGIN
 IF NOT has_column_privilege('hi5_release_planner','public.tenant_release_rollout_jobs','status','UPDATE') THEN
  RAISE EXCEPTION 'Planner cannot promote pending jobs';
 END IF;
 IF has_column_privilege('hi5_release_planner','public.tenant_release_rollout_jobs','lease_token','UPDATE') THEN
  RAISE EXCEPTION 'Planner can change worker leases';
 END IF;
 IF has_column_privilege('hi5_release_planner','public.tenant_release_rollout_jobs','lease_fence','UPDATE') THEN
  RAISE EXCEPTION 'Planner can change lease fencing';
 END IF;
 RAISE NOTICE 'PASS planner status-only UPDATE columns; no lease or fence grants';
END $planner_check$;
ROLLBACK;
