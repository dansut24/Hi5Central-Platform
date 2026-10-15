#!/usr/bin/env node
/**
 * Bounded staff-Admin audit canary on the REAL IONOS VPS.
 * Route ONLY admin.hi5central.com frontend + one staff-only API family to
 * the official immutable worker-audit pair, not other customers/services.
 *
 * Caddy currently has two distinct sources (old bind inode, newer host path).
 * Back up, update, verify and independently restore BOTH on failure.
 */
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [target,mode]=process.argv.slice(2)
if(target!=='793e0e14ba7af20cd40b444af1182b560396f050'
  ||!['--rehearse','--apply'].includes(mode))
  throw Error('Usage: node qa-worker-admin-canary.mjs 793e0e14...<sha40> --rehearse|--apply')
const stamp=Date.now(),prefix='admin-worker-audit-'+stamp
const guard='hi5c-worker-admin-revert-'+stamp
const volume='hi5central_qa_admin_worker_gateway_backups'
const diskPath='/opt/hi5central/deployment/Caddyfile'
const api='hi5central-qa-worker-audit-793e0e14ba7a-api'
const web='hi5central-qa-worker-audit-793e0e14ba7a-web'
const hash=s=>createHash('sha256').update(s).digest('hex')
const cmd=(bin,args,input,timeout=75000)=>{
 const p=spawnSync(bin,args,{input,encoding:'utf8',timeout,maxBuffer:18*1024*1024})
 if(p.status!==0)throw Error(bin+' '+args.slice(0,2).join(' ')+': '+String(p.stderr||p.stdout||'').slice(-500))
 return p.stdout
}
const docker=(args,input,timeout)=>cmd('docker',args,input,timeout)
const volumeCmd=(sql,input)=>docker(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+diskPath+',target=/host/Caddyfile',
 '--mount','type=volume,source='+volume+',target=/backup',
 'busybox:1.36','sh','-c',sql],input)
const active=()=>docker(['exec','hi5central-web','cat','/etc/caddy/Caddyfile'])
const onDisk=()=>volumeCmd('cat /host/Caddyfile')
const liveJson=()=>JSON.stringify(JSON.parse(docker(['exec','hi5central-web','wget',
 '-q','-O','-','http://127.0.0.1:2019/config/'])))
const get=url=>cmd('curl',['-fsS','--max-time','8',url],undefined,15000)
const status=url=>cmd('curl',['-sS','-o','/dev/null','-w','%{http_code}','--max-time','8',url],undefined,15000).trim()
const sha=x=>JSON.parse(get(x)).sha
const reload=(text,label)=>docker(['exec','-i','hi5central-web','sh','-c',
 'cat >/tmp/'+label+'.Caddyfile && caddy reload --config /tmp/'+label+'.Caddyfile --adapter caddyfile'],
 text,75000)
