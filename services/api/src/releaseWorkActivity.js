/**
 * Central staff Work Activity. A browser can pause new claims, cancel an
 * exact unclaimed job, or request a reviewed retry, but NEVER unpause,
 * claim, deploy, approve a stage, or change a tenant route here.
 */
import {activeTenantMaintenanceWindow} from './releaseRolloutPlanner.js'
import {readFleetResumeReadiness,reviewedFleetResumeRequest} from './releaseFleetResume.js'
import {reviewedRollbackCompatibilityRequest,reviewedRollbackExecutorRequest,reviewedRollbackRevocation,reviewRollbackCompatibility,reviewRollbackExecutor} from './reviewedCustomerRollbackApprovals.js'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SHA=/^[a-f0-9]{40}$/
const STAGES=new Set(['test','uat','live'])
const refuse=(message,status=409)=>Object.assign(new Error(message),{status})
const note=value=>{
  if(typeof value!=='string'||value.trim().length<20||value.length>500)
    throw refuse('Provide a specific 20–500 character staff audit reason.',400)
  return value.trim()
}
export function reviewedJobRequest(body,action){
  if(!UUID.test(String(body?.jobId||''))||!SHA.test(String(body?.buildSha||''))
    ||!STAGES.has(body?.environment)
    ||typeof body?.tenantSlug!=='string'
    ||!/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/.test(body.tenantSlug)
    ||body?.confirm!==(action==='cancel'?'CANCEL_UNCLAIMED_RELEASE_JOB':'RETRY_FAILED_RELEASE_JOB'))
    throw refuse('Review the exact tenant, stage, SHA, job and confirmation.',400)
  return {jobId:body.jobId,buildSha:body.buildSha,environment:body.environment,
    tenantSlug:body.tenantSlug,reason:note(body.reason)}
}
export function jobSafeToCancel(job){
  return job&&['pending','scheduled','deferred'].includes(job.status)
    &&job.attempt_count===0&&job.lease_token==null
    &&job.lease_expires_at==null&&Number(job.lease_fence)===0
    &&job.routed_generation==null
}
export function jobSafeToRetry(job){
  return job?.status==='failed'&&job.lease_token==null
    &&job.lease_expires_at==null&&job.routed_generation==null
    &&Number(job.attempt_count)>0&&Number(job.max_attempts)>0
}
/** Explicit human sign-off for ONE Managed Production job, never Custom.
 * No unattended host access or global resume is possible from this request.
 */
