import {randomUUID} from 'node:crypto'
import {maintenanceWindowStatus} from './runtimePoolPolicy.js'

const SHA=/^[a-f0-9]{40}$/
const ENV=new Set(['test','uat','live'])
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const ACTIVE=['scheduled','deferred','running']
const invalid=reason=>Object.assign(new Error(reason),{code:'ROLLOUT_GUARD'})
const goodDate=v=>{const date=new Date(v);return Number.isFinite(date.getTime())?date:null}

/**
 * These functions receive a Postgres transaction-scoped client. The caller
 * owns BEGIN/COMMIT, and no function starts/restarts Docker or changes Caddy.
 * The database is a durable queue; host route activation is a separate gate.
 */
export async function enqueueReleasePlans(db,{plans,releaseRef=''}) {
  if(!Array.isArray(plans)||!plans.length||plans.length>2000)
    throw invalid('Release planning batch must contain 1–2000 tenants.')
  const results=[]
  for(const plan of plans){
    if(plan.status!=='scheduled'){results.push({tenantId:plan.tenantId,stage:plan.stage,state:'blocked',reason:plan.reason});continue}
    if(!UUID.test(String(plan.tenantId))||!SHA.test(String(plan.buildSha))
      ||!ENV.has(plan.stage)||!goodDate(plan.scheduledAt))
      throw invalid('Invalid tenant, environment, immutable release or time.')
    const existing=await db.query(
      'SELECT id,status,scheduled_at FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND environment=$2 AND build_sha=$3',
      [plan.tenantId,plan.stage,plan.buildSha])
    if(existing.rowCount){
      results.push({tenantId:plan.tenantId,stage:plan.stage,
        state:existing.rows[0].status,id:existing.rows[0].id,reused:true})
      continue
    }
    const created=await db.query([
      'INSERT INTO tenant_release_rollout_jobs',
      '(tenant_id,environment,build_sha,status,scheduled_at,release_ref)',
      "VALUES($1,$2,$3,'pending',$4,$5)",
      'ON CONFLICT (tenant_id,environment,build_sha) DO NOTHING RETURNING id',
    ].join(' '),[plan.tenantId,plan.stage,plan.buildSha,plan.scheduledAt,String(releaseRef).slice(0,200)])
    const row=created.rows[0]||(await db.query(
      'SELECT id FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND environment=$2 AND build_sha=$3',
      [plan.tenantId,plan.stage,plan.buildSha])).rows[0]
    if(!row)throw invalid('Rollout job registration conflict; retry transaction.')
    if(created.rowCount)await db.query([
      'INSERT INTO tenant_release_rollout_events(job_id,tenant_id,environment,build_sha,event_type,details)',
      "VALUES($1,$2,$3,$4,'scheduled',$5::jsonb)",
    ].join(' '),[row.id,plan.tenantId,plan.stage,plan.buildSha,
      JSON.stringify({queued:true,scheduledAt:plan.scheduledAt})])
    results.push({tenantId:plan.tenantId,stage:plan.stage,id:row.id,
      state:'pending',reused:!created.rowCount})
  }
  return results
}

/** Call under transaction; respects the unique active tenant/env index. */
export async function activateNextPendingRollout(db,{tenantId,environment}){
  if(!UUID.test(String(tenantId))||!ENV.has(environment))throw invalid('Invalid tenant/environment.')
  const lock=await db.query(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
    ['tenant-rollout:'+tenantId+':'+environment])
  if(!lock.rows[0]?.locked)return {activated:false,reason:'Another worker holds the tenant lock.'}
  const active=await db.query(
    'SELECT 1 FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND environment=$2 AND status=ANY($3::text[]) LIMIT 1',
    [tenantId,environment,ACTIVE])
  if(active.rowCount)return {activated:false,reason:'Another version is already scheduled or running.'}
  const next=await db.query([
    'SELECT id FROM tenant_release_rollout_jobs',
    "WHERE tenant_id=$1 AND environment=$2 AND status='pending'",
    'ORDER BY scheduled_at ASC,created_at ASC,id ASC FOR UPDATE SKIP LOCKED LIMIT 1',
  ].join(' '),[tenantId,environment])
  if(!next.rowCount)return {activated:false,reason:'No queued rollout for this tenant/environment.'}
  const change=await db.query([
    "UPDATE tenant_release_rollout_jobs SET status='scheduled',updated_at=now()",
    "WHERE id=$1 AND status='pending' RETURNING id,build_sha,scheduled_at",
  ].join(' '),[next.rows[0].id])
  return {activated:true,job:change.rows[0]}
}

/**
 * A lease is NOT deployment authorisation. Read-only verified state, blackout,
 * live window, tenant scope, and host proof must be rechecked before a route
 * switch. Default global pause protects environments until full E2E tests pass.
 */
