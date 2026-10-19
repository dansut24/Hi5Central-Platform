-- Restricted direct-customer release planner must see explicitly signed
-- Custom UAT acceptance + Production promotion, or it cannot enqueue the
-- customer's approved Production rollout. Preserve default-deny RLS for all
-- unsigned, unaccepted, inactive, unrelated and self-hosted tenants.
--
-- The dedicated hi5_release_planner role already has SELECT on this table,
-- but historically no SELECT RLS policy existed: it could see zero rows.
-- This policy does not grant SELECT to any other identity or any write rights.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hi5_release_planner') THEN
   CREATE POLICY h5c_release_planner_signed_custom_offers
     ON tenant_runtime_update_offers
     FOR SELECT TO hi5_release_planner
     USING (
       update_mode='admin_controlled'
       AND environment IN ('uat','live')
       AND public.hi5_release_generic_tenant_permitted(tenant_id)=true
       AND (
         (environment='uat'
           AND state IN ('uat_accepted','active')
           AND uat_accepted_at IS NOT NULL
           AND uat_accepted_by IS NOT NULL)
         OR
         (environment='live'
           AND state IN ('scheduled','active')
           AND promotion_approved_at IS NOT NULL
           AND promotion_approved_by IS NOT NULL
           AND maintenance_not_before IS NOT NULL)
       )
       AND EXISTS (
         SELECT 1
         FROM platform_certified_application_releases c
         JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha
         WHERE c.build_sha=tenant_runtime_update_offers.build_sha
           AND c.status='approved'
           AND c.approved_by IS NOT NULL
       )
     );
 END IF;
END $$;
