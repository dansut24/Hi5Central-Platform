#!/usr/bin/env node
/** Exact-image, generic tenant cutover against the CURRENT VPS Docker daemon.
 * This runs only after a central DB worker has obtained a fenced gateway lock.
 * --preflight validates a proposed route but does NOT change anything.
 * --apply requires the worker's live per-job authority; it creates durable
 * snapshots and an independent watchdog before a gateway is modified.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {prepareTenantCaddyRoute} from '../../services/api/src/tenantCaddyVersionRoutes.js'

const [environment,slug,sha,mode]=process.argv.slice(2)
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
if(!CONFIG[environment]||!SLUG.test(String(slug||''))||!SHA.test(String(sha||''))
  ||!['--preflight','--stage','--apply'].includes(mode))
  throw Error('Usage: tenant-host-executor <test|uat|live> <tenant-slug> <sha40> <--preflight|--stage|--apply>')
if(mode==='--apply'&&(process.env.H5C_RELEASE_LEASE_AUTH!=='worker-gateway-fenced'
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
let prior='',liveJson='',active=false,watcher='',backupKey=''
try{
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
  const currentControl=await cmd('docker',['exec','hi5central-postgres','sh','-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"'])
  if(mode==='--apply'&&currentControl.trim()!=='f')throw Error('Global customer rollout is paused.')
  if(mode==='--apply'){
    prior=await shaPublic('https://'+host+'/api/v1/updates/version')
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
  const watch='sleep 360; if [ ! -e /backup/'+backupKey+'.done ]; then '+
    restorePart+' fi'
  watcher='h5c-release-watch-'+environment+'-'+Date.now()
  await docker('run','-d','--rm','--name',watcher,'--network','none',
    ...mounts,'docker:27-cli','sh','-c',watch)
  active=true
  // Source CAS before modifying a shared Caddy configuration.
  const actual=await fileHost()
  if(hash(actual)!==hash(old))throw Error('Another gateway writer changed the Caddy source.')
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
  await docker('run','--rm','--network','none','--mount',
    'type=volume,source='+c.backup+',target=/backup',
    'busybox:1.36','touch','/backup/'+backupKey+'.done')
  await docker('stop','-t','1',watcher)
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
