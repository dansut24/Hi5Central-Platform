import {deployment} from './deploymentConfig.js'
import {pool,withTransaction} from './db.js'
import {scheduledPromotionGate,scheduleTenantLive} from './tenantRuntimeReleaseLifecycle.js'
import {preparePoolOffer} from './runtimePoolControl.js'
import {verifiedRuntimePool} from './runtimePoolPolicy.js'

// A release publication does not deploy software. An operator can discover
// the next tenant offers only after exact-build UAT/Live pool health evidence.
// No Test/Production traffic changes, and the default is read-only.
export function rolloutLane(mode){
 if(mode==='admin_controlled')return 'uat'
 if(mode==='hi5_managed')return 'live'
 return null
}

export function registerRuntimeScheduleOperator(app,requireOperator){
 app.post('/api/platform-operator/v1/runtime-pools/discover-offers',async c=>{
  const denied=requireOperator(c)
  if(denied)return denied
  if(deployment.runtimeEnvironment!=='live')
    return c.json({error:'Central Live release authority only.'},403)
  const body=await c.req.json().catch(()=>null)
  const sha=String(body?.buildSha||'')
  if(!/^[a-f0-9]{40}$/.test(sha))
    return c.json({error:'Specify one immutable published build SHA.'},400)
  if(body?.apply!==undefined&&typeof body.apply!=='boolean')
    return c.json({error:'apply must be a boolean.'},400)
  const apply=body?.apply===true
  const published=await pool.query('SELECT published_at FROM hi5central_published_release_notes WHERE build_sha=$1',[sha])
  if(!published.rowCount)return c.json({error:'This release has not been published.'},409)
  const tenants=await pool.query([
   'SELECT t.id,t.slug,p.update_mode,p.uat_auto_stage,p.live_auto_promote',
   'FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id',
   "WHERE t.status='active' ORDER BY t.slug LIMIT 200",
  ].join(' '))
  const available=await pool.query([
   'SELECT * FROM platform_runtime_pools',
   "WHERE build_sha=$1 AND environment IN ('uat','live')",
   "AND state='verified' ORDER BY verified_at DESC",
  ].join(' '),[sha])
  const summary={buildSha:sha,apply,productionChanged:false,routingChanged:false,
    offers:[],deferred:[]}
  const now=new Date()
  for(const tenant of tenants.rows){
   const lane=rolloutLane(tenant.update_mode)
   if(!lane||lane==='uat'&&!tenant.uat_auto_stage
     ||lane==='live'&&!tenant.live_auto_promote){
     summary.deferred.push({slug:tenant.slug,reason:'Automatic release offers disabled for this tenant.'})
     continue
   }
   const candidate=available.rows.find(p=>p.environment===lane&&verifiedRuntimePool(p,now).verified)
   if(!candidate){
     summary.deferred.push({slug:tenant.slug,reason:'A healthy exact-build runtime pool is not attested.'})
     continue
   }
   const already=await pool.query([
    'SELECT id,state FROM tenant_runtime_update_offers',
    'WHERE tenant_id=$1 AND environment=$2',
    "AND state IN ('offered','uat_testing','uat_accepted','scheduled','activating','active')",
    'ORDER BY created_at DESC LIMIT 1',
   ].join(' '),[tenant.id,lane])
   if(already.rowCount){
     summary.deferred.push({slug:tenant.slug,reason:'An existing release assignment or offer must be reconciled first.'})
     continue
   }
   if(!apply){
     summary.offers.push({slug:tenant.slug,environment:lane,buildSha:sha,
       poolId:candidate.id,status:'preview'})
     continue
   }
   try{
     const created=await withTransaction(db=>preparePoolOffer({
       db,tenantId:tenant.id,environment:lane,poolId:candidate.id,now,
     }))
     summary.offers.push({slug:tenant.slug,environment:lane,buildSha:sha,
       offerId:created.offer.id,status:'offered'})
   }catch(error){
     summary.deferred.push({slug:tenant.slug,reason:String(error.message||'Not eligible').slice(0,200)})
   }
  }
  return c.json(summary)
 })


 app.post('/api/platform-operator/v1/runtime-pools/schedule-managed',async c=>{
  const denied=requireOperator(c)
  if(denied)return denied
  if(deployment.runtimeEnvironment!=='live')
   return c.json({error:'Central Live release authority only.'},403)
  const candidates=await pool.query([
   'SELECT o.id,o.tenant_id FROM tenant_runtime_update_offers o',
   'JOIN tenant_release_preferences p ON p.tenant_id=o.tenant_id',
   "WHERE o.environment='live' AND o.state='offered'",
   "AND o.update_mode='hi5_managed' AND p.update_mode='hi5_managed'",
   'AND p.live_auto_promote=true ORDER BY o.created_at ASC LIMIT 30'
  ].join(' '))
  const summary={scheduled:[],deferred:[]}
  for(const offer of candidates.rows){
   try{
    const scheduled=await withTransaction(db=>scheduleTenantLive({
     db,tenantId:offer.tenant_id,offerId:offer.id,userId:null,
    }))
    summary.scheduled.push({id:scheduled.id,notBefore:scheduled.maintenance_not_before,
     buildSha:scheduled.build_sha})
   }catch(error){
    summary.deferred.push({id:offer.id,reason:String(error.message||'Not eligible').slice(0,180)})
   }
  }
  return c.json({...summary,productionChanged:false})
 })

 // A read-only host poll. It evaluates the *current* maintenance policy,
 // UAT acceptance, delay and fresh pool health on every call. No route changes.
 app.get('/api/platform-operator/v1/runtime-pools/due',async c=>{
  const denied=requireOperator(c)
  if(denied)return denied
  if(deployment.runtimeEnvironment!=='live')
   return c.json({error:'Central Live authority only.'},403)
  const rows=await pool.query([
   'SELECT o.*,p.update_mode AS current_mode,p.live_auto_promote,',
   'p.live_delay_hours,p.maintenance_window,',
   'published.published_at AS release_published_at,',
   'q.id AS verified_pool_id,q.environment AS pool_environment,',
   'q.build_sha AS pool_build_sha,q.state AS pool_state,',
   'q.api_target,q.web_target,q.last_seen_at,q.verified_at,',
   'a.state AS uat_state,a.build_sha AS uat_build_sha,',
   'a.uat_accepted_at AS uat_time',
   'FROM tenant_runtime_update_offers o',
   'JOIN tenant_release_preferences p ON p.tenant_id=o.tenant_id',
   'JOIN platform_runtime_pools q ON q.id=o.pool_id AND q.environment=o.environment',
   'LEFT JOIN hi5central_published_release_notes published ON published.build_sha=o.build_sha',
   'LEFT JOIN LATERAL (SELECT state,build_sha,uat_accepted_at',
   'FROM tenant_runtime_update_offers u',
   "WHERE u.tenant_id=o.tenant_id AND u.environment='uat'",
   "AND u.build_sha=o.build_sha AND u.state IN ('uat_accepted','active')",
   'ORDER BY u.uat_accepted_at DESC LIMIT 1) a ON true',
   "WHERE o.environment='live' AND o.state='scheduled'",
   'ORDER BY o.maintenance_not_before ASC LIMIT 50'
  ].join(' '))
  const now=new Date()
  const eligible=[],deferred=[]
  for(const row of rows.rows){
   const poolState={id:row.verified_pool_id,environment:row.pool_environment,
    build_sha:row.pool_build_sha,state:row.pool_state,
    api_target:row.api_target,web_target:row.web_target,
    verified_at:row.verified_at,last_seen_at:row.last_seen_at}
   const gate=scheduledPromotionGate({
    offer:row,pool:poolState,preference:{
     update_mode:row.current_mode,live_auto_promote:row.live_auto_promote,
     live_delay_hours:row.live_delay_hours,maintenance_window:row.maintenance_window,
    },
    publishedAt:row.release_published_at,
    uatOffer:row.uat_state?{
     state:row.uat_state,build_sha:row.uat_build_sha,uat_accepted_at:row.uat_time,
    }:null,now,
   })
   const item={id:row.id,tenantId:row.tenant_id,
    buildSha:row.build_sha,poolId:row.pool_id,reason:gate.reason}
   if(gate.allowed)eligible.push(item)
   else deferred.push(item)
  }
  return c.json({eligible,deferred,activationEnabled:false,
   message:'Read-only gate. Host route changes need separate approved generation and rollback verification.'})
 })
}