export function reviewedLivePilotRequest(body){
  if(!UUID.test(String(body?.jobId||''))||!SHA.test(String(body?.buildSha||''))
    ||body?.environment!=='live'
    ||typeof body?.tenantSlug!=='string'
    ||!/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/.test(body.tenantSlug)
    ||body?.confirm!=='ARM_SINGLE_MANAGED_PRODUCTION_PILOT')
    throw refuse('Explicit exact Managed Production pilot confirmation is required.',400)
  return {jobId:body.jobId,buildSha:body.buildSha,
    environment:'live',tenantSlug:body.tenantSlug,reason:note(body.reason)}
}
export function livePilotJobEligible(job){
  return job?.environment==='live'&&job?.update_mode==='hi5_managed'
    &&job.live_auto_promote===true&&job.status==='scheduled'
    &&job.attempt_count===0&&job.lease_token==null
    &&job.lease_expires_at==null
    &&(Number(job.lease_fence)===0
      ||(Number.isSafeInteger(Number(job.lease_fence))
        &&Number(job.lease_fence)>0
        &&SHA.test(String(job.previous_build_sha||''))
        &&job.retryAuthorised===true))
    &&job.routed_generation==null&&job.tenant_status==='active'
}
const checkSame=(job,request)=>{
  if(!job||job.id!==request.jobId||job.build_sha!==request.buildSha
    ||job.environment!==request.environment||job.slug!==request.tenantSlug)
    throw refuse('The reviewed job scope no longer matches the actual queue.')
}
async function pausedTransaction(db){
  // Share the control row lock with each Work Activity write. No resume here.
  const flag=await db.query(
    'SELECT paused FROM platform_release_rollout_control WHERE singleton=true FOR UPDATE')
  if(flag.rows[0]?.paused!==true)throw refuse('Pause global rollout before acting on an individual job.')
  const active=await db.query(
    "SELECT count(*)::int AS count FROM tenant_release_rollout_jobs WHERE status='running'")
  if(Number(active.rows[0]?.count)!==0)
    throw refuse('A deployment is running. Wait for host verification and drain before changing jobs.')
}
async function lockJob(db,request){
  const found=await db.query([
    'SELECT j.*,t.slug FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'WHERE j.id=$1 FOR UPDATE OF j',
  ].join(' '),[request.jobId])
  const job=found.rows[0]
  checkSame(job,request)
  return job
}
async function staffAuthority(c,{requireAdmin,WRITE_ROLES,pool,deployment},write=true){
  if(deployment.runtimeEnvironment!=='live')
    return {error:c.json({error:'Central Production authority only.'},403)}
  const auth=await requireAdmin(c,write?WRITE_ROLES:undefined)
  if(auth.error)return auth
  const member=await pool.query([
    'SELECT 1 FROM platform_admin_members',
    "WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
  ].join(' '),[auth.session.user_id])
  if(member.rowCount!==1)return {error:c.json({error:'Active platform owner/admin membership required.'},403)}
  return auth
}
export function registerReleaseWorkActivityRoutes(app,deps){
  const {pool,withTransaction,audit}=deps
  // Central staff review only: these endpoints sign exact rollback evidence,
  // never fabricate a customer request or touch a gateway or Docker image.
  app.post('/api/platform/v1/releases/customer-rollback/review-compatibility',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    try{
      const request=reviewedRollbackCompatibilityRequest(await c.req.json().catch(()=>null))
      const result=await withTransaction(async db=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
        const review=await reviewRollbackCompatibility(db,request,auth.session.user_id)
        await audit(c,auth.session,'release.customer_rollback_compatibility_reviewed',
          'rollback_compatibility',request.sourceSha+'-'+request.targetSha,
          {tenantSlug:review.tenantSlug,sourceSha:request.sourceSha,
           targetSha:request.targetSha,expiresAt:review.expires_at,
           originalReleaseJobId:review.originalReleaseJobId,
           evidence:request.evidence,reason:request.reason,
           customerRequestCreated:false,productionChanged:false},db)
        return review
      })
      return c.json({review:result,productionChanged:false},201)
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},error.status||409)}
  })
  app.post('/api/platform/v1/releases/customer-rollback/certify-worker',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    try{
      const request=reviewedRollbackExecutorRequest(await c.req.json().catch(()=>null))
      const result=await withTransaction(async db=>{
        const review=await reviewRollbackExecutor(db,request,auth.session.user_id)
        await audit(c,auth.session,'release.customer_rollback_executor_certified',
          'rollback_executor',request.revisionSha,
          {revisionSha:request.revisionSha,expiresAt:review.expires_at,
           evidence:request.evidence,reason:request.reason,
           customerRequestCreated:false,productionChanged:false,
           workerActivationChanged:false},db)
        return review
      })
      return c.json({review:result,workerActivated:false,productionChanged:false},201)
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},error.status||409)}
  })
  app.post('/api/platform/v1/releases/customer-rollback/revoke-review',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    try{
      const request=reviewedRollbackRevocation(await c.req.json().catch(()=>null))
      const result=await withTransaction(async db=>{
        const record=request.type==='compatibility'
          ?await db.query([
             'UPDATE platform_release_rollback_compatibility',
             "SET state='revoked' WHERE from_build_sha=$1 AND to_build_sha=$2",
             "AND state='approved' RETURNING from_build_sha",
           ].join(' '),[request.sourceSha,request.targetSha])
          :await db.query([
             'UPDATE platform_release_customer_rollback_executor_certifications',
             "SET state='revoked' WHERE revision_sha=$1 AND state='approved'",
             'RETURNING revision_sha',
           ].join(' '),[request.revisionSha])
        if(record.rowCount!==1)throw refuse('Exact current approved rollback review not found.')
        await audit(c,auth.session,'release.customer_rollback_review_revoked',
          'rollback_review',request.type==='compatibility'
            ?request.sourceSha+'-'+request.targetSha:request.revisionSha,
          {type:request.type,reason:request.reason,sourceSha:request.sourceSha||null,
           targetSha:request.targetSha||null,revisionSha:request.revisionSha||null,
           productionChanged:false},db)
        return {revoked:true,type:request.type}
      })
      return c.json({...result,productionChanged:false})
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},error.status||409)}
  })
  app.get('/api/platform/v1/releases/rollout-jobs/activity',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const [control,jobs,pilot,resume]=await Promise.all([
      pool.query('SELECT paused,reason,updated_at FROM platform_release_rollout_control WHERE singleton=true'),
      pool.query([
        'SELECT j.id,t.slug AS tenant_slug,j.environment,j.build_sha,j.status,',
        'j.attempt_count,j.max_attempts,j.scheduled_at,j.created_at,j.updated_at,',
        'p.update_mode,p.live_auto_promote,',
        'j.completed_at,j.last_error,j.expected_duration_minutes,',
        "EXTRACT(EPOCH FROM (COALESCE(j.completed_at,now())-e.occurred_at))::int AS duration_seconds",
        'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
        'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
        'LEFT JOIN LATERAL (SELECT occurred_at FROM tenant_release_rollout_events',
        "WHERE job_id=j.id AND event_type='claimed' ORDER BY occurred_at DESC LIMIT 1) e ON true",
        'ORDER BY j.updated_at DESC,j.id DESC LIMIT 100',
      ].join(' ')),
      pool.query([
        'SELECT p.job_id,p.tenant_id,p.build_sha,p.state,p.not_before,p.expires_at,',
        't.slug AS tenant_slug FROM platform_release_single_live_pilot_permits p',
        'JOIN tenants t ON t.id=p.tenant_id',
        "WHERE p.state='armed' AND p.expires_at>now() ORDER BY p.armed_at DESC LIMIT 1",
      ].join(' ')),
      readFleetResumeReadiness(pool),
    ])
    c.header('Cache-Control','no-store')
    return c.json({control:{paused:control.rows[0]?.paused!==false,
      reason:control.rows[0]?.reason||'No global control evidence.',
      updatedAt:control.rows[0]?.updated_at||null},
      jobs:jobs.rows.map(j=>({id:j.id,tenantSlug:j.tenant_slug,environment:j.environment,
        buildSha:j.build_sha,status:j.status,attemptCount:j.attempt_count,maxAttempts:j.max_attempts,
        scheduledAt:j.scheduled_at,createdAt:j.created_at,updatedAt:j.updated_at,
        completedAt:j.completed_at,lastError:j.last_error,durationSeconds:j.duration_seconds,
        expectedMinutes:j.expected_duration_minutes,
        updateMode:j.update_mode,managedAutoPromote:j.live_auto_promote===true})),
      activeLivePilot:pilot.rows[0]?{
        jobId:pilot.rows[0].job_id,tenantSlug:pilot.rows[0].tenant_slug,
        buildSha:pilot.rows[0].build_sha,state:pilot.rows[0].state,
        notBefore:pilot.rows[0].not_before,expiresAt:pilot.rows[0].expires_at,
      }:null,
      canResume:resume.canResume,
      resumeReadiness:resume,
      resumeBlockedReason:resume.canResume?'':resume.reasons.join(' ')})
  })
  app.post('/api/platform/v1/releases/rollout-jobs/resume',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    let request
    try{request=reviewedFleetResumeRequest(body)}
    catch(err){return c.json({error:err.message},err.status||400)}
    try{
      const result=await withTransaction(async db=>{
        // Exclude concurrent claims and preference rescheduling, then lock the
        // global pause row. All readiness checks and the audit are in this
        // transaction; no direct route or Docker mutation occurs.
        await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
        await pausedTransaction(db)
        const ready=await readFleetResumeReadiness(db)
        if(!ready.canResume)throw refuse('Fleet resume prerequisites failed: '+ready.reasons.join(' ').slice(0,300))
        if(ready.buildSha!==request.buildSha
          ||JSON.stringify(ready.jobIds)!==JSON.stringify(request.expectedJobIds))
          throw refuse('The exact active job cohort or certified SHA changed; refresh and reconfirm.')
        const previous=await db.query([
          'UPDATE platform_release_rollout_control',
          "SET paused=false,reason=$1,updated_at=now()",
          'WHERE singleton=true AND paused=true',
          'RETURNING singleton',
        ].join(' '),['Staff-authorised certified fleet rollout after verified Managed Production rollback: '+request.reason])
        if(previous.rowCount!==1)throw refuse('Global release control changed during authorisation.')
        for(const job of ready.jobs){
          await db.query([
            'INSERT INTO tenant_release_rollout_events',
            '(job_id,tenant_id,environment,build_sha,event_type,details)',
            "SELECT j.id,j.tenant_id,j.environment,j.build_sha,'resumed',$2::jsonb",
            'FROM tenant_release_rollout_jobs j',
            "WHERE j.id=$1 AND j.status IN ('scheduled','deferred')",
          ].join(' '),[job.id,JSON.stringify({
            reason:request.reason,staffActorId:auth.session.user_id,
            certifiedBuildSha:ready.buildSha,
            provedRollbackJobId:ready.rollbackJobId,
            approvedFleetResume:true,jobScheduleUnchanged:true,
            explicitMaintenanceWindowRequired:true,
          })])
        }
        await audit(c,auth.session,'release.fleet_resumed_after_managed_rollback',
          'release_control',ready.buildSha,{
            reason:request.reason,
            provedRollbackJobId:ready.rollbackJobId,
            provedPreviousSha:ready.rollbackPreviousSha,
            certifiedReleaseSha:ready.buildSha,
            exactApprovedJobs:ready.jobs,
            totalJobs:ready.jobs.length,
            globalPauseCleared:true,actualDeploymentsStartedByAction:0,
            maintenanceAndStageGatesRemainRequired:true,
          },db)
        return {paused:false,approvedBuildSha:ready.buildSha,
          scheduledJobs:ready.jobs,rollbackJobId:ready.rollbackJobId,
          releasesDeployedNow:0}
      })
      return c.json(result)
    }catch(err){return c.json({error:String(err.message||err).slice(0,500)},err.status||409)}
  })
  app.post('/api/platform/v1/releases/rollout-jobs/pilot/arm',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    let request
    try{request=reviewedLivePilotRequest(body)}
    catch(err){return c.json({error:err.message},err.status||400)}
    try{
      return c.json(await withTransaction(async db=>{
        // Same dequeue advisory lock, then global hold, then exact target row.
        await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
        await pausedTransaction(db)
        const inspected=await db.query([
          'SELECT j.*,t.slug,t.status AS tenant_status,',
          'p.update_mode,p.live_auto_promote,p.maintenance_window,p.blackout_periods',
          'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
          'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
          'WHERE j.id=$1 FOR UPDATE OF j',
        ].join(' '),[request.jobId])
        const job=inspected.rows[0]
        checkSame(job,request)
        if(Number(job.lease_fence)>0){
          // Fence counters never reset. Only an exact, recent staff-audited
          // retry event with a verified previous SHA may arm this job again.
          const latest=await db.query([
            'SELECT details FROM tenant_release_rollout_events',
            "WHERE job_id=$1 AND event_type='scheduled'",
            'ORDER BY id DESC LIMIT 1',
          ].join(' '),[job.id])
          const details=latest.rows[0]?.details
          job.retryAuthorised=details?.retryRequested===true
            &&details?.globalPausePreserved===true
            &&SHA.test(String(details?.priorBuild||''))
            &&details.priorBuild===job.previous_build_sha
            &&UUID.test(String(details?.staffActorId||''))
        }
        if(!livePilotJobEligible(job))
          throw refuse('Only an active, unclaimed Managed Production job can be piloted.')
        const now=new Date()
        const window=activeTenantMaintenanceWindow({
          policy:job.maintenance_window,blackouts:job.blackout_periods,
          durationMinutes:job.expected_duration_minutes,now,
        })
        if(!window.allowed||new Date(job.scheduled_at)>now)
          throw refuse('Pilot can only be armed at or after its scheduled time, inside the full approved customer window.')
        const release=await db.query([
          'SELECT 1 FROM platform_certified_application_releases c',
          'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
          'JOIN platform_release_generic_stage_approvals a ON a.build_sha=c.build_sha',
          "WHERE c.build_sha=$1 AND c.status='approved' AND c.approved_by IS NOT NULL",
          "AND a.environment='live' AND a.planning_enabled=true",
          'AND a.execution_enabled=true AND a.approved_by IS NOT NULL',
          'AND a.approved_at<=now() AND a.expires_at>now()',
          "AND a.evidence<>'{}'::jsonb LIMIT 1",
        ].join(' '),[job.build_sha])
        if(release.rowCount!==1)throw refuse('Release certification, publication or Live execution approval is not current.')
        // No first Production pilot from an unverified prior customer route.
        const prior=await db.query([
          'SELECT a.build_sha FROM tenant_runtime_route_attestations a',
          "WHERE a.tenant_id=$1 AND a.environment='live' AND a.state='active'",
          "AND a.public_host=$2 AND a.checked_at>=now()-interval '15 minutes'",
          'AND a.build_sha<>$3 LIMIT 1',
        ].join(' '),[job.tenant_id,job.slug+'.hi5central.com',job.build_sha])
        if(prior.rowCount!==1||!SHA.test(prior.rows[0].build_sha))
          throw refuse('A fresh attestation of the previous Managed Production build is required.')
        // One active pilot at a time; expired permits are revoked in this
        // staff-audited transaction and never authorise a new gateway write.
        await db.query([
          'UPDATE platform_release_single_live_pilot_permits',
          "SET state='revoked',closed_at=now()",
          "WHERE state='armed' AND expires_at<=now()",
        ].join(' '))
        const already=await db.query(
          "SELECT 1 FROM platform_release_single_live_pilot_permits WHERE state='armed' LIMIT 1")
        if(already.rowCount)throw refuse('An existing single-customer pilot is still armed.')
        const end=new Date(now.getTime()+30*60000)
        const remainingWindow=activeTenantMaintenanceWindow({
          policy:job.maintenance_window,blackouts:job.blackout_periods,
          durationMinutes:job.expected_duration_minutes,
          now:new Date(end.getTime()-job.expected_duration_minutes*60000),
        })
        if(!remainingWindow.allowed)
          throw refuse('The protected 30-minute pilot does not fit the remaining customer maintenance window.')
        const entry=await db.query([
          'INSERT INTO platform_release_single_live_pilot_permits',
          '(job_id,tenant_id,build_sha,environment,state,not_before,expires_at,approved_by,reason)',
          "VALUES($1,$2,$3,'live','armed',$4,$5,$6,$7)",
          'ON CONFLICT (job_id) DO UPDATE SET',
          "state='armed',closed_at=NULL,not_before=excluded.not_before,",
          'expires_at=excluded.expires_at,approved_by=excluded.approved_by,',
          'reason=excluded.reason,armed_at=now()',
          "WHERE platform_release_single_live_pilot_permits.state IN ('revoked','completed')",
          'RETURNING job_id,tenant_id,build_sha,not_before,expires_at',
        ].join(' '),[job.id,job.tenant_id,job.build_sha,now,end,
          auth.session.user_id,request.reason])
        if(entry.rowCount!==1)throw refuse('Existing pilot must first be revoked before re-arming.')
        await audit(c,auth.session,'release.managed_production_pilot_armed',
          'rollout_job',job.id,{
            tenantSlug:job.slug,environment:'live',buildSha:job.build_sha,
            previousBuildSha:prior.rows[0].build_sha,
            expiresAt:end.toISOString(),reason:request.reason,
            fleetPaused:true,otherJobsAuthorised:false,
          },db)
        return {pilotArmed:true,jobId:job.id,tenantSlug:job.slug,
          buildSha:job.build_sha,expiresAt:entry.rows[0].expires_at,
          globalRolloutPaused:true,otherJobsAuthorised:false}
      }))
    }catch(err){return c.json({error:String(err.message||err).slice(0,350)},err.status||409)}
  })
  app.post('/api/platform/v1/releases/rollout-jobs/pause',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    if(body?.confirm!=='PAUSE_RELEASE_ROLLOUTS')
      return c.json({error:'Explicit pause confirmation required.'},400)
    let reason
    try{reason=note(body.reason)}catch(err){return c.json({error:err.message},err.status||400)}
    const result=await withTransaction(async db=>{
      const control=await db.query(
        'SELECT paused FROM platform_release_rollout_control WHERE singleton=true FOR UPDATE')
      if(!control.rowCount)throw refuse('Global rollout control is missing.')
      await db.query("UPDATE platform_release_rollout_control SET paused=true,reason=$1,updated_at=now() WHERE singleton=true",[reason])
      const active=await db.query(
        "SELECT count(*)::int AS count FROM tenant_release_rollout_jobs WHERE status='running'")
      await audit(c,auth.session,'release.rollout_paused','rollout','global',
        {reason,alreadyPaused:control.rows[0].paused===true,runningJobs:Number(active.rows[0]?.count||0)},db)
      return {paused:true,runningJobs:Number(active.rows[0]?.count||0)}
    })
    return c.json(result)
  })
  app.post('/api/platform/v1/releases/rollout-jobs/action',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    const action=body?.action
    if(!['cancel','retry'].includes(action))return c.json({error:'Only cancel and retry are supported.'},400)
    let request
    try{request=reviewedJobRequest(body,action)}catch(err){
      return c.json({error:err.message},err.status||400)
    }
    try{
      const result=await withTransaction(async db=>{
        await pausedTransaction(db)
        const job=await lockJob(db,request)
        let retryPriorBuild=job.previous_build_sha||null
        let retryPreWrite=false
        if(action==='cancel'){
          if(!jobSafeToCancel(job))throw refuse('Only an unclaimed, unrouted pending/scheduled/deferred job can be cancelled.')
          const changed=await db.query([
            "UPDATE tenant_release_rollout_jobs SET status='cancelled',",
            'updated_at=now(),completed_at=now(),last_error=$2',
            "WHERE id=$1 AND status=ANY(ARRAY['pending','scheduled','deferred'])",
            'AND attempt_count=0 AND lease_token IS NULL AND lease_expires_at IS NULL',
            'AND lease_fence=0 AND routed_generation IS NULL RETURNING id',
          ].join(' '),[job.id,'Cancelled by staff: '+request.reason])
          if(changed.rowCount!==1)throw refuse('Concurrent queue modification prevented cancellation.')
        }else{
          if(!jobSafeToRetry(job))throw refuse('This failed job requires separate host recovery; it cannot be requeued here.')
          const certified=await db.query([
            'SELECT 1 FROM platform_certified_application_releases',
            "WHERE build_sha=$1 AND status='approved' LIMIT 1",
          ].join(' '),[job.build_sha])
          const published=await db.query(
            'SELECT 1 FROM hi5central_published_release_notes WHERE build_sha=$1 LIMIT 1',[job.build_sha])
          const approval=await db.query([
            'SELECT 1 FROM platform_release_generic_stage_approvals',
            'WHERE build_sha=$1 AND environment=$2',
            'AND planning_enabled=true AND execution_enabled=true',
            'AND approved_by IS NOT NULL AND approved_at<=now() AND expires_at>now()',
            "AND evidence<>'{}'::jsonb LIMIT 1",
          ].join(' '),[job.build_sha,job.environment])
          if(!certified.rowCount||!published.rowCount||!approval.rowCount)
            throw refuse('Retry requires a still-certified, published build and current separate stage execution approval.')
          // A failed worker may have attempted routing. Refuse every retry
          // without independent, fresh host evidence that the customer's
          // exact previous build is still active at the correct stage.
          // Ordinary failures still require the previously recorded SHA.
          // An exact, known pre-gateway SQL rejection cannot record it.
          // Only this one proven pre-write failure can recover from the
          // independently host-attested, actually served customer baseline.
          retryPreWrite=job.environment==='live'
            &&typeof job.last_error==='string'
            &&job.last_error.includes('missing FROM-clause entry for table "j"')
            &&job.routed_generation==null
          let priorBuild=job.previous_build_sha
          if(!SHA.test(String(priorBuild||''))){
            if(!retryPreWrite)
              throw refuse('Retry blocked: previous deployed build was not recorded; independent host recovery required.')
            const assigned=await db.query([
              'SELECT a.build_sha FROM tenant_runtime_assignments a',
              'JOIN tenant_release_preferences p ON p.tenant_id=a.tenant_id',
              "WHERE a.tenant_id=$1 AND a.environment='live'",
              "AND p.update_mode='hi5_managed' AND p.live_auto_promote=true",
              'AND a.build_sha<>$2 LIMIT 1',
            ].join(' '),[job.tenant_id,job.build_sha])
            priorBuild=assigned.rows[0]?.build_sha
            if(!SHA.test(String(priorBuild||'')))
              throw refuse('No verified prior Managed Production assignment exists.')
          }
          const restored=await db.query([
            'SELECT 1 FROM tenant_runtime_route_attestations',
            "WHERE tenant_id=$1 AND environment=$2 AND state='active'",
            "AND build_sha=$3 AND checked_at>=now()-interval '15 minutes'",
            'AND public_host=$4 LIMIT 1',
          ].join(' '),[job.tenant_id,job.environment,priorBuild,
            job.slug+(job.environment==='live'?'':'-'+job.environment)+'.hi5central.com'])
          if(restored.rowCount!==1)
            throw refuse('Retry blocked: a fresh independent host-attested route of the old customer build is required.')
          if(retryPreWrite){
            // Public HTTPS proof in addition to current 15-minute worker attestation.
            // Host is based on a validated tenant slug and fixed application domain.
            const response=await fetch('https://'+job.slug+'.hi5central.com/api/v1/updates/version',{
              signal:AbortSignal.timeout(8000),headers:{accept:'application/json'},
            })
            const version=await response.json().catch(()=>null)
            if(!response.ok||version?.sha!==priorBuild||version?.environment!=='live')
              throw refuse('The actual public Managed Production site does not serve the attested prior SHA.')
          }
          retryPriorBuild=priorBuild
          // A failed one-customer pilot must be explicitly rearmed by staff
          // only after this separately authorised retry; no stale permit
          // is allowed to authorise the second attempt.
          await db.query([
            'UPDATE platform_release_single_live_pilot_permits',
            "SET state='revoked',closed_at=now()",
            "WHERE job_id=$1 AND state='armed'",
          ].join(' '),[job.id])
          // This only schedules. Global rollout remains paused and the claim
          // worker must independently apply all stage/maintenance/route gates.
          const changed=await db.query([
            "UPDATE tenant_release_rollout_jobs SET status='scheduled',",
            "scheduled_at=now()+interval '5 minutes',attempt_count=0,",
            'lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,',
            "last_error='',previous_build_sha=$2,updated_at=now()",
            "WHERE id=$1 AND status='failed' AND lease_token IS NULL",
            'AND lease_expires_at IS NULL AND routed_generation IS NULL RETURNING id',
          ].join(' '),[job.id,priorBuild])
          if(changed.rowCount!==1)throw refuse('Concurrent retry modification prevented scheduling.')
        }
        const details={reason:request.reason,staffActorId:auth.session.user_id,
          previousStatus:job.status,previousAttempts:job.attempt_count,
          previousError:job.last_error,retryRequested:action==='retry',priorBuild:retryPriorBuild,
          preWritePilotRecovery:retryPreWrite,
          globalPausePreserved:true,routeChanges:0}
        await db.query([
          'INSERT INTO tenant_release_rollout_events',
          '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
          'VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        ].join(' '),[job.id,job.tenant_id,job.environment,job.build_sha,
          action==='cancel'?'cancelled':'scheduled',job.lease_fence,JSON.stringify(details)])
        await audit(c,auth.session,action==='cancel'?'release.rollout_job_cancelled':'release.rollout_job_retry_scheduled',
          'rollout_job',job.id,{...details,tenantSlug:job.slug,environment:job.environment,buildSha:job.build_sha},db)
        return {action,jobId:job.id,previousStatus:job.status,
          status:action==='cancel'?'cancelled':'scheduled',globallyPaused:true,routeChanges:0}
      })
      return c.json(result)
    }catch(err){return c.json({error:String(err.message||err).slice(0,350)},err.status||409)}
  })
}
