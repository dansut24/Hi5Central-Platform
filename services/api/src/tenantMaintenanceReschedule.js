/** Recalculate unclaimed customer release jobs against the SAVED maintenance
 * window, without changing immutable build/stage, granting execution or routing
 * traffic. Must run inside the caller's SQL transaction. The same advisory
 * transaction lock as claimDueRollouts excludes concurrent worker claims.
 */
import {nextTenantMaintenanceWindow} from './releaseRolloutPlanner.js'

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[89ab][a-f0-9]{12}$/i
// PostgreSQL UUIDs can contain any hexadecimal digit in the variant positions;
// the database constraint is the authoritative tenant identity.
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const SAFE_STATES=new Set(['pending','scheduled','deferred'])
const SHA=/^[a-f0-9]{40}$/
const error=message=>Object.assign(new Error(message),{status:409})

export function planMaintenanceReschedule({
 job,preference,approvedAt,publishedAt,now=new Date(),liveOffer=null,uatOffer=null
}={}){
 if(!job||!SAFE_STATES.has(job.status)||!SHA.test(String(job.build_sha||''))
    ||Number(job.attempt_count)!==0||Number(job.lease_fence)!==0
    ||job.lease_token!=null||job.lease_expires_at!=null||job.routed_generation!=null)
   return {allowed:false,reason:'Only an unclaimed, never-routed pending release can move.'}
 const managed=preference?.update_mode==='hi5_managed'
 const custom=preference?.update_mode==='admin_controlled'
 if(!managed&&!custom
   ||(job.environment==='uat'&&(!custom||preference.uat_auto_stage!==true))
   ||(job.environment==='live'&&managed&&preference.live_auto_promote!==true)
   ||!['test','uat','live'].includes(job.environment))
   return {allowed:false,reason:'Release stage is not eligible under the current update policy.'}
 if(job.environment==='test'&&preference.test_auto_sync!==true)
   return {allowed:false,reason:'Test updates are disabled.'}
 const approved=new Date(approvedAt).getTime(),published=new Date(publishedAt).getTime()
 const created=new Date(job.created_at).getTime()
 if(![approved,published,created].every(Number.isFinite))
   return {allowed:false,reason:'Verified release timing evidence is missing.'}
 let earliest=Math.max(approved,published,created)
 if(custom&&job.environment==='live'){
   const releaseMatches=liveOffer?.build_sha===job.build_sha
     &&uatOffer?.build_sha===job.build_sha
     &&['uat_accepted','active'].includes(uatOffer?.state)
     &&uatOffer?.uat_accepted_by&&uatOffer?.uat_accepted_at
     &&liveOffer?.state==='scheduled'&&liveOffer?.promotion_approved_by
     &&liveOffer?.promotion_approved_at&&liveOffer?.maintenance_not_before
   if(!releaseMatches)
     return {allowed:false,reason:'Custom Production rescheduling requires the original explicit UAT and Production approvals.'}
   for(const value of [uatOffer.uat_accepted_at,liveOffer.promotion_approved_at,liveOffer.maintenance_not_before]){
     const stamp=new Date(value).getTime()
     if(!Number.isFinite(stamp))
       return {allowed:false,reason:'Customer-authorised earliest Production time is missing.'}
     earliest=Math.max(earliest,stamp)
   }
 }
 if(!Number.isInteger(Number(job.expected_duration_minutes))
    ||Number(job.expected_duration_minutes)<1||Number(job.expected_duration_minutes)>240)
   return {allowed:false,reason:'Invalid release duration.'}
 const result=nextTenantMaintenanceWindow({
   policy:preference.maintenance_window,
   blackouts:preference.blackout_periods,
   now,
   notBefore:new Date(earliest),
   durationMinutes:Number(job.expected_duration_minutes),
   minLeadMinutes:5,
 })
 if(!result.ok)return {allowed:false,reason:result.reason}
 return {allowed:true,scheduledAt:result.scheduledAt,
   changed:new Date(job.scheduled_at).getTime()!==new Date(result.scheduledAt).getTime()}
}

