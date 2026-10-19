#!/usr/bin/env node
/**
 * SINGLE reviewed and explicitly customer-authorised Production rollback
 * acceptance drill. NOT a general customer self-service execution endpoint.
 * Exact tenant/build/job/generation/host snapshot pinned; no CLI overrides.
 *
 * No customer request is forged, and no compatibility approval is fabricated.
 * Later self-service rollback remains OFF until a separate restricted executor
 * and authenticated customer request are certified.
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {planCustomerRouteRollback} from './customer-route-rollback-plan.mjs'
const require=createRequire(new URL('../../services/api/package.json',import.meta.url))
const pg=require('pg')
const MODE=process.argv[2]
if(!['--preflight','--apply'].includes(MODE)||process.argv.length!==3)
  throw Error('Only --preflight and --apply are supported.')
const APPLY=MODE==='--apply'
const EXPECT={
 slug:'companycustom',
 host:'companycustom.hi5central.com',
 job:'1e53479b-7c36-44d7-8bda-656955db7027',
 old:'a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c',
 current:'79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e',
 generation:1792412068014,
 backup:'release-live-1792412065513-companycustom-hi5central-com',
 currentCaddy:'f6da381780c251f3b89ba8ee74fc502b51b486ca82303a69db42e0433416938f',
 previousCaddy:'067b20b8d63e81eeccba050eb697175bd1a97c63df25cf79ef53f60efce9daa9',
}
const CADDY='/opt/hi5central/runtime/caddy/Caddyfile'
const BACKUP_VOLUME='hi5central_release_backups'
const GATEWAY='hi5central-gateway-1'
const KEY='operator-custom-production-rollback-20261019'
const hash=s=>createHash('sha256').update(s).digest('hex')
const run=(cmd,args=[],input,timeout=24000)=>execFileSync(cmd,args,{
 encoding:'utf8',input,timeout,maxBuffer:3000000,
})
const docker=(...args)=>run('docker',args)
const expect=(condition,reason)=>{if(!condition)throw Error('CUSTOM_ROLLBACK_SAFETY_DENIED: '+reason)}
const execCaddyReload=()=>docker('exec',GATEWAY,'caddy','reload','--config',
 '/etc/caddy/Caddyfile','--adapter','caddyfile')
const publicJson=hostPath=>JSON.parse(run('curl',['-fsS','--max-time','9','https://'+hostPath]))
const version=h=>publicJson(h+'/api/v1/updates/version').sha
const frontend=h=>publicJson(h+'/release-manifest.json').sha
const writeGateway=contents=>run('docker',[
 'run','--rm','-i','--network','none','--mount',
 'type=bind,source='+CADDY+',target=/gateway/Caddyfile',
 'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],contents)
const saveBackup=(name,contents)=>run('docker',[
 'run','--rm','-i','--network','none','--mount',
 'type=volume,source='+BACKUP_VOLUME+',target=/backup',
 'busybox:1.36','sh','-c','umask 077; cat >/backup/'+name],contents)
const backupContent=filename=>docker('run','--rm','--network','none',
 '--mount','type=volume,source='+BACKUP_VOLUME+',target=/backup,readonly',
 'busybox:1.36','cat','/backup/'+filename)
const auditedCustomerVersions=()=>Object.fromEntries([
 'companycustom.hi5central.com','companycustom-uat.hi5central.com',
 'company.hi5central.com','companymanaged.hi5central.com',
].map(host=>[host,{api:version(host),web:frontend(host)}]))
const [api,dbContainer]=JSON.parse(docker('inspect',
 'hi5central-api-control-1','hi5central-db-1'))
const url=new URL(api.Config.Env.find(e=>e.startsWith('DATABASE_URL='))
 .slice('DATABASE_URL='.length))
url.hostname=Object.values(dbContainer.NetworkSettings.Networks)[0].IPAddress
const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5500})
let held=false,tx=false,routeApplied=false,watchdog=false,committed=false
let plan=null,before=null
const cancelWatch=()=>{
 if(watchdog){
  try{saveBackup(KEY+'.done','finished\n')}catch(e){console.error('WATCHDOG_DISARM_FAILED',e.message)}
  try{docker('stop','-t','1','h5c-'+KEY)}catch(e){console.error('WATCHDOG_STOP_FAILED',e.message)}
 }
}
async function gate(){
 const ctl=await client.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
 expect(ctl.rows[0]?.paused===false,'Global rollout mode changed.')
 const busy=await client.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status='running'")
 expect(busy.rows[0].n===0,'A customer deployment is currently running.')
 const tenant=await client.query([
  'SELECT t.id,t.slug,t.status,p.update_mode FROM tenants t',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  "WHERE t.slug='companycustom' FOR UPDATE OF t",
 ].join(' '))
 expect(tenant.rowCount===1&&tenant.rows[0].status==='active'
  &&tenant.rows[0].update_mode==='admin_controlled','Expected active Custom tenant only.')
 const tid=tenant.rows[0].id
 const assignment=await client.query([
  'SELECT environment,build_sha,pool_id,generation FROM tenant_runtime_assignments',
  "WHERE tenant_id=$1 AND environment='live' FOR UPDATE",
 ].join(' '),[tid])
 expect(assignment.rowCount===1&&assignment.rows[0].build_sha===EXPECT.current
  &&Number(assignment.rows[0].generation)===EXPECT.generation
  &&assignment.rows[0].pool_id==='h5pool-live-79d95f3ffa2a',
  'Actual Live routing baseline/generation changed.')
 const route=await client.query([
  'SELECT build_sha,pool_id,public_host,state,checked_at FROM tenant_runtime_route_attestations',
  "WHERE tenant_id=$1 AND environment='live' FOR UPDATE",
 ].join(' '),[tid])
 expect(route.rowCount===1&&route.rows[0].build_sha===EXPECT.current
  &&route.rows[0].pool_id===assignment.rows[0].pool_id
  &&route.rows[0].public_host===EXPECT.host&&route.rows[0].state==='active'
  &&Date.now()-new Date(route.rows[0].checked_at).getTime()<900000,
  'Fresh independent Production route attestation is required.')
 const job=await client.query([
  'SELECT status,environment,build_sha,previous_build_sha,attempt_count',
  'FROM tenant_release_rollout_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
 ].join(' '),[EXPECT.job,tid])
 expect(job.rowCount===1&&job.rows[0].status==='succeeded'
  &&job.rows[0].environment==='live'
  &&job.rows[0].build_sha===EXPECT.current
  &&job.rows[0].previous_build_sha===EXPECT.old
  &&job.rows[0].attempt_count===1,'Production rollout evidence changed.')
 const offers=await client.query([
  'SELECT environment,state,build_sha,uat_accepted_by,promotion_approved_by',
  'FROM tenant_runtime_update_offers WHERE tenant_id=$1 AND build_sha=$2',
  'FOR UPDATE',
 ].join(' '),[tid,EXPECT.current])
 expect(offers.rowCount===2
  &&offers.rows.some(o=>o.environment==='uat'&&o.state==='uat_accepted'&&o.uat_accepted_by)
  &&offers.rows.some(o=>o.environment==='live'&&o.state==='active'&&o.promotion_approved_by),
  'Customer UAT and Production approvals are not intact.')
 const requests=await client.query([
  'SELECT count(*)::int n FROM tenant_release_customer_rollback_requests',
  "WHERE tenant_id=$1 AND state IN ('requested','approved','running')",
 ].join(' '),[tid])
 expect(requests.rows[0].n===0,'An actual customer rollback request is already pending.')
 const holds=await client.query(
  'SELECT count(*)::int n FROM tenant_release_upgrade_holds WHERE tenant_id=$1 AND active=true',[tid])
 expect(holds.rows[0].n===0,'An existing customer upgrade hold needs separate review.')
 const active=await client.query([
  'SELECT count(*)::int n FROM tenant_release_rollout_jobs',
  "WHERE tenant_id=$1 AND environment='live'",
  "AND status IN ('pending','scheduled','deferred','running')",
 ].join(' '),[tid])
 expect(active.rows[0].n===0,'Another Custom Production rollout is active.')
 return tid
}
try{
 await client.connect()
 const identity=await client.query('SELECT current_user AS role,current_database() AS database')
 expect(identity.rows[0]?.role==='hi5central'&&identity.rows[0]?.database==='hi5central',
  'Unexpected trusted PostgreSQL host-operator identity.')
 const mutex=await client.query(
  "SELECT pg_try_advisory_lock(hashtext('hi5central-release-gateway'),hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile')) AS held")
 expect(mutex.rows[0].held===true,'Other rollout worker owns the shared gateway.')
 held=true
 await client.query('BEGIN');tx=true
 await client.query("SET LOCAL lock_timeout='6s'")
 await client.query("SET LOCAL statement_timeout='110s'")
 await client.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
 const tenantId=await gate()
 const current=run('cat',[CADDY])
 expect(hash(current)===EXPECT.currentCaddy,'Exact Production gateway hash changed.')
 expect(hash(docker('exec',GATEWAY,'cat','/etc/caddy/Caddyfile'))===hash(current),
  'Live gateway mounted source and host disk diverged.')
 const previous=backupContent(EXPECT.backup+'.caddy')
 expect(hash(previous)===EXPECT.previousCaddy,'Immutable previous deployment backup changed.')
 const previousJson=backupContent(EXPECT.backup+'.json')
 expect(JSON.parse(previousJson)?.apps?.http,'Previous gateway JSON recovery is invalid.')
 plan=planCustomerRouteRollback({
  hostname:EXPECT.host,fromBuildSha:EXPECT.current,toBuildSha:EXPECT.old,
  currentSource:current,previousSource:previous,
  expectedCurrentGatewayHash:EXPECT.currentCaddy,
  expectedPreviousGatewayHash:EXPECT.previousCaddy,
 })
 expect(plan.mode==='legacy_shared_fallback'&&plan.restoredSource===previous
   &&plan.previousSnapshotSha256===EXPECT.previousCaddy,
  'Not an exact legacy customer-only Caddy route restoration.')
 // Verify loaded Caddy runtime contains the same active hostnames as this
 // disk/mount source; reloading a stale source would silently remove another
 // tenant's route even if the backup diff were correct.
 const runtime=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-',
  'http://127.0.0.1:2019/config/'))
 const seen=new Set()
 const visit=v=>{
  if(Array.isArray(v)){for(const i of v)visit(i);return}
  if(v&&typeof v==='object'){
   if(Array.isArray(v.host))for(const host of v.host)seen.add(host)
   for(const value of Object.values(v))visit(value)
  }
 }
 visit(runtime.apps?.http?.servers||{})
 const inSource=new Set([...current.matchAll(/# H5C_RELEASE_ROUTE_BEGIN ([a-z0-9-]+\.hi5central\.com)/g)]
  .map(m=>m[1]))
 const infrastructure=new Set(['api','admin','dev','dev-api','test','uat','rmm','www']
  .map(x=>x+'.hi5central.com'))
 for(const activeHost of seen){
  if(typeof activeHost!=='string'||!activeHost.endsWith('.hi5central.com')
    ||activeHost.includes('*')||infrastructure.has(activeHost))continue
  expect(inSource.has(activeHost),'A runtime-only customer route is missing from disk: '+activeHost)
 }
 expect(seen.has(EXPECT.host),'Current Production customer route not active in gateway.')
 // Use exactly the official Caddy image to validate the proposed source without writing it.
 run('docker',['run','--rm','-i','--network','none','--entrypoint','sh',
  'hi5central/caddy-ionos:2.10.2','-c',
  'cat >/tmp/custom-restore.Caddyfile && caddy adapt --config /tmp/custom-restore.Caddyfile --adapter caddyfile >/dev/null'],
  plan.restoredSource,20000)
 for(const [name,expectedSha] of [
  ['hi5central-api-1',EXPECT.old],['hi5central-itsm-1',EXPECT.old],
  ['hi5pool-live-79d95f3ffa2a-api',EXPECT.current],
  ['hi5pool-live-79d95f3ffa2a-web',EXPECT.current]]){
   const inspected=JSON.parse(docker('inspect',name))[0]
   expect(inspected.State?.Health?.Status==='healthy'
    &&inspected.Config.Image.endsWith(':sha-'+expectedSha),
    'Production or rollback target container is unhealthy or unpinned: '+name)
 }
 const oldApi=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-',
  'http://api:3001/api/v1/updates/version'))
 const oldWeb=JSON.parse(docker('exec',GATEWAY,'wget','-q','-O','-',
  'http://itsm:80/release-manifest.json'))
 expect(oldApi.sha===EXPECT.old&&oldWeb.sha===EXPECT.old,
  'Legacy shared Production services do not serve exact restore SHA.')
 before=auditedCustomerVersions()
 expect(before[EXPECT.host].api===EXPECT.current&&before[EXPECT.host].web===EXPECT.current
  &&before['companycustom-uat.hi5central.com'].api===EXPECT.current,
  'Public Production/UAT baselines changed unexpectedly.')
 console.log('CUSTOMER_SCOPED_HOST_REHEARSAL_PASS',JSON.stringify({
  sourceSha:plan.currentSourceSha256,restoreSha:plan.restoredSourceSha256,
  exactCustomer:EXPECT.slug,mode:plan.mode,
  approvedCurrentBuild:EXPECT.current,restoredBuild:EXPECT.old,
  customerUatUnchanged:true,existingReleaseJob:EXPECT.job,
  noCustomerRequestForged:true,
  customerSelfServiceStillDisabled:true,
 }))
 if(!APPLY){
  await client.query('ROLLBACK');tx=false
  console.log('DRY_RUN_NO_CADDY_OR_DATABASE_MODIFICATION')
 }else{
  // Independent fail-safe for a crash before the PostgreSQL commit. A later
  // unrelated gateway change will make the candidate hash differ and block
  // this watchdog from replacing another customer's route.
  saveBackup(KEY+'.before',current)
  saveBackup(KEY+'.after',plan.restoredSource)
  const watch='sleep 210; if [ ! -f /backup/'+KEY+'.done ]; then '+
    'current=$(sha256sum /gateway/Caddyfile | cut -c1-64); '+
    'if [ "$current" = "'+plan.restoredSourceSha256+'" ]; then '+
    'cat /backup/'+KEY+'.before > /gateway/Caddyfile; '+
    'docker exec '+GATEWAY+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi; fi'
  docker('run','-d','--rm','--name','h5c-'+KEY,'--network','none',
   '--mount','type=volume,source='+BACKUP_VOLUME+',target=/backup',
   '--mount','type=bind,source='+CADDY+',target=/gateway/Caddyfile',
   '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
   'docker:27-cli','sh','-c',watch)
  watchdog=true
  expect(hash(run('cat',[CADDY]))===EXPECT.currentCaddy,'Shared Caddy changed during preparation.')
  writeGateway(plan.restoredSource);routeApplied=true
  execCaddyReload()
  let restored=false
  for(let i=0;i<15;i++){
   try{
    const prod=version(EXPECT.host),web=frontend(EXPECT.host)
    if(prod===EXPECT.old&&web===EXPECT.old){restored=true;break}
   }catch{}
   await new Promise(r=>setTimeout(r,900))
  }
  expect(restored,'Public Production API and frontend did not restore exact previous build.')
  const after=auditedCustomerVersions()
  for(const [host,v] of Object.entries(before)){
   if(host===EXPECT.host)continue
   expect(after[host].api===v.api&&after[host].web===v.web,
    'Another customer application version changed: '+host)
  }
  expect(hash(run('cat',[CADDY]))===plan.restoredSourceSha256
   &&hash(docker('exec',GATEWAY,'cat','/etc/caddy/Caddyfile'))===plan.restoredSourceSha256,
   'Gateway changed during HTTPS verification.')
  const audit={
   source:'customer-explicit-authorisation-in-chat-2026-10-19',
   initiationType:'reviewed_operator_executed_live_rollback_drill',
   customerSelfServiceRequestUsed:false,customerIdentityImpersonated:false,
   rollbackCompatibilityStaffApprovalCreated:false,
   tenantSlug:EXPECT.slug,environment:'live',previousReleasedBuildSha:EXPECT.current,
   restoredBuildSha:EXPECT.old,originalReleaseJobId:EXPECT.job,
   originalDeploymentBackup:EXPECT.backup,
   restoredPreviousLivePool:false,restoredLegacySharedFallback:true,
   sourceRouteGeneration:EXPECT.generation,
   sourceCaddySha256:EXPECT.currentCaddy,
   restoredScopedCaddySha256:plan.restoredSourceSha256,
   publicApiAndFrontendVerified:true,otherTenantRoutesPreserved:true,
   customUatPreserved:true,automaticRedeployBlockedByTerminalJobAndOfferState:true,
   activeCustomerUpgradeHoldCreated:false,
  }
  const deletedRoute=await client.query([
   'DELETE FROM tenant_runtime_route_attestations',
   "WHERE tenant_id=$1 AND environment='live' AND build_sha=$2 AND pool_id=$3",
   'RETURNING tenant_id',
  ].join(' '),[tenantId,EXPECT.current,'h5pool-live-79d95f3ffa2a'])
  const deletedAssignment=await client.query([
   'DELETE FROM tenant_runtime_assignments',
   "WHERE tenant_id=$1 AND environment='live' AND build_sha=$2 AND pool_id=$3",
   'RETURNING tenant_id',
  ].join(' '),[tenantId,EXPECT.current,'h5pool-live-79d95f3ffa2a'])
  const offer=await client.query([
   'UPDATE tenant_runtime_update_offers',
   "SET state='blocked',last_gate_reason=$3,updated_at=now()",
   "WHERE tenant_id=$1 AND environment='live' AND build_sha=$2 AND state='active'",
   'RETURNING id',
  ].join(' '),[tenantId,EXPECT.current,
   'Customer-authorised Production rollback to prior legacy version '+EXPECT.old])
  const job=await client.query([
   "UPDATE tenant_release_rollout_jobs SET status='rolled_back',updated_at=now()",
   "WHERE id=$1 AND tenant_id=$2 AND environment='live'",
   "AND status='succeeded' AND build_sha=$3 AND previous_build_sha=$4",
   'RETURNING id',
  ].join(' '),[EXPECT.job,tenantId,EXPECT.current,EXPECT.old])
  expect(deletedRoute.rowCount===1&&deletedAssignment.rowCount===1
   &&offer.rowCount===1&&job.rowCount===1,'Atomic rollback database proof failed.')
  const event=await client.query([
   'INSERT INTO tenant_release_rollout_events',
   '(job_id,tenant_id,environment,build_sha,event_type,details)',
   "VALUES($1,$2,'live',$3,'rolled_back',$4::jsonb) RETURNING id",
  ].join(' '),[EXPECT.job,tenantId,EXPECT.current,JSON.stringify({
   ...audit,routeGeneration:EXPECT.generation,
  })])
  const history=await client.query([
   'INSERT INTO platform_admin_audit_events',
   '(action,target_type,target_id,metadata)',
   "VALUES('release.customer_authorised_operator_custom_live_rollback_verified',",
   "'rollout_job',$1,$2::jsonb) RETURNING id",
  ].join(' '),[EXPECT.job,JSON.stringify(audit)])
  expect(event.rowCount===1&&history.rowCount===1,'Independent audit records not persisted.')
  await client.query('COMMIT');tx=false;committed=true
  cancelWatch()
  console.log('CUSTOM_CUSTOMER_PRODUCTION_ROLLBACK_SUCCEEDED_AND_AUDITED',JSON.stringify({
   ...audit,oldProductionNowLive:true,
   requestNotFabricated:true,rollbackAuditId:history.rows[0].id,
  }))
 }
}catch(e){
 console.error('CUSTOM_CUSTOMER_PRODUCTION_ROLLBACK_DENIED_OR_FAILED',e.message)
 if(tx){await client.query('ROLLBACK').catch(()=>{});tx=false}
 let compensated=false
 if(!committed&&routeApplied){
  try{
   const now=run('cat',[CADDY])
   if(hash(now)===plan.restoredSourceSha256){
    writeGateway(backupContent(KEY+'.before'));execCaddyReload()
    expect(version(EXPECT.host)===EXPECT.current,
     'Recovery did not return to original customer Production build.')
    compensated=true
    console.error('PRODUCTION_CUTOVER_COMPENSATED_TO_ORIGINAL_RELEASE')
   }else console.error('RECOVERY_BLOCKED_BY_GATEWAY_DRIFT_REVIEW_REQUIRED')
  }catch(error){console.error('CRITICAL_RECOVERY_UNCONFIRMED',error.message)}
 }
 if(!routeApplied||compensated)cancelWatch()
 else console.error('CRITICAL_GATEWAY_RESCUE_WATCHDOG_RETAINED_TO_RECOVER_UNVERIFIED_CUTOVER')
 process.exitCode=1
}finally{
 if(held){
  await client.query("SELECT pg_advisory_unlock(hashtext('hi5central-release-gateway'),hashtext('hi5central-gateway-1:/etc/caddy/Caddyfile'))")
   .catch(()=>{})
 }
 await client.end().catch(()=>{})
}