const originalActive=active(),originalDisk=onDisk()
const activeHash=hash(originalActive),diskHash=hash(originalDisk)
const oldAdmin='reverse_proxy hi5central-admin-preview-cc516180:80'
const origin='api.hi5central.com {'
const workerApiLine='    # HI5C WORKER AUDIT CANARY BEGIN'
const adminBlock=[
 workerApiLine,
 '    @h5WorkerAudit path /api/platform/v1/releases/worker-activity /api/platform/v1/releases/worker-activity/*',
 '    handle @h5WorkerAudit {',
 '        reverse_proxy '+api+':3001',
 '    }',
 '    # HI5C WORKER AUDIT CANARY END',
].join('\n')+'\n'
function mutate(config){
 if(config.includes(workerApiLine)
  ||config.split(oldAdmin).length!==2
  ||config.split(origin).length!==2)
  throw Error('Admin/API Caddyfile unexpectedly changed since preflight.')
 return config.replace(oldAdmin,'reverse_proxy '+web+':80')
   .replace(origin,origin+'\n'+adminBlock)
}
function validate(config){
 const json=JSON.parse(docker(['run','--rm','-i','--network','none','--entrypoint','sh',
 'deployment-web','-c',
 'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile'],config))
 const routes=Object.values(json.apps.http.servers).flatMap(s=>s.routes||[])
 const admin=routes.find(r=>JSON.stringify(r.match||[]).includes('"admin.hi5central.com"'))
 const apiSite=routes.find(r=>JSON.stringify(r.match||[]).includes('"api.hi5central.com"'))
 if(!admin||!apiSite||!JSON.stringify(admin).includes(web+':80')
   ||!JSON.stringify(apiSite).includes(api+':3001'))
   throw Error('Caddy adapted routes do not target exact Admin/frontend and audit API.')
}
function routeIsEnabled(){
 const config=liveJson()
 return config.includes(api+':3001')&&config.includes(web+':80')
}
let changedHost=false,changedLive=false,watchdog=false,complete=false
let managedBefore,customBefore,rootBefore
function restore(){
 let failure
 try{volumeCmd('set -eu; cat /backup/'+prefix+'.disk.Caddyfile > /host/Caddyfile')}catch(e){failure=e}
 try{reload(volumeCmd('cat /backup/'+prefix+'.live.Caddyfile'),'h5c-admin-restore-'+stamp)}catch(e){failure ||= e}
 if(failure)throw failure
 changedHost=false;changedLive=false
 if(hash(active())!==activeHash||hash(onDisk())!==diskHash||routeIsEnabled())
  throw Error('Original staff Admin gateway sources were not recovered.')
 if(sha('https://h5c-managed-qa26.hi5central.com/release-manifest.json')!==managedBefore
  ||sha('https://h5c-custom-qa26.hi5central.com/release-manifest.json')!==customBefore)
  throw Error('Unrelated tenant routing changed while restoring Admin.')
}
try{
 const check=docker(['exec','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT paused FROM platform_release_rollout_control WHERE singleton=true;"']).trim()
 if(check!=='t')throw Error('Global rollout pause required to update staff Admin safely.')
 if(routeIsEnabled())throw Error('Staff Admin audit route is already active.')
 for(const [name,kind] of [[api,'api'],[web,'admin']]){
  const c=JSON.parse(docker(['inspect',name]))[0]
  if(c.State.Health?.Status!=='healthy'||!c.Config.Image.endsWith(target))
   throw Error('Official Admin '+kind+' canary missing or unhealthy.')
 }
 managedBefore=sha('https://h5c-managed-qa26.hi5central.com/release-manifest.json')
 customBefore=sha('https://h5c-custom-qa26.hi5central.com/release-manifest.json')
 rootBefore=sha('https://api.hi5central.com/api/v1/updates/version')
 const newActive=mutate(originalActive),newDisk=mutate(originalDisk)
 validate(newActive);validate(newDisk)
 docker(['volume','create',volume])
 volumeCmd('cat > /backup/'+prefix+'.live.Caddyfile; chmod 600 /backup/'+prefix+'.live.Caddyfile',originalActive)
 volumeCmd('cat > /backup/'+prefix+'.disk.Caddyfile; chmod 600 /backup/'+prefix+'.disk.Caddyfile',originalDisk)
 if(hash(volumeCmd('cat /backup/'+prefix+'.live.Caddyfile'))!==activeHash
  ||hash(volumeCmd('cat /backup/'+prefix+'.disk.Caddyfile'))!==diskHash)
  throw Error('Dual Caddy recovery snapshot checksum mismatch.')
 console.log('ADMIN_AUDIT_ROLLBACK_SNAPSHOTS',prefix,'active='+activeHash,'disk='+diskHash)
 const watch='sleep 150; if [ ! -e /backup/'+prefix+'.done ]; then '+
  'cat /backup/'+prefix+'.disk.Caddyfile > /host/Caddyfile; '+
  "docker exec -i hi5central-web sh -c 'cat >/tmp/h5c-admin-autorevert-"+stamp+
  ".Caddyfile && caddy reload --config /tmp/h5c-admin-autorevert-"+stamp+
  ".Caddyfile --adapter caddyfile' </backup/"+prefix+
  '.live.Caddyfile >/dev/null 2>&1 || true; fi'
 docker(['run','-d','--rm','--name',guard,'--network','none',
  '--mount','type=bind,source='+diskPath+',target=/host/Caddyfile',
  '--mount','type=volume,source='+volume+',target=/backup',
  '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  'docker:27-cli','sh','-c',watch])
 watchdog=true
 volumeCmd('set -eu; cmp /host/Caddyfile /backup/'+prefix+'.disk.Caddyfile; cat > /host/Caddyfile',newDisk)
 changedHost=true
 reload(newActive,'h5c-admin-worker-'+stamp)
 changedLive=true
 if(!routeIsEnabled())throw Error('Live Caddy runtime did not enable staff Admin audit route.')
 if(sha('https://admin.hi5central.com/release-manifest.json')!==target)
  throw Error('Public Admin frontend did not switch to exact official image.')
 if(status('https://api.hi5central.com/api/platform/v1/releases/worker-activity')!=='401')
  throw Error('Cross-tenant staff audit endpoint not protected by authentication.')
 if(sha('https://api.hi5central.com/api/v1/updates/version')!==rootBefore)
  throw Error('Shared Production API was incorrectly upgraded.')
 if(sha('https://h5c-managed-qa26.hi5central.com/release-manifest.json')!==managedBefore
  ||sha('https://h5c-custom-qa26.hi5central.com/release-manifest.json')!==customBefore)
  throw Error('Managed/Custom Production tenant version changed.')
 console.log('WORKER_AUDIT_PUBLIC_CANARY_PASS',target)
 if(mode==='--rehearse'){
  restore();console.log('WORKER_AUDIT_DUAL_SOURCE_ROLLBACK_PASS',activeHash,diskHash)
 }else console.log('WORKER_AUDIT_ADMIN_CENTRE_ENABLED',target)
 volumeCmd('touch /backup/'+prefix+'.done')
 complete=true
}catch(e){
 console.error('WORKER_AUDIT_CANARY_FAILED',e.message)
 if(changedHost||changedLive)try{restore();console.error('ADMIN_AUDIT_ROLLBACK_PASS')}
   catch(err){console.error('ADMIN_AUDIT_ROLLBACK_UNCONFIRMED_WATCHDOG_ARMED',err.message)}
 process.exitCode=1
}finally{
 if(watchdog&&(!changedHost&&!changedLive||complete))
   try{docker(['stop','-t','1',guard])}catch{}
}
