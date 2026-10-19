/**
 * Customer-authorised Production rollback REQUEST, not a host cutover.
 *
 * This module never writes Caddy, selects a Docker image or marks rollback
 * verified. An independently restricted host executor must implement that
 * separately, rechecking current route, compatibility and fenced ownership.
 * Until that executor is certified, customer requests fail closed.
 */
const SHA=/^[0-9a-f]{40}$/
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail=(reason,status=409)=>Object.assign(new Error(reason),{status})
const newest=(value)=>Number.isFinite(Date.parse(String(value||'')))?new Date(value):null
export function rollbackRequestPayload(body){
  const reason=String(body?.reason||'').trim()
  if(body?.confirm!=='ROLLBACK_MY_CUSTOM_PRODUCTION'
    ||!SHA.test(String(body?.fromBuildSha||''))
    ||!SHA.test(String(body?.toBuildSha||''))
    ||body.fromBuildSha===body.toBuildSha
    ||!Number.isSafeInteger(Number(body?.routeGeneration))
    ||Number(body.routeGeneration)<1||Number(body.routeGeneration)!==body.routeGeneration
    ||reason.length<20||reason.length>1000)
    throw fail('Confirm the exact installed Production build, previous build, route generation and a 20–1000 character reason.',400)
  return {fromBuildSha:body.fromBuildSha,toBuildSha:body.toBuildSha,
    routeGeneration:body.routeGeneration,reason}
}
function reviewedCompatibility(row,from,to,now){
  if(!row||row.from_build_sha!==from||row.to_build_sha!==to||row.state!=='approved'
    ||row.schema_backward_compatible!==true||row.immutable_images_verified!==true
    ||row.recovery_snapshot_verified!==true||!UUID.test(String(row.reviewed_by||''))
    ||!newest(row.reviewed_at)||!newest(row.expires_at)
    ||newest(row.expires_at)<=now)return false
  const proof=row.evidence||{}
  return proof.schemaChecked===true&&proof.previousImagePulled===true
    &&proof.recoveryTestPassed===true
}
export function evaluateCustomerRollback({
  mode,slug,current,route,verifiedJob,compatibility,activeHold,activeRequest,
  activeRolloutCount=0,executorReady=false,now=new Date()
}){
 const reasons=[]
 if(mode!=='admin_controlled')reasons.push('Self-service Custom rollback is available only to customer-controlled Production environments.')
 if(!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(String(slug||'')))
   reasons.push('Customer hostname is invalid.')
 if(!current||current.environment!=='live'||!SHA.test(String(current.build_sha||''))
    ||!Number.isSafeInteger(Number(current.generation))||Number(current.generation)<1)
   reasons.push('No verified current Production assignment and route generation.')
 if(!route||route.environment!=='live'||route.state!=='active'
   ||route.build_sha!==current?.build_sha||route.pool_id!==current?.pool_id
   ||route.public_host!==slug+'.hi5central.com'
   ||!newest(route.checked_at)||now.getTime()-newest(route.checked_at).getTime()>900000
   ||newest(route.checked_at).getTime()>now.getTime()+30000)
   reasons.push('The installed Production hostname requires a fresh independent route attestation.')
 if(!verifiedJob||verifiedJob.status!=='succeeded'
   ||verifiedJob.environment!=='live'||verifiedJob.build_sha!==current?.build_sha
   ||!SHA.test(String(verifiedJob.previous_build_sha||''))
   ||verifiedJob.previous_build_sha===current?.build_sha
   ||verifiedJob.has_verified_event!==true
   ||!verifiedJob.previous_gateway_backup)
   reasons.push('A verified, backed-up prior Production deployment is required.')
 if(!reviewedCompatibility(compatibility,current?.build_sha,verifiedJob?.previous_build_sha,now))
   reasons.push('The exact rollback build pair requires unexpired staff-reviewed schema, image and recovery compatibility.')
 if(activeHold||activeRequest)
   reasons.push('A customer rollback is already pending or a tenant-specific upgrade hold is active.')
 if(Number(activeRolloutCount)!==0)
   reasons.push('A customer Production release is pending or running; rollback cannot race an upgrade.')
 if(executorReady!==true)
   reasons.push('The restricted Production rollback executor has not been enabled and verified.')
 return {canRequest:reasons.length===0,reasons,installedBuildSha:current?.build_sha||null,
   previousBuildSha:verifiedJob?.previous_build_sha||null,
   sourceRouteGeneration:current?.generation??null,
   matchedReleaseJobId:verifiedJob?.id||null,
   compatibilityExpiresAt:compatibility?.expires_at||null}
}

