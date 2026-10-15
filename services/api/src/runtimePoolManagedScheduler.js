import {deployment} from './deploymentConfig.js'
import {pool,withTransaction} from './db.js'
import {scheduledPromotionGate,scheduleTenantLive} from './tenantRuntimeReleaseLifecycle.js'

export function registerRuntimeScheduleOperator(app,requireOperator){
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
   'q.id AS verified_pool_id,q.environment AS pool_environment,',
   'q.build_sha AS pool_build_sha,q.state AS pool_state,',
   'q.api_target,q.web_target,q.last_seen_at,q.verified_at,',
   'a.state AS uat_state,a.build_sha AS uat_build_sha,',
   'a.uat_accepted_at AS uat_time,',
   'g.state AS platform_test_state,g.passed_at AS platform_test_time,',
   'g.passed_canary_count AS platform_test_count',
   'FROM tenant_runtime_update_offers o',
   'JOIN tenant_release_preferences p ON p.tenant_id=o.tenant_id',
   'JOIN platform_runtime_pools q ON q.id=o.pool_id AND q.environment=o.environment',
   'LEFT JOIN platform_release_test_qa_gates g ON g.build_sha=o.build_sha',
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
    uatOffer:row.uat_state?{
     state:row.uat_state,build_sha:row.uat_build_sha,uat_accepted_at:row.uat_time,
    }:null,
    testGate:row.platform_test_state?{
     state:row.platform_test_state,build_sha:row.build_sha,
     passed_at:row.platform_test_time,passed_canary_count:row.platform_test_count,
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
