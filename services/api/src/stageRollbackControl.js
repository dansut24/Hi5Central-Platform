/**
 * Hi5Central rollback permissions and queue admission.
 *
 * Customer origin: Custom UAT ONLY.
 * Central platform owner/admin: one tenant or a batched all-customer request.
 * Queue admission cannot alter the gateway, images or database runtime routes.
 * A separate stage-restricted host executor must claim and verify each job.
 */
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/
const fail=(msg,status=409)=>Object.assign(new Error(msg),{status})
export const RELEASE_ROLLBACK_STAGE=new Set(['uat','live'])
export function rollbackPermission({actor,mode,environment}){
 if(!RELEASE_ROLLBACK_STAGE.has(environment))return false
 if(actor==='platform_admin')return environment!=='uat'||mode==='admin_controlled'
 return actor==='customer'&&mode==='admin_controlled'&&environment==='uat'
}
export function rollbackIntent(body,{actor}){
 if(!body||!RELEASE_ROLLBACK_STAGE.has(body.environment)
   ||body.confirm!==(actor==='platform_admin'
     ?'HI5CENTRAL_ROLLBACK_CONFIRMED':'ROLLBACK_MY_CUSTOM_UAT')
   ||actor!=='platform_admin'&&actor!=='customer')
   throw fail('Explicit authorised stage rollback confirmation is required.',400)
 const reason=String(body.reason||'').trim()
 if(reason.length<20||reason.length>1000)
   throw fail('Provide a specific rollback reason of 20–1000 characters.',400)
 if(actor==='customer'&&body.environment!=='uat')
   throw fail('Customers may roll back Custom UAT only. Production rollback is managed by Hi5Central.',403)
 if(typeof body.fromBuildSha!=='string'||!SHA.test(body.fromBuildSha)
   ||typeof body.toBuildSha!=='string'||!SHA.test(body.toBuildSha)
   ||body.toBuildSha===body.fromBuildSha
   ||!Number.isSafeInteger(body.routeGeneration)||body.routeGeneration<=0)
   throw fail('Confirm the exact current SHA, verified previous SHA and route generation.',400)
 return {environment:body.environment,reason,fromSha:body.fromBuildSha,
  toSha:body.toBuildSha,generation:body.routeGeneration}
}
export function staffRollbackSelection(body){
 if(!body||!['one','all'].includes(body.scope)
   ||!RELEASE_ROLLBACK_STAGE.has(body.environment)
   ||body.confirm!=='HI5CENTRAL_ROLLBACK_CONFIRMED'
   ||typeof body.reason!=='string'
   ||body.reason.trim().length<20||body.reason.trim().length>1000)
   throw fail('Confirm an exact stage, one/all scope and a 20–1000 character reason.',400)
 if(body.scope==='one'&&!SLUG.test(String(body.tenantSlug||'')))
   throw fail('Choose a valid exact customer.',400)
 if(body.scope==='all'&&body.tenantSlug!=null)
   throw fail('A fleet rollback must not also specify a tenant.',400)
 if(body.scope==='all'&&body.environment!=='live')
   throw fail('All-customer rollback is restricted to the Production fleet; use one customer for UAT/Test.',400)
 return {scope:body.scope,environment:body.environment,reason:body.reason.trim(),
  tenantSlug:body.scope==='one'?body.tenantSlug:null}
}
async function readEligible(db,{tenantId,environment,lockTenant=true}){
 const tenant=await db.query([
  'SELECT t.id,t.slug,t.status,p.update_mode',
  'FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'WHERE t.id=$1'+(lockTenant?' FOR UPDATE OF t':''),
 ].join(' '),[tenantId])
 const t=tenant.rows[0]
 if(!t||t.status!=='active')
   throw fail('Customer not found or inactive.')
 const assignment=await db.query([
  'SELECT environment,pool_id,build_sha,generation',
  'FROM tenant_runtime_assignments WHERE tenant_id=$1 AND environment=$2',
 ].join(' '),[tenantId,environment])
 const a=assignment.rows[0]
 if(!a||!SHA.test(String(a.build_sha||''))
   ||!Number.isSafeInteger(Number(a.generation))||Number(a.generation)<1)
   throw fail('No verified active build and route generation for this environment.')
 const host=t.slug+(environment==='live'?'':'-'+environment)+'.hi5central.com'
 const attestation=await db.query([
  'SELECT pool_id,build_sha,public_host,state,checked_at',
  'FROM tenant_runtime_route_attestations',
  'WHERE tenant_id=$1 AND environment=$2',
 ].join(' '),[tenantId,environment])
 const observed=attestation.rows[0]
 const checked=Date.parse(String(observed?.checked_at||''))
 if(observed?.state!=='active'||observed.build_sha!==a.build_sha
   ||observed.pool_id!==a.pool_id||observed.public_host!==host
   ||!Number.isFinite(checked)||Date.now()-checked>15*60*1000
   ||checked>Date.now()+30000)
   throw fail('Customer route is not freshly verified on the expected stage.')
 const previous=await db.query([
  'SELECT j.id,j.build_sha,j.previous_build_sha,j.status,',
  'EXISTS(SELECT 1 FROM tenant_release_rollout_events e',
  " WHERE e.job_id=j.id AND e.event_type='verified'",
  " AND e.details->>'previousSha'=j.previous_build_sha",
  " AND length(e.details->>'backup')>20) AS backed_up",
  'FROM tenant_release_rollout_jobs j',
  'WHERE j.tenant_id=$1 AND j.environment=$2 AND j.build_sha=$3',
  "AND j.status='succeeded' AND j.completed_at IS NOT NULL",
  'ORDER BY j.completed_at DESC LIMIT 1',
 ].join(' '),[tenantId,environment,a.build_sha])
 const j=previous.rows[0]
 if(!j||!SHA.test(String(j.previous_build_sha||''))
   ||j.previous_build_sha===a.build_sha||j.backed_up!==true)
   throw fail('No verified and backed-up immediately previous build for this customer/stage.')
 const running=await db.query([
  'SELECT 1 FROM tenant_release_rollout_jobs',
  "WHERE tenant_id=$1 AND environment=$2 AND status IN ('pending','scheduled','deferred','running') LIMIT 1",
 ].join(' '),[tenantId,environment])
 if(running.rowCount)throw fail('A customer release is pending or running in this environment.')
 if(environment==='uat'){
   const production=await db.query([
     'SELECT 1 FROM tenant_release_rollout_jobs',
     "WHERE tenant_id=$1 AND environment='live' AND build_sha=$2",
     "AND status IN ('pending','scheduled','deferred','running') LIMIT 1",
   ].join(' '),[tenantId,a.build_sha])
   if(production.rowCount)
     throw fail('Cancel or finish the pending Production promotion of this UAT build before rolling it back.')
 }
 const concurrent=await db.query([
  'SELECT 1 FROM platform_release_rollback_jobs',
  "WHERE tenant_id=$1 AND environment=$2 AND state IN ('requested','running') LIMIT 1",
 ].join(' '),[tenantId,environment])
 if(concurrent.rowCount)throw fail('A rollback is already pending for this customer and environment.')
 return {tenant:t,assignment:a,original:j,host}
}
export async function rollbackReadiness(db,{tenantId,environment,actor,executorReady=false}){
 if(!UUID.test(String(tenantId||''))||!RELEASE_ROLLBACK_STAGE.has(environment))
   throw fail('Invalid tenant or stage.',400)
 const mode=await db.query([
  'SELECT t.status,p.update_mode FROM tenants t',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'WHERE t.id=$1',
 ].join(' '),[tenantId])
 const row=mode.rows[0]
 const allowed=row?.status==='active'&&rollbackPermission({
  actor,mode:row.update_mode,environment})
 if(!allowed)return {canRequest:false,reasons:['This account cannot request a rollback of that environment.'],
  environment}
 // Read-only status must not take FOR UPDATE locks or mutate the source.
 const latest=await db.query([
  "SELECT id,state,source_build_sha,target_build_sha,created_at,completed_at,last_error,",
  "CASE WHEN state='verified' THEN completed_at ELSE NULL END AS host_verified_at",
  'FROM platform_release_rollback_jobs',
  'WHERE tenant_id=$1 AND environment=$2 ORDER BY created_at DESC LIMIT 1',
 ].join(' '),[tenantId,environment])
 const active=await db.query([
  'SELECT a.build_sha,a.generation,a.pool_id,t.slug',
  'FROM tenant_runtime_assignments a JOIN tenants t ON t.id=a.tenant_id',
  'WHERE a.tenant_id=$1 AND a.environment=$2',
 ].join(' '),[tenantId,environment])
 const cur=active.rows[0]
 const previous=cur?await db.query([
  'SELECT j.previous_build_sha FROM tenant_release_rollout_jobs j',
  "WHERE j.tenant_id=$1 AND j.environment=$2 AND j.build_sha=$3 AND j.status='succeeded'",
  'ORDER BY j.completed_at DESC NULLS LAST LIMIT 1',
 ].join(' '),[tenantId,environment,cur.build_sha]):{rows:[]}
 // Readiness uses the same backup, route and queue guards as admission,
 // but never acquires a tenant write lock or changes any state. The customer
 // must not see an enabled button while there is no runnable stage worker.
 let admissionError=null
 if(executorReady!==true)admissionError='The stage rollback executor is disabled.'
 else {
  try{await readEligible(db,{tenantId,environment,lockTenant:false})}
  catch(error){admissionError=String(error.message||error).slice(0,350)}
 }
 return {canRequest:admissionError===null,
  reasons:admissionError?[admissionError]:[],
  environment,installedBuildSha:cur?.build_sha||null,
  previousBuildSha:previous.rows[0]?.previous_build_sha||null,
  sourceRouteGeneration:cur?.generation??null,
  latestRequest:latest.rows[0]||null,
  activeRequest:['requested','running'].includes(latest.rows[0]?.state)?latest.rows[0]:null,
  upgradeHoldActive:false,
  confirmationRequired:true}
}
export async function queueRollback(db,{
 tenantId,userId,actor,body,batchId=null,
}){
 if(!UUID.test(String(tenantId||''))||!UUID.test(String(userId||'')))
   throw fail('Valid authenticated tenant and user identities required.',400)
 const intent=rollbackIntent(body,{actor})
 // Serialize against current rollout claims, and lock the actual tenant.
 await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
 const check=await readEligible(db,{tenantId,environment:intent.environment})
 if(!rollbackPermission({actor,mode:check.tenant.update_mode,environment:intent.environment}))
   throw fail('Rollback scope not permitted for this customer or stage.',403)
 if(check.assignment.build_sha!==intent.fromSha
   ||check.original.previous_build_sha!==intent.toSha
   ||Number(check.assignment.generation)!==intent.generation)
   throw fail('Current or previous build/route generation changed; refresh and reconfirm.')
 const via=actor==='customer'?'custom_customer':'hi5central_admin'
 if(intent.environment==='live'){
   // Share the EXISTING Production upgrade hold/trigger with the normal
   // release worker so a rollback never races an automatic Live promotion.
   const hold=await db.query([
     'INSERT INTO tenant_release_upgrade_holds',
     '(tenant_id,active,reason,requested_by,held_at,released_at,released_by)',
     'VALUES($1,true,$2,$3,now(),NULL,NULL)',
     'ON CONFLICT (tenant_id) DO UPDATE SET',
     'active=true,reason=excluded.reason,requested_by=excluded.requested_by,',
     'held_at=excluded.held_at,released_at=NULL,released_by=NULL',
     'WHERE tenant_release_upgrade_holds.active=false RETURNING tenant_id',
   ].join(' '),[tenantId,intent.reason,userId])
   if(hold.rowCount!==1)throw fail('An existing Production upgrade hold prevents a duplicate rollback.')
 }
 const result=await db.query([
  'INSERT INTO platform_release_rollback_jobs',
  '(batch_id,tenant_id,environment,source_build_sha,target_build_sha,',
  'source_route_generation,original_release_job_id,requested_via,requested_by,reason)',
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING",
  'id,batch_id,environment,state,source_build_sha,target_build_sha,created_at',
 ].join(' '),[batchId,tenantId,intent.environment,intent.fromSha,intent.toSha,
  intent.generation,check.original.id,via,userId,intent.reason])
 const job=result.rows[0]
 await db.query([
  'INSERT INTO platform_release_rollback_events',
  '(request_id,tenant_id,actor_user_id,event_type,details)',
  "VALUES($1,$2,$3,'requested',$4::jsonb)",
 ].join(' '),[job.id,tenantId,userId,JSON.stringify({
  stage:intent.environment,requestedVia:via,host:check.host,
  originalReleaseJobId:check.original.id,sourceRouteGeneration:intent.generation,
  productionChanged:false})])
 return {...job,tenantSlug:check.tenant.slug,productionChanged:false}
}
export async function listStaffRollbackCandidates(db,{environment}){
 if(!RELEASE_ROLLBACK_STAGE.has(environment))
   throw fail('Choose a valid rollback environment.',400)
 const result=await db.query([
  'SELECT t.id,t.slug,p.update_mode,a.build_sha,a.generation,',
  'j.previous_build_sha',
  'FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'JOIN tenant_runtime_assignments a ON a.tenant_id=t.id AND a.environment=$1',
  'LEFT JOIN LATERAL (SELECT previous_build_sha FROM tenant_release_rollout_jobs',
  'WHERE tenant_id=t.id AND environment=$1 AND build_sha=a.build_sha',
  "AND status='succeeded' ORDER BY completed_at DESC LIMIT 1) j ON true",
  "WHERE t.status='active' AND ($1<>'uat' OR p.update_mode='admin_controlled')",
  'ORDER BY t.slug LIMIT 501',
 ].join(' '),[environment])
 if(result.rows.length>500)
   throw fail('A fleet exceeds 500 tenant candidates. Split into reviewed batches rather than silently omit customers.')
 return result.rows.filter(r=>SHA.test(String(r.previous_build_sha||''))
  &&r.previous_build_sha!==r.build_sha).map(r=>({
    tenantId:r.id,tenantSlug:r.slug,mode:r.update_mode,
    fromBuildSha:r.build_sha,toBuildSha:r.previous_build_sha,
    routeGeneration:Number(r.generation),
  }))
}
