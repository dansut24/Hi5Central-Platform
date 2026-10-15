import { createHash } from 'node:crypto'
import { customerPoolHostname,resolvedCustomerPool,tenantReleaseEligibility,verifiedRuntimePool } from './runtimePoolPolicy.js'

// Registering runtime plans cannot reconfigure a proxy or publish an update.
export async function runtimePoolsOverview(database,now=new Date()){
  const [pools,assignments,offers,generations]=await Promise.all([
    database.query('SELECT id,environment,build_sha,state,verified_at,last_seen_at,health,created_at FROM platform_runtime_pools ORDER BY environment,created_at DESC LIMIT 80'),
    database.query('SELECT a.tenant_id,t.slug,a.environment,a.pool_id,a.build_sha,a.generation,a.activated_at FROM tenant_runtime_assignments a JOIN tenants t ON t.id=a.tenant_id ORDER BY a.activated_at DESC LIMIT 120'),
    database.query('SELECT o.id,o.tenant_id,t.slug,o.environment,o.pool_id,o.build_sha,o.update_mode,o.state,o.maintenance_not_before,o.uat_accepted_at,o.created_at FROM tenant_runtime_update_offers o JOIN tenants t ON t.id=o.tenant_id ORDER BY o.created_at DESC LIMIT 100'),
    database.query('SELECT generation,environment,state,mapping_sha256,created_at,activated_at FROM platform_runtime_route_generations ORDER BY generation DESC LIMIT 20'),
  ])
  return {
    routingEnabled:false,
    pools:pools.rows.map(row=>({
      id:row.id,environment:row.environment,buildSha:row.build_sha,
      state:row.state,verified:verifiedRuntimePool(row,now).verified,
      lastSeenAt:row.last_seen_at,verifiedAt:row.verified_at,health:row.health,
    })),
    assignments:assignments.rows.map(row=>({
      tenantId:row.tenant_id,tenantSlug:row.slug,environment:row.environment,
      poolId:row.pool_id,buildSha:row.build_sha,generation:row.generation,
      activatedAt:row.activated_at,
    })),
    offers:offers.rows.map(row=>({
      id:row.id,tenantId:row.tenant_id,tenantSlug:row.slug,environment:row.environment,
      poolId:row.pool_id,buildSha:row.build_sha,mode:row.update_mode,state:row.state,
      maintenanceNotBefore:row.maintenance_not_before,uatAcceptedAt:row.uat_accepted_at,
      createdAt:row.created_at,
    })),
    generations:generations.rows,
  }
}
export async function tenantRuntimePoolState(database,tenantId){
  const [preference,assignments,offers]=await Promise.all([
    database.query('SELECT update_mode FROM tenant_release_preferences WHERE tenant_id=$1',[tenantId]),
    database.query('SELECT a.environment,a.pool_id,a.build_sha,p.state FROM tenant_runtime_assignments a JOIN platform_runtime_pools p ON p.id=a.pool_id AND p.environment=a.environment WHERE a.tenant_id=$1 ORDER BY a.environment',[tenantId]),
    database.query('SELECT o.id,o.environment,o.pool_id,o.build_sha,o.state,o.created_at,o.uat_accepted_at,o.maintenance_not_before,r.version_label,r.title FROM tenant_runtime_update_offers o LEFT JOIN hi5central_published_release_notes r ON r.build_sha=o.build_sha WHERE o.tenant_id=$1 ORDER BY o.created_at DESC LIMIT 20',[tenantId]),
  ])
  return {
    mode:preference.rows[0]?.update_mode||'admin_controlled',
    assignmentStatus:assignments.rows.map(row=>({
      environment:row.environment,poolId:row.pool_id,buildSha:row.build_sha,
      routingState:'host_verification_required',
    })),
    updateOffers:offers.rows.map(row=>({
      id:row.id,environment:row.environment,poolId:row.pool_id,
      buildSha:row.build_sha,state:row.state,versionLabel:row.version_label,
      title:row.title,createdAt:row.created_at,
      uatAcceptedAt:row.uat_accepted_at,maintenanceNotBefore:row.maintenance_not_before,
    })),
    note:'Traffic is not switched until the trusted host verifies and activates a routing generation.',
  }
}
export function buildHostRoutingManifest({environment,rows,now=new Date(),domain='hi5central.com'}){
  if(!['uat','live'].includes(environment))throw Error('Unsupported route environment.')
  const entries=[],seen=new Set()
  for(const row of rows){
    if(row.environment!==environment)throw Error('Route environment mismatch.')
    const host=customerPoolHostname(row.slug,environment,domain)
    if(seen.has(host))throw Error('Duplicate tenant hostname in routing plan.')
    seen.add(host)
    const pool={id:row.pool_id,environment:row.environment,build_sha:row.pool_build_sha,
      state:row.pool_state,api_target:row.api_target,web_target:row.web_target,
      verified_at:row.verified_at,last_seen_at:row.last_seen_at}
    const assigned={pool_id:row.pool_id,environment:row.environment,build_sha:row.build_sha}
    const result=resolvedCustomerPool({assignment:assigned,pool,environment,generationActive:true,now})
    if(result.route!=='pool')throw Error('Unverified route for '+host+': '+result.reason)
    entries.push({host,poolId:row.pool_id,buildSha:row.build_sha,
      apiUpstream:pool.api_target,webUpstream:pool.web_target})
  }
  entries.sort((a,b)=>a.host.localeCompare(b.host))
  const payload={schemaVersion:1,environment,entries}
  return {...payload,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}
}
export async function preparePoolOffer({db,tenantId,environment,poolId,now=new Date()}){
  if(!['uat','live'].includes(environment))throw Error('Invalid release environment.')
  const tenant=await db.query('SELECT t.id,t.slug,p.update_mode,p.live_delay_hours,p.maintenance_window FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id WHERE t.id=$1 AND t.status=$2',[tenantId,'active'])
  if(!tenant.rowCount)throw Error('Active customer or update policy not found.')
  const pool=await db.query('SELECT * FROM platform_runtime_pools WHERE id=$1 AND environment=$2',[poolId,environment])
  if(!pool.rowCount)throw Error('Pool has not been registered in this environment.')
  const release=await db.query('SELECT build_sha FROM hi5central_published_release_notes WHERE build_sha=$1',[pool.rows[0].build_sha])
  if(!release.rowCount)throw Error('Dev has not published this exact application release.')
  let uatAccepted=false,testPassed=false,testPassedAt=null
  const preference=tenant.rows[0]
  if(environment==='live'&&preference.update_mode==='admin_controlled'){
    const approved=await db.query([
      'SELECT state FROM tenant_runtime_update_offers',
      "WHERE tenant_id=$1 AND environment='uat' AND build_sha=$2",
      "AND state IN ('uat_accepted','active') ORDER BY updated_at DESC LIMIT 1",
    ].join(' '),[tenantId,pool.rows[0].build_sha])
    uatAccepted=Boolean(approved.rowCount)
  }else if(environment==='live'&&preference.update_mode==='hi5_managed'){
    const qa=await db.query([
      'SELECT passed_at FROM platform_release_test_qa_gates',
      "WHERE build_sha=$1 AND state='passed' AND passed_canary_count>=2",
    ].join(' '),[pool.rows[0].build_sha])
    testPassed=Boolean(qa.rowCount)
    testPassedAt=qa.rows[0]?.passed_at
  }
  const eligibility=tenantReleaseEligibility({
    preference,pool:pool.rows[0],environment,uatAccepted,testPassed,testPassedAt,
    published:true,now,
  })
  if(['blocked','waiting_for_pool','unreleased','awaiting_uat','awaiting_test'].includes(eligibility.state))
    throw Error(eligibility.reason)
  const created=await db.query("INSERT INTO tenant_runtime_update_offers (tenant_id,environment,pool_id,build_sha,update_mode,state) VALUES($1,$2,$3,$4,$5,'offered') RETURNING id,tenant_id,environment,pool_id,build_sha,state,created_at",
    [tenantId,environment,poolId,pool.rows[0].build_sha,preference.update_mode])
  return {offer:created.rows[0],eligibility}
}
