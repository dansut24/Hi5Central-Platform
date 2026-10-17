#!/usr/bin/env node
/**
 * Staff-control-plane API/Admin immutable upgrade with exact Caddy-only
 * substitution, independent active and disk backups, and crash watchdog.
 * Never changes Production customer route/version or shared core API.
 */
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [sha,mode]=process.argv.slice(2)
const target='4e0fee71db951ab5e6ea86b7fdcbf2373e47f1a9'
if(sha!==target||!['--rehearse','--apply'].includes(mode))
  throw Error('Use official release 4e0fee71db95 and --rehearse|--apply.')
const old='hi5central-qa-worker-audit-9f3cb1da7c27'
const newer='hi5central-qa-worker-audit-'+sha.slice(0,12)
const source='/tmp/pub-release-1792091889731.Caddyfile'
const host='/opt/hi5central/deployment/Caddyfile'
const backup='hi5central_certified_release_gateway_backups'
const at=Date.now(),prefix='staff-upgrade-'+at
const watcher='h5c-staff-upgrade-revert-'+at
const digest=s=>createHash('sha256').update(s).digest('hex')
const run=(args,input)=>{
 const x=spawnSync('docker',args,{input,encoding:'utf8',timeout:100000,maxBuffer:20*1024*1024})
 if(x.status!==0)throw Error('Docker '+args.slice(0,2).join(' ')+': '+String(x.stderr||x.stdout||'').slice(-450))
 return x.stdout
}
const volume=(script,input)=>run(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+host+',target=/host/Caddyfile',
 '--mount','type=volume,source='+backup+',target=/backup',
 'busybox:1.36','sh','-c',script],input)
const active=()=>run(['exec','hi5central-web','cat',source])
const disk=()=>volume('cat /host/Caddyfile')
const loaded=()=>JSON.stringify(JSON.parse(run(['exec','hi5central-web','wget','-q','-O','-',
 'http://127.0.0.1:2019/config/'])))
const reload=(body,name)=>run(['exec','-i','hi5central-web','sh','-c',
 'cat >/tmp/'+name+'.Caddyfile && caddy reload --config /tmp/'+name+'.Caddyfile --adapter caddyfile'],body)
