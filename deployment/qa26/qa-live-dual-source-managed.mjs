#!/usr/bin/env node
/**
 * QA26 shared Production gateway canary with DUAL-SOURCE rollback.
 * The running Caddy container may bind an older inode than the present
 * /opt/hi5central/deployment/Caddyfile (atomic replacement by operations).
 *
 * Both originals are backed up independently. The disk config is staged
 * for eventual restart; the running config is loaded from a Caddy temp file.
 * An independent Docker watcher restores BOTH if the process is interrupted.
 * --rehearse always rolls back even on success. --apply requires an explicit
 * QA-only approval env flag and is intended only for a gated rollout worker.
 */
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const [sha,mode]=process.argv.slice(2)
const TARGET='4a363cf9054b0b3667fd450f36e354b704ec2166'
if(sha!==TARGET||!['--rehearse','--apply'].includes(mode))
  throw Error('Usage: node qa-live-dual-source-managed.mjs 4a363...<sha40> --rehearse|--apply')
const hostname='h5c-managed-qa26.hi5central.com'
const peer='h5c-custom-qa26.hi5central.com'
const diskPath='/opt/hi5central/deployment/Caddyfile'
const vol='hi5central_qa_live_route_rollback_backups'
const stamp=Date.now(),prefix='managed-live-'+stamp
const guard='h5c-managed-dual-restore-'+stamp
const testUrl='https://'+hostname+'/api/v1/updates/version'
const hash=s=>createHash('sha256').update(s).digest('hex')
const d=(args,input,timeout=75000)=>{
 const p=spawnSync('docker',args,{input,encoding:'utf8',timeout,maxBuffer:15*1024*1024})
 if(p.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+': '+String(p.stderr||p.stdout||'').slice(-500))
 return p.stdout
}
const envSql=query=>d(['exec','-i','hi5central-postgres','sh','-c',
 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At -v ON_ERROR_STOP=1'],query).trim()
const live=()=>d(['exec','hi5central-web','cat','/etc/caddy/Caddyfile'])
const helper=(script,input)=>d(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+diskPath+',target=/host/Caddyfile',
 '--mount','type=volume,source='+vol+',target=/backup',
 'busybox:1.36','sh','-c',script],input)
const disk=()=>helper('cat /host/Caddyfile')
const liveRuntime=()=>JSON.parse(d(['exec','hi5central-web','wget',
 '-q','-O','-','http://127.0.0.1:2019/config/']))
const hasExactRelease=()=>{
 const json=JSON.stringify(liveRuntime())
 return json.includes('hi5pool-live-qa-release-4a363cf9054b-api:3001')
  &&json.includes('hi5pool-live-qa-release-4a363cf9054b-web:80')
  &&json.includes('h5c-managed-qa26.hi5central.com')
}
const publicGet=url=>{
 const p=spawnSync('curl',['-fsS','--max-time','8',url],{encoding:'utf8',timeout:12000})
 if(p.status!==0)throw Error('Unreachable external QA endpoint '+url)
 return p.stdout
}
const json=url=>JSON.parse(publicGet(url))
const pause=()=>envSql('SELECT paused FROM platform_release_rollout_control WHERE singleton=true;')
const hashCode=config=>{
 const p=spawnSync('docker',['run','--rm','-i','--network','none','--entrypoint','sh',
 'deployment-web','-c','cat >/tmp/QA-Caddyfile && caddy adapt --config /tmp/QA-Caddyfile --adapter caddyfile'],
 {input:config,encoding:'utf8',timeout:60000,maxBuffer:15*1024*1024})
 if(p.status!==0)throw Error('Caddy did not adapt QA proposed config: '+p.stderr.slice(-600))
 const adapted=JSON.parse(p.stdout)
 const site=Object.values(adapted.apps.http.servers).flatMap(s=>s.routes||[])
  .find(r=>JSON.stringify(r.match||[]).includes('*.hi5central.com'))
 const rules=site?.handle?.[0]?.routes||[]
 const exact=rules.findIndex(r=>JSON.stringify(r.match||[])==='[{"host":["'+hostname+'"]}]')
 const currentQA=rules.findIndex(r=>JSON.stringify(r.match||[]).includes('h5c-custom-qa26.hi5central.com'))
 if(exact<0||currentQA<0||exact>=currentQA)
   throw Error('Exact QA Managed Production route lost priority under Caddy adapt.')
 return hash(config)
}
const configBlock=[
'    # QA26 LIVE CANARY BEGIN - exact Managed QA host, no other tenant',
'    @qa26ManagedLiveRelease host '+hostname,
'    handle @qa26ManagedLiveRelease {',
'        @qaManagedApi path /api/*',
'        handle @qaManagedApi {',
'            reverse_proxy hi5pool-live-qa-release-4a363cf9054b-api:3001',
'        }',
'        handle {',
'            reverse_proxy hi5pool-live-qa-release-4a363cf9054b-web:80',
'        }',
'    }',
'    # QA26 LIVE CANARY END',
].join('\n')+'\n\n'
function proposed(before){
 const anchor='    # Isolated QA onboarding recovery frontend; other customers untouched.'
 if(before.split(anchor).length!==2||before.includes('QA26 LIVE CANARY BEGIN'))
   throw Error('Gateway already has a QA canary, or the canonical insertion point changed.')
 return before.replace(anchor,configBlock+anchor)
}
function reload(config,label){
 // Does not write to read-only /etc/caddy/Caddyfile bind inode. Caddy accepts
 // admin reload from a validated ephemeral in-container file.
 d(['exec','-i','hi5central-web','sh','-c',
   'cat > /tmp/'+label+'.Caddyfile && caddy reload --config /tmp/'+label+'.Caddyfile --adapter caddyfile'],
   config,90000)
}
function initial(){
 if(pause()!=='t')throw Error('Global kill switch must be enabled for manual QA rehearsal.')
 const imagePair=['api','web'].map(role=>{
   const c='hi5pool-live-qa-release-4a363cf9054b-'+role
   return JSON.parse(d(['inspect',c]))[0]
 })
 if(imagePair.some(x=>!x.Config.Image.endsWith(sha)||x.State.Health?.Status!=='healthy'))
   throw Error('Official release pool not healthy or missing exact revision.')
}
let armed=false,hostChanged=false,liveChanged=false,done=false
const sourceLive=live(),sourceDisk=disk()
const liveBefore=hash(sourceLive),diskBefore=hash(sourceDisk)
let peerBefore,prodApiBefore
function restore(){
 // Revert BOTH resources independently, even if the second reload fails.
 let failure=null
 try{
   helper('set -eu; cat /backup/'+prefix+'.disk.Caddyfile > /host/Caddyfile')
 }catch(e){failure=e}
 try{
   const original=helper('cat /backup/'+prefix+'.live.Caddyfile')
   reload(original,'QA-restore-'+stamp)
 }catch(e){failure=errorOrFirst(failure,e)}
 if(failure)throw failure
 if(hasExactRelease())
   throw Error('Caddy live admin configuration still routes Managed QA to new release.')
 const publicPrevious=json('https://h5c-managed-qa26.hi5central.com/release-manifest.json').sha
 if(publicPrevious==='4a363cf9054b0b3667fd450f36e354b704ec2166')
   throw Error('Public Managed QA remains on the candidate after rollback.')
 hostChanged=false;liveChanged=false
 if(hash(live())!==liveBefore||hash(disk())!==diskBefore)
   throw Error('Rollback hashes differ from separately preserved originals.')
 if(json('https://'+peer+'/release-manifest.json').sha!==peerBefore)
   throw Error('Custom Production peer changed after recovery.')
}
function errorOrFirst(a,b){return a||b}
try{
 initial()
 if(mode==='--apply'&&process.env.H5C_QA_MANAGED_PROD_APPROVED!=='yes')
   throw Error('Persisting a QA Production route requires explicit operator approval.')
 peerBefore=json('https://'+peer+'/release-manifest.json').sha
 prodApiBefore=json('https://api.hi5central.com/api/v1/updates/version').sha
 if(hasExactRelease())
   throw Error('Live Caddy already has candidate route; deployment state was not clean.')
 const nextLive=proposed(sourceLive),nextDisk=proposed(sourceDisk)
 hashCode(nextLive);hashCode(nextDisk)
 d(['volume','create',vol])
 helper('cat > /backup/'+prefix+'.live.Caddyfile && chmod 600 /backup/'+prefix+'.live.Caddyfile',sourceLive)
 helper('cat > /backup/'+prefix+'.disk.Caddyfile && chmod 600 /backup/'+prefix+'.disk.Caddyfile',sourceDisk)
 if(hash(helper('cat /backup/'+prefix+'.live.Caddyfile'))!==liveBefore
   ||hash(helper('cat /backup/'+prefix+'.disk.Caddyfile'))!==diskBefore)
   throw Error('Dual-source backups failed integrity verification.')
 console.log('LIVE_BEFORE_SHA256',liveBefore)
 console.log('HOST_DISK_BEFORE_SHA256',diskBefore)
 console.log('RECOVERY_SNAPSHOTS',prefix+'.live.Caddyfile',prefix+'.disk.Caddyfile')
 // Watchdog reverts both independently if Node crashes after either update.
 const watcher='sleep 155; if [ ! -e /backup/'+prefix+'.done ]; then '+
  'cat /backup/'+prefix+'.disk.Caddyfile > /host/Caddyfile; '+
  "docker exec -i hi5central-web sh -c 'cat >/tmp/qa-dual-restore-"+stamp+".Caddyfile && caddy reload --config /tmp/qa-dual-restore-"+stamp+".Caddyfile --adapter caddyfile'"+
  ' </backup/'+prefix+'.live.Caddyfile >/dev/null 2>&1 || true; fi'
 d(['run','-d','--rm','--name',guard,'--network','none',
   '--mount','type=bind,source='+diskPath+',target=/host/Caddyfile',
   '--mount','type=volume,source='+vol+',target=/backup',
   '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
   'docker:27-cli','sh','-c',watcher])
 armed=true
 // Compare-and-swap to avoid overwriting a concurrent deploy/edit.
 helper('set -eu; cmp /host/Caddyfile /backup/'+prefix+'.disk.Caddyfile; cat >/host/Caddyfile',nextDisk)
 hostChanged=true
 reload(nextLive,'QA-release-'+stamp)
 liveChanged=true
 if(!hasExactRelease())throw Error('Live Caddy admin JSON did not activate the exact QA route.')
 if(json(testUrl).sha!==sha || json('https://'+hostname+'/release-manifest.json').sha!==sha)
   throw Error('Public QA Managed Live frontend and API revision mismatch.')
 const cfg=publicGet('https://'+hostname+'/runtime-config.js')
 if(!cfg.includes('apiUrl: "" || window.location.origin'))
   throw Error('QA Managed Production frontend does not use same-origin API.')
 const session=spawnSync('curl',['-sS','-o','/dev/null','-w','%{http_code}',
 '--max-time','8','https://'+hostname+'/api/v1/auth/session'],{encoding:'utf8',timeout:12000})
 if(session.status!==0||session.stdout.trim()!=='401')
   throw Error('Host-only session endpoint not protected.')
 if(json('https://'+peer+'/release-manifest.json').sha!==peerBefore
   ||json('https://api.hi5central.com/api/v1/updates/version').sha!==prodApiBefore)
   throw Error('Shared Live authority or Custom Production changed.')
 console.log('EXACT_MANAGED_QA_PRODUCTION_HTTPS_PASS',sha)
 if(mode==='--rehearse'){
   restore()
   console.log('DUAL_SOURCE_ROLLBACK_PASS',liveBefore,diskBefore)
 }else{
   if(process.env.H5C_QA_MANAGED_PROD_APPROVED!=='yes')
     throw Error('Persisting QA Production requires audited explicit operator approval.')
   console.log('QA_MANAGED_PRODUCTION_APPLIED',sha)
 }
 helper('touch /backup/'+prefix+'.done')
 done=true
}catch(error){
 console.error('QA_MANAGED_PRODUCTION_FAILED',error.message)
 if(hostChanged||liveChanged)try{restore();console.error('DUAL_SOURCE_AUTOMATIC_ROLLBACK_PASS')}
 catch(e){console.error('DUAL_SOURCE_ROLLBACK_UNCONFIRMED_WATCHDOG_ARMED',e.message)}
 process.exitCode=1
}finally{
 if(armed&&(!hostChanged&&!liveChanged||done))try{d(['stop','-t','1',guard])}catch{}
}
