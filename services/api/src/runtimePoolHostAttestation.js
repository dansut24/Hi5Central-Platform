import {withTransaction} from './db.js'
import {deployment} from './deploymentConfig.js'
import {customerPoolHostname,verifiedRuntimePool} from './runtimePoolPolicy.js'

export function registerTenantUatHostAttestation(app,requireOperator){
 app.post('/api/platform-operator/v1/runtime-pools/attest-tenant-uat',async c=>{
  const denied=requireOperator(c)
  if(denied)return denied
  if(deployment.runtimeEnvironment!=='live')
   return c.json({error:'Central Live authority only.'},403)
  const body=await c.req.json().catch(()=>null)
  const slug=String(body?.tenantSlug||''),id=String(body?.poolId||'')
  const sha=String(body?.buildSha||''),host=String(body?.publicHost||'')
  const state=String(body?.state||'')
  if(!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(slug)
   ||!/^[a-z][a-z0-9-]{2,62}$/.test(id)
   ||!/^[a-f0-9]{40}$/.test(sha)
   ||!['active','rolled_back'].includes(state))
   return c.json({error:'Invalid host attestation.'},400)
  if(host!==customerPoolHostname(slug,'uat',deployment.rootDomain))
   return c.json({error:'Customer UAT hostname mismatch.'},400)
  try{
   const response=await withTransaction(async db=>{
    const tenant=await db.query('SELECT id FROM tenants WHERE slug=$1 AND status=$2',[slug,'active'])
    if(!tenant.rowCount)throw Error('Active customer not found.')
    const tenantId=tenant.rows[0].id
    const result=await db.query([
     'SELECT o.id,o.state,o.build_sha,p.id AS pool_id,p.environment,',
     'p.build_sha AS pool_sha,p.state AS pool_state,p.api_target,p.web_target,',
     'p.verified_at,p.last_seen_at FROM tenant_runtime_update_offers o',
     'JOIN platform_runtime_pools p ON p.id=o.pool_id AND p.environment=o.environment',
     'WHERE o.tenant_id=$1 AND o.environment=$2 AND o.pool_id=$3',
     'AND o.build_sha=$4 AND o.state IN ($5,$6,$7) FOR UPDATE OF o',
    ].join(' '),[tenantId,'uat',id,sha,'offered','uat_testing','uat_accepted'])
    const offer=result.rows[0]
    if(!offer)throw Error('This build has no matching UAT release offer.')
    const pool={id:offer.pool_id,environment:offer.environment,build_sha:offer.pool_sha,
     state:offer.pool_state,api_target:offer.api_target,web_target:offer.web_target,
     verified_at:offer.verified_at,last_seen_at:offer.last_seen_at}
    const verified=verifiedRuntimePool(pool)
    if(!verified.verified)throw Error(verified.reason)
    const published=await db.query('SELECT 1 FROM hi5central_published_release_notes WHERE build_sha=$1',[sha])
    if(!published.rowCount)throw Error('This application build has not been published.')
    await db.query([
     'INSERT INTO tenant_runtime_route_attestations',
     '(tenant_id,environment,pool_id,build_sha,public_host,state,checked_at)',
     "VALUES($1,'uat',$2,$3,$4,$5,now())",
     'ON CONFLICT(tenant_id,environment) DO UPDATE SET',
     'pool_id=EXCLUDED.pool_id,build_sha=EXCLUDED.build_sha,',
     'public_host=EXCLUDED.public_host,state=EXCLUDED.state,checked_at=now()',
    ].join(' '),[tenantId,id,sha,host,state])
    if(state==='active'&&offer.state==='offered')
     await db.query("UPDATE tenant_runtime_update_offers SET state='uat_testing',updated_at=now() WHERE id=$1 AND state='offered'",[offer.id])
    if(state==='rolled_back'&&offer.state==='uat_testing')
     await db.query("UPDATE tenant_runtime_update_offers SET state='blocked',last_gate_reason='Host rolled back the UAT route',updated_at=now() WHERE id=$1",[offer.id])
    await db.query([
     'INSERT INTO tenant_runtime_release_events',
     '(tenant_id,offer_id,event_type,build_sha,details)',
     'VALUES($1,$2,$3,$4,$5::jsonb)',
    ].join(' '),[tenantId,offer.id,state==='active'?'uat_attested':'rolled_back',
     sha,JSON.stringify({host,poolId:id,state,source:'trusted-host-public-check'})])
    return {tenantSlug:slug,offerId:offer.id,buildSha:sha,state}
   })
   return c.json({attestation:response,routingChanged:false})
  }catch(error){return c.json({error:error.message||'Route proof rejected.'},409)}
 })
}
