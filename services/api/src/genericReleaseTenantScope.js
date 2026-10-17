/**
 * Independently reviewed ten-tenant pilot admission. No fake signups, no
 * auto-enrolment, no stage execution, no global unpause or Docker operations.
 * Requires a REAL fully onboarded cohort: 5 Managed, 5 Custom; 2 also RMM.
 * The database's 169 default-deny tenant-scope function is the enforcement
 * boundary at scheduler, queue, worker and host.
 */
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const reject=msg=>Object.assign(new Error(msg),{code:'GENERIC_PILOT_SCOPE_REFUSED'})
export function validateTenTenantPilotRequest({body,actorId}={}){
 if(!UUID.test(String(actorId||''))||!body||typeof body!=='object'||Array.isArray(body))
  throw reject('Authenticated platform owner/admin and explicit pilot request required.')
 if(body.confirmation!=='AUTHORISE_TEN_TENANT_PILOT')
  throw reject('Type AUTHORISE_TEN_TENANT_PILOT to enrol a named pilot.')
 if(['deployNow','unpause','executionEnabled','allTenants','bypassApproval','force']
   .some(key=>Object.hasOwn(body,key)))
  throw reject('Pilot cohort enrolment cannot deploy, unpause or enable general rollout.')
 const ids=body.tenantIds
 if(!Array.isArray(ids)||ids.length!==10
   ||ids.some(id=>!UUID.test(String(id)))||new Set(ids).size!==10)
  throw reject('Exactly ten distinct existing tenant UUIDs are required.')
 const reason=String(body.reason||'').trim()
 const reviewedChange=String(body.reviewedChange||'').trim()
 if(reason.length<25||reason.length>500
   ||reviewedChange.length<8||reviewedChange.length>200)
  throw reject('Record a meaningful pilot reason and an independently reviewed change reference.')
 return {actorId,tenantIds:ids,reason,reviewedChange}
}
export async function readGenericTenantScope(db){
 const control=(await db.query(
  'SELECT mode,approved_by,approved_at,evidence,reason,updated_at FROM platform_release_generic_scope_control WHERE singleton=true'
 )).rows[0]
 if(!control)throw reject('Tenant scope migration 169 has not been installed.')
 const [pilot,candidates,audit]=await Promise.all([
  db.query([
   'SELECT p.tenant_id,t.slug,p.enabled,p.approved_by,p.approved_at,p.reason',
   'FROM platform_release_generic_pilot_tenants p',
   'JOIN tenants t ON t.id=p.tenant_id',
   'ORDER BY t.slug LIMIT 200',
  ].join(' ')),
  db.query([
   'SELECT t.id,t.slug,t.status,p.update_mode,',
   "COALESCE((s.modules->>'rmm')::boolean,false) AS rmm,",
   'p.maintenance_window,p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote',
   'FROM tenants t',
   'JOIN tenant_settings s ON s.tenant_id=t.id',
   'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
   "WHERE t.status='active' AND s.onboarding_completed_at IS NOT NULL",
   "AND COALESCE((s.modules->>'itsm')::boolean,false)=true",
   'ORDER BY t.slug LIMIT 500',
  ].join(' ')),
  db.query([
   'SELECT actor_role,operation,target,tenant_id,occurred_at',
   'FROM platform_release_generic_scope_audit',
   'ORDER BY occurred_at DESC LIMIT 40',
  ].join(' ')),
 ])
 return {scope:control,pilot:pilot.rows,candidates:candidates.rows,
  audit:audit.rows,readOnly:true}
}
export async function enrolTenTenantPilot(db,request){
 const validated=validateTenTenantPilotRequest(request)
 const control=(await db.query([
  'SELECT mode FROM platform_release_generic_scope_control',
  'WHERE singleton=true FOR UPDATE',
 ].join(' '))).rows[0]
 if(control?.mode!=='pilot')
  throw reject('Pilot enrolment is only permitted while the fleet scope is pilot.')
 const existing=await db.query(
  'SELECT tenant_id FROM platform_release_generic_pilot_tenants WHERE enabled=true FOR UPDATE')
 if(existing.rowCount)
  throw reject('A pilot is already enrolled. Reconcile or revoke it through separate review before replacing tenants.')
 const tenants=await db.query([
  'SELECT t.id,t.slug,t.status,p.update_mode,p.maintenance_window,',
  'p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
  "COALESCE((s.modules->>'itsm')::boolean,false) AS itsm,",
  "COALESCE((s.modules->>'rmm')::boolean,false) AS rmm,",
  's.onboarding_completed_at',
  'FROM tenants t',
  'JOIN tenant_settings s ON s.tenant_id=t.id',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'WHERE t.id=ANY($1::uuid[]) FOR SHARE OF t,s,p',
 ].join(' '),[validated.tenantIds])
 if(tenants.rowCount!==10)
  throw reject('All ten named tenants must exist in standard provisioning.')
 const managed=tenants.rows.filter(x=>x.update_mode==='hi5_managed')
 const custom=tenants.rows.filter(x=>x.update_mode==='admin_controlled')
 const rmm=tenants.rows.filter(x=>x.rmm===true)
 if(managed.length!==5||custom.length!==5||rmm.length!==2)
  throw reject('Pilot must include five Managed, five Custom, and exactly two also RMM-entitled.')
 for(const t of tenants.rows){
  if(t.status!=='active'||t.itsm!==true||!t.onboarding_completed_at
    ||t.test_auto_sync!==true
    ||(t.update_mode==='admin_controlled'&&t.uat_auto_stage!==true)
    ||(t.update_mode==='hi5_managed'&&t.live_auto_promote!==true)
    ||!t.maintenance_window?.timezone
    ||!Array.isArray(t.maintenance_window.days)
    ||t.maintenance_window.days.length<1)
   throw reject('Tenant '+t.slug+' is not fully onboarded with a valid ITSM update window/policy.')
 }
 for(const id of validated.tenantIds){
  await db.query([
   'INSERT INTO platform_release_generic_pilot_tenants',
   '(tenant_id,enabled,approved_by,approved_at,reason)',
   'VALUES($1,true,$2,now(),$3)',
   'ON CONFLICT(tenant_id) DO UPDATE SET',
   'enabled=true,approved_by=excluded.approved_by,',
   'approved_at=excluded.approved_at,reason=excluded.reason,updated_at=now()',
  ].join(' '),[id,validated.actorId,
   validated.reason+' [review: '+validated.reviewedChange+']'])
 }
 return {mode:'pilot',enrolled:10,managed:5,custom:5,rmmEntitled:2,
  rolloutUnpaused:false,executionApproved:false,
  slugs:tenants.rows.map(x=>x.slug).sort()}
}