/** Never inserts/updates a request or hold. Safe for customer summary UI. */
export async function customerRollbackReadiness(db,{tenantId,now=new Date(),executorReady=false}){
 if(!UUID.test(String(tenantId||'')))throw fail('Invalid tenant.',400)
 const tenant=await db.query([
   'SELECT t.slug,t.status,p.update_mode FROM tenants t',
   'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
   'WHERE t.id=$1',
 ].join(' '),[tenantId])
 const current=await db.query([
   'SELECT environment,pool_id,build_sha,generation FROM tenant_runtime_assignments',
   "WHERE tenant_id=$1 AND environment='live'",
 ].join(' '),[tenantId])
 const route=await db.query([
   'SELECT environment,pool_id,build_sha,public_host,state,checked_at',
   'FROM tenant_runtime_route_attestations',
   "WHERE tenant_id=$1 AND environment='live'",
 ].join(' '),[tenantId])
 const verified=await db.query([
   'SELECT j.id,j.environment,j.status,j.build_sha,j.previous_build_sha,',
   'EXISTS(SELECT 1 FROM tenant_release_rollout_events e',
   " WHERE e.job_id=j.id AND e.event_type='verified'",
   " AND e.details->>'previousSha'=j.previous_build_sha",
   " AND length(e.details->>'backup')>=20) AS has_verified_event,",
   '(SELECT e.details->>\'backup\' FROM tenant_release_rollout_events e',
   " WHERE e.job_id=j.id AND e.event_type='verified'",
   ' ORDER BY e.id DESC LIMIT 1) AS previous_gateway_backup',
   'FROM tenant_release_rollout_jobs j',
   "WHERE j.tenant_id=$1 AND j.environment='live'",
   'AND j.build_sha=$2 ORDER BY j.completed_at DESC NULLS LAST LIMIT 1',
 ].join(' '),[tenantId,current.rows[0]?.build_sha||''])
 const compatibility=verified.rows[0]?.previous_build_sha
   ?await db.query([
     'SELECT from_build_sha,to_build_sha,state,schema_backward_compatible,',
     'immutable_images_verified,recovery_snapshot_verified,reviewed_by,reviewed_at,expires_at,evidence',
     'FROM platform_release_rollback_compatibility',
     'WHERE from_build_sha=$1 AND to_build_sha=$2',
   ].join(' '),[current.rows[0]?.build_sha,verified.rows[0]?.previous_build_sha])
   :{rows:[]}
 const active=await db.query([
   'SELECT id,state,requested_at,source_build_sha,target_build_sha',
   'FROM tenant_release_customer_rollback_requests',
   "WHERE tenant_id=$1 AND state IN ('requested','approved','running')",
   'ORDER BY requested_at DESC LIMIT 1',
 ].join(' '),[tenantId])
 const holds=await db.query(
   'SELECT active FROM tenant_release_upgrade_holds WHERE tenant_id=$1 AND active=true',[tenantId])
 const queued=await db.query([
   'SELECT count(*)::int AS total FROM tenant_release_rollout_jobs',
   "WHERE tenant_id=$1 AND environment='live'",
   "AND status IN ('pending','scheduled','deferred','running')",
 ].join(' '),[tenantId])
 const status=evaluateCustomerRollback({
   mode:tenant.rows[0]?.status==='active'?tenant.rows[0]?.update_mode:null,
   slug:tenant.rows[0]?.slug,current:current.rows[0],route:route.rows[0],
   verifiedJob:verified.rows[0],compatibility:compatibility.rows[0],
   activeRequest:active.rows[0],activeHold:holds.rows[0],
   activeRolloutCount:queued.rows[0]?.total,executorReady,now,
 })
 return {...status,activeRequest:active.rows[0]||null}
}

/** Caller owns transaction, and must hold global queue claim advisory lock.
 * Tenant row lock serialises with the upgrade-hold trigger.
 */
export async function requestCustomerRollback(db,{
 tenantId,userId,body,now=new Date(),executorReady=false
}){
 if(!UUID.test(String(tenantId))||!UUID.test(String(userId)))
   throw fail('Invalid customer/user identity.',400)
 const request=rollbackRequestPayload(body)
 await db.query('SELECT id FROM tenants WHERE id=$1 AND status=$2 FOR UPDATE',[tenantId,'active'])
 const gate=await customerRollbackReadiness(db,{tenantId,now,executorReady})
 if(!gate.canRequest)throw fail('Rollback is not available: '+gate.reasons.join(' '))
 if(gate.installedBuildSha!==request.fromBuildSha
   ||gate.previousBuildSha!==request.toBuildSha
   ||Number(gate.sourceRouteGeneration)!==request.routeGeneration)
   throw fail('Production version or route changed; refresh and explicitly reconfirm.')
 const hold=await db.query([
   'INSERT INTO tenant_release_upgrade_holds',
   '(tenant_id,active,reason,requested_by,held_at,released_at,released_by)',
   'VALUES($1,true,$2,$3,$4,NULL,NULL)',
   'ON CONFLICT (tenant_id) DO UPDATE SET',
   'active=true,reason=excluded.reason,requested_by=excluded.requested_by,',
   'held_at=excluded.held_at,released_at=NULL,released_by=NULL',
   'WHERE tenant_release_upgrade_holds.active=false RETURNING tenant_id',
 ].join(' '),[tenantId,request.reason,userId,now])
 if(hold.rowCount!==1)throw fail('An existing rollback hold prevents a duplicate request.')
 const created=await db.query([
   'INSERT INTO tenant_release_customer_rollback_requests',
   '(tenant_id,environment,source_build_sha,target_build_sha,state,',
   'requested_by,reason,compatibility_reviewed_at,source_route_generation)',
   "SELECT $1,'live',$2,$3,'requested',$4,$5,c.reviewed_at,$6",
   'FROM platform_release_rollback_compatibility c',
   "WHERE c.from_build_sha=$2 AND c.to_build_sha=$3 AND c.state='approved'",
   'AND c.expires_at>now() RETURNING id,state,source_build_sha,target_build_sha,requested_at',
 ].join(' '),[tenantId,request.fromBuildSha,request.toBuildSha,userId,
   request.reason,request.routeGeneration])
 if(created.rowCount!==1)throw fail('Compatibility review was withdrawn during customer request.')
 await db.query([
   'INSERT INTO tenant_release_customer_rollback_events',
   '(request_id,tenant_id,actor_user_id,event_type,source_build_sha,target_build_sha,details)',
   "VALUES($1,$2,$3,'requested',$4,$5,$6::jsonb)",
 ].join(' '),[created.rows[0].id,tenantId,userId,request.fromBuildSha,request.toBuildSha,
   JSON.stringify({reason:request.reason,routeGeneration:request.routeGeneration,
     approvedCompatibility:true,productionChanged:false,upgradeHoldActive:true})])
 return {...created.rows[0],productionChanged:false,upgradeHoldActive:true}
}
