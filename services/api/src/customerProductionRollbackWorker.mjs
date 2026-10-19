#!/usr/bin/env node
/**
 * Customer-authorised, dedicated Production rollback host executor.
 * Default OFF, one restrictive DB identity, one fenced gateway session.
 * The browser can request a rollback but CANNOT run this process or choose
 * upstreams. It consumes only DB-validated, signed Custom tenant requests.
 *
 * --preflight: read-only role/config check; --once: ONE poll when explicitly
 * enabled; no flag: poll while enabled. Never autostart from a Dev build.
 */
import pg from 'pg'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {planCustomerRouteRollback} from '../../../deployment/release/customer-route-rollback-plan.mjs'

const SHA=/^[0-9a-f]{40}$/
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HOST=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]\.hi5central\.com$/
const BACKUP=/^release-live-[0-9]{10,18}-[a-z0-9-]+$/
const SRC='/opt/hi5central/runtime/caddy/Caddyfile'
const GATEWAY='hi5central-gateway-1'
const VOLUME='hi5central_release_backups'
const IS_MAIN=Boolean(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)
const MODE=process.argv[2]||'--loop'
if(IS_MAIN&&(!['--preflight','--once','--loop'].includes(MODE)||process.argv.length>3))
  throw Error('Usage: customerProductionRollbackWorker.mjs [--preflight|--once|--loop]')
const REVISION=process.env.ROLLBACK_WORKER_REVISION_SHA
if(IS_MAIN&&!SHA.test(String(REVISION||'')))
  throw Error('Pin the reviewed immutable rollback worker SHA.')
const active=process.env.ROLLBACK_WORKER_ACTIVE==='true'
if(IS_MAIN&&MODE!=='--preflight'&&!active)
  throw Error('Rollback worker is disabled; explicit reviewed activation is required.')
