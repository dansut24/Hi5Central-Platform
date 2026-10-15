#!/usr/bin/env node
// One real Custom QA26 UAT hostname, official immutable API+ITSM image pair.
// Caddy snapshot + independent Docker watchdog restore on errors/disconnect.
// Does not modify global gateway, Live, Managed UAT, RMM, other UAT canaries.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const SHA=/^[a-f0-9]{40}$/
const targetSha=process.env.H5C_QA_TARGET_SHA
const previousSha=process.env.H5C_QA_PREVIOUS_SHA
if(!SHA.test(String(targetSha||''))||!SHA.test(String(previousSha||''))
  ||targetSha===previousSha)
  throw Error('Require exact and different official target/previous SHA40.')
const keep=process.env.H5C_QA_KEEP_ON_SUCCESS==='1'
const gateway='hi5central-uat-gateway'
const hostname='h5c-custom-qa26-uat.hi5central.com'
const shared='https://uat-api.hi5central.com/api/v1/updates/version'
const network='hi5central-uat_hi5internal'
const configVol='hi5central-uat_gateway_runtime_config'
const backupVol='hi5central_qa_uat_route_rollback_backups'
const pool='hi5pool-uat-qa-release-'+targetSha.slice(0,12)
const stamp=Date.now()
const snapshot='uat-before-real-route-'+stamp+'.Caddyfile'
const guard='h5c-uat-rollback-watch-'+stamp
const names=[pool+'-api',pool+'-web']
const sha256=x=>createHash('sha256').update(x).digest('hex')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const run=(args,input,timeout=120000)=>{
  const r=spawnSync('docker',args,{encoding:'utf8',input,timeout,maxBuffer:8*1024*1024})
  if(r.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+': '+String(r.stderr||r.stdout||'').slice(-600))
  return r.stdout
}
const inspect=name=>{
  const r=spawnSync('docker',['inspect',name],{encoding:'utf8',timeout:20000})
  if(r.status!==0)return null
  return JSON.parse(r.stdout)[0]
}
function publicVersion(url){
  const r=spawnSync('curl',['-fsS','--max-time','8',url],{encoding:'utf8',timeout:12000})
  if(r.status!==0)throw Error('Public version endpoint unavailable '+url)
  return JSON.parse(r.stdout).sha
}
async function checkPublic(url,sha,attempts=16){
  for(let i=0;i<attempts;i++){
    try{if(publicVersion(url)===sha)return}
    catch{}
    await sleep(750)
  }
  throw Error('Public release attestation mismatch '+url+' '+sha.slice(0,12))
}
function volume(cmd,input){
  return run(['run','--rm','-i','--network','none',
    '--mount','type=volume,source='+configVol+',target=/gateway',
    '--mount','type=volume,source='+backupVol+',target=/backup',
    'busybox:1.36','sh','-c',cmd],input)
}
const getConfig=()=>run(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
function clone(source,name,image,mem){
  const old=inspect(source)
  if(!old?.State?.Running)throw Error('UAT baseline not running.')
  const args=['run','-d','--name',name,'--network',network,
    '--restart','unless-stopped','--memory',mem,'--pids-limit','300',
    '--security-opt','no-new-privileges:true']
  if(old.Config.User)args.push('--user',old.Config.User)
  if(old.Config.WorkingDir)args.push('--workdir',old.Config.WorkingDir)
  for(const env of old.Config.Env||[])args.push('--env',env)
  for(const mount of old.Mounts||[]){
    if(mount.Type!=='volume')throw Error('Unexpected UAT mount type.')
    args.push('--mount','type=volume,source='+mount.Name+
      ',target='+mount.Destination+(mount.RW?'':',readonly'))
  }
  run([...args,image])
}
async function waitHealthy(name){
  for(let i=0;i<90;i++){
    const state=inspect(name)?.State
    if(state?.Health?.Status==='healthy')return
    if(state?.Health?.Status==='unhealthy'||state?.Running===false)break
    await sleep(1000)
  }
  throw Error('UAT new pool unhealthy '+name)
}
function validate(config){
  run(['run','--rm','-i','--network','none','--entrypoint','sh',
    'caddy:2.11.4-alpine','-c',
    'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],
    config)
}
let modified=false,watched=false,persist=false,createdPool=false
let baseline='',baselineHash=''
async function restore(){
  volume('set -eu; cp /backup/'+snapshot+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile')
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  modified=false
  await checkPublic('https://'+hostname+'/api/v1/updates/version',previousSha)
  await checkPublic(shared,previousSha)
  if(sha256(getConfig())!==baselineHash)throw Error('UAT gateway backup was not restored byte-exactly.')
}
try{
  const images=['api','itsm'].map(t=>
    'ghcr.io/dansut24/hi5central-platform-'+t+':sha-'+targetSha)
  for(const image of images){
    run(['pull',image],undefined,150000)
    const actual=JSON.parse(run(['image','inspect',image]))[0]
    if(actual.Config?.Labels?.['org.opencontainers.image.revision']!==targetSha)
      throw Error('Unverified immutable UAT image.')
  }
  const oldApi=inspect('hi5central-uat-control-server-1')
  const oldWeb=inspect('hi5central-uat-itsm-web-1')
  if(!oldApi?.Config.Image.endsWith(previousSha)||!oldWeb?.Config.Image.endsWith(previousSha))
    throw Error('Shared UAT baseline differs from expected previously proven release.')
  await checkPublic('https://'+hostname+'/api/v1/updates/version',previousSha)
  await checkPublic(shared,previousSha)
  baseline=getConfig()
  baselineHash=sha256(baseline)
  const anchor='http://uat.hi5central.com {'
  if(baseline.split(anchor).length!==2
    ||baseline.includes('header X-Forwarded-Host '+hostname))
    throw Error('Unexpected or already switched Custom UAT gateway.')
  const previous=names.map(inspect)
  if(previous.filter(Boolean).length===1)throw Error('Partial versioned UAT pool needs recovery.')
  if(previous.every(Boolean)){
    for(let i=0;i<2;i++){
      if(previous[i].Config.Image!==images[i]
        ||previous[i].State.Health?.Status!=='healthy')
        throw Error('Existing UAT pool has wrong build or unhealthy container.')
    }
  }else{
    clone('hi5central-uat-control-server-1',names[0],images[0],'512m')
    clone('hi5central-uat-itsm-web-1',names[1],images[1],'256m')
    createdPool=true
  }
  await Promise.all(names.map(waitHealthy))
  const block=[
    '  # Custom QA UAT release: exact tenant host only',
    '  @qaCustomUatRelease header X-Forwarded-Host '+hostname,
    '  handle @qaCustomUatRelease {',
    '    @qaCustomUatApi path /api/*',
    '    handle @qaCustomUatApi {',
    '      reverse_proxy '+names[0]+':3001',
    '    }',
    '    handle {',
    '      reverse_proxy '+names[1]+':80',
    '    }',
    '  }',
  ].join('\n')
  const next=baseline.replace(anchor,anchor+'\n'+block)
  validate(next)
  run(['volume','create',backupVol])
  volume('set -eu; cat >/backup/'+snapshot+'; chmod 600 /backup/'+snapshot,baseline)
  if(sha256(volume('cat /backup/'+snapshot))!==baselineHash)
    throw Error('UAT saved gateway snapshot differs from observed config.')
  const watcher='sleep 180; if [ ! -e /backup/'+snapshot+'.done ]; then '+
    'cp /backup/'+snapshot+' /gateway/Caddyfile; '+
    'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi'
  run(['run','-d','--rm','--name',guard,'--network','none',
    '--mount','type=volume,source='+configVol+',target=/gateway',
    '--mount','type=volume,source='+backupVol+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',watcher])
  watched=true
  volume('set -eu; cmp /gateway/Caddyfile /backup/'+snapshot+
    '; cat >/gateway/Caddyfile',next)
  modified=true
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  await checkPublic('https://'+hostname+'/api/v1/updates/version',targetSha)
  await checkPublic(shared,previousSha)
  console.log('REAL_CUSTOM_UAT_HTTP_PASS',targetSha,'baseline',previousSha)
  if(!keep){
    await restore()
    console.log('REAL_CUSTOM_UAT_REHEARSAL_ROLLBACK_PASS',baselineHash)
  }else{
    console.log('QA_UAT_ROUTE_PROMOTED',hostname,targetSha)
  }
  volume('touch /backup/'+snapshot+'.done')
  persist=keep
  console.log('QA_UAT_ROLLBACK_SNAPSHOT',snapshot)
}catch(e){
  console.error('CUSTOM_UAT_RELEASE_FAILED',e.message)
  if(modified)try{await restore();console.error('UAT_AUTOMATIC_ROLLBACK_PASS')}
    catch(re){console.error('UAT_WATCHDOG_STILL_ARMED',re.message)}
  process.exitCode=1
}finally{
  if(watched&&!modified || watched&&persist){
    try{run(['stop','-t','1',guard])}catch{}
  }
  if(createdPool&&!persist&&!modified)for(const name of names){
    try{run(['rm','-f',name])}catch{}
  }
}
