-- Generic rollout admission control: first certify a named real tenant cohort,
-- then allow every newly onboarded ITSM tenant ONLY after separately reviewed
-- ten-tenant acceptance + independent security approval.
-- Default is PILOT with NO enrolled tenants. No grants, approvals, or routes.
CREATE TABLE platform_release_generic_scope_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton=true),
 mode text NOT NULL DEFAULT 'pilot' CHECK (mode IN ('pilot','all_onboarded')),
 approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 reason text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (mode <> 'all_onboarded' OR (
  approved_by IS NOT NULL AND approved_at IS NOT NULL
  AND approved_at<=updated_at
  AND evidence @> '{"tenTenantAcceptance":true,"independentSecurityReview":true}'::jsonb
  AND length(reason) BETWEEN 20 AND 500
 ))
);
INSERT INTO platform_release_generic_scope_control(singleton,mode)
VALUES(true,'pilot');

CREATE TABLE platform_release_generic_pilot_tenants (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT enabled OR (
  approved_by IS NOT NULL AND approved_at IS NOT NULL
  AND length(reason) BETWEEN 20 AND 500
 ))
);

CREATE TABLE platform_release_generic_scope_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_role text NOT NULL DEFAULT session_user,
 operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 target text NOT NULL CHECK(target IN ('scope','pilot')),
 tenant_id uuid,
 previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
 next_state jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_release_generic_scope_audit_recent
 ON platform_release_generic_scope_audit(occurred_at DESC);

CREATE OR REPLACE FUNCTION public.hi5_audit_generic_tenant_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $h5audit$
DECLARE
 v_tenant uuid := NULL;
BEGIN
 -- A scope-control row has no tenant_id column: never reference OLD/NEW
 -- pilot fields in a CASE expression compiled for the scope table.
 IF TG_TABLE_NAME='platform_release_generic_pilot_tenants' THEN
   IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;
   ELSE v_tenant:=NEW.tenant_id; END IF;
 END IF;
 INSERT INTO public.platform_release_generic_scope_audit
  (actor_role,operation,target,tenant_id,previous_state,next_state)
 VALUES (session_user::text,TG_OP,
  CASE WHEN TG_TABLE_NAME='platform_release_generic_scope_control' THEN 'scope' ELSE 'pilot' END,
  v_tenant,
  CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
  CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END);
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$h5audit$;
REVOKE ALL ON FUNCTION public.hi5_audit_generic_tenant_scope() FROM PUBLIC;

CREATE TRIGGER audit_generic_scope_control
AFTER INSERT OR UPDATE OR DELETE ON platform_release_generic_scope_control
FOR EACH ROW EXECUTE FUNCTION public.hi5_audit_generic_tenant_scope();
CREATE TRIGGER audit_generic_pilot_tenants
AFTER INSERT OR UPDATE OR DELETE ON platform_release_generic_pilot_tenants
FOR EACH ROW EXECUTE FUNCTION public.hi5_audit_generic_tenant_scope();

-- This read-only, centrally enforced entitlement is evaluated by the planner,
-- queue claim, executor guard and privileged host lease verifier.
-- The call remains inaccessible to PUBLIC until specific non-superuser workers
-- receive an independently approved EXECUTE grant. No worker gets table writes.
CREATE OR REPLACE FUNCTION public.hi5_release_generic_tenant_permitted(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
 SELECT COALESCE((
  SELECT CASE
    WHEN c.mode='all_onboarded'
     THEN c.approved_by IS NOT NULL AND c.approved_at IS NOT NULL
      AND c.evidence @> '{"tenTenantAcceptance":true,"independentSecurityReview":true}'::jsonb
    WHEN c.mode='pilot' THEN EXISTS (
     SELECT 1 FROM public.platform_release_generic_pilot_tenants p
     WHERE p.tenant_id=t.id AND p.enabled=true
      AND p.approved_by IS NOT NULL AND p.approved_at IS NOT NULL
    )
    ELSE false
  END
  FROM public.tenants t
  JOIN public.tenant_settings s ON s.tenant_id=t.id
  JOIN public.tenant_release_preferences pref ON pref.tenant_id=t.id
  JOIN public.platform_release_generic_scope_control c ON c.singleton=true
  WHERE t.id=p_tenant AND t.status='active'
   AND s.onboarding_completed_at IS NOT NULL
   AND COALESCE((s.modules->>'itsm')::boolean,false)=true
   AND pref.update_mode IN ('hi5_managed','admin_controlled')
 ),false);
$$;
REVOKE ALL ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid) FROM PUBLIC;
COMMENT ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid) IS
 'Fail-closed tenant admission at planner, claim, worker and host boundaries; pilot first, then independently approved all-onboarded mode.';
