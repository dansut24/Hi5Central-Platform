#!/usr/bin/env node
/**
 * QA-only staff Admin certification endpoint activation, immutable official
 * API/Admin pair, dual-source Caddy backup and independent rollback watchdog.
 * This is a narrow staff-control-plane switch, not a customer deployment.
 */
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [target,mode]=process.argv.slice(2)
const sha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
if(target!==sha||!['--rehearse','--apply'].includes(mode))
  throw Error('Use exact verified certification build and --rehearse|--apply.')
const prev='793e0e14ba7af20cd40b444af1182b560396f050'
const old='hi5central-qa-worker-audit-'+prev.slice(0,12)
const next='hi5central-qa-worker-audit-'+sha.slice(0,12)
const gateway='hi5central-web'
const disk='/opt/hi5central/deployment/Caddyfile'
const active='/tmp/h5c-admin-worker-1792085756567.Caddyfile'
const volume='hi5central_certified_release_gateway_backups'
const stamp=Date.now(),base='staff-release-'+stamp
const watchdog='h5c-staff-release-watch-'+stamp
const hash=x=>createHash('sha256').update(x).digest('hex')
function cmd(args,input,timeout=90000){
 const r=spawnSync('docker',args,{encoding:'utf8',input,timeout,maxBuffer:15*1024*1024})
 if(r.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+': '+String(r.stderr||r.stdout).slice(-460))
 return r.stdout
}
const getActive=()=>cmd(['exec',gateway,'cat',active])
const getDisk=()=>cmd(['run','--rm','--network','none',
 '--mount','type=bind,source='+disk+',target=/host/Caddyfile,readonly',
 'busybox:1.36','cat','/host/Caddyfile'])
const volumeRun=(script,input)=>cmd(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+disk+',target=/host/Caddyfile',
 '--mount','type=volume,source='+volume+',target=/backup',
 'busybox:1.36','sh','-c',script],input)
const config=()=>JSON.stringify(JSON.parse(cmd(['exec',gateway,'wget','-q','-O','-','http://127.0.0.1:2019/config/'])))
const reload=(bytes,label)=>cmd(['exec','-i',gateway,'sh','-c',
 'cat > /tmp/'+label+'.Caddyfile && caddy reload --config /tmp/'+label+'.Caddyfile --adapter caddyfile'],
 bytes)
