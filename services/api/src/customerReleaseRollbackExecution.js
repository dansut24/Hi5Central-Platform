/**
 * Durable customer rollback state machine. Metadata only: no route writes.
 * Only the lease-holding trusted Live worker may call completeRollbackRequest
 * after receiving independent proof from the Unix-only host adapter.
 * Separate customer requests and gateway execution prevent browser access.
 */
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const refuse=message=>Object.assign(new Error(message),{code:'CUSTOMER_ROLLBACK_EXECUTION_DENIED'})
const cleanDate=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d:null}

export function verifyCustomerRollbackHostProof({request,proof,now=new Date()}={}){
 const invalid=reason=>({ok:false,reason})
 if(!request||request.state!=='running'||!UUID.test(String(request.id||'')))
  return invalid('A claimed exact rollback request is required.')
 if(!proof||typeof proof!=='object'||Array.isArray(proof)
  ||proof.status!=='rollback_verified'||proof.requestId!==request.id
  ||proof.tenantId!==request.tenant_id||proof.environment!=='live'
  ||proof.sourceBuildSha!==request.source_build_sha
  ||proof.observedBuildSha!==request.target_build_sha
  ||!SHA.test(String(proof.observedBuildSha||'')))
  return invalid('Proof does not match the claimed tenant and exact rollback versions.')
 if(!Number.isSafeInteger(proof.routeGeneration)
  ||proof.routeGeneration<=Number(request.source_route_generation||0))
  return invalid('The rollback needs a new, monotonic routing generation.')
 const when=cleanDate(proof.checkedAt),at=cleanDate(now)
 if(!when||!at||when>at||at-when>120000)
  return invalid('Trusted host HTTPS verification is not recent.')
 if(proof.apiHealthy!==true||proof.frontendHealthy!==true
  ||proof.gatewaySourceAgreed!==true
  ||proof.tenantScopedRouteOnly!==true)
  return invalid('The exact tenant API, frontend and gateway isolation must be verified.')
 return {ok:true,reason:'Fresh exact-tenant trusted host evidence accepted.',checkedAt:when}
}
export async function claimNextCustomerRollback(db,{now=new Date()}={}){
 const at=cleanDate(now)
 if(!at)throw refuse('Invalid claim time.')
 // A global rollout emergency hold also prevents unreviewed rollback cutovers.
 const control=await db.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
 if(control.rows[0]?.paused!==false)return null
 const selected=await db.query([
  'SELECT r.* FROM tenant_release_customer_rollback_requests r',
  'JOIN tenant_release_upgrade_holds h ON h.tenant_id=r.tenant_id',
  'JOIN tenants t ON t.id=r.tenant_id',
  'JOIN tenant_settings ts ON ts.tenant_id=r.tenant_id',
  'JOIN platform_release_rollback_compatibility c',
  'ON c.from_build_sha=r.source_build_sha AND c.to_build_sha=r.target_build_sha',
  'JOIN tenant_runtime_assignments a ON a.tenant_id=r.tenant_id',
  "AND a.environment='live' AND a.build_sha=r.source_build_sha",
  'JOIN tenant_runtime_route_attestations v ON v.tenant_id=r.tenant_id',
  "AND v.environment='live' AND v.build_sha=r.source_build_sha",
  'AND v.pool_id=a.pool_id',
  "WHERE r.state='requested' AND r.environment='live'",
  "AND t.status='active' AND h.active=true",
  "AND coalesce((ts.modules->>'itsm')::boolean,false)=true",
  "AND c.state='approved' AND c.schema_backward_compatible=true",
  'AND c.immutable_images_verified=true AND c.recovery_snapshot_verified=true',
  'AND c.reviewed_by IS NOT NULL',
  "AND date_trunc('milliseconds',c.reviewed_at)=r.compatibility_reviewed_at",
  'AND c.expires_at>now() AND a.generation=r.source_route_generation',
  "AND v.state='active'",
  'AND NOT EXISTS (SELECT 1 FROM tenant_release_rollout_jobs j',
  "WHERE j.tenant_id=r.tenant_id AND j.environment='live'",
  "AND j.status='running')",
  'ORDER BY r.requested_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1',
 ].join(' '))
 const request=selected.rows[0]
 if(!request)return null
 const updated=await db.query([
  'UPDATE tenant_release_customer_rollback_requests',
  "SET state='running',started_at=$2,last_error=''",
  "WHERE id=$1 AND state='requested' RETURNING *",
 ].join(' '),[request.id,at])
 if(updated.rowCount!==1)throw refuse('Rollback claim changed concurrently.')
 await db.query([
  'INSERT INTO tenant_release_customer_rollback_events',
  '(request_id,tenant_id,event_type,source_build_sha,target_build_sha,details)',
  "VALUES($1,$2,'started',$3,$4,$5::jsonb)",
 ].join(' '),[request.id,request.tenant_id,request.source_build_sha,
  request.target_build_sha,JSON.stringify({worker:'trusted-live-worker',hostExecuted:false})])
 return updated.rows[0]
}
export async function completeCustomerRollback(db,{requestId,proof,now=new Date()}={}){
 if(!UUID.test(String(requestId||'')))throw refuse('Exact rollback request required.')
 const row=(await db.query(
  'SELECT * FROM tenant_release_customer_rollback_requests WHERE id=$1 FOR UPDATE',
  [requestId])).rows[0]
 const valid=verifyCustomerRollbackHostProof({request:row,proof,now})
 if(!valid.ok)throw refuse(valid.reason)
 const hold=await db.query([
  'SELECT active FROM tenant_release_upgrade_holds',
  'WHERE tenant_id=$1 FOR UPDATE',
 ],[row.tenant_id])
 if(hold.rows[0]?.active!==true)
  throw refuse('The customer rollback hold must remain active.')
 // A newer release must not have moved this tenant during the host step.
 const current=await db.query([
  'SELECT generation,build_sha FROM tenant_runtime_assignments',
  "WHERE tenant_id=$1 AND environment='live' FOR UPDATE",
 ],[row.tenant_id])
 if(current.rows[0]?.build_sha!==row.source_build_sha
  ||Number(current.rows[0]?.generation)!==Number(row.source_route_generation))
  throw refuse('Production changed since rollback was claimed.')
 const pool=await db.query([
  'SELECT id FROM platform_runtime_pools',
  "WHERE environment='live' AND build_sha=$1 AND state='verified'",
  'AND last_seen_at>now()-interval \'15 minutes\' LIMIT 1',
 ],[row.target_build_sha])
 if(pool.rowCount!==1)throw refuse('Previous exact immutable pool is not verified and healthy.')
 const target=pool.rows[0].id
 await db.query([
  'UPDATE tenant_runtime_assignments SET pool_id=$2,build_sha=$3,',
  'generation=$4,activated_at=$5',
  "WHERE tenant_id=$1 AND environment='live'",
 ],[row.tenant_id,target,row.target_build_sha,proof.routeGeneration,valid.checkedAt])
 await db.query([
  'UPDATE tenant_runtime_route_attestations',
  "SET pool_id=$2,build_sha=$3,state='active',checked_at=$4",
  "WHERE tenant_id=$1 AND environment='live'",
 ],[row.tenant_id,target,row.target_build_sha,valid.checkedAt])
 const updated=await db.query([
  'UPDATE tenant_release_customer_rollback_requests',
  "SET state='verified',host_verified_at=$2,completed_at=$2,",
  'host_proof=$3::jsonb,last_error=\'\' WHERE id=$1',
  "AND state='running' RETURNING id,tenant_id,state,target_build_sha",
 ],[requestId,valid.checkedAt,JSON.stringify({
  routeGeneration:proof.routeGeneration,observedBuildSha:proof.observedBuildSha,
  sourceBuildSha:proof.sourceBuildSha,checkedAt:proof.checkedAt,
  tenantScopedRouteOnly:true,apiHealthy:true,frontendHealthy:true,
  gatewaySourceAgreed:true,
 })])
 if(updated.rowCount!==1)throw refuse('Verified rollback status could not be committed.')
 await db.query([
  'INSERT INTO tenant_release_customer_rollback_events',
  '(request_id,tenant_id,event_type,source_build_sha,target_build_sha,details)',
  "VALUES($1,$2,'verified',$3,$4,$5::jsonb)",
 ],[requestId,row.tenant_id,row.source_build_sha,row.target_build_sha,
  JSON.stringify({routeGeneration:proof.routeGeneration,verifiedAt:valid.checkedAt,
   upgradeHoldPreserved:true})])
 // Intentionally retain the upgrade hold. Re-enabling the same bad version
 // must require separate, authenticated customer release of this safety hold.
 return {...updated.rows[0],upgradeHoldPreserved:true}
}
export async function failCustomerRollback(db,{requestId,reason}={}){
 if(!UUID.test(String(requestId||'')))throw refuse('Exact rollback request required.')
 const text=String(reason||'Unknown trusted host failure').slice(0,400)
 const changed=await db.query([
  'UPDATE tenant_release_customer_rollback_requests',
  "SET state='failed',completed_at=now(),last_error=$2",
  "WHERE id=$1 AND state='running'",
  'RETURNING id,tenant_id,source_build_sha,target_build_sha',
 ],[requestId,text])
 if(!changed.rowCount)return {changed:false}
 const r=changed.rows[0]
 await db.query([
  'INSERT INTO tenant_release_customer_rollback_events',
  '(request_id,tenant_id,event_type,source_build_sha,target_build_sha,details)',
  "VALUES($1,$2,'failed',$3,$4,$5::jsonb)",
 ],[r.id,r.tenant_id,r.source_build_sha,r.target_build_sha,
  JSON.stringify({reason:text,upgradeHoldPreserved:true})])
 return {changed:true,upgradeHoldPreserved:true}
}
