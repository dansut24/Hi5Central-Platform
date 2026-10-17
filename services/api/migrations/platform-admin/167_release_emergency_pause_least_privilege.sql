-- Fail-closed emergency stop for dedicated NON-superuser generic release workers.
-- No worker receives UPDATE on platform_release_rollout_control. The narrowly
-- scoped SECURITY DEFINER function can ONLY change the fleet to paused=true.
-- There is deliberately NO grant to PUBLIC and NO role is created/granted here:
-- approved security provisioning must grant EXECUTE to each specific executor.
-- A rejected or failed invocation aborts both the pause and audit atomically.
CREATE TABLE IF NOT EXISTS platform_release_emergency_pause_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_role text NOT NULL,
  worker_id text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(requested_role) BETWEEN 1 AND 120),
  CHECK (length(worker_id) BETWEEN 4 AND 120),
  CHECK (length(reason) BETWEEN 20 AND 500)
);

CREATE OR REPLACE FUNCTION public.hi5_release_emergency_pause(
  p_worker_id text, p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL
     OR p_worker_id !~ '^h5c-dynamic-(test|uat|live)-[a-z0-9-]+$'
     OR length(p_worker_id) > 120
     OR p_reason IS NULL
     OR length(trim(p_reason)) < 20
     OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Invalid release emergency pause request';
  END IF;

  -- No SQL path through this function can unpause or start a deployment.
  UPDATE public.platform_release_rollout_control
  SET paused = true,
      reason = left(p_reason, 500),
      updated_at = now()
  WHERE singleton = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Release rollout pause control is missing';
  END IF;

  INSERT INTO public.platform_release_emergency_pause_events
    (requested_role, worker_id, reason)
  VALUES (session_user::text, p_worker_id, p_reason);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.hi5_release_emergency_pause(text,text) FROM PUBLIC;
COMMENT ON FUNCTION public.hi5_release_emergency_pause(text,text) IS
  'Only permit an explicitly granted release executor to set global rollout paused=true; never grants unpause or direct table UPDATE.';
