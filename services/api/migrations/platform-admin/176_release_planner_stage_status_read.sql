-- The generic release scheduler must check that Custom Test/UAT have been
-- provisioned before it may schedule any customer release. Only grant read
-- access to the three status fields actually used by that fail-closed check.
-- NEVER permit stage access updates, arbitrary customer data reads or gateway
-- operations to the restricted release planner.
DO $body$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hi5_release_planner') THEN
   GRANT SELECT (tenant_id,environment,status)
     ON TABLE tenant_environment_state TO hi5_release_planner;
 END IF;
END
$body$;
COMMENT ON TABLE tenant_environment_state IS
 'Environment status is maintained by trusted onboarding/control APIs. Restricted release planner may SELECT only tenant_id, environment, status to ensure stage readiness; no stage rights are granted.';
