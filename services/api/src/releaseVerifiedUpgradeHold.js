/** Central-only, audited release of the tenant upgrade hold after both verified
 * Production-first and Custom UAT recoveries. This NEVER starts a deployment. */
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/
const refuse=(message,status=409)=>Object.assign(new Error(message),{status})

export function reviewedUpgradeHoldRelease(body){
 if(!body||body.confirm!=='RELEASE_VERIFIED_PRODUCTION_UPGRADE_HOLD'
   ||!SLUG.test(String(body.tenantSlug||''))
   ||!SHA.test(String(body.fromBuildSha||''))||!SHA.test(String(body.toBuildSha||''))
   ||body.fromBuildSha===body.toBuildSha
   ||!UUID.test(String(body.productionRollbackId||''))
   ||!UUID.test(String(body.uatRollbackId||''))
   ||body.productionRollbackId===body.uatRollbackId
   ||typeof body.holdStartedAt!=='string'
   ||!Number.isFinite(Date.parse(body.holdStartedAt))
   ||new Date(body.holdStartedAt).toISOString()!==body.holdStartedAt
   ||typeof body.reason!=='string'
   ||body.reason.trim().length<20||body.reason.trim().length>500)
   throw refuse('Select the exact verified Production/UAT recovery and confirm a 20–500 character audit reason.',400)
 return {...body,reason:body.reason.trim()}
}
export function rollbackPairReady({live,uat,request}={}){
 return Boolean(live&&uat&&request
  &&live.state==='verified'&&uat.state==='verified'
  &&live.environment==='live'&&uat.environment==='uat'
  &&live.requested_via==='hi5central_admin'
  &&uat.requested_via==='custom_customer'
  &&live.source_build_sha===request.fromBuildSha
  &&live.target_build_sha===request.toBuildSha
  &&uat.source_build_sha===request.fromBuildSha
  &&uat.target_build_sha===request.toBuildSha
  &&Date.parse(live.completed_at)>0
  &&Date.parse(uat.completed_at)>Date.parse(live.completed_at)
  &&live.proof?.publicApiSha===request.toBuildSha
  &&live.proof?.publicWebSha===request.toBuildSha
  &&uat.proof?.publicApiSha===request.toBuildSha
  &&uat.proof?.publicWebSha===request.toBuildSha
  &&live.proof?.otherCustomersUnchanged===true
  &&uat.proof?.otherCustomersUnchanged===true
  &&live.proof?.gatewaySourceAndMountMatch===true
  &&uat.proof?.gatewaySourceAndMountMatch===true)
}
export async function listVerifiedUpgradeHolds(db){
 const rows=await db.query([
  'SELECT t.slug,h.held_at,',
  'live.id AS live_id,live.source_build_sha AS from_sha,',
  'live.target_build_sha AS to_sha,live.completed_at AS live_completed,',
  'uat.id AS uat_id,uat.completed_at AS uat_completed,',
  'production.build_sha AS production_sha,testing.build_sha AS uat_sha,',
  'EXISTS(SELECT 1 FROM platform_release_rollback_jobs pending',
  " WHERE pending.tenant_id=t.id AND pending.state IN ('requested','running')) AS pending_recovery",
  'FROM tenant_release_upgrade_holds h',
  'JOIN tenants t ON t.id=h.tenant_id',
  "LEFT JOIN LATERAL (SELECT id,source_build_sha,target_build_sha,completed_at",
  ' FROM platform_release_rollback_jobs r',
  " WHERE r.tenant_id=t.id AND r.environment='live' AND r.state='verified'",
  ' ORDER BY r.completed_at DESC LIMIT 1) live ON true',
  'LEFT JOIN LATERAL (SELECT id,completed_at',
  ' FROM platform_release_rollback_jobs r',
  " WHERE r.tenant_id=t.id AND r.environment='uat' AND r.state='verified'",
  ' AND r.source_build_sha=live.source_build_sha',
  ' AND r.target_build_sha=live.target_build_sha',
  ' ORDER BY r.completed_at DESC LIMIT 1) uat ON true',
  'LEFT JOIN tenant_runtime_assignments production',
  " ON production.tenant_id=t.id AND production.environment='live'",
  'LEFT JOIN tenant_runtime_assignments testing',
  " ON testing.tenant_id=t.id AND testing.environment='uat'",
  'WHERE h.active=true ORDER BY h.held_at DESC LIMIT 100',
 ].join(' '))
 return rows.rows.map(r=>({
  tenantSlug:r.slug,holdStartedAt:new Date(r.held_at).toISOString(),
  productionRollbackId:r.live_id||null,uatRollbackId:r.uat_id||null,
  fromBuildSha:r.from_sha||null,toBuildSha:r.to_sha||null,
  productionBuildSha:r.production_sha||null,uatBuildSha:r.uat_sha||null,
  canRequest:Boolean(r.live_id&&r.uat_id&&r.to_sha
   &&r.production_sha===r.to_sha&&r.uat_sha===r.to_sha
   &&Date.parse(r.uat_completed)>Date.parse(r.live_completed)
   &&r.pending_recovery===false),
 }))
}
export async function releaseVerifiedUpgradeHold(db,request,userId,auditAction){
 if(!UUID.test(String(userId||'')))throw refuse('Authenticated administrator identity required.',403)
 // Same lock ordering as worker/upgrade claim: shared queue fence, then
 // tenant row, then upgrade hold. All proofs and audit in ONE transaction.
 await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
 const tenant=await db.query([
  'SELECT id,status FROM tenants WHERE slug=$1 FOR UPDATE',
 ].join(' '),[request.tenantSlug])
 const tenantId=tenant.rows[0]?.id
 if(!tenantId||tenant.rows[0].status!=='active')
  throw refuse('Target customer is not active.')
 const hold=await db.query([
  'SELECT active,held_at,held_at::text AS held_at_exact,requested_by FROM tenant_release_upgrade_holds',
  'WHERE tenant_id=$1 FOR UPDATE',
 ].join(' '),[tenantId])
 const original=hold.rows[0]
 if(!original?.active||new Date(original.held_at).toISOString()!==request.holdStartedAt)
  throw refuse('Exact active hold changed or is already released; refresh.')
 const pair=await db.query([
  'SELECT id,environment,state,requested_via,source_build_sha,target_build_sha,',
  'completed_at,proof FROM platform_release_rollback_jobs',
  'WHERE tenant_id=$1 AND id IN ($2,$3) FOR UPDATE',
 ].join(' '),[tenantId,request.productionRollbackId,request.uatRollbackId])
 const live=pair.rows.find(r=>r.id===request.productionRollbackId)
 const uat=pair.rows.find(r=>r.id===request.uatRollbackId)
 if(!rollbackPairReady({live,uat,request}))
  throw refuse('Production-first and customer UAT rollback verification is incomplete or mismatched.')
 const origin=await db.query([
  'SELECT 1 FROM platform_release_rollback_jobs r',
  'JOIN tenant_release_upgrade_holds h ON h.tenant_id=r.tenant_id',
  "WHERE r.tenant_id=$1 AND r.environment='live'",
  // Compare the two original DB timestamps INSIDE PostgreSQL: converting
  // either to a JS Date truncates its microseconds and would fail valid holds.
  'AND r.created_at=h.held_at AND r.requested_by=h.requested_by',
  "AND h.active=true AND r.requested_via='hi5central_admin'",
  'AND r.source_build_sha=$2 AND r.target_build_sha=$3',
  'LIMIT 1',
 ].join(' '),[tenantId,request.fromBuildSha,request.toBuildSha])
 if(origin.rowCount!==1)throw refuse('Active hold does not originate from this verified recovery.')
 const observed=await db.query([
  'SELECT a.environment,a.build_sha,a.pool_id,a.generation,',
  'att.build_sha AS att_sha,att.pool_id AS att_pool,',
  'att.state,att.checked_at,att.public_host',
  'FROM tenant_runtime_assignments a',
  'JOIN tenant_runtime_route_attestations att',
  ' ON att.tenant_id=a.tenant_id AND att.environment=a.environment',
  "WHERE a.tenant_id=$1 AND a.environment IN ('live','uat')",
  'FOR UPDATE OF a',
 ].join(' '),[tenantId])
 if(observed.rows.length!==2||!['uat','live'].every(stage=>{
  const row=observed.rows.find(x=>x.environment===stage)
  return row?.build_sha===request.toBuildSha
   &&row?.att_sha===request.toBuildSha&&row.att_pool===row.pool_id
   &&row.state==='active'
   &&row.public_host===request.tenantSlug+(stage==='live'?'':'-uat')+'.hi5central.com'
   &&Date.now()-Date.parse(row.checked_at)<15*60*1000
   &&Date.parse(row.checked_at)<=Date.now()+30000
 }))throw refuse('Both customer routes must be freshly attested on the exact same restored build.')
 const active=await db.query([
  'SELECT (SELECT count(*)::int FROM platform_release_rollback_jobs r',
  " WHERE r.tenant_id=$1 AND r.state IN ('requested','running')) AS rollbacks,",
  '(SELECT count(*)::int FROM tenant_release_rollout_jobs j',
  " WHERE j.tenant_id=$1 AND j.status IN ('pending','scheduled','deferred','running')) AS releases,",
  '(SELECT count(*)::int FROM platform_release_gateway_owners o',
  ' WHERE o.tenant_id=$1) AS gateway_owners,',
  '(SELECT count(*)::int FROM tenant_runtime_update_offers o',
  " WHERE o.tenant_id=$1 AND o.build_sha=$2",
  " AND o.state IN ('offered','uat_testing','uat_accepted','scheduled','activating','active')) AS rejected_offers",
 ].join(' '),[tenantId,request.fromBuildSha])
 const conflict=active.rows[0]
 if(!conflict||Number(conflict.rollbacks)!==0||Number(conflict.releases)!==0
   ||Number(conflict.gateway_owners)!==0||Number(conflict.rejected_offers)!==0)
  throw refuse('Pending jobs, gateway owners or a still-offered rejected release prevent hold release.')
 const updated=await db.query([
  'UPDATE tenant_release_upgrade_holds',
  'SET active=false,released_at=now(),released_by=$2',
  'WHERE tenant_id=$1 AND active=true AND held_at::text=$3 RETURNING released_at',
 ].join(' '),[tenantId,userId,original.held_at_exact])
 if(updated.rowCount!==1)throw refuse('Upgrade hold changed during operator authorisation.')
 await auditAction({
  tenantId,reason:request.reason,
  productionRollbackId:live.id,uatRollbackId:uat.id,
  fromBuildSha:request.fromBuildSha,toBuildSha:request.toBuildSha,
  previouslyHeldAt:original.held_at,releasedAt:updated.rows[0].released_at,
  exactCustomerOnly:true,deploymentsStartedByAction:0,
  futureMaintenanceAndApprovalGatesRemainRequired:true,
 })
 return {tenantSlug:request.tenantSlug,holdReleased:true,
  restoredBuildSha:request.toBuildSha,deploymentsStarted:0}
}