if(IS_MAIN&&!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
  throw Error('Dedicated rollback worker PostgreSQL identity is required.')
const digest=value=>createHash('sha256').update(value).digest('hex')
const exec=(program,args=[],stdin=null,timeout=16000)=>{
 const result=spawnSync(program,args,{
  encoding:'utf8',input:stdin??undefined,timeout,maxBuffer:2_500_000,
  env:{...process.env},
 })
 if(result.error||result.status!==0)
   throw Error('Host check failed ('+program+'): '+String(result.stderr||result.error?.message||'').slice(-400))
 return result.stdout
}
const docker=(...args)=>exec('docker',args)
const version=(host,path)=>JSON.parse(exec('curl',[
 '-fsS','--max-time','9','https://'+host+path,
 ]))
const apiSha=h=>version(h,'/api/v1/updates/version').sha
const webSha=h=>version(h,'/release-manifest.json').sha
const originalPair=h=>({api:apiSha(h),web:webSha(h)})
const pause=ms=>new Promise(done=>setTimeout(done,ms))
let stopping=false
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true})
export function validatedRollbackClaim(c,revision){
 if(!c||!UUID.test(String(c.requestId||''))||!UUID.test(String(c.tenantId||''))
  ||!UUID.test(String(c.originalJobId||''))||!UUID.test(String(c.leaseToken||''))
  ||!HOST.test(String(c.host||''))||c.host!==c.slug+'.hi5central.com'
  ||!SHA.test(String(c.sourceSha||''))||!SHA.test(String(c.targetSha||''))
  ||c.sourceSha===c.targetSha||c.workerRevision!==revision
  ||!Number.isSafeInteger(Number(c.generation))||Number(c.generation)<1
  ||!Number.isSafeInteger(Number(c.leaseFence))||Number(c.leaseFence)<1
  ||!BACKUP.test(String(c.snapshot||''))
  ||!c.snapshot.endsWith('-'+c.host.replaceAll('.','-'))
  ||c.poolId!=='h5pool-live-'+c.sourceSha?.slice(0,12))
  throw Error('Untrusted rollback claim lacks exact signed tenant, lease, route or snapshot scope.')
 return {
  ...c,generation:Number(c.generation),leaseFence:Number(c.leaseFence),
 }
}
export function assertOtherTenantVersions(before,after,customerHost){
 for(const [host,previous] of Object.entries(before)){
  if(host===customerHost)continue
  const current=after[host]
  if(!current||previous.api!==current.api||previous.web!==current.web)
   throw Error('Another tenant changed during customer-only Production rollback: '+host)
 }
 return true
}
const BACKUP_PREFIX='h5c-customer-rollback-'
function backupRead(name){
 if(!BACKUP.test(name))throw Error('Previous backup name is not from a certified Live deployment.')
 return docker('run','--rm','--network','none',
  '--mount','type=volume,source='+VOLUME+',target=/backup,readonly',
  'busybox:1.36','cat','/backup/'+name+'.caddy')
}
function volumeWrite(name,text){
 if(!/^h5c-customer-rollback-[a-f0-9]{32}\.(?:before|after|done)$/.test(name))
  throw Error('Invalid backup journal key.')
 exec('docker',['run','--rm','-i','--network','none',
  '--mount','type=volume,source='+VOLUME+',target=/backup',
  'busybox:1.36','sh','-c','set -e; umask 077; test ! -e "/backup/$1"; cat > "/backup/$1"','--',name],text)
}
function writeLiveCaddy(content){
 exec('docker',['run','--rm','-i','--network','none',
  '--mount','type=bind,source='+SRC+',target=/gateway/Caddyfile',
  'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],content)
}
function gatewayReload(){
 docker('exec',GATEWAY,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile')
}
function validateCandidate(source){
 exec('docker',['run','--rm','-i','--network','none',
  '--entrypoint','sh','hi5central/caddy-ionos:2.10.2',
  '-c','cat >/tmp/rollback.Caddyfile && caddy adapt --config /tmp/rollback.Caddyfile --adapter caddyfile >/dev/null'],source)
}
function activeGatewayHostSet(){
 const data=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-','http://127.0.0.1:2019/config/'))
 const hosts=new Set()
 const scan=v=>{
  if(Array.isArray(v)){for(const x of v)scan(x);return}
  if(v&&typeof v==='object'){
   if(Array.isArray(v.host))for(const h of v.host)hosts.add(h)
   for(const x of Object.values(v))scan(x)
  }
 }
 scan(data.apps?.http?.servers||{})
 return hosts
}
function assertNoGatewayRuntimeDrift(source,host){
 const activeHosts=activeGatewayHostSet()
 const recorded=new Set([...source.matchAll(/# H5C_RELEASE_ROUTE_BEGIN ([a-z0-9-]+\.hi5central\.com)/g)]
  .map(m=>m[1]))
 const reserved=new Set(['api','admin','dev','dev-api','test','uat','rmm','www']
  .map(x=>x+'.hi5central.com'))
 if(!activeHosts.has(host))throw Error('Customer Production target is not active in gateway runtime.')
 for(const h of activeHosts){
  if(typeof h!=='string'||!h.endsWith('.hi5central.com')||h.includes('*')
    ||reserved.has(h))continue
  if(!recorded.has(h))throw Error('Active route is absent from source, refusing shared gateway reload: '+h)
 }
}
function checkContainer(name,sha){
 const record=JSON.parse(docker('inspect',name))[0]
 if(record?.State?.Health?.Status!=='healthy'
  ||!record.Config.Image.endsWith(':sha-'+sha))
  throw Error('Previous application container unhealthy or image revision differs: '+name)
}
function recordLocalBaseline(customerHost,source){
 // Independently verify every versioned route in the ACTUAL gateway snapshot,
 // rather than relying on a small static QA tenant allowlist.
 const hosts=new Set([customerHost,customerHost.replace('.hi5central.com','-uat.hi5central.com')])
 for(const match of source.matchAll(/# H5C_RELEASE_ROUTE_BEGIN ([a-z0-9-]+\.hi5central\.com)/g))
   hosts.add(match[1])
 return Object.fromEntries([...hosts].map(h=>[h,originalPair(h)]))
}
function ensureOldBuildHealthy(claim,mode){
 if(mode==='legacy_shared_fallback'){
  checkContainer('hi5central-api-1',claim.targetSha)
  checkContainer('hi5central-itsm-1',claim.targetSha)
  const api=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-',
   'http://api:3001/api/v1/updates/version'))
  const web=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-',
   'http://itsm:80/release-manifest.json'))
  if(api.sha!==claim.targetSha||web.sha!==claim.targetSha)
   throw Error('Legacy shared API/frontend are not the certified previous release.')
 }else{
  checkContainer('hi5pool-live-'+claim.targetSha.slice(0,12)+'-api',claim.targetSha)
  checkContainer('hi5pool-live-'+claim.targetSha.slice(0,12)+'-web',claim.targetSha)
 }
}
function snapshotCurrentSource(){
 const current=readFileSync(SRC,'utf8')
 const mounted=docker('exec',GATEWAY,'cat','/etc/caddy/Caddyfile')
 if(digest(current)!==digest(mounted))
  throw Error('Gateway Caddy host/source mismatch before cutover.')
 return current
}
async function ensureServing(host,sha){
 for(let i=0;i<15;i++){
  try{if(apiSha(host)===sha&&webSha(host)===sha)return true}
  catch{}
  await pause(850)
 }
 throw Error('Customer Production API and frontend did not serve the restored exact build.')
}
function startWatchdog(name,requestId,candidateHash){
 const label='h5c-'+name
 // A crash after database COMMIT but before the done marker must NOT restore
 // a successful customer rollback. Read the durable request state, then only
 // compensate an UNVERIFIED running operation and ONLY if gateway source
 // still equals this rollback's candidate checksum. If PostgreSQL is
 // unreachable, leave route/hold untouched and require human reconciliation.
 const query="SELECT state FROM public.tenant_release_customer_rollback_requests WHERE id='"+requestId+"'"
 const pg='docker exec hi5central-db-1 sh -c '+
  "'exec psql -X -At -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -c \"$1\"'"+
  ' -- "'+query+'"'
 const watch='sleep 210; if [ ! -e /backup/'+name+'.done ]; then '+
  'state=$('+pg+' 2>/dev/null) || state=unknown; '+
  'if [ "$state" = "running" ]; then '+
  'h=$(sha256sum /gateway/Caddyfile | cut -c1-64); '+
  'if [ "$h" = "'+candidateHash+'" ]; then '+
  'cat /backup/'+name+'.before >/gateway/Caddyfile; '+
  'docker exec '+GATEWAY+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; '+
  'fi; fi; fi'
 const id=docker('run','-d','--rm','--name',label,'--network','none',
  '--mount','type=volume,source='+VOLUME+',target=/backup',
  '--mount','type=bind,source='+SRC+',target=/gateway/Caddyfile',
  '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  'docker:27-cli','sh','-c',watch).trim()
 if(!id)throw Error('Could not arm the compare-and-swap recovery watchdog.')
 return label
}
function finishWatchdog(label,name){
 volumeWrite(name+'.done','completed\n')
 try{docker('rm','-f',label)}catch{} // marker persists; delayed rescue cannot overwrite success
}
async function processClaim(client,claim){
 const name=BACKUP_PREFIX+claim.requestId.replaceAll('-','')
 let rollbackPlan=null,original=null,watchdog=null,mutated=false,committed=false
 let baseline=null
 const fenced=async()=>client.query(
  'SELECT public.hi5_customer_rollback_assert_fence($1,$2,$3,$4)',
  [claim.requestId,claim.leaseToken,claim.leaseFence,REVISION])
 try{
  await fenced()
  original=snapshotCurrentSource()
  assertNoGatewayRuntimeDrift(original,claim.host)
  const preserved=backupRead(claim.snapshot)
  rollbackPlan=planCustomerRouteRollback({
   hostname:claim.host,fromBuildSha:claim.sourceSha,toBuildSha:claim.targetSha,
   currentSource:original,previousSource:preserved,
   expectedCurrentGatewayHash:digest(original),
   expectedPreviousGatewayHash:digest(preserved),
  })
  validateCandidate(rollbackPlan.restoredSource)
  ensureOldBuildHealthy(claim,rollbackPlan.mode)
  baseline=recordLocalBaseline(claim.host,original)
  if(baseline[claim.host].api!==claim.sourceSha||baseline[claim.host].web!==claim.sourceSha)
   throw Error('Public customer Production source version changed before rollback.')
  await fenced()
  // Preserve the exact source and candidate so a process crash can recover.
  volumeWrite(name+'.before',original)
  volumeWrite(name+'.after',rollbackPlan.restoredSource)
  watchdog=startWatchdog(name,claim.requestId,rollbackPlan.restoredSourceSha256)
  if(digest(snapshotCurrentSource())!==rollbackPlan.currentSourceSha256)
   throw Error('Concurrent gateway update detected before guarded write.')
  await fenced()
  writeLiveCaddy(rollbackPlan.restoredSource)
  mutated=true
  gatewayReload()
  await ensureServing(claim.host,claim.targetSha)
  const after=recordLocalBaseline(claim.host,original)
  assertOtherTenantVersions(baseline,after,claim.host)
  if(digest(snapshotCurrentSource())!==rollbackPlan.restoredSourceSha256)
   throw Error('Shared gateway changed during host verification.')
  await fenced()
  const proof={
   hostname:claim.host,publicApiSha:after[claim.host].api,
   publicWebSha:after[claim.host].web,
   recoveredFromBackup:true,otherCustomersUnchanged:true,uatUnchanged:true,
   gatewaySourceAndMountMatch:true,priorImagesHealthy:true,
   workerRevision:REVISION,sourceRouteGeneration:claim.generation,
   restorationMode:rollbackPlan.mode,
   previousSnapshotSha256:rollbackPlan.previousSnapshotSha256,
   restoredRouteSha256:rollbackPlan.restoredSourceSha256,
   tenantId:claim.tenantId,originalReleaseJobId:claim.originalJobId,
  }
  await client.query('BEGIN')
  try{
   await client.query(
    'SELECT public.hi5_customer_rollback_complete($1,$2,$3,$4,$5::jsonb)',
    [claim.requestId,claim.leaseToken,claim.leaseFence,REVISION,JSON.stringify(proof)])
   await client.query('COMMIT')
   committed=true
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
  finishWatchdog(watchdog,name)
  console.log('CUSTOMER_ROLLBACK_VERIFIED',JSON.stringify({
   requestId:claim.requestId,slug:claim.slug,source:claim.sourceSha,
   target:claim.targetSha,upgradeHoldRetained:true,
  }))
 }catch(error){
  console.error('CUSTOMER_ROLLBACK_FAILED',String(error.message).slice(0,500))
  if(committed)throw error // database completion is immutable; never reverse verified result
  let restored=!mutated
  if(mutated&&rollbackPlan&&original){
   try{
    if(digest(readFileSync(SRC,'utf8'))===rollbackPlan.restoredSourceSha256){
     writeLiveCaddy(original);gatewayReload()
     await ensureServing(claim.host,claim.sourceSha)
     assertOtherTenantVersions(baseline,recordLocalBaseline(claim.host,original),claim.host)
     restored=true
    }
   }catch(recoveryError){
    console.error('CRITICAL_ROLLBACK_RESCUE_RETAINED',String(recoveryError.message).slice(0,400))
   }
  }
  // Only disarm the watchdog when the original customer Production is proven
  // back in place. An unverified gateway cutover is held for staff response.
  if(watchdog&&restored)finishWatchdog(watchdog,name)
  await client.query('SELECT public.hi5_customer_rollback_fail($1,$2,$3,$4,$5,$6)',
   [claim.requestId,claim.leaseToken,claim.leaseFence,REVISION,
    String(error.message||error).slice(0,500),restored])
  if(!restored)throw Error('URGENT: Production gateway recovery not verified; tenant upgrade hold remains active.')
 }
}
async function executeOnce(){
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,
   connectionTimeoutMillis:5500,statement_timeout:30000})
 await client.connect()
 let held=false
 try{
  const {rows}=await client.query('SELECT session_user, current_user')
  if(rows[0]?.session_user!=='hi5_release_rollback_executor'
    ||rows[0]?.current_user!=='hi5_release_rollback_executor')
   throw Error('Dedicated restricted PostgreSQL identity is mandatory; no fallback.')
  const lock=await client.query(
   "SELECT pg_try_advisory_lock(hashtext('hi5central-release-gateway'),hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile')) AS acquired")
  if(lock.rows[0]?.acquired!==true){
   if(MODE==='--preflight')throw Error('Gateway currently owned by another deployment.')
   return false
  }
  held=true
  if(MODE==='--preflight'){
   const valid=await client.query('SELECT public.hi5_customer_rollback_worker_session_ok() AS valid')
   if(valid.rows[0]?.valid!==true)
     throw Error('Gateway session lock cannot be verified under dedicated worker role.')
   console.log('CUSTOMER_ROLLBACK_RESTRICTED_WORKER_PREFLIGHT_PASS_NO_WRITES')
   return false
  }
  await client.query('SELECT public.hi5_customer_rollback_worker_heartbeat($1,$2,$3)',
   [REVISION,'idle',''])
  await client.query('BEGIN')
  let raw
  try{
   const rows=await client.query('SELECT public.hi5_customer_rollback_claim($1) AS claim',[REVISION])
   raw=rows.rows[0]?.claim||null
   await client.query('COMMIT')
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
  if(!raw)return false
  const claim=validatedRollbackClaim(raw,REVISION)
  await client.query('SELECT public.hi5_customer_rollback_worker_heartbeat($1,$2,$3)',
   [REVISION,'busy',''])
  await processClaim(client,claim)
  await client.query('SELECT public.hi5_customer_rollback_worker_heartbeat($1,$2,$3)',
   [REVISION,'idle',''])
  return true
 }finally{
  if(held)await client.query(
   "SELECT pg_advisory_unlock(hashtext('hi5central-release-gateway'),hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile'))").catch(()=>{})
  await client.end().catch(()=>{})
 }
}
if(IS_MAIN){
 try{
  // Operationally isolated: --loop should be run under a dedicated systemd
  // unit with restart policy; no release queue worker shares this process.
  if(MODE==='--loop'){
   while(!stopping){
    await executeOnce()
    if(!stopping)await pause(25000)
   }
  }else await executeOnce()
 }catch(error){
  console.error('CUSTOMER_ROLLBACK_WORKER_HALTED',String(error.message||error).slice(0,500))
  process.exitCode=1
 }
}
