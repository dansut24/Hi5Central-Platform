/** Read-only safety evidence for the FIRST globally paused customer-fleet resume.
 * Changing pause is a separate, authenticated owner/admin action, guarded by
 * the same claim mutex and database transaction. No host or job mutation here.
 */
import {activeTenantMaintenanceWindow} from './releaseRolloutPlanner.js'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SHA=/^[a-f0-9]{40}$/
const invalid=s=>Object.assign(new Error(s),{status:409})
const validDate=s=>{const v=new Date(s);return Number.isFinite(v.getTime())?v:null}
const addMinutes=(date,n)=>new Date(date.getTime()+n*60000)

export function reviewedFleetResumeRequest(body){
 if(body?.confirm!=='RESUME_VERIFIED_CUSTOMER_RELEASE_FLEET'
   ||!SHA.test(String(body?.buildSha||''))
   ||typeof body?.reason!=='string'||body.reason.trim().length<20
   ||body.reason.length>500
   ||!Array.isArray(body?.expectedJobIds)
   ||body.expectedJobIds.length<2||body.expectedJobIds.length>25
   ||body.expectedJobIds.some(x=>!UUID.test(String(x)))
   ||new Set(body.expectedJobIds).size!==body.expectedJobIds.length)
   throw invalid('Confirm the exact certified build and ALL pending customer job IDs with a 20–500 character reason.')
 return {buildSha:body.buildSha,expectedJobIds:body.expectedJobIds.slice().sort(),
   reason:body.reason.trim()}
}

/** Fail closed unless all named jobs are still eligible at their own local
 * maintenance windows. The exact job list must be confirmed again at POST.
 */
export function assessFleetResume({
 paused,running,permits,queued,release,pilot,heartbeats,now=new Date()
}){
 const reasons=[]
 const jobs=Array.isArray(queued)?queued:[]
 const sha=jobs[0]?.build_sha
 if(paused!==true)reasons.push('Global release rollout is not paused.')
 if(Number(running)!==0)reasons.push('A release deployment is still running.')
 if(Number(permits)!==0)reasons.push('An exact customer pilot permit is still armed.')
 if(jobs.length<2)reasons.push('Expected both Managed Production and Custom UAT rollout jobs.')
 if(!SHA.test(String(sha||''))||jobs.some(j=>j.build_sha!==sha))
   reasons.push('Pending jobs are not scoped to exactly one release SHA.')
 if(!release||release.build_sha!==sha
   ||release.certification_status!=='approved'
   ||release.certified_approved_by==null||release.published_at==null)
   reasons.push('This application build is not certified, staff-approved and published.')
 if(!pilot||pilot.build_sha!==sha||pilot.status!=='rolled_back'
   ||pilot.update_mode!=='hi5_managed'
   ||pilot.previous_build_sha===sha||!SHA.test(String(pilot.previous_build_sha||''))
   ||pilot.permit_state!=='completed'
   ||pilot.has_verified!==true||pilot.has_rollback!==true
   ||pilot.has_admin_audit!==true||pilot.live_assignment_restored!==true
   ||pilot.previous_route_attested!==true)
   reasons.push('A completed, audited, independently verified real Managed Production rollback is required.')
 const actualStages=new Set()
 for(const job of jobs){
   if(!UUID.test(String(job.id||''))||!['scheduled','deferred'].includes(job.status)
     ||Number(job.attempt_count)!==0||Number(job.lease_fence)!==0
     ||job.lease_token!=null||job.lease_expires_at!=null
     ||job.routed_generation!=null)
     reasons.push('An active job is claimed, attempted, terminal or otherwise not safely queued.')
   if(job.tenant_status!=='active'||job.tenant_admitted!==true)
     reasons.push('Queued customer is inactive or not admitted for approved rollouts.')
   const managed=job.environment==='live'&&job.update_mode==='hi5_managed'
     &&job.live_auto_promote===true
   const customUat=job.environment==='uat'&&job.update_mode==='admin_controlled'
     &&job.uat_auto_stage===true&&job.live_auto_promote===false
   if(!managed&&!customUat)
     reasons.push('A queued job does not have the expected Managed Live or Custom UAT policy.')
   if(managed)actualStages.add('live')
   if(customUat)actualStages.add('uat')
   const scheduled=validDate(job.scheduled_at)
   const duration=Number(job.expected_duration_minutes)
   if(!scheduled||!Number.isInteger(duration)||duration<1||duration>240
     ||scheduled.getTime()<=now.getTime())
     reasons.push('A queued job does not have a valid future scheduled time and duration.')
   else {
     const window=activeTenantMaintenanceWindow({
       policy:job.maintenance_window,blackouts:job.blackout_periods,
       now:scheduled,durationMinutes:duration,
     })
     if(!window.allowed)reasons.push('A queued job is not wholly inside its customer maintenance window.')
     const expiry=validDate(job.approval_expires_at)
     if(job.approval_environment!==job.environment
       ||job.planning_enabled!==true||job.execution_enabled!==true
       ||job.approved_by==null||job.approved_at==null
       ||!expiry||expiry.getTime()<=addMinutes(scheduled,duration+15).getTime()
       ||!job.approval_evidence)
       reasons.push('Stage-specific certified execution approval does not cover the full scheduled job.')
   }
 }
 if(!actualStages.has('live')||!actualStages.has('uat'))
   reasons.push('The reviewed resume cohort must contain both Managed Live and Custom UAT.')
 for(const stage of ['live','uat']){
   const heartbeat=(heartbeats||[]).find(h=>h.gateway===stage)
   const last=validDate(heartbeat?.last_poll_at)
   if(!heartbeat||!['idle','paused'].includes(heartbeat.state)
     ||!last||now.getTime()-last.getTime()>300000||last.getTime()>now.getTime()+30000)
     reasons.push('A restricted '+stage.toUpperCase()+' worker lacks a fresh safe heartbeat.')
 }
 return {canResume:reasons.length===0,reasons:[...new Set(reasons)],
   buildSha:SHA.test(String(sha||''))?sha:null,
   jobIds:jobs.map(j=>j.id).sort(),
   jobs:jobs.map(j=>({id:j.id,tenantSlug:j.slug,environment:j.environment,
     scheduledAt:j.scheduled_at,buildSha:j.build_sha})),
   rollbackJobId:pilot?.id||null,rollbackPreviousSha:pilot?.previous_build_sha||null}
}

