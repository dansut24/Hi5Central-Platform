-- Reviewed operator-run release worker stage identity boundary.
-- Requires the additive release-control schema (through verified rollout/route stages).
-- Run only after source and stage denial tests are reviewed. NO credentials are embedded.
-- Roles start NOLOGIN. Set unique secrets and LOGIN only at approved cutover.
-- Existing hi5central superuser and customer routes are unchanged.
BEGIN;

DO $roleblock$
DECLARE role_name text;
BEGIN
  IF to_regclass('public.tenant_release_rollout_jobs') IS NULL
    OR to_regclass('public.platform_release_generic_stage_approvals') IS NULL
    OR to_regclass('public.tenant_runtime_update_offers') IS NULL
    OR to_regclass('public.platform_release_gateway_owners') IS NULL
    OR to_regprocedure('public.hi5_release_emergency_pause(text,text)') IS NULL
    THEN RAISE EXCEPTION 'Missing reviewed release-control migrations; stage identities not applied';
  END IF;
  FOR role_name IN
    SELECT unnest(ARRAY['hi5_release_planner','hi5_release_executor_test',
      'hi5_release_executor_uat','hi5_release_executor_live'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    ELSE
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name
        AND (rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole)) THEN
        RAISE EXCEPTION 'Existing % is not a restricted role',role_name;
      END IF;
    END IF;
  END LOOP;
END $roleblock$;

GRANT CONNECT ON DATABASE hi5central TO
  hi5_release_planner,hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT USAGE ON SCHEMA public TO
  hi5_release_planner,hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;

-- Readers can inspect tenant entitlement, exact immutable release, and stage gates;
-- they never gain access to user secrets or broad configuration writes.
GRANT SELECT ON
  public.tenants,public.tenant_settings,public.tenant_release_preferences,
  public.platform_certified_application_releases,
  public.hi5central_published_release_notes,
  public.platform_release_generic_stage_approvals,
  public.platform_release_rollout_control,
  public.platform_release_test_qa_gates,
  public.platform_release_canary_tenants
TO hi5_release_planner,hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;

GRANT SELECT ON
  public.tenant_release_rollout_jobs,public.tenant_release_rollout_events,
  public.platform_runtime_pools,public.tenant_runtime_assignments,
  public.tenant_runtime_route_attestations,public.tenant_runtime_update_offers
TO hi5_release_planner,hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;

GRANT INSERT ON public.tenant_release_rollout_jobs,public.tenant_release_rollout_events
TO hi5_release_planner;
GRANT SELECT,INSERT,UPDATE ON
  public.platform_release_fanout_checkpoints,
  public.platform_release_fanout_events,
  public.platform_release_test_qa_gates
TO hi5_release_planner;

GRANT SELECT,UPDATE ON public.tenant_release_rollout_jobs TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT SELECT,INSERT,UPDATE ON public.tenant_release_rollout_events TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT SELECT,INSERT,UPDATE ON public.platform_runtime_pools TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT SELECT,INSERT,UPDATE ON
  public.tenant_runtime_assignments,public.tenant_runtime_route_attestations,
  public.tenant_runtime_update_offers
TO hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_release_gateway_owners TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT SELECT,INSERT,UPDATE ON public.platform_release_worker_heartbeats TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;

-- Stage workers have SELECT only on global pause: no worker can issue UPDATE
-- paused=false. Emergency pause is a pre-existing audited SECURITY DEFINER
-- that can only SET paused=true; its owner, input checks and search path remain.
GRANT EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT EXECUTE ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid) TO
  hi5_release_executor_test,hi5_release_executor_uat,hi5_release_executor_live;
GRANT EXECUTE ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer)
TO hi5_release_planner;

-- Scope serial IDs to exactly the writable event sequences.
DO $$
DECLARE seq_name text;
BEGIN
  FOREACH seq_name IN ARRAY ARRAY[
    pg_get_serial_sequence('public.tenant_release_rollout_events','id'),
    pg_get_serial_sequence('public.platform_release_fanout_events','id')
  ] LOOP
    IF seq_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO %I',seq_name,'hi5_release_planner');
      IF seq_name=pg_get_serial_sequence('public.tenant_release_rollout_events','id') THEN
        EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO %I,%I,%I',
          seq_name,'hi5_release_executor_test','hi5_release_executor_uat','hi5_release_executor_live');
      END IF;
    END IF;
  END LOOP;
END $$;

