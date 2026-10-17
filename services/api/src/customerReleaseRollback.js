/**
 * Fail-closed customer ITSM rollback request boundary.
 * A browser request NEVER writes Caddy or chooses an arbitrary version.
 * The only permitted target is the predecessor of the currently verified
 * tenant Live rollout, and a staff-reviewed backward-compatible pair.
 * Dispatch remains a separate fenced trusted-host operation.
 */
import {customerPoolHostname} from './runtimePoolPolicy.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const deny=(message,status=409)=>Object.assign(new Error(message),{status})
const validDate=x=>new Date(x||'').getTime()
const format=x=>x?String(x):null

export function assessCustomerRollback({
  tenant,assignment,route,lastJob,compatibility,activeRollout,
  activeRequest,now=new Date(),
}={}) {
  const unavailable=reason=>({available:false,reason,currentBuildSha:null,targetBuildSha:null})
  if(!tenant||tenant.status!=='active'||tenant.itsm!==true)
    return unavailable('An active ITSM subscription is required.')
  if(!['hi5_managed','admin_controlled'].includes(tenant.update_mode))
    return unavailable('This tenant has no approved ITSM update policy.')
  if(!assignment||assignment.environment!=='live'||!SHA.test(format(assignment.build_sha)||''))
    return unavailable('No verified current Production application version.')
  const current=assignment.build_sha
  const target=lastJob?.previous_build_sha
  const pending=reason=>({available:false,reason,currentBuildSha:current,
    targetBuildSha:SHA.test(format(target)||'')?target:null})
  if(activeRequest)return pending('A customer rollback is already pending.')
  if(activeRollout)return pending('A Production upgrade is currently running. Retry after the cutover completes.')
  if(!lastJob||lastJob.status!=='succeeded'||lastJob.environment!=='live'
    ||lastJob.build_sha!==current||!SHA.test(format(target)||'')||target===current)
    return pending('A previously verified Production version is not recorded for this exact deployment.')
  if(!route||route.environment!=='live'||route.state!=='active'
    ||route.build_sha!==current||route.pool_id!==assignment.pool_id
    ||route.public_host!==customerPoolHostname(tenant.slug,'live')
    ||!Number.isInteger(Number(assignment.generation))||Number(assignment.generation)<1)
    return pending('Current Production route is not independently verified for this tenant.')
  const routeAge=now.getTime()-validDate(route.checked_at)
  if(!Number.isFinite(routeAge)||routeAge<0||routeAge>15*60*1000)
    return pending('Current Production HTTPS route evidence is too old; retry after verification.')
  if(!compatibility||compatibility.state!=='approved'
    ||compatibility.from_build_sha!==current||compatibility.to_build_sha!==target
    ||!compatibility.schema_backward_compatible
    ||!compatibility.immutable_images_verified
    ||!compatibility.recovery_snapshot_verified
    ||!compatibility.reviewed_by
    ||!Number.isFinite(validDate(compatibility.reviewed_at))
    ||validDate(compatibility.reviewed_at)>now.getTime()
    ||!Number.isFinite(validDate(compatibility.expires_at))
    ||validDate(compatibility.expires_at)<=now.getTime())
    return pending('No current independent schema, image and recovery approval for this exact rollback.')
  return {available:true,reason:'Compatible previous release confirmed; host execution will require a second independent fenced verification.',
    currentBuildSha:current,targetBuildSha:target,
    routeGeneration:Number(assignment.generation),
    compatibilityReviewedAt:compatibility.reviewed_at}
}

async function snapshot(db,tenantId,{lockTenant=false}={}){
  if(!UUID.test(format(tenantId)||''))throw deny('Invalid tenant identity.',400)
  // When requesting, serialize with the per-tenant database trigger that
  // protects scheduled/claimed Live jobs under a customer upgrade hold.
  const tenantResult=await db.query([
    'SELECT t.id,t.slug,t.status,p.update_mode,',
    "COALESCE((s.modules->>'itsm')::boolean,false) AS itsm",
    'FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id',
    'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
    'WHERE t.id=$1'+(lockTenant?' FOR UPDATE OF t':''),
  ].join(' '),[tenantId])
  const tenant=tenantResult.rows[0]
  if(!tenant)return {availability:assessCustomerRollback(),hold:null,recent:[]}
  const [assignment,route,job,active,request,hold]=await Promise.all([
    db.query("SELECT * FROM tenant_runtime_assignments WHERE tenant_id=$1 AND environment='live'",[tenantId]),
    db.query("SELECT * FROM tenant_runtime_route_attestations WHERE tenant_id=$1 AND environment='live'",[tenantId]),
    db.query([
      'SELECT id,environment,build_sha,previous_build_sha,status,completed_at',
      'FROM tenant_release_rollout_jobs WHERE tenant_id=$1',
      "AND environment='live' AND status='succeeded'",
      'ORDER BY completed_at DESC LIMIT 1',
    ].join(' '),[tenantId]),
    db.query([
      'SELECT id,status FROM tenant_release_rollout_jobs WHERE tenant_id=$1',
      "AND environment='live' AND status='running' LIMIT 1",
    ].join(' '),[tenantId]),
    db.query([
      'SELECT id,state FROM tenant_release_customer_rollback_requests',
      "WHERE tenant_id=$1 AND state IN ('requested','approved','running')",
      'LIMIT 1',
    ].join(' '),[tenantId]),
    db.query('SELECT active,reason,held_at FROM tenant_release_upgrade_holds WHERE tenant_id=$1',[tenantId]),
  ])
  const current=assignment.rows[0],lastJob=job.rows[0]
  let compatibility=null
  if(current&&lastJob?.previous_build_sha){
    const r=await db.query([
      'SELECT from_build_sha,to_build_sha,state,schema_backward_compatible,',
      'immutable_images_verified,recovery_snapshot_verified,reviewed_by,',
      'reviewed_at,expires_at',
      'FROM platform_release_rollback_compatibility',
      'WHERE from_build_sha=$1 AND to_build_sha=$2',
    ].join(' '),[current.build_sha,lastJob.previous_build_sha])
    compatibility=r.rows[0]
  }
  const availability=assessCustomerRollback({
    tenant,assignment:current,route:route.rows[0],lastJob,compatibility,
    activeRollout:active.rowCount>0,activeRequest:request.rowCount>0,
  })
  const recent=await db.query([
    'SELECT id,source_build_sha,target_build_sha,state,reason,',
    'requested_at,started_at,completed_at,host_verified_at',
    'FROM tenant_release_customer_rollback_requests WHERE tenant_id=$1',
    'ORDER BY requested_at DESC LIMIT 8',
  ].join(' '),[tenantId])
  return {availability,hold:hold.rows[0]||null,recent:recent.rows}
}

