/**
 * Generic certified Dev-release discovery. This module is read-only and
 * independent of the six immutable QA canary tenants.
 *
 * Scans real tenant entitlements and per-tenant maintenance preferences,
 * assesses Test -> Custom UAT -> explicit Custom Production / Managed
 * Production with platform canary gate, and previews schedules. Approval
 * rows are default-DENY. NO SQL mutations, route writes or Docker operations.
 */
import {nextCustomerReleaseStage,scheduledCustomerRelease} from './certifiedReleaseFanout.js'

const SHA=/^[a-f0-9]{40}$/
const valid=value=>value!=null&&Number.isFinite(new Date(value).getTime())
const issue=message=>Object.assign(new Error(message),{code:'GENERIC_RELEASE_DISCOVERY_BLOCKED'})
export const GENERIC_STAGES=Object.freeze(['test','uat','live'])

export function authorisedGenericReleaseStage({approval,sha,stage,now=new Date()}={}){
  if(!SHA.test(String(sha||''))||!GENERIC_STAGES.includes(stage))
    return {allowed:false,reason:'Invalid immutable release SHA or environment.'}
  if(approval?.build_sha!==sha||approval?.environment!==stage
    ||approval.planning_enabled!==true||!approval.approved_by
    ||!valid(approval.approved_at)||!valid(approval.expires_at)
    ||!(new Date(approval.approved_at)<=new Date(now)
      &&new Date(now)<new Date(approval.expires_at))
    ||!approval.evidence||typeof approval.evidence!=='object'
    ||Array.isArray(approval.evidence)||Object.keys(approval.evidence).length===0)
    return {allowed:false,reason:'No current staff-approved stage-specific generic planning authorisation.'}
  return {allowed:true,reason:'Approved generic planning scope; worker execution is independently gated.'}
}

export const genericReleaseTenantQuery=[
 'SELECT t.id,t.slug,t.status,p.update_mode AS mode,',
 'p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
 'p.live_delay_hours,p.maintenance_window,p.blackout_periods,',
 "COALESCE((ts.modules->>'itsm')::boolean,false) AS itsm",
 'FROM tenants t',
 'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
 'JOIN tenant_settings ts ON ts.tenant_id=t.id',
 "WHERE t.status='active' AND ts.onboarding_completed_at IS NOT NULL",
 "AND COALESCE((ts.modules->>'itsm')::boolean,false)=true",
 "AND t.id>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",
 'ORDER BY t.id LIMIT $1',
].join(' ')

export async function readGenericReleaseApprovals(db,{sha}={}){
 if(!SHA.test(String(sha||'')))throw issue('Exact release SHA is required.')
 const res=await db.query([
  'SELECT build_sha,environment,planning_enabled,execution_enabled,',
  'approved_by,approved_at,expires_at,evidence',
  'FROM platform_release_generic_stage_approvals WHERE build_sha=$1',
 ].join(' '),[sha])
 return Object.fromEntries(res.rows.map(r=>[r.environment,r]))
}

export async function previewGenericCertifiedRelease(db,{
 sha,now=new Date(),limit=200,testSoakMinutes=30,maxTenants=10000,
}={}){
 if(!SHA.test(String(sha||''))||!valid(now)
  ||!Number.isInteger(limit)||limit<1||limit>2000
  ||!Number.isInteger(maxTenants)||maxTenants<1||maxTenants>100000
  ||!Number.isInteger(testSoakMinutes)||testSoakMinutes<2||testSoakMinutes>10080)
  throw issue('Release, clock or bounded tenant scan options invalid.')
 const releaseRows=await db.query([
  'SELECT c.build_sha,c.status,c.approved_by,c.approved_at,c.evidence,',
  'n.published_at,n.version_label',
  'FROM platform_certified_application_releases c',
  'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
  "WHERE c.build_sha=$1 AND c.status='approved' AND c.approved_by IS NOT NULL",
  'AND c.evidence @> $2::jsonb',
 ].join(' '),[sha,JSON.stringify({
  build:true,ci:true,security:true,migrations:true,smoke:true,
 })])
 if(releaseRows.rowCount!==1)
  throw issue('Exact human-approved, CI/security-qualified and published release required.')
 const release=releaseRows.rows[0]
 const approvals=await readGenericReleaseApprovals(db,{sha})
 const gateResult=await db.query('SELECT * FROM platform_release_test_qa_gates WHERE build_sha=$1',[sha])
 const gate=gateResult.rows[0]||null
 const report={sha,versionLabel:release.version_label,
  scanned:0,eligible:0,approvalBlocked:0,policyBlocked:0,
  gateState:gate?.state||'absent',stageApprovals:{},tenants:[]}
 for(const stage of GENERIC_STAGES)
  report.stageApprovals[stage]=authorisedGenericReleaseStage({approval:approvals[stage],sha,stage,now})
 let cursor=null
 for(;;){
  const batch=await db.query(genericReleaseTenantQuery,[limit,cursor])
  if(!batch.rows.length)break
  for(const row of batch.rows){
   if(report.scanned>=maxTenants)throw issue('Tenant preview cap reached; use an audited pagination strategy.')
   const tenant={id:row.id,status:row.status,mode:row.mode,itsm:row.itsm,
    testAutoSync:row.test_auto_sync,uatAutoStage:row.uat_auto_stage,
    liveAutoPromote:row.live_auto_promote,liveDelayHours:row.live_delay_hours,
    maintenance:row.maintenance_window,blackouts:row.blackout_periods}
   const jobs=(await db.query([
    'SELECT environment,build_sha,status,completed_at',
    'FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2',
   ].join(' '),[row.id,sha])).rows
   const offers=(await db.query([
    'SELECT environment,build_sha,state,uat_accepted_at,uat_accepted_by,',
    'promotion_approved_at,promotion_approved_by,maintenance_not_before',
    'FROM tenant_runtime_update_offers WHERE tenant_id=$1 AND build_sha=$2',
   ].join(' '),[row.id,sha])).rows
   const decision=nextCustomerReleaseStage({
    tenant,sha,publishedAt:release.published_at,approvedAt:release.approved_at,
    jobs,gate,liveOffer:offers.find(o=>o.environment==='live'),
    uatOffer:offers.find(o=>o.environment==='uat'),testSoakMinutes,now,
   })
   const schedule=scheduledCustomerRelease({decision,tenant,sha,now})
   const approval=decision.stage?report.stageApprovals[decision.stage]:null
   const allowed=schedule.status==='scheduled'&&approval?.allowed===true
   if(allowed)report.eligible++
   else if(schedule.status==='scheduled')report.approvalBlocked++
   else report.policyBlocked++
   report.tenants.push({slug:row.slug,tenantId:row.id,mode:row.mode,
    proposedStage:decision.stage,notBefore:decision.notBefore||null,
    proposedAt:schedule.scheduledAt||null,
    status:allowed?'eligible':schedule.status==='scheduled'?'approval_required':'blocked',
    reason:allowed?schedule.reason:
      schedule.status==='scheduled'?approval.reason:schedule.reason})
   report.scanned++
  }
  cursor=batch.rows[batch.rows.length-1].id
  if(batch.rows.length<limit)break
 }
 return report
}
