-- Dedicated least-privilege generic planner quality-gate operation.
-- The planner must NEVER receive direct INSERT/UPDATE/DELETE on QA gates.
-- This function computes evidence from independently verified designated Test
-- jobs and a real minimum soak, not from untrusted planner-supplied JSON.
-- No grant to PUBLIC and no live role grants are created by this migration.
CREATE OR REPLACE FUNCTION public.hi5_release_record_verified_test_gate(
  p_build_sha text, p_minimum_soak_minutes integer DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
  v_job_ids jsonb;
  v_tenant_ids jsonb;
BEGIN
  IF p_build_sha IS NULL OR p_build_sha !~ '^[a-f0-9]{40}$'
     OR p_minimum_soak_minutes IS NULL
     OR p_minimum_soak_minutes < 30
     OR p_minimum_soak_minutes > 10080 THEN
    RAISE EXCEPTION 'Invalid verified Test gate request';
  END IF;
  -- Certification is independent of two designated, durable Test proofs.
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_certified_application_releases c
    JOIN public.hi5central_published_release_notes n
      ON n.build_sha=c.build_sha
    WHERE c.build_sha=p_build_sha AND c.status='approved'
      AND c.approved_by IS NOT NULL AND c.approved_at IS NOT NULL
      AND c.evidence @> '{"build":true,"ci":true,"security":true,"migrations":true,"smoke":true}'::jsonb
  ) THEN
    RETURN false;
  END IF;

  SELECT count(*)::int,
         COALESCE(jsonb_agg(id ORDER BY completed_at,id),'[]'::jsonb),
         COALESCE(jsonb_agg(tenant_id ORDER BY completed_at,id),'[]'::jsonb)
  INTO v_count,v_job_ids,v_tenant_ids
  FROM (
    SELECT DISTINCT ON (j.tenant_id)
      j.id,j.tenant_id,j.completed_at
    FROM public.tenant_release_rollout_jobs j
    JOIN public.platform_release_canary_tenants d
      ON d.tenant_id=j.tenant_id AND d.enabled=true
    JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
    WHERE j.environment='test' AND j.build_sha=p_build_sha
      AND j.status='succeeded' AND j.attempt_count>0
      AND j.completed_at IS NOT NULL
      AND j.completed_at<=now()-make_interval(mins=>p_minimum_soak_minutes)
      AND EXISTS (
        SELECT 1 FROM public.tenant_release_rollout_events e
        WHERE e.job_id=j.id AND e.tenant_id=j.tenant_id
          AND e.environment='test' AND e.build_sha=p_build_sha
          AND e.event_type='verified' AND e.fence=j.lease_fence
      )
    ORDER BY j.tenant_id,j.completed_at DESC
  ) verified;
  IF v_count<2 THEN RETURN false; END IF;

  INSERT INTO public.platform_release_test_qa_gates
    (build_sha,state,passed_canary_count,passed_at,accepted_by,evidence)
  VALUES (p_build_sha,'passed',v_count,now(),NULL,
    jsonb_build_object(
      'automatic',true,
      'source','two-verified-designated-test-canaries',
      'certifiedReleaseSha',p_build_sha,
      'testSoakMinutes',p_minimum_soak_minutes,
      'verifiedJobIds',v_job_ids,
      'verifiedTenantIds',v_tenant_ids))
  ON CONFLICT (build_sha) DO NOTHING;
  RETURN EXISTS (
    SELECT 1 FROM public.platform_release_test_qa_gates g
    WHERE g.build_sha=p_build_sha AND g.state='passed'
      AND g.passed_canary_count>=2
  );
END;
$$;
REVOKE ALL ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer)
  FROM PUBLIC;
COMMENT ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer) IS
  'Database-verified, two-designated-Test-canary quality gate; no planner-supplied pass/evidence. Independent DBA must grant EXECUTE only to reviewed generic planner.';
