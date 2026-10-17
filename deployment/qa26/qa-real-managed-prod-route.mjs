#!/usr/bin/env node
/**
 * REAL Managed-QA Production route canary on the existing shared VPS.
 * --rehearse ALWAYS restores the original byte-exact shared Caddyfile.
 * --apply persists only one exact QA26 Managed hostname route, requiring the
 * operator / release scheduler to have checked maintenance + tenant release.
 * Automatic independent rollback remains armed until marked healthy.
 * No Caddy cert/TLS config, other tenant paths, RMM, Admin, DB DDL changed.
 */
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const targetSha=process.argv[2],mode=process.argv[3]
if(!/^[a-f0-9]{40}$/.test(String(targetSha||''))
  ||!['--rehearse','--apply'].includes(mode))
  throw Error('Usage: node deployment/qa26/qa-real-managed-prod-route.mjs <sha40> --rehearse|--apply')
const expected='4a363cf9054b0b3667fd450f36e354b704ec2166'
if(targetSha!==expected)throw Error('This QA operator only supports the rehearsed 4a363cf9 release.')
const host='h5c-managed-qa26.hi5central.com'
const peer='h5c-custom-qa26.hi5central.com'
const api='hi5pool-live-qa-release-4a363cf9054b-api'
const web='hi5pool-live-qa-release-4a363cf9054b-web'
const gateway='hi5central-web'
const path='/opt/hi5central/deployment/Caddyfile'
const backupVol='hi5central_qa_live_route_rollback_backups'
const backup='live-before-managed-qa-'+Date.now()+'.Caddyfile'
const guard='hi5-qa-managed-live-revert-'+Date.now()
const sha=x=>createHash('sha256').update(x).digest('hex')
const get=(bin,args,input,time=65000)=>{
 const p=spawnSync(bin,args,{encoding:'utf8',input,timeout:time,maxBuffer:15*1024*1024})
 if(p.status!==0)throw Error(bin+' '+args.slice(0,2).join(' ')+': '+String(p.stderr||p.stdout||'').slice(-450))
 return p.stdout
}
const docker=(args,input,time)=>get('docker',args,input,time)
const liveConfig=()=>docker(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
const mount=(cmd,input)=>docker(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+path+',target=/gateway/Caddyfile',
 '--mount','type=volume,source='+backupVol+',target=/backup',
 'busybox:1.36','sh','-c',cmd],input)
