#!/usr/bin/env node
/** Exact-image, generic tenant cutover against the CURRENT VPS Docker daemon.
 * This runs only after a central DB worker has obtained a fenced gateway lock.
 * --preflight validates a proposed route but does NOT change anything.
 * --apply requires the worker's live per-job authority; it creates durable
 * snapshots and an independent watchdog before a gateway is modified.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {prepareSharedTenantCaddyRoute} from '../../services/api/src/tenantCaddyVersionRoutes.js'
import {resolveTenantCurrentRevision} from '../../services/api/src/tenantLiveBaseline.js'

const [environment,slug,sha,mode,restoreKey]=process.argv.slice(2)
const SHA=/^[a-f0-9]{40}$/
const SLUG=/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?$/
const SOURCE={
  gateway:'hi5central-gateway-1',
  hostFile:'/opt/hi5central/runtime/caddy/Caddyfile',
  api:'hi5central-api-1', web:'hi5central-itsm-1',
  backup:'hi5central_release_backups',
}
const CONFIG=Object.fromEntries(['test','uat','live'].map(stage=>[stage,SOURCE]))
if(!CONFIG[environment]||!SLUG.test(String(slug||''))||!SHA.test(String(sha||''))
  ||!['--preflight','--stage','--apply','--restore'].includes(mode))
  throw Error('Usage: tenant-host-executor <test|uat|live> <tenant-slug> <sha40> <--preflight|--stage|--apply|--restore>')
if(['--apply','--restore'].includes(mode)&&(process.env.H5C_RELEASE_LEASE_AUTH!=='worker-gateway-fenced'
  ||!/^[a-f0-9-]{36}$/.test(String(process.env.H5C_RELEASE_JOB_ID||''))))
  throw Error('A fenced, server-verified lease is required for host cutover.')
const c=CONFIG[environment]
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
  return docker('exec',c.gateway,'cat','/etc/caddy/Caddyfile')
}
async function gatewayRuntime(){
  return await docker('exec',c.gateway,'wget','-q','-O','-',
    'http://127.0.0.1:2019/config/')
}
async function dockerWithInput(args,input,timeout=85000){return cmd('docker',args,input,timeout)}
async function validate(config){
  const image='hi5central/caddy-ionos:2.10.2'
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
  const v=JSON.parse(await getText('https://'+host+'/api/v1/updates/version'))
  if(!SHA.test(String(v.sha||'')))throw Error('Tenant API version response has no valid SHA.')
  return {sha:v.sha}
}
async function assertLiveGatewaySource(){
  const disk=await fileHost()
  const mounted=await docker('exec',c.gateway,'cat','/etc/caddy/Caddyfile')
  if(hash(disk)!==hash(mounted)||!disk.includes('  # H5C_RELEASE_ROUTE_INSERT'))
    throw Error('Shared gateway revision or route anchor changed; refusing cutover.')
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
    if(isWeb&&(item.startsWith('API_URL=')||item.startsWith('HI5_API_SAME_ORIGIN=')))continue
    if(!isWeb&&item.startsWith('BACKGROUND_WORKERS_ENABLED='))continue
    args.push('--env',item)
  }
  if(isWeb)args.push('--env','API_URL=','--env','HI5_API_SAME_ORIGIN=true')
  else args.push('--env','BACKGROUND_WORKERS_ENABLED=false')
  for(const mount of old.Mounts||[]){
    if(!['volume','bind'].includes(mount.Type))throw Error('Unrecognised base container mount.')
    args.push('--mount','type='+mount.Type+',source='+
      (mount.Type==='volume'?mount.Name:mount.Source)+',target='+mount.Destination+
      (mount.RW?'':',readonly'))
  }
  await docker(...args,image)
}
// Never publish a Test/UAT API backed by the Production database, even if
// its image and container health checks pass. A stage-specific, isolated API
// must be provisioned before a non-Live Caddy route can be switched.
async function assertIsolatedStageApi(name){
  if(environment==='live')return
  const [candidate,production]=await Promise.all([dockerInspect(name),dockerInspect(c.api)])
  const envOf=container=>Object.fromEntries((container?.Config?.Env||[]).map(pair=>{
    const at=pair.indexOf('=')
    return at<0?[pair,'']:[pair.slice(0,at),pair.slice(at+1)]
  }))
  const candidateEnv=envOf(candidate),productionEnv=envOf(production)
  if(!candidateEnv.DATABASE_URL||!productionEnv.DATABASE_URL||
    candidateEnv.DATABASE_URL===productionEnv.DATABASE_URL||
    candidateEnv.RUNTIME_ENVIRONMENT!==environment)
    throw Error('Isolated '+environment.toUpperCase()+' API database/runtime not provisioned; refusing customer route cutover.')
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
  await dockerWithInput(['run','--rm','-i','--network','none',
    '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile',
    'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],contents)
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
    "AND t.status='active' AND c.status='approved'",
    "AND public.hi5_release_generic_tenant_permitted(t.id)=true",
    "AND EXISTS (SELECT 1 FROM platform_release_generic_stage_approvals a",
    " WHERE a.build_sha=j.build_sha AND a.environment=j.environment",
    " AND a.planning_enabled=true AND a.execution_enabled=true",
    " AND a.approved_by IS NOT NULL AND a.expires_at>now()))",
    'AND (SELECT paused=false FROM platform_release_rollout_control WHERE singleton=true)',
    "THEN 'ALLOW' ELSE 'DENY' END",
  ].join(' ')
  const decision=await docker('exec','hi5central-db-1','sh','-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "'+query+'"')
  if(decision.trim()!=='ALLOW')throw Error('Stale or revoked database lease: refusing public gateway write.')
}

async function restore(original,liveJson){
  await dockerWithInput(['run','--rm','-i','--network','none',
    '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile',
    'busybox:1.36','sh','-c','cat >/gateway/Caddyfile'],original)
  if(liveJson)await dockerWithInput(['exec','-i',c.gateway,'sh','-c',
    'cat >/tmp/h5c-release-restore.json && caddy reload --config /tmp/h5c-release-restore.json'],liveJson)
  else await writeGateway(original)
}
// Compensating rollback for a host cutover whose durable database commit failed.
// The same gateway session lock remains held by the caller.
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
  const json=await load('json')
  await restore(previous,json)
  const served=(await currentTenantRevision()).sha
  if(served===sha)throw Error('Restored route still serves the failed release.')
  console.log(JSON.stringify({status:'rolled_back',host,environment,previousSha:served}))
  process.exit(0)
}
let prior='',liveJson='',active=false,watcher='',backupKey='',oldSource='',plannedHash=''
try{
  if(mode==='--preflight'||mode==='--apply')await assertLiveGatewaySource()
  const old=await fileHost()
  oldSource=old
  const plan=prepareSharedTenantCaddyRoute({config:old,tenantSlug:slug,
    environment,buildSha:sha})
  plannedHash=hash(plan.config)
  await validate(plan.config)
  if(mode==='--preflight'){
    console.log(JSON.stringify({status:'preflight_pass',environment,host,
      newSha:sha,sourceSha256:hash(old),newRouteSha256:hash(plan.config)}))
    process.exit(0)
  }
  if(mode==='--stage')console.log('STAGING_ONLY_NO_CUSTOMER_ROUTE',environment,sha)
  const currentControl=await cmd('docker',['exec','hi5central-db-1','sh','-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"'])
  if(mode==='--apply'&&currentControl.trim()!=='f')throw Error('Global customer rollout is paused.')
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
  if(mode==='--apply')await assertIsolatedStageApi(plan.api)
  if(mode==='--stage'){
    console.log(JSON.stringify({status:'pool_verified',environment,buildSha:sha,
      api:plan.api,web:plan.web}))
    process.exit(0)
  }
  liveJson=await gatewayRuntime()
  await docker('volume','create',c.backup)
  backupKey='release-'+environment+'-'+Date.now()+'-'+plan.host.replaceAll('.','-')
  await save(backupKey+'.caddy',old)
  if(liveJson)await save(backupKey+'.json',liveJson)
  // Validate source and fenced job identity BEFORE creating any watchdog.
  // A stale read must never trigger a restore that overwrites another writer.
  const actual=await fileHost()
  if(hash(actual)!==hash(old))throw Error('Another gateway writer changed the Caddy source.')
  await assertCurrentFencedHostLease()
  // Independent crash recovery may restore only if the on-disk source is
  // STILL exactly this job's planned revision. This prevents a delayed
  // watchdog from reverting another tenant's successful deployment.
  const restorePart='cat /backup/'+backupKey+'.caddy > /gateway/Caddyfile; '+
    "docker exec -i "+c.gateway+" sh -c 'cat >/tmp/h5c-rescue.json && caddy reload --config /tmp/h5c-rescue.json' "+
    '</backup/'+backupKey+'.json >/dev/null 2>&1 || true;'
  const mounts=[
    '--mount','type=volume,source='+c.backup+',target=/backup',
    '--mount','type=bind,source='+c.hostFile+',target=/gateway/Caddyfile',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  ]
  const watch='sleep 360; if [ ! -e /backup/'+backupKey+'.done ]; then '+
    'current=$(sha256sum /gateway/Caddyfile | cut -c1-64); '+
    'if [ "$current" = "'+plannedHash+'" ]; then '+restorePart+' fi; fi'
  watcher='h5c-release-watch-'+environment+'-'+Date.now()
  await docker('run','-d','--rm','--name',watcher,'--network','none',
    ...mounts,'docker:27-cli','sh','-c',watch)
  active=true
  await writeGateway(plan.config)
  let verified=false
  for(let i=0;i<16;i++){
    try{
      const api=await shaPublic('https://'+host+'/api/v1/updates/version')
      const manifest=JSON.parse(await getText('https://'+host+'/release-manifest.json'))
      const frontend=await getText('https://'+host+'/runtime-config.js')
      if(api===sha&&manifest.sha===sha&&
        frontend.includes('apiUrl: ""') && frontend.includes('window.location.origin')){verified=true;break}
    }catch{}
    await stop(900)
  }
  if(!verified)throw Error('New tenant release did not pass public API+frontend version verification.')
  await docker('run','--rm','--network','none','--mount',
    'type=volume,source='+c.backup+',target=/backup',
    'busybox:1.36','touch','/backup/'+backupKey+'.done')
  await docker('stop','-t','1',watcher)
  active=false
  console.log(JSON.stringify({status:'verified',host,environment,
    buildSha:sha,previousSha:prior,backup:backupKey}))
}catch(error){
  console.error('TENANT_RELEASE_DEPLOYMENT_FAILED',error.message)
  if(active){
    try{
      const current=await fileHost()
      if(hash(current)!==hash(oldSource)&&hash(current)!==plannedHash)
        throw Error('Gateway changed after this cutover; refusing unsafe rollback.')
      await restore(oldSource,liveJson)
      console.error('TENANT_RELEASE_ROLLED_BACK',host,prior)
    }catch(e){
      console.error('TENANT_RELEASE_ROLLBACK_UNCONFIRMED',e.message)
    }finally{
      // A failed CAS or a completed compensation must never leave a delayed
      // watchdog that later replaces another stage's live gateway routes.
      try{
        await docker('run','--rm','--network','none','--mount',
          'type=volume,source='+c.backup+',target=/backup',
          'busybox:1.36','touch','/backup/'+backupKey+'.done')
        await docker('stop','-t','1',watcher)
      }catch(e){console.error('TENANT_RELEASE_ROLLBACK_UNCONFIRMED','Watchdog disarm failed: '+e.message)}
    }
  }
  process.exitCode=1
}
