#!/usr/bin/env node
/** Exact-image, generic tenant cutover against the CURRENT VPS Docker daemon.
 * This runs only after a central DB worker has obtained a fenced gateway lock.
 * --preflight validates a proposed route but does NOT change anything.
 * --apply requires the worker's live per-job authority; it creates durable
 * snapshots and an independent watchdog before a gateway is modified.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {qaTestBuildSha,byQaTestSlug,requireQaTestJob} from '../../services/api/src/qaSixTestCohort.js'
import {prepareTenantCaddyRoute} from '../../services/api/src/tenantCaddyVersionRoutes.js'
import {resolveTenantCurrentRevision} from '../../services/api/src/tenantLiveBaseline.js'

const [environment,slug,sha,mode,restoreKey]=process.argv.slice(2)
const CANARY_SHA=qaTestBuildSha
const scoped=byQaTestSlug(slug)
const CANARY_JOB=scoped.id
requireQaTestJob({jobId:CANARY_JOB,slug,environment,buildSha:sha})
const SHA=/^[a-f0-9]{40}$/
const SLUG=/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?$/
const CONFIG={
  test:{gateway:'hi5central-test-gateway',volume:'hi5central-test_gateway_runtime_config',
    api:'hi5central-test-control-server-1',web:'hi5central-test-itsm-web-1',
    source:'http://test.hi5central.com',backup:'hi5central_release_test_backups'},
  uat:{gateway:'hi5central-uat-gateway',volume:'hi5central-uat_gateway_runtime_config',
    api:'hi5central-uat-control-server-1',web:'hi5central-uat-itsm-web-1',
    source:'http://uat.hi5central.com',backup:'hi5central_release_uat_backups'},
  live:{gateway:'hi5central-web',hostFile:'/opt/hi5central/deployment/Caddyfile',
    api:'hi5central-api',web:'hi5central-prod-itsm',
    source:'https://api.hi5central.com',backup:'hi5central_release_live_backups'},
}
if(environment!=='test'||sha!==CANARY_SHA
  ||!['--preflight','--stage','--apply','--restore','--confirm'].includes(mode))
  throw Error('Usage: tenant-host-executor <test|uat|live> <tenant-slug> <sha40> <--preflight|--stage|--apply|--restore>')
if(['--apply','--restore'].includes(mode)&&(process.env.H5C_RELEASE_LEASE_AUTH!=='worker-gateway-fenced'
  ||process.env.H5C_RELEASE_JOB_ID!==CANARY_JOB))
  throw Error('A fenced, server-verified lease is required for host cutover.')
const c=CONFIG[environment]
const canaryPredicate=`EXISTS (
 SELECT 1 FROM platform_release_single_test_canary_permits p
 JOIN tenant_release_rollout_jobs j ON j.id=p.job_id
 JOIN tenants t ON t.id=j.tenant_id
 JOIN platform_certified_application_releases r ON r.build_sha=j.build_sha
 WHERE p.job_id='${CANARY_JOB}'::uuid
 AND p.tenant_id=j.tenant_id AND p.build_sha=j.build_sha
 AND p.environment='test' AND j.environment='test'
 AND p.tenant_slug='${slug}' AND t.slug=p.tenant_slug
 AND j.build_sha='${CANARY_SHA}' AND r.status='approved'
 AND r.approved_by=p.approved_by
 AND p.state='armed' AND p.not_before<=now() AND p.expires_at>now()
 AND j.status='running' AND j.lease_expires_at>now()
 AND j.lease_token IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM tenant_release_rollout_jobs other
   WHERE other.status='running' AND other.id!='${CANARY_JOB}'::uuid
   AND other.lease_expires_at>now())`
const postgresSql=statement=>
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "'+
  statement.replace(/\s+/g,' ').trim()+'"'
async function canarySqlQuery(statement){
 return (await docker('exec','hi5central-postgres','sh','-c',postgresSql(statement))).trim()
}
const host=slug+(environment==='live'?'':'-'+environment)+'.hi5central.com'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const stop=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function cmd(program,args=[],input=null,timeout=125000){
  return await new Promise((resolve,reject)=>{
    const p=spawn(program,args,{stdio:['pipe','pipe','pipe']})
    let stdout='',stderr='',closed=false
    const timer=setTimeout(()=>{if(!closed){p.kill('SIGKILL');reject(Error('Command timeout: '+program+' '+args[0]))}},timeout)
    p.stdout.on('data',b=>{stdout+=b; if(stdout.length>10_000_000)p.kill('SIGKILL')})
    p.stderr.on('data',b=>{stderr+=b; if(stderr.length>2_000_000)p.kill('SIGKILL')})
    p.on('error',e=>{clearTimeout(timer);reject(e)})
    p.on('close',code=>{closed=true;clearTimeout(timer)
      code===0?resolve(stdout):reject(Error(program+' '+args[0]+' failed: '+stderr.slice(-450)))})
    if(input!=null)p.stdin.end(input)
    else p.stdin.end()
  })
}
const docker=(...args)=>cmd('docker',args)
async function dockerInspect(name){
  try{return JSON.parse(await docker('inspect',name))[0]}catch{return null}
}
async function fileHost(){
  if(environment!=='live')
    return await docker('exec',c.gateway,'cat','/etc/caddy/Caddyfile')
  return await docker('run','--rm','--network','none',
    '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile,readonly',
    'busybox:1.36','cat','/gateway/Caddyfile')
}
async function gatewayRuntime(){
  return await docker('exec',c.gateway,'wget','-q','-O','-',
    'http://127.0.0.1:2019/config/')
}
async function dockerWithInput(args,input,timeout=85000){return cmd('docker',args,input,timeout)}
async function validate(config){
  const image=environment==='live'?'deployment-web':'caddy:2.11.4-alpine'
  await dockerWithInput(['run','--rm','-i','--network','none','--entrypoint','sh',
    image,'-c','cat >/tmp/QA-Caddyfile && caddy adapt --config /tmp/QA-Caddyfile --adapter caddyfile >/dev/null'],config)
}
async function shaPublic(url){
  return JSON.parse(await cmd('curl',['-fsS','--max-time','8',url],null,13000)).sha
}
async function getText(url){
  return cmd('curl',['-fsS','--max-time','8',url],null,13000)
}
/** The two original QA26 Live frontends predate tenant same-origin API routes.
 * Their /api path returns HTML, so verify the manifest and shared API
 * separately. Every other tenant and all Test/UAT require actual JSON API.
 */