export async function claimDueRollouts(db,{now=new Date(),limit=10,leaseSeconds=120}={}){
  const at=goodDate(now)
  if(!at||!Number.isInteger(limit)||limit<1||limit>50
    ||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>600)
    throw invalid('Invalid worker clock, lease or batch size.')
  const control=await db.query(
    'SELECT paused,reason FROM platform_release_rollout_control WHERE singleton=true FOR SHARE')
  if(control.rows[0]?.paused!==false)
    return {claimed:[],paused:true,reason:control.rows[0]?.reason||'No explicit rollout enablement.'}
  const queued=await db.query([
    'SELECT j.id,j.tenant_id,j.environment,j.build_sha,j.scheduled_at,j.attempt_count,j.max_attempts,',
    'p.maintenance_window,t.status AS tenant_status,p.update_mode',
    'FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
    "WHERE ((j.status IN ('scheduled','deferred') AND j.scheduled_at<=$1)",
    "OR (j.status='running' AND j.lease_expires_at<=$1))",
    'AND j.attempt_count<j.max_attempts',
    'ORDER BY j.scheduled_at ASC,j.id ASC',
    'FOR UPDATE OF j SKIP LOCKED LIMIT $2',
  ].join(' '),[at,limit])
  const claimed=[],deferred=[]
  for(const row of queued.rows){
    // Window and tenant entitlement must be rechecked after dequeuing.
    // No automatic host action occurs in this function.
    const allowedEnvironment=(row.environment==='uat'&&row.update_mode==='admin_controlled')
      ||(row.environment==='test')
      ||(row.environment==='live')
    const window=maintenanceWindowStatus(row.maintenance_window||{},at)
    if(row.tenant_status!=='active'||!allowedEnvironment||!window.allowed){
      await db.query([
        "UPDATE tenant_release_rollout_jobs SET status='deferred',lease_token=NULL,",
        'lease_expires_at=NULL,updated_at=$2,last_error=$3 WHERE id=$1',
      ].join(' '),[row.id,at,window.allowed?'Tenant is inactive or environment is ineligible.':window.reason])
      await db.query([
        'INSERT INTO tenant_release_rollout_events(job_id,tenant_id,environment,build_sha,event_type,details)',
        "VALUES($1,$2,$3,$4,'deferred',$5::jsonb)",
      ].join(' '),[row.id,row.tenant_id,row.environment,row.build_sha,
        JSON.stringify({reason:window.reason})])
      deferred.push({id:row.id,reason:window.reason})
      continue
    }
    const lease=randomUUID()
    const fence=await db.query([
      "UPDATE tenant_release_rollout_jobs SET status='running',attempt_count=attempt_count+1,",
      'lease_token=$2,lease_fence=lease_fence+1,lease_expires_at=$3,updated_at=$4',
      "WHERE id=$1 RETURNING lease_fence",
    ].join(' '),[row.id,lease,new Date(at.getTime()+leaseSeconds*1000),at])
    await db.query([
      'INSERT INTO tenant_release_rollout_events(job_id,tenant_id,environment,build_sha,event_type,fence)',
      "VALUES($1,$2,$3,$4,'claimed',$5)",
    ].join(' '),[row.id,row.tenant_id,row.environment,row.build_sha,fence.rows[0].lease_fence])
    claimed.push({id:row.id,tenantId:row.tenant_id,environment:row.environment,
      buildSha:row.build_sha,leaseToken:lease,leaseFence:fence.rows[0].lease_fence})
  }
  return {claimed,deferred,paused:false}
}

/** Only a trusted host that verified the *actual route* may report success. */
export async function finishRollout(db,{jobId,leaseToken,leaseFence,outcome,proof,now=new Date()}={}){
  if(!UUID.test(String(jobId))||!UUID.test(String(leaseToken))
    ||!Number.isInteger(leaseFence)||leaseFence<1
    ||!['succeeded','failed','rolled_back'].includes(outcome))
    throw invalid('Invalid worker completion token, fence or outcome.')
  const current=await db.query(
    'SELECT * FROM tenant_release_rollout_jobs WHERE id=$1 FOR UPDATE',[jobId])
  const row=current.rows[0],at=goodDate(now)
  if(!at||!row||row.status!=='running'||row.lease_token!==leaseToken
    ||Number(row.lease_fence)!==leaseFence||new Date(row.lease_expires_at)<=at)
    throw invalid('Lease expired, job changed or fencing token is stale.')
  if(outcome==='succeeded'){
    const checked=goodDate(proof?.checkedAt)
    if(proof?.tenantId!==row.tenant_id||proof?.environment!==row.environment
      ||proof?.buildSha!==row.build_sha
      ||!Number.isInteger(proof?.routeGeneration)||proof.routeGeneration<1
      ||!checked||checked>at||at.getTime()-checked.getTime()>120000)
      throw invalid('A fresh host-observed tenant route proof is required.')
  }
  await db.query([
    'UPDATE tenant_release_rollout_jobs SET status=$2,lease_token=NULL,',
    'lease_expires_at=NULL,completed_at=$3,updated_at=$3,',
    'routed_generation=$4 WHERE id=$1',
  ].join(' '),[jobId,outcome,at,outcome==='succeeded'?proof.routeGeneration:null])
  await db.query([
    'INSERT INTO tenant_release_rollout_events(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
    'VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
  ].join(' '),[jobId,row.tenant_id,row.environment,row.build_sha,
    outcome==='succeeded'?'verified':outcome,leaseFence,
    JSON.stringify(outcome==='succeeded'?{routeGeneration:proof.routeGeneration}:{})])
  return {id:jobId,outcome}
}
