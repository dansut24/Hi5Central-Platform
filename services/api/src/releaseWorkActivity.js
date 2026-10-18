/**
 * Central staff Work Activity. A browser can pause new claims, cancel an
 * exact unclaimed job, or request a reviewed retry, but NEVER unpause,
 * claim, deploy, approve a stage, or change a tenant route here.
 */
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
  app.get('/api/platform/v1/releases/rollout-jobs/activity',async c=>{
    const auth=await staffAuthority(c,deps)
    if(auth.error)return auth.error
    const [control,jobs]=await Promise.all([
      pool.query('SELECT paused,reason,updated_at FROM platform_release_rollout_control WHERE singleton=true'),
      pool.query([
        'SELECT j.id,t.slug AS tenant_slug,j.environment,j.build_sha,j.status,',
        'j.attempt_count,j.max_attempts,j.scheduled_at,j.created_at,j.updated_at,',
        'j.completed_at,j.last_error,j.expected_duration_minutes,',
        "EXTRACT(EPOCH FROM (COALESCE(j.completed_at,now())-e.occurred_at))::int AS duration_seconds",
        'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
        'LEFT JOIN LATERAL (SELECT occurred_at FROM tenant_release_rollout_events',
        "WHERE job_id=j.id AND event_type='claimed' ORDER BY occurred_at DESC LIMIT 1) e ON true",
        'ORDER BY j.updated_at DESC,j.id DESC LIMIT 100',
      ].join(' ')),
    ])
    c.header('Cache-Control','no-store')
    return c.json({control:{paused:control.rows[0]?.paused!==false,
      reason:control.rows[0]?.reason||'No global control evidence.',
      updatedAt:control.rows[0]?.updated_at||null},
      jobs:jobs.rows.map(j=>({id:j.id,tenantSlug:j.tenant_slug,environment:j.environment,
        buildSha:j.build_sha,status:j.status,attemptCount:j.attempt_count,maxAttempts:j.max_attempts,
        scheduledAt:j.scheduled_at,createdAt:j.created_at,updatedAt:j.updated_at,
        completedAt:j.completed_at,lastError:j.last_error,durationSeconds:j.duration_seconds,
        expectedMinutes:j.expected_duration_minutes})),
      canResume:false,resumeBlockedReason:'Global resume requires separately verified restricted workers, gateway, pilot and rollback controls.'})
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
          // This only schedules. Global rollout remains paused and the claim
          // worker must independently apply all stage/maintenance/route gates.
          const changed=await db.query([
            "UPDATE tenant_release_rollout_jobs SET status='scheduled',",
            "scheduled_at=now()+interval '5 minutes',attempt_count=0,",
            'lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,',
            'last_error=NULL,updated_at=now()',
            "WHERE id=$1 AND status='failed' AND lease_token IS NULL",
            'AND lease_expires_at IS NULL AND routed_generation IS NULL RETURNING id',
          ].join(' '),[job.id])
          if(changed.rowCount!==1)throw refuse('Concurrent retry modification prevented scheduling.')
        }
        const details={reason:request.reason,staffActorId:auth.session.user_id,
          previousStatus:job.status,previousAttempts:job.attempt_count,
          previousError:job.last_error,retryRequested:action==='retry',globalPausePreserved:true,routeChanges:0}
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
