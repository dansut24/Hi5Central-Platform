import {createHash} from 'node:crypto'
import {buildHostRoutingManifest} from './runtimePoolControl.js'
import {customerPoolHostname,verifiedRuntimePool} from './runtimePoolPolicy.js'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA=/^[a-f0-9]{40}$/
const SHA256=/^[a-f0-9]{64}$/
const modes=new Set(['hi5_managed','admin_controlled'])
const environments=new Set(['test','uat','live'])
const refused=message=>Object.assign(new Error(message),{code:'ROUTE_PREVIEW_BLOCKED'})

/**
 * Make a _single-tenant_ candidate against the full currently active
 * environment manifest. No Docker, proxy, database or filesystem writes.
 *
 * IMPORTANT: SHA-256 here is an integrity digest / optimistic CAS token, not
 * an operator signature. Only the authorised host can assert a fresh observed
 * gateway generation and then commit the corresponding DB records.
 */
export function buildTenantRouteCutover({
  environment,tenantId,slug,mode,itsmEntitled,job,candidate,
  activeRows=[],domain='hi5central.com',now=new Date(),
}={}){
  const time=new Date(now),deny=message=>{throw refused(message)}
  if(!Number.isFinite(time.getTime())||!environments.has(environment))
    deny('Invalid route environment or clock.')
  if(!UUID.test(String(tenantId||''))||!UUID.test(String(job?.id||''))
    ||!UUID.test(String(job?.lease_token||''))||!Number.isSafeInteger(Number(job?.lease_fence))
    ||Number(job.lease_fence)<1)
    deny('A trusted, leased rollout job with a fencing token is required.')
  if(!SHA.test(String(job.build_sha||''))||job.status!=='running'
    ||job.tenant_id!==tenantId||job.environment!==environment
    ||new Date(job.scheduled_at)>time
    ||!Number.isFinite(new Date(job.scheduled_at).getTime())
    ||!Number.isFinite(new Date(job.lease_expires_at).getTime())
    ||new Date(job.lease_expires_at)<=time)
    deny('Rollout job does not match this tenant/environment or its valid lease.')
  if(!modes.has(mode)||itsmEntitled!==true
    ||(environment==='uat'&&mode!=='admin_controlled'))
    deny('Tenant is not entitled to this ITSM environment.')
  const host=customerPoolHostname(slug,environment,domain)
  if(candidate?.tenant_id!==tenantId||candidate?.slug!==slug
    ||candidate?.environment!==environment||candidate?.itsm_entitled!==true
    ||candidate?.update_mode!==mode||candidate?.pool_build_sha!==job.build_sha
    ||candidate?.build_sha!==job.build_sha
    ||candidate?.pool_id!==candidate?.pool_id_verified)
    deny('Candidate pool, immutable build and tenant identity must match the job.')
  if(!/^hi5pool-[a-z0-9-]+-api:3001$/.test(String(candidate.api_target||''))
    ||!/^hi5pool-[a-z0-9-]+-web:80$/.test(String(candidate.web_target||'')))
    deny('Only verified internal API and frontend pool targets are permitted.')
  const pool={
    id:candidate.pool_id,environment,build_sha:candidate.pool_build_sha,
    state:candidate.pool_state,api_target:candidate.api_target,
    web_target:candidate.web_target,last_seen_at:candidate.last_seen_at,
    verified_at:candidate.verified_at,
  }
  const health=verifiedRuntimePool(pool,time)
  if(!health.verified)deny('Candidate host attestation is missing or stale: '+health.reason)
  if(!Array.isArray(activeRows)||activeRows.length>2000)
    deny('Active route snapshot is invalid or too large.')
  const matching=activeRows.filter(row=>row.tenant_id===tenantId)
  if(matching.length>1 || activeRows.some(row=>row.environment!==environment
    ||!UUID.test(String(row.tenant_id||''))))
    deny('Current route assignments contain duplicate or invalid tenant identities.')
  if(new Set(activeRows.map(row=>row.tenant_id)).size!==activeRows.length)
    deny('Current route assignments contain duplicate tenants.')
  if(matching.length&&matching[0].slug!==slug)
    deny('Tenant slug changed during route planning.')
  const before=buildHostRoutingManifest({environment,rows:activeRows,now:time,domain})
  const after=buildHostRoutingManifest({environment,
    rows:[...activeRows.filter(row=>row.tenant_id!==tenantId),candidate],
    now:time,domain})
  const previous=before.entries.find(row=>row.host===host)||null
  const next=after.entries.find(row=>row.host===host)
  if(!next||next.buildSha!==job.build_sha||next.poolId!==candidate.pool_id)
    deny('Candidate release was not preserved by the verified manifest.')
  const oldUnrelated=before.entries.filter(row=>row.host!==host)
  const newUnrelated=after.entries.filter(row=>row.host!==host)
  if(JSON.stringify(oldUnrelated)!==JSON.stringify(newUnrelated))
    deny('Another tenant would change during this cutover.')
  const proposal={
    schemaVersion:1,tenantId,hostname:host,environment,
    jobId:job.id,leaseFence:Number(job.lease_fence),buildSha:job.build_sha,
    previousRoute:previous,targetRoute:next,
    previousManifestSha256:before.sha256,
    targetManifestSha256:after.sha256,
    activeTenantCount:before.entries.length,
    targetTenantCount:after.entries.length,
    unchangedOtherTenants:oldUnrelated.length,
    noOp:before.sha256===after.sha256,
  }
  const planSha256=createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  return {...proposal,planSha256,
    // The host preview needs both exact snapshots to validate/rehearse switch
    // and restore the original generation. These are not customer-facing data.
    stage:after,rollback:before,
    activationAllowed:false,
    requirement:'Gateway must verify the before hash, active lease, time window, host readiness and signed operator identity before switching.'}
}

/** Prevent concurrent tenant deployments from overwriting a newer generation. */
export function routeCutoverPrecondition({plan,activeManifestSha256,leaseFence}={}){
  if(!SHA256.test(String(plan?.planSha256||''))
    ||!SHA256.test(String(plan?.previousManifestSha256||''))
    ||!SHA256.test(String(plan?.targetManifestSha256||''))
    ||!SHA256.test(String(activeManifestSha256||''))
    ||!Number.isSafeInteger(leaseFence)||leaseFence<1)
    return {allowed:false,reason:'Invalid route generation or worker lease.'}
  if(plan.leaseFence!==leaseFence)return {allowed:false,reason:'Stale rollout lease fence.'}
  if(plan.previousManifestSha256!==activeManifestSha256)
    return {allowed:false,reason:'Gateway routing changed; recompute the tenant-specific plan.'}
  return {allowed:true,reason:'Exact expected gateway generation matches.'}
}