export async function rescheduleUnclaimedTenantReleaseJobs(db,{
 tenantId,actorId=null,now=new Date(),onlyOutdated=false
}={}){
 if(!ID.test(String(tenantId||'')))throw error('An exact tenant identity is required.')
 // The claim worker takes this lock before examining any job. No active job
 // can be moved between its claim and the host-verified cutover.
 await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
 const result=await db.query([
   'SELECT j.*,p.update_mode,p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
   'p.maintenance_window,p.blackout_periods,p.updated_at AS preference_updated_at,',
   'c.approved_at,n.published_at,',
   'live_offer.build_sha AS live_offer_sha,live_offer.state AS live_offer_state,',
   'live_offer.promotion_approved_by,live_offer.promotion_approved_at,live_offer.maintenance_not_before,',
   'uat_offer.build_sha AS uat_offer_sha,uat_offer.state AS uat_offer_state,',
   'uat_offer.uat_accepted_by,uat_offer.uat_accepted_at',
   'FROM tenant_release_rollout_jobs j',
   'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
   "JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha AND c.status='approved'",
   'JOIN hi5central_published_release_notes n ON n.build_sha=j.build_sha',
   'LEFT JOIN tenant_runtime_update_offers live_offer ON live_offer.tenant_id=j.tenant_id',
   " AND live_offer.environment='live' AND live_offer.build_sha=j.build_sha",
   'LEFT JOIN tenant_runtime_update_offers uat_offer ON uat_offer.tenant_id=j.tenant_id',
   " AND uat_offer.environment='uat' AND uat_offer.build_sha=j.build_sha",
   'WHERE j.tenant_id=$1 AND j.status=ANY($2::text[])',
   'AND j.attempt_count=0 AND j.lease_fence=0',
   'AND j.lease_token IS NULL AND j.lease_expires_at IS NULL AND j.routed_generation IS NULL',
   ...(onlyOutdated?['AND p.updated_at>j.updated_at']:[]),
   'ORDER BY j.scheduled_at,j.id FOR UPDATE OF j',
 ].join(' '),[tenantId,[...SAFE_STATES]])
 const changes=[],unchanged=[],blocked=[]
 for(const row of result.rows){
   const plan=planMaintenanceReschedule({
     job:row,preference:row,approvedAt:row.approved_at,publishedAt:row.published_at,now,
     liveOffer:row.live_offer_sha?{
       build_sha:row.live_offer_sha,state:row.live_offer_state,
       promotion_approved_by:row.promotion_approved_by,
       promotion_approved_at:row.promotion_approved_at,
       maintenance_not_before:row.maintenance_not_before,
     }:null,
     uatOffer:row.uat_offer_sha?{
       build_sha:row.uat_offer_sha,state:row.uat_offer_state,
       uat_accepted_by:row.uat_accepted_by,
       uat_accepted_at:row.uat_accepted_at,
     }:null,
   })
   if(!plan.allowed){
     blocked.push({jobId:row.id,environment:row.environment,reason:plan.reason})
     // Do not rewrite or re-arm an ineligible release.
     continue
   }
   if(!plan.changed){
     // Mark the policy revision as seen even if its safe scheduled time
     // remains identical, so the background reconciler does not loop forever.
     await db.query([
       'UPDATE tenant_release_rollout_jobs SET updated_at=now()',
       'WHERE id=$1 AND status=$2 AND attempt_count=0 AND lease_token IS NULL',
     ].join(' '),[row.id,row.status])
     unchanged.push({jobId:row.id,environment:row.environment,
       scheduledAt:row.scheduled_at})
     continue
   }
   const updated=await db.query([
     'UPDATE tenant_release_rollout_jobs SET scheduled_at=$2,updated_at=now(),last_error=NULL',
     'WHERE id=$1 AND status=$3 AND attempt_count=0 AND lease_fence=0',
     'AND lease_token IS NULL AND lease_expires_at IS NULL AND routed_generation IS NULL',
     'RETURNING id',
   ].join(' '),[row.id,plan.scheduledAt,row.status])
   if(updated.rowCount!==1)throw error('A release job changed during maintenance rescheduling.')
   const detail={
     reason:'tenant-maintenance-window-changed',
     previousScheduledAt:row.scheduled_at,
     scheduledAt:plan.scheduledAt,maintenanceWindow:row.maintenance_window,
     actorUserId:actorId,executionAuthorisedByReschedule:false,
     jobStatusUnchanged:true,buildShaUnchanged:true,
   }
   await db.query([
     'INSERT INTO tenant_release_rollout_events',
     '(job_id,tenant_id,environment,build_sha,event_type,details)',
     "VALUES($1,$2,$3,$4,'rescheduled',$5::jsonb)",
   ].join(' '),[row.id,tenantId,row.environment,row.build_sha,JSON.stringify(detail)])
   changes.push({jobId:row.id,environment:row.environment,buildSha:row.build_sha,
     previousScheduledAt:row.scheduled_at,scheduledAt:plan.scheduledAt})
 }
 return {rescheduledJobs:changes,unchangedJobs:unchanged,blockedJobs:blocked}
}

/** Fallback for installed older customer API images. Their settings PATCH
 * updates tenant_release_preferences but cannot themselves move a job.
 * The trusted planner notices p.updated_at>j.updated_at and applies exactly
 * the same transaction-scoped reconciliation. It does not unpause execution.
 */
export async function reconcileChangedTenantMaintenanceWindows(db,{now=new Date(),limit=100}={}){
 const pending=await db.query([
   'SELECT DISTINCT p.tenant_id FROM tenant_release_preferences p',
   'JOIN tenant_release_rollout_jobs j ON j.tenant_id=p.tenant_id',
   "WHERE j.status IN ('pending','scheduled','deferred')",
   'AND j.attempt_count=0 AND j.lease_fence=0 AND j.lease_token IS NULL',
   'AND j.lease_expires_at IS NULL AND j.routed_generation IS NULL',
   'AND p.updated_at>j.updated_at ORDER BY p.tenant_id LIMIT $1',
 ].join(' '),[limit])
 const all=[]
 for(const row of pending.rows){
   const result=await rescheduleUnclaimedTenantReleaseJobs(db,{
     tenantId:row.tenant_id,now,onlyOutdated:true,
   })
   all.push(...result.rescheduledJobs)
 }
 return {scannedTenants:pending.rows.length,rescheduledJobs:all}
}
