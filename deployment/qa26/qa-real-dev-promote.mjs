#!/usr/bin/env node
// Real internal Dev API+ITSM release candidate deployment with durable
// Caddy backup, independent watchdog and public SHA verification.
// Run only on the authorised VPS Docker host, not in a web server container.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const sha=process.argv[2],mode=process.argv[3]
if(!/^[a-f0-9]{40}$/.test(String(sha||''))||!['--rehearse','--apply'].includes(mode))
  throw Error('Usage: node deployment/qa26/qa-real-dev-promote.mjs <official_sha40> --rehearse|--apply')
const label=sha.slice(0,12)
const gateway='hi5central-dev-gateway'
const devApi='hi5central-dev-control-server-1'
const devWeb='hi5central-dev-itsm-web-1'
const network='hi5central-dev_hi5internal'
const configVolume='hi5central-dev_gateway_runtime_config'
const backupVolume='hi5central_dev_route_rollback_backups'
const apiPool='hi5pool-dev-'+label+'-api'
const webPool='hi5pool-dev-'+label+'-web'
const stamp=Date.now()
const backup='dev-before-'+label+'-'+stamp+'.Caddyfile'
const guard='hi5central-dev-watch-'+stamp
const hash=data=>createHash('sha256').update(data).digest('hex')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const docker=(args,input,timeout=90000)=>{
  const r=spawnSync('docker',args,{input,encoding:'utf8',timeout,maxBuffer:8*1024*1024})
  if(r.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+': '+String(r.stderr||r.stdout||'').slice(-600))
  return r.stdout
}
const inspect=name=>JSON.parse(docker(['inspect',name]))[0]
const caddyfile=()=>docker(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
const persisted=(script,input)=>docker(['run','--rm','-i','--network','none',
  '--mount','type=volume,source='+configVolume+',target=/gateway',
  '--mount','type=volume,source='+backupVolume+',target=/backup',
  'busybox:1.36','sh','-c',script],input)
function fetchVersion(url){
  const r=spawnSync('curl',['-fsS','--max-time','8',url],
    {encoding:'utf8',timeout:12000})
  if(r.status!==0)throw Error('Public Dev API endpoint unavailable.')
  return JSON.parse(r.stdout).sha
}
async function observed(url,expected){
  let error
  for(let i=0;i<18;i++){
    try{const actual=fetchVersion(url);if(actual===expected)return}
    catch(e){error=e}
    await sleep(650)
  }
  throw Error('Observed Dev release is not '+expected+': '+(error?.message||'SHA mismatch'))
}
function clone(oldName,newName,image,memory){
  try {
    const found=inspect(newName)
    if(found.Config.Image!==image||found.State.Health?.Status!=='healthy')
      throw Error('Existing Dev pool must be inspected: '+newName)
    return
  }catch(error){
    if(!String(error.message).includes('No such object'))
      throw error
  }
  const source=inspect(oldName)
  const args=['run','-d','--name',newName,'--network',network,
    '--restart','unless-stopped','--memory',memory,'--pids-limit','300',
    '--security-opt','no-new-privileges:true']
  if(source.Config.User)args.push('--user',source.Config.User)
  if(source.Config.WorkingDir)args.push('--workdir',source.Config.WorkingDir)
  for(const env of source.Config.Env||[])args.push('--env',env)
  for(const mount of source.Mounts||[]){
    if(mount.Type!=='volume')throw Error('Dev API has unexpected non-volume mount.')
    args.push('--mount','type=volume,source='+mount.Name+
      ',target='+mount.Destination+(mount.RW?'':',readonly'))
  }
  docker([...args,image])
}
async function waitHealthy(name){
  for(let i=0;i<75;i++){
    const found=inspect(name)
    if(found.State?.Health?.Status==='healthy')return
    if(found.State?.Health?.Status==='unhealthy'||found.State?.Running===false)
      throw Error(name+' is unhealthy')
    await sleep(1000)
  }
  throw Error(name+' health wait exceeded 75 seconds')
}
const images=['api','itsm'].map(type=>'ghcr.io/dansut24/hi5central-platform-'+type+':sha-'+sha)
let watchdog=false,modified=false,success=false
let previousVersion=''
function restore(){
  persisted('set -e; cp /backup/'+backup+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile')
  docker(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  modified=false
}
try{
  const old=caddyfile(),oldHash=hash(old)
  previousVersion=fetchVersion('https://dev-api.hi5central.com/api/v1/updates/version')
  for(const image of images){
    // Official immutable artifacts only; never attempt a dev/latest tag here.
    docker(['pull',image],undefined,150000)
    const obj=JSON.parse(docker(['image','inspect',image]))[0]
    if(obj.Config?.Labels?.['org.opencontainers.image.revision']!==sha)
      throw Error('Official registry image revision mismatch: '+image)
  }
  if(!inspect(devApi).State.Running||!inspect(devWeb).State.Running)
    throw Error('Existing Dev baseline must remain running during deployment.')
  const expectedApi='http://dev-api.hi5central.com {\n  reverse_proxy control-server:3001\n}'
  const expectedWeb='http://dev.hi5central.com {\n  reverse_proxy itsm-web:80\n}'
  if(old.split(expectedApi).length!==2||old.split(expectedWeb).length!==2)
    throw Error('Dev gateway no longer matches expected baseline: stop.')
  const candidate=old.replace(expectedApi,expectedApi.replace('control-server:3001',apiPool+':3001'))
    .replace(expectedWeb,expectedWeb.replace('itsm-web:80',webPool+':80'))
  docker(['run','--rm','-i','--network','none','--entrypoint','sh','caddy:2.11.4-alpine',
    '-c','cat >/tmp/config && caddy adapt --config /tmp/config --adapter caddyfile >/dev/null'],
    candidate)
  clone(devApi,apiPool,images[0],'512m')
  clone(devWeb,webPool,images[1],'256m')
  await Promise.all([waitHealthy(apiPool),waitHealthy(webPool)])
  docker(['volume','create',backupVolume])
  persisted('set -eu; cat > /backup/'+backup+'; chmod 600 /backup/'+backup,old)
  if(hash(persisted('cat /backup/'+backup))!==oldHash)
    throw Error('Dev recovery snapshot integrity mismatch.')
  const guardScript='sleep 150; if [ ! -e /backup/'+backup+'.done ]; then '+
    'cp /backup/'+backup+' /gateway/Caddyfile; '+
    'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi'
  docker(['run','-d','--rm','--name',guard,'--network','none',
    '--mount','type=volume,source='+configVolume+',target=/gateway',
    '--mount','type=volume,source='+backupVolume+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',guardScript])
  watchdog=true
  persisted('set -eu; cmp /gateway/Caddyfile /backup/'+backup+
    '; cat > /gateway/Caddyfile',candidate)
  modified=true
  docker(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  await observed('https://dev-api.hi5central.com/api/v1/updates/version',sha)
  const h=spawnSync('curl',['-fsS','-o','/dev/null','-w','%{http_code}','--max-time','8',
    'https://dev.hi5central.com/login'],{encoding:'utf8',timeout:12000})
  if(h.status!==0||h.stdout.trim()!=='200')
    throw Error('Dev ITSM login page HTTP validation failed.')
  console.log('DEV_RELEASE_HTTP_PASS',sha,'API and ITSM')
  if(mode==='--rehearse'){
    restore()
    await observed('https://dev-api.hi5central.com/api/v1/updates/version',previousVersion)
    if(hash(caddyfile())!==oldHash)throw Error('Dev rehearsal rollback did not restore baseline bytes.')
    console.log('DEV_REHEARSAL_ROLLBACK_PASS',previousVersion)
  }else{
    console.log('DEV_CANDIDATE_APPLIED',sha)
  }
  persisted('touch /backup/'+backup+'.done')
  success=true
  console.log('DEV_RESTORE_BACKUP',backup)
}catch(error){
  console.error('DEV_CANDIDATE_FAILED',error.message)
  if(modified){
    try{restore();await observed('https://dev-api.hi5central.com/api/v1/updates/version',previousVersion)
      console.error('DEV_AUTOMATIC_ROLLBACK_PASS',previousVersion)}
    catch(e){console.error('DEV_ROLLBACK_FAILED_WATCHDOG_ACTIVE',e.message)}
  }
  process.exitCode=1
}finally{
  if(watchdog&&(!modified||success))try{docker(['stop','-t','1',guard])}catch{}
}
