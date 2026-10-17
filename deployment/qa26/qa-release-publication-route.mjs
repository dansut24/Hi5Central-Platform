#!/usr/bin/env node
// Safe, exact-scope publication endpoint addition to the already-versioned
// central staff release API. Both active and host-disk Caddy sources are backed
// up independently, with a Docker watchdog and unmodified customer routes.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const mode=process.argv[2]
if(!['--rehearse','--apply'].includes(mode))
 throw Error('Usage: node qa-release-publication-route.mjs --rehearse|--apply')
const active='/tmp/staff-release-1792091613020.Caddyfile'
const disk='/opt/hi5central/deployment/Caddyfile'
const vol='hi5central_certified_release_gateway_backups'
const t=Date.now(),prefix='release-publish-route-'+t
const watchdog='h5c-pub-watch-'+t
const before='    @h5ReleaseCert path /api/platform/v1/releases/certifications /api/platform/v1/releases/certifications/*'
const after=before+' /api/platform-operator/v1/releases/publish /api/platform-operator/v1/releases/version-correction'
const digest=s=>createHash('sha256').update(s).digest('hex')
const exec=(args,input)=>{
 const p=spawnSync('docker',args,{input,encoding:'utf8',timeout:90000,maxBuffer:18*1024*1024})
 if(p.status!==0)throw Error('Docker '+args.slice(0,2).join(' ')+': '+String(p.stderr||p.stdout||'').slice(-480))
 return p.stdout
}
const activeFile=()=>exec(['exec','hi5central-web','cat',active])
const mount=(cmd,input)=>exec(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+disk+',target=/host/Caddyfile',
 '--mount','type=volume,source='+vol+',target=/backup',
 'busybox:1.36','sh','-c',cmd],input)
const diskFile=()=>mount('cat /host/Caddyfile')
const loaded=()=>JSON.stringify(JSON.parse(exec(['exec','hi5central-web',
 'wget','-q','-O','-','http://127.0.0.1:2019/config/'])))
const reload=(data,name)=>exec(['exec','-i','hi5central-web','sh','-c',
 'cat > /tmp/'+name+'.Caddyfile && caddy reload --config /tmp/'+name+'.Caddyfile --adapter caddyfile'],data)
const code=(path)=> {
 const p=spawnSync('curl',['-sS','-X','POST','-H','Content-Type: application/json',
  '--data','{}','-o','/dev/null','-w','%{http_code}','--max-time','8',
  'https://api.hi5central.com'+path],{encoding:'utf8',timeout:12000})
 if(p.status!==0)throw Error('Publication API unavailable.')
 return p.stdout.trim()
}
const manifest=host=>{
 const p=spawnSync('curl',['-fsS','--max-time','8','https://'+host+'/release-manifest.json'],
   {encoding:'utf8',timeout:12000})
 if(p.status!==0)throw Error('Tenant public frontend unavailable.')
 return JSON.parse(p.stdout).sha
}
const route=bytes=>{
 if(bytes.split(before).length!==2||bytes.includes(after))
  throw Error('Expected exactly one pristine staff release matcher.')
 const next=bytes.replace(before,after)
 exec(['run','--rm','-i','--network','none','--entrypoint','sh','deployment-web',
 '-c','cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],next)
 return next
}
let changed=false,armed=false,done=false,originalActive='',originalDisk=''
let managed,custom
function restore(){
 let err
 try{mount('cat /backup/'+prefix+'.disk > /host/Caddyfile')}catch(e){err=e}
 try{reload(mount('cat /backup/'+prefix+'.live'),'h5c-pub-restore-'+t)}
 catch(e){err ||=e}
 if(err)throw err
 changed=false
 if(digest(activeFile())!==digest(originalActive)
 ||digest(diskFile())!==digest(originalDisk))
  throw Error('Publication rollback source hash mismatch.')
 if(manifest('h5c-managed-qa26.hi5central.com')!==managed
 ||manifest('h5c-custom-qa26.hi5central.com')!==custom)
  throw Error('Customer version changed during release-publication rollback.')
}
try{
 const paused=exec(['exec','hi5central-postgres','sh','-c',
 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"']).trim()
 if(paused!=='t')throw Error('Release rollout must remain paused for gateway update.')
 if(!loaded().includes('hi5central-qa-worker-audit-9f3cb1da7c27-api:3001'))
  throw Error('Staff certification API has changed unexpectedly.')
 originalActive=activeFile();originalDisk=diskFile()
 managed=manifest('h5c-managed-qa26.hi5central.com')
 custom=manifest('h5c-custom-qa26.hi5central.com')
 const newActive=route(originalActive),newDisk=route(originalDisk)
 mount('umask 077; cat >/backup/'+prefix+'.live',originalActive)
 mount('umask 077; cat >/backup/'+prefix+'.disk',originalDisk)
 if(digest(mount('cat /backup/'+prefix+'.live'))!==digest(originalActive)
   ||digest(mount('cat /backup/'+prefix+'.disk'))!==digest(originalDisk))
   throw Error('Publication-route backups not byte-identical.')
 const recovery='sleep 150; if [ ! -e /backup/'+prefix+'.done ]; then '+
   'cat /backup/'+prefix+'.disk > /host/Caddyfile; '+
   "docker exec -i hi5central-web sh -c 'cat >/tmp/pubrevert-"+t+
   ".Caddyfile && caddy reload --config /tmp/pubrevert-"+t+
   ".Caddyfile --adapter caddyfile' </backup/"+prefix+".live >/dev/null 2>&1 || true; fi"
 exec(['run','-d','--rm','--name',watchdog,'--network','none',
 '--mount','type=bind,source='+disk+',target=/host/Caddyfile',
 '--mount','type=volume,source='+vol+',target=/backup',
 '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
 'docker:27-cli','sh','-c',recovery])
 armed=true
 mount('cmp /host/Caddyfile /backup/'+prefix+'.disk && cat >/host/Caddyfile',newDisk)
 changed=true
 reload(newActive,'pub-release-'+t)
 for(const path of ['/api/platform-operator/v1/releases/publish',
    '/api/platform-operator/v1/releases/version-correction']){
   if(code(path)!=='401')throw Error('Trusted publication API is not rejecting anonymous writes.')
 }
 if(manifest('h5c-managed-qa26.hi5central.com')!==managed
   ||manifest('h5c-custom-qa26.hi5central.com')!==custom)
   throw Error('Unrelated Production tenant changed.')
 console.log('STAFF_RELEASE_PUBLICATION_API_PROTECTED_PASS')
 if(mode==='--rehearse'){restore();console.log('RELEASE_PUBLICATION_ROUTE_ROLLBACK_PASS')}
 else console.log('STAFF_RELEASE_PUBLICATION_ROUTE_APPLIED')
 mount('touch /backup/'+prefix+'.done')
 console.log('PUBLICATION_RESTORE_PREFIX',prefix)
 done=true
}catch(e){
 console.error('RELEASE_PUBLICATION_ROUTE_FAILED',e.message)
 if(changed)try{restore();console.error('RELEASE_PUBLICATION_ROUTE_AUTO_RESTORED')}
 catch(re){console.error('PUBLICATION_WATCHDOG_ACTIVE',re.message)}
 process.exitCode=1
}finally{
 if(armed&&(!changed||done))try{exec(['stop','-t','1',watchdog])}catch{}
}