const fetch=url=>{
 const p=spawnSync('curl',['-fsS','--max-time','8',url],{encoding:'utf8',timeout:12000})
 if(p.status!==0)throw Error('Public HTTP unavailable: '+url)
 return p.stdout
}
const version=url=>JSON.parse(fetch(url)).sha
const contentConfig=()=>fetch('https://'+host+'/runtime-config.js')
const manifest=hostname=>JSON.parse(fetch('https://'+hostname+'/release-manifest.json'))
const pause=()=>docker(['exec','-i','hi5central-postgres','sh','-c',
 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"']).trim()
function validate(config){
 const adapted=docker(['run','--rm','-i','--network','none',
 '--entrypoint','sh','deployment-web','-c',
 'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile'],config)
 const json=JSON.parse(adapted)
 const site=Object.values(json.apps.http.servers).flatMap(s=>s.routes||[])
   .find(r=>JSON.stringify(r.match||[]).includes('*.hi5central.com'))
 if(!site)throw Error('Wildcard Production route disappeared.')
 const handlers=site.handle?.[0]?.routes||[]
 const our=handlers.findIndex(r=>JSON.stringify(r.match||[])==='[{"host":["'+host+'"]}]')
 const old=handlers.findIndex(r=>JSON.stringify(r.match||[]).includes('h5c-custom-qa26.hi5central.com'))
 if(our<0||old<0||our>=old)throw Error('Exact QA route is not higher priority than old QA onboarding fallback.')
}
let armed=false,changed=false,persist=false
const old=liveConfig(),baseline=sha(old)
const begin='    # QA26 LIVE CANARY BEGIN - exact Managed QA host, no other tenant'
if(old.includes(begin))throw Error('QA Managed Live override already exists: refuse another untracked modification.')
const anchor='    # Isolated QA onboarding recovery frontend; other customers untouched.'
if(old.split(anchor).length!==2)throw Error('Wildcard Caddy anchor changed.')
const block=[
begin,
'    @qa26ManagedLiveRelease host '+host,
'    handle @qa26ManagedLiveRelease {',
'        @qaManagedApi path /api/*',
'        handle @qaManagedApi {',
'            reverse_proxy '+api+':3001',
'        }',
'        handle {',
'            reverse_proxy '+web+':80',
'        }',
'    }',
'    # QA26 LIVE CANARY END',
].join('\n')+'\n\n'
const next=old.replace(anchor,block+anchor)
async function checkTarget(){
 if(version('https://'+host+'/api/v1/updates/version')!==targetSha)
   throw Error('Production QA tenant API revision differs.')
 if(manifest(host).sha!==targetSha)
   throw Error('Production QA frontend manifest differs.')
 if(!contentConfig().includes('apiUrl: "" || window.location.origin'))
   throw Error('Production QA frontend does not use the assigned tenant API.')
 const auth=get('curl',['-sS','--max-time','8','-o','/dev/null','-w','%{http_code}',
   'https://'+host+'/api/v1/auth/session'])
 if(auth.trim()!=='401')throw Error('Production QA session boundary not protected (expected 401).')
}
let originalPeer,originalApi
function verifyPeer(){
 if(manifest(peer).sha!==originalPeer)throw Error('Custom Production frontend changed.')
 if(version('https://api.hi5central.com/api/v1/updates/version')!==originalApi)
   throw Error('Shared Production API was unexpectedly switched.')
}
function restore(){
 mount('set -eu; cp /backup/'+backup+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile')
 docker(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
 changed=false
 if(sha(liveConfig())!==baseline)throw Error('Shared gateway restore hash differs from baseline.')
 verifyPeer()
}
try{
 if(pause()!=='t')throw Error('Global automatic rollout switch is not paused for QA rehearsal.')
 if(mode==='--apply'&&process.env.H5C_QA_MANAGED_PROD_APPROVED!=='yes')
   throw Error('Managed Production apply requires explicit QA release approval.')
 const pair=[{name:api,type:'api'},{name:web,type:'itsm'}]
 for(const p of pair){
   const inspect=JSON.parse(docker(['inspect',p.name]))[0]
   if(!inspect.Config.Image.endsWith(targetSha)||inspect.State.Health?.Status!=='healthy')
     throw Error('Production candidate pool missing verified immutable image: '+p.name)
 }
 originalPeer=manifest(peer).sha
 originalApi=version('https://api.hi5central.com/api/v1/updates/version')
 validate(next)
 docker(['volume','create',backupVol])
 mount('set -eu; cat > /backup/'+backup+'; chmod 600 /backup/'+backup,old)
 if(sha(mount('cat /backup/'+backup))!==baseline)
   throw Error('Saved shared gateway Caddyfile SHA does not match.')
 console.log('SHARED_GATEWAY_RECOVERY',backup,'sha256='+baseline)
 const watch='sleep 160; if [ ! -e /backup/'+backup+'.done ]; then '+
   'cp /backup/'+backup+' /gateway/Caddyfile; '+
   'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi'
 docker(['run','-d','--rm','--name',guard,'--network','none',
    '--mount','type=bind,source='+path+',target=/gateway/Caddyfile',
    '--mount','type=volume,source='+backupVol+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',watch])
 armed=true
 mount('set -eu; cmp /gateway/Caddyfile /backup/'+backup+
    '; cat > /gateway/Caddyfile',next)
 changed=true
 docker(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
 await checkTarget()
 verifyPeer()
 console.log('MANAGED_PROD_CANARY_HTTPS_PASS',host,targetSha)
 if(mode==='--rehearse'){
   restore()
   console.log('MANAGED_PROD_GATEWAY_ROLLBACK_PASS',baseline)
 }else{
   console.log('MANAGED_PROD_QA_ROUTE_APPLIED',host,targetSha)
 }
 mount('touch /backup/'+backup+'.done')
 persist=true
}catch(error){
 console.error('MANAGED_PROD_QA_ERROR',error.message)
 if(changed)try{restore();console.error('MANAGED_PROD_AUTOMATIC_ROLLBACK_PASS')}
  catch(e){console.error('MANAGED_PROD_WATCHDOG_PENDING',e.message)}
 process.exitCode=1
}finally{
 if(armed&&(!changed||persist))try{docker(['stop','-t','1',guard])}catch{}
}