-- Every physical stage-stamped table is isolated in PostgreSQL, not merely
-- filtered by a JavaScript query. API operator superuser deliberately bypasses
-- RLS as before; narrow stage credentials never do.
ALTER TABLE public.tenant_release_rollout_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_release_rollout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_runtime_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_runtime_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_runtime_route_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_runtime_update_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_release_gateway_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_release_worker_heartbeats ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE relation_name text; col_name text; suffix text; role_name text;stage text;read_stages text; expr text;
BEGIN
  FOR relation_name,col_name IN
    SELECT * FROM (VALUES
      ('tenant_release_rollout_jobs','environment'),
      ('tenant_release_rollout_events','environment'),
      ('platform_runtime_pools','environment'),
      ('tenant_runtime_assignments','environment'),
      ('tenant_runtime_route_attestations','environment'),
      ('tenant_runtime_update_offers','environment'),
      ('platform_release_gateway_owners','gateway'),
      ('platform_release_worker_heartbeats','gateway')
    ) AS pairs(table_name,stage_col)
  LOOP
    -- Planner is allowed to observe release completion at all three stages.
    IF relation_name IN ('tenant_release_rollout_jobs','tenant_release_rollout_events') THEN
      EXECUTE format('DROP POLICY IF EXISTS h5c_release_planner_read ON public.%I',relation_name);
      EXECUTE format('CREATE POLICY h5c_release_planner_read ON public.%I FOR SELECT TO hi5_release_planner USING (true)',relation_name);
      EXECUTE format('DROP POLICY IF EXISTS h5c_release_planner_insert ON public.%I',relation_name);
      IF relation_name='tenant_release_rollout_jobs' THEN
        EXECUTE format($p$CREATE POLICY h5c_release_planner_insert ON public.%I
          FOR INSERT TO hi5_release_planner WITH CHECK (
           status IN ('pending','scheduled') AND attempt_count=0
           AND lease_token IS NULL AND lease_expires_at IS NULL
           AND EXISTS(SELECT 1 FROM public.platform_release_generic_stage_approvals a
             WHERE a.build_sha=tenant_release_rollout_jobs.build_sha AND a.environment=tenant_release_rollout_jobs.environment
               AND a.planning_enabled=true AND a.approved_by IS NOT NULL
               AND a.expires_at>now())
          )$p$,relation_name);
      ELSE
        EXECUTE format($p$CREATE POLICY h5c_release_planner_insert ON public.%I
          FOR INSERT TO hi5_release_planner WITH CHECK (event_type IN ('scheduled','deferred'))$p$,relation_name);
      END IF;
    END IF;
    FOREACH stage IN ARRAY ARRAY['test','uat','live']
    LOOP
      role_name='hi5_release_executor_'||stage;
      read_stages=CASE stage WHEN 'test' THEN '''test'''
        WHEN 'uat' THEN '''test'',''uat'',''live'''
        ELSE '''test'',''uat'',''live''' END;
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I','h5c_release_'||stage||'_read',relation_name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO %I USING (%I IN (%s))',
        'h5c_release_'||stage||'_read',relation_name,role_name,col_name,read_stages);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I','h5c_release_'||stage||'_write',relation_name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO %I USING (%I=%L) WITH CHECK (%I=%L)',
        'h5c_release_'||stage||'_write',relation_name,role_name,col_name,stage,col_name,stage);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I','h5c_release_'||stage||'_insert',relation_name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO %I WITH CHECK (%I=%L)',
        'h5c_release_'||stage||'_insert',relation_name,role_name,col_name,stage);
      IF relation_name='platform_release_gateway_owners' THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I','h5c_release_'||stage||'_delete',relation_name);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO %I USING (%I=%L)',
          'h5c_release_'||stage||'_delete',relation_name,role_name,col_name,stage);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- UAT is allowed to prepare a precisely bounded Live pool/offer ONLY after
-- possessing an active UAT lease. It receives NO direct INSERT/UPDATE on Live
-- rows (checked independently by the RLS denial test).
CREATE OR REPLACE FUNCTION public.hi5_release_prepare_live_after_uat(
  p_job uuid,p_token uuid,p_fence bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE job_row public.tenant_release_rollout_jobs%ROWTYPE;
  pool_id text;pair_base text;
BEGIN
  IF session_user <> 'hi5_release_executor_uat' THEN
    RAISE EXCEPTION 'Only the restricted UAT executor can prepare a Live offer';
  END IF;
  SELECT * INTO job_row FROM public.tenant_release_rollout_jobs
    WHERE id=p_job AND environment='uat' AND status='running'
      AND lease_token=p_token AND lease_fence=p_fence
      AND lease_expires_at>now() AND routed_generation IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Verified current UAT lease required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants t
    JOIN public.tenant_release_preferences p ON p.tenant_id=t.id
    WHERE t.id=job_row.tenant_id AND t.status='active'
      AND p.update_mode='admin_controlled') THEN
    RAISE EXCEPTION 'Only active Custom UAT tenants can stage Live offers';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.platform_certified_application_releases c
    JOIN public.hi5central_published_release_notes n ON n.build_sha=c.build_sha
    WHERE c.build_sha=job_row.build_sha AND c.status='approved') THEN
    RAISE EXCEPTION 'Published and certified release required for Live offer';
  END IF;
  pair_base='hi5pool-live-'||left(job_row.build_sha,12);
  pool_id=pair_base;
  INSERT INTO public.platform_runtime_pools
    (id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at,health)
  VALUES(pool_id,'live',job_row.build_sha,pair_base||'-api:3001',
         pair_base||'-web:80','verified',now(),now(),
         '{"status":"healthy","source":"verified-uat-staging"}'::jsonb)
  ON CONFLICT(id) DO UPDATE SET
    verified_at=now(),last_seen_at=now(),updated_at=now(),
    health=EXCLUDED.health
    WHERE platform_runtime_pools.environment='live'
      AND platform_runtime_pools.build_sha=job_row.build_sha;
  IF NOT FOUND THEN RAISE EXCEPTION 'Live pool conflicts with immutable release'; END IF;
  INSERT INTO public.tenant_runtime_update_offers
    (tenant_id,environment,pool_id,build_sha,update_mode,state)
  SELECT job_row.tenant_id,'live',pool_id,job_row.build_sha,'admin_controlled','offered'
  WHERE NOT EXISTS(
    SELECT 1 FROM public.tenant_runtime_update_offers
    WHERE tenant_id=job_row.tenant_id AND environment='live' AND build_sha=job_row.build_sha
  );
  RETURN pool_id;
END $$;
REVOKE ALL ON FUNCTION public.hi5_release_prepare_live_after_uat(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hi5_release_prepare_live_after_uat(uuid,uuid,bigint)
TO hi5_release_executor_uat;

COMMIT;
