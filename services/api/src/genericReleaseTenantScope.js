/**
 * Discover all active, onboarded ITSM customers for staff release planning.
 * No named pilots, ten-customer minimum, or manual tenant registration.
 * SQL's hi5_release_generic_tenant_permitted function is the same authority
 * used by the scheduler, claim, executor and host gateway.
 */
export async function readGenericTenantScope(db){
 const control=(await db.query(
  'SELECT mode,reason,updated_at FROM platform_release_generic_scope_control WHERE singleton=true'
 )).rows[0]
 if(control?.mode!=='all_onboarded')
  throw Error('Automatic ITSM discovery migration has not been applied.')
 const candidates=await db.query([
  'SELECT t.id,t.slug,t.status,p.update_mode,',
  "COALESCE((s.modules->>'itsm')::boolean,false) AS itsm,",
  'p.maintenance_window,p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
  'public.hi5_release_generic_tenant_permitted(t.id) AS eligible',
  'FROM tenants t',
  'JOIN tenant_settings s ON s.tenant_id=t.id',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  "WHERE t.status='active' AND s.onboarding_completed_at IS NOT NULL",
  "AND COALESCE((s.modules->>'itsm')::boolean,false)=true",
  'ORDER BY t.slug LIMIT 1000',
 ].join(' '))
 return {scope:{mode:'automatic',reason:control.reason,
   updatedAt:control.updated_at},candidates:candidates.rows,
   eligible:candidates.rows.filter(t=>t.eligible===true).length,
   autoDiscovery:true,manualAdmissionRequired:false,
   certificationStillRequired:true,readOnly:true}
}