async function currentTenantRevision(){
  const url='https://'+host
  const versionResponse=await getText(url+'/api/v1/updates/version')
  if(versionResponse.trimStart().startsWith('{'))
    return resolveTenantCurrentRevision({environment,tenantSlug:slug,versionResponse})
  if(environment!=='live'||!['h5c-managed-qa26','h5c-custom-qa26'].includes(slug))
    return resolveTenantCurrentRevision({environment,tenantSlug:slug,versionResponse})
  return resolveTenantCurrentRevision({
    environment,tenantSlug:slug,versionResponse,
    manifestResponse:await getText(url+'/release-manifest.json'),
    runtimeConfigResponse:await getText(url+'/runtime-config.js'),
    sharedApiVersionResponse:await getText('https://api.hi5central.com/api/v1/updates/version'),
  })
}
/** Never silently reload a pending host Caddy revision over a different active
 * mount. This would activate unrelated changes or a stale QA Live canary.
 * Reconciliation needs separately reviewed dual-source activation/recovery.
 */
async function assertLiveGatewaySource(){
  if(environment!=='live')return
  const disk=await fileHost()
  const mounted=await docker('exec',c.gateway,'cat','/etc/caddy/Caddyfile')
  if(hash(disk)!==hash(mounted))
    throw Error('Live gateway Caddy sources differ; dual-source gateway reconciliation required.')
  const canaryBlocks=disk.match(/# QA26 LIVE CANARY BEGIN[\s\S]*?# QA26 LIVE CANARY END/g)||[]
  if(canaryBlocks.some(block=>block.includes('host '+host)))
    throw Error('Legacy QA Live canary would compete with exact tenant release route.')
}
async function clone(source,name,image,isWeb){
  const old=await dockerInspect(source)
  if(!old?.State?.Running)throw Error('Existing base environment container is not running.')
  const existing=await dockerInspect(name)
  if(existing){
    if(existing.Config.Image!==image||existing.State?.Health?.Status!=='healthy')
      throw Error('Existing version pool differs from target or is unhealthy.')
    return
  }
  const network=Object.keys(old.NetworkSettings?.Networks||{})[0]
  if(!network)throw Error('Cannot resolve trusted source network.')
  const args=['run','-d','--name',name,'--network',network,
    '--restart','unless-stopped','--memory',isWeb?'256m':'768m',
    '--pids-limit','300','--security-opt','no-new-privileges:true',
    '--log-opt','max-size=10m','--log-opt','max-file=3']
  if(old.Config.User)args.push('--user',old.Config.User)
  if(old.Config.WorkingDir)args.push('--workdir',old.Config.WorkingDir)
  for(const item of old.Config.Env||[]){
    if(isWeb&&item.startsWith('API_URL='))continue
    if(!isWeb&&item.startsWith('BACKGROUND_WORKERS_ENABLED='))continue
    args.push('--env',item)
  }
  args.push('--env',isWeb?'API_URL=same-origin':'BACKGROUND_WORKERS_ENABLED=false')
  for(const mount of old.Mounts||[]){
    if(!['volume','bind'].includes(mount.Type))throw Error('Unrecognised base container mount.')
    args.push('--mount','type='+mount.Type+',source='+
      (mount.Type==='volume'?mount.Name:mount.Source)+',target='+mount.Destination+
      (mount.RW?'':',readonly'))
  }
  await docker(...args,image)
}
async function healthy(name){
  for(let i=0;i<110;i++){
    const t=await dockerInspect(name)
    if(t?.State?.Health?.Status==='healthy')return
    if(!t?.State?.Running||t?.State?.Health?.Status==='unhealthy')
      throw Error('Candidate runtime unhealthy: '+name)
    await stop(900)
  }
  throw Error('Candidate health timeout: '+name)
}
async function save(path,contents){
  await dockerWithInput(['run','--rm','-i','--network','none',
    '--mount','type=volume,source='+c.backup+',target=/backup',
    'busybox:1.36','sh','-c',
    'umask 077; cat > /backup/'+path],contents)
}
async function writeGateway(contents){
  if(environment==='live'){
    await dockerWithInput(['run','--rm','-i','--network','none',
      '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile',
      'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],contents)
  }else{
    await dockerWithInput(['run','--rm','-i','--network','none',
      '--mount','type=volume,source='+c.volume+',target=/gateway',
      'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],contents)
  }
  await dockerWithInput(['exec','-i',c.gateway,'sh','-c',
    'cat >/tmp/h5c-release-executor.Caddyfile && caddy reload --config /tmp/h5c-release-executor.Caddyfile --adapter caddyfile'],contents)
}
async function assertCurrentFencedHostLease(){
  const id=process.env.H5C_RELEASE_JOB_ID
  const token=process.env.H5C_RELEASE_LEASE_TOKEN
  const fence=Number(process.env.H5C_RELEASE_LEASE_FENCE)
  if(!/^[a-f0-9-]{36}$/.test(String(id||''))
    ||!/^[a-f0-9-]{36}$/.test(String(token||''))
    ||!Number.isSafeInteger(fence)||fence<1)
    throw Error('Missing valid direct host lease identity.')
  const query=[
    'SELECT CASE WHEN EXISTS (SELECT 1 FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha',
    "WHERE j.id='"+id+"' AND j.lease_token='"+token+"'",
    "AND j.lease_fence="+fence+" AND j.status='running'",
    "AND j.lease_expires_at>now() AND j.environment='"+environment+"'",
    "AND j.build_sha='"+sha+"' AND t.slug='"+slug+"'",
    "AND t.status='active' AND c.status='approved')",
    'AND (SELECT paused=true FROM platform_release_rollout_control WHERE singleton=true)',
    'AND '+canaryPredicate,
    "THEN 'ALLOW' ELSE 'DENY' END",
  ].join(' ')
  const decision=await docker('exec','hi5central-postgres','sh','-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "'+query+'"')
  if(decision.trim()!=='ALLOW')throw Error('Stale or revoked database lease: refusing public gateway write.')
}

async function restore(original,liveJson){
  if(environment==='live'){
    // JSON is captured from Caddy's *active* admin API, unlike the stale
    // /etc/caddy/Caddyfile bind inode on the current IONOS production host.
    await dockerWithInput(['run','--rm','-i','--network','none',
      '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile',
      'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],original)
    await dockerWithInput(['exec','-i',c.gateway,'sh','-c',
      'cat >/tmp/h5c-release-restore.json && caddy reload --config /tmp/h5c-release-restore.json'],liveJson)
  }else await writeGateway(original)
}
// Compensating rollback for a host cutover whose durable database commit failed.
// The same gateway session lock remains held by the caller.
// The worker invokes --confirm only after its durable verified job commit.
if(mode==='--confirm'){
  const expectedSuffix='-'+host.replaceAll('.','-')
  if(process.env.H5C_RELEASE_JOB_ID!==CANARY_JOB
    ||typeof restoreKey!=='string'
    ||!restoreKey.startsWith('release-test-')
    ||!restoreKey.endsWith(expectedSuffix)
    ||!/^release-test-[0-9]{12,16}-[a-z0-9-]+$/.test(restoreKey))
    throw Error('Confirm requires pinned job and exact backup identity.')
  const permitted=await canarySqlQuery(`SELECT CASE WHEN
    (SELECT paused FROM platform_release_rollout_control WHERE singleton=true)
    AND EXISTS(
      SELECT 1 FROM tenant_release_rollout_jobs j
      JOIN platform_release_single_test_canary_permits p ON p.job_id=j.id
      WHERE j.id='${CANARY_JOB}'::uuid
      AND j.environment='test' AND j.build_sha='${CANARY_SHA}'
      AND j.status='succeeded' AND j.completed_at IS NOT NULL
      AND p.state='completed' AND p.tenant_id=j.tenant_id
      AND p.build_sha=j.build_sha
    ) THEN 'ALLOW' ELSE 'DENY' END`)
  if(permitted!=='ALLOW')throw Error('Durable QA canary completion missing: watchdog remains armed.')
  await docker('run','--rm','--network','none','--mount',
    'type=volume,source='+c.backup+',target=/backup',
    'busybox:1.36','touch','/backup/'+restoreKey+'.done')
  const name='h5c-release-watch-test-'+restoreKey.split('-')[2]
  try{await docker('stop','-t','1',name)}catch{}
  console.log(JSON.stringify({status:'watchdog_confirmed',backup:restoreKey,jobId:CANARY_JOB}))
  process.exit(0)
}
if(mode==='--restore'){
  const prefix='release-'+environment+'-'
  if(!restoreKey||!restoreKey.startsWith(prefix)||
    !/^release-(test|uat|live)-[0-9]{12,16}-[a-z0-9-]+$/.test(restoreKey)||
    !restoreKey.endsWith(host.replaceAll('.','-')))
    throw Error('Restore key is not bound to this exact tenant and environment.')
  const load=ext=>docker('run','--rm','--network','none',
    '--mount','type=volume,source='+c.backup+',target=/backup,readonly',
    'busybox:1.36','cat','/backup/'+restoreKey+'.'+ext)
  const previous=await load('caddy')
  const json=environment==='live'?await load('json'):''
  await restore(previous,json)
  const served=(await currentTenantRevision()).sha
  if(served===sha)throw Error('Restored route still serves the failed release.')
  // An independently verified restore is terminal for this snapshot.
  // Retire its watchdog so it cannot overwrite a different tenant's newer
  // cutover on the shared TEST gateway 360 seconds later.
  await docker('run','--rm','--network','none','--mount',
    'type=volume,source='+c.backup+',target=/backup',
    'busybox:1.36','touch','/backup/'+restoreKey+'.done')
  const watchdog='h5c-release-watch-test-'+restoreKey.split('-')[2]
  try{await docker('stop','-t','1',watchdog)}catch{}
  console.log(JSON.stringify({status:'rolled_back',host,environment,
    previousSha:served,watchdogRetired:true}))
  process.exit(0)
}
let prior='',liveJson='',active=false,watcher='',backupKey=''
try{
  if(mode==='--preflight'||mode==='--apply')await assertLiveGatewaySource()
  const old=await fileHost()
  const plan=prepareTenantCaddyRoute({config:old,tenantSlug:slug,
    environment,buildSha:sha})
  await validate(plan.config)
  if(mode==='--preflight'){
    console.log(JSON.stringify({status:'preflight_pass',environment,host,
      newSha:sha,sourceSha256:hash(old),newRouteSha256:hash(plan.config)}))
    process.exit(0)
  }
  if(mode==='--stage')console.log('STAGING_ONLY_NO_CUSTOMER_ROUTE',environment,sha)
  if(mode==='--apply'){
    const permit=await canarySqlQuery(`SELECT CASE WHEN
      (SELECT paused FROM platform_release_rollout_control WHERE singleton=true)
      AND ${canaryPredicate} THEN 'ALLOW' ELSE 'DENY' END`)
    if(permit!=='ALLOW')throw Error('Single Test canary permit is missing, expired or globally unpaused.')
  }
  if(mode==='--apply'){
    prior=(await currentTenantRevision()).sha
    if(prior===sha)throw Error('Exact tenant build is already active; reconcile its job.')
  }
  for(const type of ['api','itsm']){
    const image='ghcr.io/dansut24/hi5central-platform-'+type+':sha-'+sha
    await cmd('docker',['pull',image],null,210000)
    const info=JSON.parse(await docker('image','inspect',image))[0]
    if(info.Config.Labels?.['org.opencontainers.image.revision']!==sha)
      throw Error('Registry image revision mismatch.')
    await clone(type==='api'?c.api:c.web,type==='api'?plan.api:plan.web,image,
      type==='itsm')
  }
  await Promise.all([healthy(plan.api),healthy(plan.web)])
  if(mode==='--stage'){
    console.log(JSON.stringify({status:'pool_verified',environment,buildSha:sha,
      api:plan.api,web:plan.web}))
    process.exit(0)
  }
  if(environment==='live')liveJson=await gatewayRuntime()
  await docker('volume','create',c.backup)
  backupKey='release-'+environment+'-'+Date.now()+'-'+plan.host.replaceAll('.','-')
  await save(backupKey+'.caddy',old)
  if(liveJson)await save(backupKey+'.json',liveJson)
  // Independent host process recovers the pre-cutover config if the caller dies.
  // Watchdog never deletes the snapshot, and checks the '.done' marker.
  const restorePart=environment==='live'?
    'cat /backup/'+backupKey+'.caddy > /gateway/Caddyfile; '+
    "docker exec -i "+c.gateway+" sh -c 'cat >/tmp/h5c-rescue.json && caddy reload --config /tmp/h5c-rescue.json' "+
    '</backup/'+backupKey+'.json >/dev/null 2>&1 || true;':
    'cat /backup/'+backupKey+'.caddy > /gateway/Caddyfile; '+
    'docker exec '+c.gateway+
    ' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true;'
  const mounts=[
    '--mount','type=volume,source='+c.backup+',target=/backup',
    '--mount',environment==='live'?
      'type=bind,source='+c.hostFile+',target=/gateway/Caddyfile':
      'type=volume,source='+c.volume+',target=/gateway',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  ]
  // The independent watchdog checks the committed job outcome before
  // restoring a gateway when SSH or the host caller disappears.
  const committedSql=`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM tenant_release_rollout_jobs j
    JOIN platform_release_single_test_canary_permits p ON p.job_id=j.id
    WHERE j.id='${CANARY_JOB}'::uuid AND j.environment='test'
    AND j.build_sha='${CANARY_SHA}' AND j.status='succeeded'
    AND j.completed_at IS NOT NULL AND p.state='completed'
  ) THEN 'COMMITTED' ELSE 'UNCOMMITTED' END`
  const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'"
  const check='docker exec hi5central-postgres sh -c '+quote(postgresSql(committedSql))
  const watch='sleep 360; if [ ! -e /backup/'+backupKey+
    '.done ]; then if [ "$('+check+')" != "COMMITTED" ]; then '+
    restorePart+' fi; fi'
  watcher='h5c-release-watch-'+environment+'-'+backupKey.split('-')[2]
  await docker('run','-d','--rm','--name',watcher,'--network','none',
    ...mounts,'docker:27-cli','sh','-c',watch)
  active=true
  // Source CAS before modifying a shared Caddy configuration.
  const actual=await fileHost()
  if(hash(actual)!==hash(old))throw Error('Another gateway writer changed the Caddy source.')
  await assertCurrentFencedHostLease()
  await writeGateway(plan.config)
  let verified=false
  for(let i=0;i<16;i++){
    try{
      const api=await shaPublic('https://'+host+'/api/v1/updates/version')
      const manifest=JSON.parse(await getText('https://'+host+'/release-manifest.json'))
      const frontend=await getText('https://'+host+'/runtime-config.js')
      if(api===sha&&manifest.sha===sha&&
        frontend.includes('apiUrl: "" || window.location.origin')){verified=true;break}
    }catch{}
    await stop(900)
  }
  if(!verified)throw Error('New tenant release did not pass public API+frontend version verification.')
  // Deliberately keep the watchdog armed until the WORKER commits the
  // verified job to PostgreSQL. A crash after route verification but before
  // durable acknowledgement is recovered by the independent watchdog.
  active=false
  console.log(JSON.stringify({status:'verified',host,environment,
    buildSha:sha,previousSha:prior,backup:backupKey}))
}catch(error){
  console.error('TENANT_RELEASE_DEPLOYMENT_FAILED',error.message)
  if(active)try{await restore(await fileHost().then(async()=>await docker('run','--rm','--network','none',
    '--mount','type=volume,source='+c.backup+',target=/backup,readonly',
    'busybox:1.36','cat','/backup/'+backupKey+'.caddy')),liveJson)
    console.error('TENANT_RELEASE_ROLLED_BACK',host,prior)
  }catch(e){console.error('RELEASE_WATCHDOG_REMAINS_ARMED',e.message)}
  process.exitCode=1
}