export async function readCustomerRollback({db,tenantId}){
  return snapshot(db,tenantId)
}

export async function requestCustomerRollback({db,tenantId,userId,
  expectedCurrentSha,targetBuildSha,confirmed,reason,now=new Date()}={}){
  if(!UUID.test(format(userId)||'')||!UUID.test(format(tenantId)||''))
    throw deny('Invalid authenticated tenant administrator.',400)
  if(confirmed!==true||!SHA.test(format(expectedCurrentSha)||'')
    ||!SHA.test(format(targetBuildSha)||''))
    throw deny('Confirm the exact current and previous release versions.',400)
  const note=String(reason||'').trim()
  if(note.length<20||note.length>1000)
    throw deny('Provide 20–1000 characters explaining the rollback.',400)
  // This function REQUIRES a caller-managed DB transaction. It acquires the
  // tenant lock ahead of the upgrade-hold trigger's tenant lock.
  const state=await snapshot(db,tenantId,{lockTenant:true})
  const selected=state.availability
  if(!selected.available)throw deny(selected.reason)
  if(selected.currentBuildSha!==expectedCurrentSha
    ||selected.targetBuildSha!==targetBuildSha)
    throw deny('Production changed since this rollback was reviewed.')
  if(state.hold?.active)throw deny('A tenant Production upgrade hold is already in place.')
  // Any not-yet-running automatic Live jobs are cancelled under this lock;
  // their workers use the same database tenant lock before a Live claim.
  const queued=await db.query([
    'UPDATE tenant_release_rollout_jobs SET status=$2,updated_at=$3,',
    'last_error=$4 WHERE tenant_id=$1 AND environment=$5',
    "AND status IN ('pending','scheduled','deferred')",
    'RETURNING id,environment,build_sha,lease_fence',
  ].join(' '),[tenantId,'cancelled',now,'Customer requested a scoped Production rollback','live'])
  for(const job of queued.rows){
    await db.query([
      'INSERT INTO tenant_release_rollout_events',
      '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
      "VALUES($1,$2,'live',$3,'cancelled',$4,$5::jsonb)",
    ].join(' '),[job.id,tenantId,job.build_sha,job.lease_fence,
      JSON.stringify({reason:'Customer rollback hold',actorUserId:userId})])
  }
  await db.query([
    'INSERT INTO tenant_release_upgrade_holds',
    '(tenant_id,active,reason,requested_by,held_at)',
    'VALUES($1,true,$2,$3,$4)',
    'ON CONFLICT(tenant_id) DO UPDATE SET active=true,reason=excluded.reason,',
    'requested_by=excluded.requested_by,held_at=excluded.held_at,',
    'released_by=NULL,released_at=NULL',
  ].join(' '),[tenantId,note,userId,now])
  const result=await db.query([
    'INSERT INTO tenant_release_customer_rollback_requests',
    '(tenant_id,source_build_sha,target_build_sha,requested_by,reason,',
    'compatibility_reviewed_at,source_route_generation,requested_at)',
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    'RETURNING id,tenant_id,source_build_sha,target_build_sha,state,requested_at',
  ].join(' '),[tenantId,expectedCurrentSha,targetBuildSha,userId,note,
    selected.compatibilityReviewedAt,selected.routeGeneration,now])
  const request=result.rows[0]
  await db.query([
    'INSERT INTO tenant_release_customer_rollback_events',
    '(request_id,tenant_id,actor_user_id,event_type,source_build_sha,',
    "target_build_sha,details) VALUES($1,$2,$3,'requested',$4,$5,$6::jsonb)",
  ].join(' '),[request.id,tenantId,userId,expectedCurrentSha,targetBuildSha,
    JSON.stringify({cancelledForwardJobs:queued.rowCount,
      upgradeHold:true,hostRollbackExecuted:false})])
  return {...request,cancelledForwardJobs:queued.rowCount,
    productionChanged:false,upgradeHold:true}
}