export async function readFleetResumeReadiness(db,{now=new Date()}={}){
 const ctl=await db.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
 const running=await db.query("SELECT count(*)::int AS n FROM tenant_release_rollout_jobs WHERE status='running'")
 const permits=await db.query("SELECT count(*)::int AS n FROM platform_release_single_live_pilot_permits WHERE state='armed' AND expires_at>now()")
 const jobs=await db.query([
   'SELECT j.*,t.slug,t.status AS tenant_status,',
   'p.update_mode,p.uat_auto_stage,p.live_auto_promote,p.maintenance_window,p.blackout_periods,',
   'public.hi5_release_generic_tenant_permitted(t.id) AS tenant_admitted,',
   'a.environment AS approval_environment,a.planning_enabled,a.execution_enabled,',
   'a.approved_by,a.approved_at,a.expires_at AS approval_expires_at,',
   "a.evidence IS NOT NULL AND a.evidence<>'{}'::jsonb AS approval_evidence",
   'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
   'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
   'LEFT JOIN platform_release_generic_stage_approvals a',
   'ON a.build_sha=j.build_sha AND a.environment=j.environment',
   "WHERE j.status IN ('scheduled','deferred','pending','running')",
   'ORDER BY j.scheduled_at,j.id',
 ].join(' '))
 let release=null,pilot=null
 const sha=jobs.rows[0]?.build_sha
 if(SHA.test(String(sha||''))){
   const releases=await db.query([
     'SELECT c.build_sha,c.status AS certification_status,',
     'c.approved_by AS certified_approved_by,n.published_at',
     'FROM platform_certified_application_releases c',
     'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
     'WHERE c.build_sha=$1 LIMIT 1',
   ].join(' '),[sha])
   release=releases.rows[0]||null
   const evidence=await db.query([
     'SELECT j.id,j.build_sha,j.previous_build_sha,j.status,p.update_mode,',
     'permit.state AS permit_state,',
     'EXISTS(SELECT 1 FROM tenant_release_rollout_events e',
     " WHERE e.job_id=j.id AND e.event_type='verified'",
     ' AND e.build_sha=j.build_sha AND e.details->>\'previousSha\'=j.previous_build_sha)',
     ' AS has_verified,',
     'EXISTS(SELECT 1 FROM tenant_release_rollout_events e',
     " WHERE e.job_id=j.id AND e.event_type='rolled_back'",
     " AND e.details->>'restoredBuildSha'=j.previous_build_sha",
     " AND e.details->>'previousReleasedBuildSha'=j.build_sha",
     " AND e.details->>'publicApiAndFrontendVerified'='true'",
     " AND e.details->>'otherTenantRoutesPreserved'='true') AS has_rollback,",
     'EXISTS(SELECT 1 FROM platform_admin_audit_events e',
     " WHERE e.action='release.managed_live_customer_rollback_verified'",
     " AND e.target_id=j.id::text",
     " AND e.metadata->>'restoredBuildSha'=j.previous_build_sha",
     " AND e.metadata->>'globalRolloutPaused'='true') AS has_admin_audit,",
     'EXISTS(SELECT 1 FROM tenant_runtime_assignments a',
     " WHERE a.tenant_id=j.tenant_id AND a.environment='live'",
     ' AND a.build_sha=j.previous_build_sha) AS live_assignment_restored,',
     'EXISTS(SELECT 1 FROM tenant_runtime_route_attestations a',
     " WHERE a.tenant_id=j.tenant_id AND a.environment='live'",
     " AND a.public_host=t.slug||'.hi5central.com'",
     " AND a.state='active' AND a.build_sha=j.previous_build_sha",
     " AND a.checked_at>now()-interval '15 minutes') AS previous_route_attested",
     'FROM tenant_release_rollout_jobs j',
     'JOIN tenants t ON t.id=j.tenant_id',
     'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
     'JOIN platform_release_single_live_pilot_permits permit ON permit.job_id=j.id',
     "WHERE j.build_sha=$1 AND j.environment='live'",
     "AND j.status='rolled_back' AND p.update_mode='hi5_managed'",
     'ORDER BY j.completed_at DESC LIMIT 1',
   ].join(' '),[sha])
   pilot=evidence.rows[0]||null
 }
 const heartbeats=await db.query([
   'SELECT DISTINCT ON (gateway) gateway,state,last_poll_at',
   'FROM platform_release_worker_heartbeats',
   "WHERE gateway IN ('live','uat')",
   'ORDER BY gateway,last_poll_at DESC',
 ].join(' '))
 return assessFleetResume({
   paused:ctl.rows[0]?.paused===true,
   running:running.rows[0]?.n??-1,permits:permits.rows[0]?.n??-1,
   queued:jobs.rows,release,pilot,heartbeats:heartbeats.rows,now,
 })
}
