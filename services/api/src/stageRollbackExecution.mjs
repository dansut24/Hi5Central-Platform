/**
 * Rollbacks run INSIDE the existing stage deployment worker, not a new
 * scheduler or second gateway owner. The identical physical advisory lock
 * serialises recovery with upgrade cutovers across Live and UAT.
 *
 * The request's previous SHA comes only from a successfully verified
 * original stage release. No customer-supplied URL, Docker target or host
 * command is ever accepted here.
 */
import {readFileSync} from 'node:fs'
import {prepareSharedTenantCaddyRoute,releasePair} from './tenantCaddyVersionRoutes.js'
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/
const SOURCE='/opt/hi5central/runtime/caddy/Caddyfile'
const GATEWAY='hi5central-gateway-1'
const LOCK=['hi5central-release-gateway','hi5central-gateway-1:/etc/caddy/Caddyfile']
export function validateStageRollbackLease(job,stage){
 if(!job||!['uat','live'].includes(stage)||job.environment!==stage
   ||!UUID.test(String(job.id||''))||!UUID.test(String(job.tenantId||''))
   ||!UUID.test(String(job.originalJobId||''))||!UUID.test(String(job.leaseToken||''))
   ||!SLUG.test(String(job.tenantSlug||''))
   ||!SHA.test(String(job.fromSha||''))||!SHA.test(String(job.toSha||''))
   ||job.toSha===job.fromSha
   ||!Number.isSafeInteger(Number(job.generation))||Number(job.generation)<1
   ||!Number.isSafeInteger(Number(job.leaseFence))||Number(job.leaseFence)<1)
   throw Error('Stage rollback lease does not match a verified tenant and immutable build pair.')
 return {...job,generation:Number(job.generation),leaseFence:Number(job.leaseFence)}
}
export function assertTenantOnlyGatewayMutation({before,after,host,tenantSlug,stage,buildSha}={}){
 if(typeof before!=='string'||typeof after!=='string'
   ||!before.includes('# H5C_RELEASE_ROUTE_BEGIN '+host))
   throw Error('Original customer route marker missing before rollback.')
 // The trusted host deployer relocates the selected route to its standard
 // insertion point. Undoing only its CONTENTS leaves that block in the new
 // position and falsely reports unrelated gateway drift. Independently
 // reconstruct the exact authorised full Caddyfile instead: any other
 // customer, shared setting, route order or target is rejected.
 const expected=prepareSharedTenantCaddyRoute({
  config:before,tenantSlug,environment:stage,buildSha,
 })
 if(expected.host!==host||after!==expected.config)
   throw Error('Another customer or shared gateway setting changed during rollback.')
 return true
}
function otherHosts(source,targetHost){
 return [...new Set([...source.matchAll(
  /# H5C_RELEASE_ROUTE_BEGIN ([a-z0-9-]+\.hi5central\.com)/g)]
  .map(x=>x[1]).filter(h=>h!==targetHost))]
}
const hostName=(slug,stage)=>slug+(stage==='live'?'':'-'+stage)+'.hi5central.com'
const publicVersion=async(shell,host)=>{
 const api=JSON.parse(await shell('curl',[
  '-fsS','--max-time','9','https://'+host+'/api/v1/updates/version'],{},15000))
 const web=JSON.parse(await shell('curl',[
  '-fsS','--max-time','9','https://'+host+'/release-manifest.json'],{},15000))
 if(!SHA.test(String(api.sha||''))||!SHA.test(String(web.sha||'')))
   throw Error('Public tenant version endpoints returned no exact SHA: '+host)
 return {api:api.sha,web:web.sha}
}
const versionsOf=async(shell,hosts)=>{
 const versions={}
 for(const host of hosts)versions[host]=await publicVersion(shell,host)
 return versions
}
const sameOtherVersions=(before,after)=>{
 for(const [host,expected] of Object.entries(before)){
  if(after[host]?.api!==expected.api||after[host]?.web!==expected.web)
   throw Error('Unrelated customer route changed during recovery: '+host)
 }
}
const observedSource=async shell=>{
 const disk=readFileSync(SOURCE,'utf8')
 const mounted=await shell('docker',['exec',GATEWAY,'cat','/etc/caddy/Caddyfile'],{},15000)
 if(disk!==mounted)throw Error('Physical gateway host/mount Caddy source mismatch.')
 return disk
}
export async function processQueuedStageRollback({pool,stage,shell,heartbeat}){
 if(!['uat','live'].includes(stage))return false
 const session=await pool.connect()
 let hasLock=false
 try{
  const ownership=await session.query(
   'SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS owned',LOCK)
  if(ownership.rows[0]?.owned!==true)return false
  hasLock=true
  const claimed=await session.query(
   'SELECT public.hi5_stage_rollback_claim($1) AS job',[stage])
  if(!claimed.rows[0]?.job)return false
  const job=validateStageRollbackLease(claimed.rows[0].job,stage)
  const hostname=hostName(job.tenantSlug,stage)
  const fenced=async()=>session.query(
   'SELECT public.hi5_stage_rollback_assert($1,$2,$3,$4)',
   [job.id,job.leaseToken,job.leaseFence,stage])
  // Verify cross-stage order in the stage-restricted session before and
  // after host execution. A Production upgrade/rollback is not a version
  // number comparison; only the intended exact restore SHA is accepted.
  const productionBeforeUat=async()=>{
   if(stage!=='uat')return
   const installed=await session.query([
     'SELECT build_sha FROM tenant_runtime_assignments',
     "WHERE tenant_id=$1 AND environment='live' LIMIT 1",
   ].join(' '),[job.tenantId])
   if(installed.rows[0]?.build_sha!==job.toSha)
     throw Error('Rollback Production to the UAT target build before restoring UAT.')
  }
  const hostEnv={
   H5C_RELEASE_LEASE_AUTH:'worker-gateway-fenced',
   H5C_RELEASE_JOB_ID:job.id,
   H5C_RELEASE_LEASE_TOKEN:job.leaseToken,
   H5C_RELEASE_LEASE_FENCE:String(job.leaseFence),
   H5C_STAGE_ROLLBACK_WORKER:'true',
   H5C_ROLLBACK_REQUEST_ID:job.id,
  }
  let before='',activated=null,baselines=null,sourceVerified=false,restored=false
  try{
   await heartbeat('busy')
   await fenced()
   await productionBeforeUat()
   before=await observedSource(shell)
   const hosts=otherHosts(before,hostname)
   if(hosts.length>500)throw Error('Too many routes to independently verify.')
   baselines=await versionsOf(shell,hosts)
   const current=await publicVersion(shell,hostname)
   if(current.api!==job.fromSha||current.web!==job.fromSha)
     throw Error('Original customer stage changed before rollback.')
   await fenced()
   const output=await shell('node',[
    'deployment/release/host-deploy.mjs',stage,job.tenantSlug,job.toSha,'--apply',
   ],hostEnv,330000)
   activated=JSON.parse(output.trim().split('\n').at(-1))
   if(activated.status!=='verified'||activated.environment!==stage
      ||activated.host!==hostname||activated.buildSha!==job.toSha
      ||activated.previousSha!==job.fromSha||!activated.backup)
     throw Error('Host did not return a matching verified rollback and recovery snapshot.')
   await fenced()
   const after=await observedSource(shell)
   assertTenantOnlyGatewayMutation({before,after,host:hostname,
    tenantSlug:job.tenantSlug,stage,buildSha:job.toSha})
   sourceVerified=true
   const currentAfter=await publicVersion(shell,hostname)
   if(currentAfter.api!==job.toSha||currentAfter.web!==job.toSha)
     throw Error('Public API/frontend version mismatch after recovery.')
   sameOtherVersions(baselines,await versionsOf(shell,hosts))
   await fenced()
   await productionBeforeUat()
   const pair=releasePair(job.toSha,stage),poolId='h5pool-'+stage+'-'+job.toSha.slice(0,12)
   const proof={
    hostname,verifiedStage:stage,sourceSha:job.fromSha,targetSha:job.toSha,
    routeGeneration:job.generation,publicApiSha:currentAfter.api,
    publicWebSha:currentAfter.web,otherCustomersUnchanged:true,
    gatewaySourceAndMountMatch:true,priorImagesHealthy:true,
    originalReleaseJobId:job.originalJobId,worker:'existing-stage-executor',
    backup:activated.backup,
   }
   await session.query('BEGIN')
   try{
    // Existing stage worker can publish its own already-host-verified
    // immutable pool, just as persistVerified does for forward releases.
    await session.query([
     'INSERT INTO platform_runtime_pools',
     '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at,health)',
     "VALUES($1,$2,$3,$4,$5,'verified',now(),now(),$6::jsonb)",
     'ON CONFLICT(id) DO UPDATE SET state=excluded.state,',
     'verified_at=now(),last_seen_at=now(),updated_at=now(),health=excluded.health',
    ].join(' '),[poolId,stage,job.toSha,pair.api+':3001',pair.web+':80',
      JSON.stringify({status:'healthy',source:'host-verified-rollback'})])
    await session.query(
     'SELECT public.hi5_stage_rollback_complete($1,$2,$3,$4,$5::jsonb)',
     [job.id,job.leaseToken,job.leaseFence,stage,JSON.stringify(proof)])
    await session.query('COMMIT')
   }catch(error){await session.query('ROLLBACK').catch(()=>{});throw error}
   await heartbeat('idle')
   console.log('STAGE_ROLLBACK_VERIFIED',JSON.stringify({
    id:job.id,stage,slug:job.tenantSlug,target:job.toSha,
    otherTenantRoutesPreserved:true}))
  }catch(error){
   let originalRestored=!activated
   // Host executor compensates its own failed cutovers. If it returned a
   // verified cutover but our durable completion failed, compensate under
   // the SAME physical gateway lock and the STILL-VALID claim.
   if(activated?.status==='verified'&&activated.backup){
    try{
     await fenced()
     const response=await shell('node',[
      'deployment/release/host-deploy.mjs',stage,job.tenantSlug,job.toSha,
      '--restore',activated.backup,
     ],hostEnv,90000)
     const proof=JSON.parse(response.trim().split('\n').at(-1))
     if(proof.status==='rolled_back'&&proof.environment===stage
       &&proof.previousSha===job.fromSha){
      const current=await publicVersion(shell,hostname)
      originalRestored=current.api===job.fromSha&&current.web===job.fromSha
      if(before){
       const after=await observedSource(shell)
       originalRestored=originalRestored&&after===before
      }
      if(baselines)sameOtherVersions(baselines,
        await versionsOf(shell,Object.keys(baselines)))
     }
    }catch(recoveryError){
     originalRestored=false
     console.error('STAGE_ROLLBACK_RESTORE_UNVERIFIED',
      String(recoveryError.message||recoveryError).slice(0,350))
    }
   }
   // If a host process crashed after its gateway write, never infer that
   // the initial false return means Production was restored.
   if(!activated&&before){
    try{
     const actual=await observedSource(shell)
     const sourceBefore=await publicVersion(shell,hostname)
     originalRestored=actual===before
       &&sourceBefore.api===job.fromSha&&sourceBefore.web===job.fromSha
    }catch{originalRestored=false}
   }
   await session.query(
    'SELECT public.hi5_stage_rollback_fail($1,$2,$3,$4,$5,$6)',
    [job.id,job.leaseToken,job.leaseFence,stage,
     String(error.message||error).slice(0,500),originalRestored]).catch(e=>{
       console.error('STAGE_ROLLBACK_AUDIT_FAILED',e.message)
     })
   if(!originalRestored){
    await session.query('SELECT public.hi5_release_emergency_pause($1,$2)',[
     'stage-rollback-'+stage,'Unverified gateway restore: staff intervention required',
    ]).catch(()=>{})
   }
   await heartbeat('error',null,error.message).catch(()=>{})
   console.error('STAGE_ROLLBACK_FAILED',JSON.stringify({
    id:job.id,stage,slug:job.tenantSlug,restored:originalRestored,
    sourceVerified,error:String(error.message||error).slice(0,350)}))
  }
  return true
 }finally{
  if(hasLock){
   try{await session.query(
    'SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',LOCK)}catch{}
  }
  session.release()
 }
}