const publicCode=(endpoint,method='GET')=>{
 const x=spawnSync('curl',['-sS','--max-time','8','-X',method,
  '-o','/dev/null','-w','%{http_code}',endpoint],{encoding:'utf8',timeout:12000})
 if(x.status!==0)throw Error('Public staff endpoint unavailable.')
 return x.stdout.trim()
}
const pubSha=slug=>{
 const x=spawnSync('curl',['-fsS','--max-time','8','https://'+slug+'.hi5central.com/release-manifest.json'],
  {encoding:'utf8',timeout:12000})
 if(x.status!==0)throw Error('Customer manifest public proof unavailable.')
 return JSON.parse(x.stdout).sha
}
const mutate=current=>{
 for(const [item,expected] of [[old+'-api:3001',2],[old+'-web:80',1]]){
  if(current.split(item).length!==expected+1)
   throw Error('Unrecognised staff reverse proxy count: '+item)
 }
 if(current.includes(newer))throw Error('New release already routed.')
 const body=current.replaceAll(old+'-api:3001',newer+'-api:3001')
  .replaceAll(old+'-web:80',newer+'-web:80')
 run(['run','--rm','-i','--network','none','--entrypoint','sh','deployment-web',
 '-c','cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],body)
 return body
}
const oldActive=active(),oldDisk=disk()
let changed=false,armed=false,complete=false
const previous={managed:pubSha('h5c-managed-qa26'),custom:pubSha('h5c-custom-qa26')}
function restore(){
 let first
 try{volume('cat /backup/'+prefix+'.disk > /host/Caddyfile')}catch(e){first=e}
 try{reload(volume('cat /backup/'+prefix+'.live'),'staff-old-restore-'+at)}
 catch(e){first ||=e}
 if(first)throw first
 changed=false
 if(digest(active())!==digest(oldActive)||digest(disk())!==digest(oldDisk)
   ||!loaded().includes(old+'-web:80'))
  throw Error('Original staff API/frontend was not independently recovered.')
}
try{
 const paused=run(['exec','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"']).trim()
 if(paused!=='t')throw Error('Staff change requires globally paused tenant releases.')
 if(!loaded().includes(old+'-api:3001')||!loaded().includes(old+'-web:80'))
  throw Error('Active staff control-plane baseline changed.')
 for(const [name,type] of [[newer+'-api','api'],[newer+'-web','admin']]){
  const state=JSON.parse(run(['inspect',name]))[0]
  if(state.Config.Image!=='ghcr.io/dansut24/hi5central-platform-'+type+':sha-'+sha
     ||state.State.Health?.Status!=='healthy')
   throw Error('Target staff container lacks exact healthy official revision.')
 }
 const nextActive=mutate(oldActive),nextDisk=mutate(oldDisk)
 volume('umask 077; cat > /backup/'+prefix+'.live',oldActive)
 volume('umask 077; cat > /backup/'+prefix+'.disk',oldDisk)
 if(digest(volume('cat /backup/'+prefix+'.live'))!==digest(oldActive)
    ||digest(volume('cat /backup/'+prefix+'.disk'))!==digest(oldDisk))
   throw Error('Staff gateway recoverability snapshot mismatch.')
 const watch='sleep 180; if [ ! -e /backup/'+prefix+'.done ]; then '+
  'cat /backup/'+prefix+'.disk > /host/Caddyfile; '+
  "docker exec -i hi5central-web sh -c 'cat >/tmp/staff-revert-"+at+
  ".Caddyfile && caddy reload --config /tmp/staff-revert-"+at+
  ".Caddyfile --adapter caddyfile' </backup/"+prefix+".live >/dev/null 2>&1 || true; fi"
 run(['run','-d','--rm','--name',watcher,'--network','none',
 '--mount','type=bind,source='+host+',target=/host/Caddyfile',
 '--mount','type=volume,source='+backup+',target=/backup',
 '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
 'docker:27-cli','sh','-c',watch])
 armed=true
 volume('cmp /host/Caddyfile /backup/'+prefix+'.disk && cat >/host/Caddyfile',nextDisk)
 changed=true
 reload(nextActive,'staff-verified-upgrade-'+at)
 const now=loaded()
 if(!now.includes(newer+'-api:3001')||!now.includes(newer+'-web:80'))
   throw Error('Live Caddy did not activate exact release.')
 const checks=[
  ['https://api.hi5central.com/api/platform/v1/releases/certifications','GET','401'],
  ['https://api.hi5central.com/api/platform/v1/releases/worker-activity','GET','401'],
  ['https://api.hi5central.com/api/platform-operator/v1/releases/publish','POST','401'],
  ['https://admin.hi5central.com/healthz','GET','200'],
 ]
 for(const [url,m,expected] of checks){
  if(publicCode(url,m)!==expected)throw Error('Staff release endpoint failed protected HTTPS proof: '+url)
 }
 if(pubSha('h5c-managed-qa26')!==previous.managed
    ||pubSha('h5c-custom-qa26')!==previous.custom)
   throw Error('Unrelated Production tenant version changed.')
 console.log('TRUSTED_RELEASE_OPERATOR_AND_ADMIN_PUBLIC_PROOF_PASS',sha)
 if(mode==='--rehearse'){restore();console.log('STAFF_API_ADMIN_ROLLBACK_PROOF_PASS')}
 else console.log('STAFF_API_ADMIN_OFFICIAL_REVISION_APPLIED',sha)
 volume('touch /backup/'+prefix+'.done')
 console.log('RESTORE_PREFIX',prefix)
 complete=true
}catch(e){
 console.error('STAFF_API_ADMIN_UPGRADE_FAILED',e.message)
 if(changed)try{restore();console.error('STAFF_API_ADMIN_AUTO_ROLLBACK_PASS')}
 catch(re){console.error('STAFF_API_ADMIN_WATCHDOG_REMAINS_ARMED',re.message)}
 process.exitCode=1
}finally{
 if(armed&&(!changed||complete))try{run(['stop','-t','1',watcher])}catch{}
}