const http=url=>{
 const c=spawnSync('curl',['-sS','--max-time','8','-o','/dev/null','-w','%{http_code}',url],
   {encoding:'utf8',timeout:12000})
 if(c.status!==0)throw Error('Cannot reach public smoke endpoint.')
 return c.stdout.trim()
}
const publicSha=host=>{
 const c=spawnSync('curl',['-fsS','--max-time','8','https://'+host+'/release-manifest.json'],
   {encoding:'utf8',timeout:12000})
 if(c.status!==0)throw Error('Tenant public manifest unavailable.')
 return JSON.parse(c.stdout).sha
}
const assertActive=(expected)=>{
 const live=config()
 if(!live.includes(expected+'-api:3001')||!live.includes(expected+'-web:80'))
   throw Error('Active staff Admin and API pool differs from the intended target.')
}
function mutate(bytes){
 for(const text of [old+'-api:3001',old+'-web:80']){
   if(bytes.split(text).length!==2)
     throw Error('Expected exactly one previously verified staff routing target: '+text)
 }
 if(bytes.includes('HI5C RELEASE CERTIFICATION CANARY'))
   throw Error('Release-certification API route is already present.')
 const anchor='    # HI5C WORKER AUDIT CANARY BEGIN'
 if(bytes.split(anchor).length!==2)throw Error('Staff Admin audit Caddy anchor changed.')
 const cert=[
  '    # HI5C RELEASE CERTIFICATION CANARY BEGIN',
  '    @h5ReleaseCert path /api/platform/v1/releases/certifications /api/platform/v1/releases/certifications/*',
  '    handle @h5ReleaseCert {',
  '        reverse_proxy '+next+'-api:3001',
  '    }',
  '    # HI5C RELEASE CERTIFICATION CANARY END',
 ].join('\n')+'\n'
 return bytes.replace(old+'-api:3001',next+'-api:3001')
   .replace(old+'-web:80',next+'-web:80')
   .replace(anchor,cert+anchor)
}
const validate=bytes=>{
 cmd(['run','--rm','-i','--network','none','--entrypoint','sh','deployment-web',
  '-c','cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],bytes)
}
let guard=false,changed=false,success=false
let beforeLive='',beforeDisk='',fingerprints={}
async function restore(){
 let first
 try{volumeRun('cat /backup/'+base+'.disk > /host/Caddyfile')}catch(e){first=e}
 try{reload(volumeRun('cat /backup/'+base+'.active'),'staff-revert-'+stamp)}
 catch(e){first ||=e}
 if(first)throw first
 changed=false
 if(hash(getActive())!==hash(beforeLive)||hash(getDisk())!==hash(beforeDisk))
  throw Error('One or both Caddyfile sources did not restore byte-exactly.')
 assertActive(old)
 if(publicSha('h5c-managed-qa26.hi5central.com')!==fingerprints.managed
   ||publicSha('h5c-custom-qa26.hi5central.com')!==fingerprints.custom)
   throw Error('Customer release route changed during staff rollback.')
}
try{
 const paused=cmd(['exec','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"']).trim()
 if(paused!=='t')throw Error('Global release pause is mandatory for staff routing change.')
 assertActive(old)
 beforeLive=getActive();beforeDisk=getDisk()
 fingerprints={managed:publicSha('h5c-managed-qa26.hi5central.com'),
  custom:publicSha('h5c-custom-qa26.hi5central.com')}
 for(const [name,type] of [[next+'-api','api'],[next+'-web','admin']]){
   const c=JSON.parse(cmd(['inspect',name]))[0]
   if(!c.Config.Image.endsWith(sha)||c.State.Health?.Status!=='healthy')
     throw Error('Official staged staff '+type+' candidate is absent/unhealthy.')
 }
 const targetLive=mutate(beforeLive),targetDisk=mutate(beforeDisk)
 validate(targetLive);validate(targetDisk)
 cmd(['volume','create',volume])
 volumeRun('umask 077; cat >/backup/'+base+'.active',beforeLive)
 volumeRun('umask 077; cat >/backup/'+base+'.disk',beforeDisk)
 if(hash(volumeRun('cat /backup/'+base+'.active'))!==hash(beforeLive)
   ||hash(volumeRun('cat /backup/'+base+'.disk'))!==hash(beforeDisk))
   throw Error('Staff Caddy recovery archives do not match source checksums.')
 const watch='sleep 170; if [ ! -e /backup/'+base+'.done ]; then '+
  'cat /backup/'+base+'.disk > /host/Caddyfile; '+
  "docker exec -i "+gateway+" sh -c 'cat >/tmp/h5c-staff-watch-"+
  stamp+".Caddyfile && caddy reload --config /tmp/h5c-staff-watch-"+
  stamp+".Caddyfile --adapter caddyfile' </backup/"+base+".active >/dev/null 2>&1 || true; fi"
 cmd(['run','-d','--rm','--name',watchdog,'--network','none',
  '--mount','type=bind,source='+disk+',target=/host/Caddyfile',
  '--mount','type=volume,source='+volume+',target=/backup',
  '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  'docker:27-cli','sh','-c',watch])
 guard=true
 volumeRun('cmp /host/Caddyfile /backup/'+base+'.disk && cat >/host/Caddyfile',targetDisk)
 changed=true
 reload(targetLive,'staff-release-'+stamp)
 assertActive(next)
 for(const endpoint of [
  'https://api.hi5central.com/api/platform/v1/releases/certifications',
  'https://api.hi5central.com/api/platform/v1/releases/worker-activity',
 ]){
   if(http(endpoint)!=='401')throw Error('Staff API was not protected (HTTP 401).')
 }
 if(http('https://admin.hi5central.com/healthz')!=='200')
   throw Error('Staff Admin web health check failed.')
 if(publicSha('h5c-managed-qa26.hi5central.com')!==fingerprints.managed
   ||publicSha('h5c-custom-qa26.hi5central.com')!==fingerprints.custom)
   throw Error('Unrelated customer was affected by staff release.')
 console.log('CERTIFICATION_ADMIN_PUBLIC_BOUNDARY_PASS',sha)
 if(mode==='--rehearse'){await restore();console.log('CERTIFICATION_STAFF_ROLLBACK_PASS')}
 else console.log('CERTIFICATION_ADMIN_API_APPLIED',sha)
 volumeRun('touch /backup/'+base+'.done')
 console.log('RESTORE_BACKUP_PREFIX',base)
 success=true
}catch(e){
 console.error('CERTIFICATION_STAFF_DEPLOY_FAILED',e.message)
 if(changed)try{await restore();console.error('CERTIFICATION_STAFF_AUTO_RESTORED')}
 catch(error){console.error('STAFF_WATCHDOG_RESTORE_PENDING',error.message)}
 process.exitCode=1
}finally{
 if(guard&&(!changed||success))try{cmd(['stop','-t','1',watchdog])}catch{}
}
