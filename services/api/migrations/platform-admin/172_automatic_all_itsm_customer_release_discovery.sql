-- All eligible ITSM customers are automatically discoverable after onboarding.
-- Supersedes the named ten-tenant pilot. Does NOT certify builds, allow workers
-- to run while paused, grant stage execution, bypass customer UAT approval,
-- override maintenance windows, or provide direct Docker/gateway privileges.
-- The per-release Platform Owner "Release to customers" action remains mandatory.

DO $migration$
DECLARE old_constraint text;
BEGIN
  FOR old_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid='public.platform_release_generic_scope_control'::regclass
      AND c.contype='c'
      AND pg_get_constraintdef(c.oid) LIKE '%tenTenantAcceptance%'
  LOOP
    EXECUTE format('ALTER TABLE public.platform_release_generic_scope_control DROP CONSTRAINT %I',old_constraint);
  END LOOP;
END
$migration$;

ALTER TABLE public.platform_release_generic_scope_control
 ALTER COLUMN mode SET DEFAULT 'all_onboarded';

UPDATE public.platform_release_generic_scope_control
 SET mode='all_onboarded',
     evidence=jsonb_build_object('automaticDiscovery',true,
        'staffCertifiedReleaseRequired',true,
        'tenantWindowAndCustomUatEnforced',true),
     reason='Eligible ITSM customers are discovered automatically; every release requires Platform Owner certification.',
     updated_at=now()
 WHERE singleton=true AND mode<>'all_onboarded';

CREATE OR REPLACE FUNCTION public.hi5_release_generic_tenant_permitted(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $func$
 SELECT EXISTS (
   SELECT 1
   FROM public.tenants t
   JOIN public.tenant_settings s ON s.tenant_id=t.id
   JOIN public.tenant_release_preferences pref ON pref.tenant_id=t.id
   JOIN public.platform_release_generic_scope_control c
     ON c.singleton=true AND c.mode='all_onboarded'
   WHERE t.id=p_tenant
     AND t.status='active'
     AND s.onboarding_completed_at IS NOT NULL
     AND COALESCE((s.modules->>'itsm')::boolean,false)=true
     AND pref.update_mode IN ('hi5_managed','admin_controlled')
 );
$func$;
REVOKE ALL ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid) FROM PUBLIC;
-- The scheduler must evaluate the same customer eligibility as the stage
-- workers. Grant no write rights and no customer-list bypass. This role is
-- provisioned separately by the restricted-workers SQL on clean installs.
DO $grant$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hi5_release_planner') THEN
  GRANT EXECUTE ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid)
   TO hi5_release_planner;
 END IF;
END
$grant$;
COMMENT ON FUNCTION public.hi5_release_generic_tenant_permitted(uuid) IS
 'Automatic all-onboarded ITSM tenant discovery. Exact certified SHA, staff stage approval, global pause, tenant maintenance and customer Custom UAT approval remain separate execution gates.';
