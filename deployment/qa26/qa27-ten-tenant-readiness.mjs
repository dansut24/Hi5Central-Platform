#!/usr/bin/env node
/**
 * QA27: READ ONLY status for an actual normally-onboarded ten-tenant pilot.
 * Never creates accounts, changes identity/passwords, verifies an email,
 * changes a module, or enables any worker/scope/rollout.
 */
import pg from 'pg'
const prior={
 'h5c-managed-qa26':{mode:'hi5_managed',rmm:false},
 'managed1':{mode:'hi5_managed',rmm:false},
 'managed2':{mode:'hi5_managed',rmm:false},
 'h5c-custom-qa26':{mode:'admin_controlled',rmm:false},
 'custom1':{mode:'admin_controlled',rmm:false},
 'custom2':{mode:'admin_controlled',rmm:false},
}
const additions={
 'h5c-managed-rmm-qa27':{mode:'hi5_managed',rmm:true},
 'h5c-custom-rmm-qa27':{mode:'admin_controlled',rmm:true},
 'h5c-managed-itsm-qa27':{mode:'hi5_managed',rmm:false},
 'h5c-custom-itsm-qa27':{mode:'admin_controlled',rmm:false},
}
const expected={...prior,...additions}
if(process.argv.length!==2||!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
 throw Error('QA27 readiness: DATABASE_URL required, no options allowed.')
const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:6000})
try{
 await db.connect()
 await db.query('BEGIN READ ONLY')
 await db.query("SET LOCAL statement_timeout='12000ms'")
 const control=await db.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
 const active=await db.query(
  "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status='running'")
 const tenantResult=await db.query([
  'SELECT t.slug,t.status,t.id,s.modules,s.onboarding_step,',
  's.onboarding_completed_at IS NOT NULL AS onboarding_complete,',
  'p.update_mode,p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
  'p.maintenance_window,',
  '(SELECT count(*)::int FROM tenant_memberships m',
  "JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner'",
  "AND m.status='active' AND u.email_verified_at IS NOT NULL) AS verified_owner_count",
  'FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id',
  'LEFT JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'WHERE t.slug=ANY($1::text[]) ORDER BY t.slug',
 ].join(' '),[Object.keys(expected)])
 const bySlug=new Map(tenantResult.rows.map(t=>[t.slug,t]))
 const rows=Object.entries(expected).map(([slug,required])=>{
  const actual=bySlug.get(slug)
  if(!actual)return {slug,expectedMode:required.mode,expectedRmm:required.rmm,
    status:'NOT_CREATED',ready:false}
  const issues=[]
  if(actual.status!=='active')issues.push('pending_email_verification_or_inactive')
  if(actual.verified_owner_count<1)issues.push('verified_active_owner_missing')
  if(!actual.onboarding_complete)issues.push('normal_onboarding_incomplete')
  if(actual.modules?.itsm!==true)issues.push('itsm_module_disabled')
  if(Boolean(actual.modules?.rmm)!==required.rmm)issues.push('rmm_entitlement_mismatch')
  if(actual.update_mode!==required.mode)issues.push('update_mode_incorrect_or_unselected')
  if(!actual.maintenance_window?.timezone||!Array.isArray(actual.maintenance_window.days)
   ||actual.maintenance_window.days.length<1)
   issues.push('maintenance_window_not_defined')
  if(actual.test_auto_sync!==true)issues.push('test_auto_sync_disabled')
  if(required.mode==='hi5_managed'&&actual.live_auto_promote!==true)
   issues.push('managed_live_auto_promote_disabled')
  if(required.mode==='admin_controlled'&&actual.uat_auto_stage!==true)
   issues.push('custom_uat_auto_stage_disabled')
  return {slug,expectedMode:required.mode,expectedRmm:required.rmm,
   status:issues.length?'INCOMPLETE':'READY',
   ready:issues.length===0,issues,onboardingStep:actual.onboarding_step,
   verifiedOwnerCount:actual.verified_owner_count}
 })
 const all=rows.every(row=>row.ready)
 console.log(JSON.stringify({
  audit:'H5C_QA27_TEN_TENANT_READINESS_V1',readOnly:true,
  globallyPaused:control.rows[0]?.paused===true,activeDeploymentJobs:active.rows[0]?.n,
  intended:{tenants:10,managed:5,custom:5,rmmEntitled:2},
  created:rows.filter(r=>r.status!=='NOT_CREATED').length,
  accepted:rows.filter(r=>r.ready).length,
  readyToConsiderPilotAdmission:all&&control.rows[0]?.paused===true&&active.rows[0]?.n===0,
  routeCutoverAuthorised:false,pilotActuallyEnrolled:false,
  rows,
 },null,2))
 await db.query('ROLLBACK')
}finally{await db.end()}
