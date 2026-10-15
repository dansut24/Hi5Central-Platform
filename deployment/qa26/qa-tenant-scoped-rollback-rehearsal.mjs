#!/usr/bin/env node
// Real QA Test rollback rehearsal of ONLY ONE tenant, then restore the entire
// pre-rehearsal gateway state. The peer must stay on its current release at
// every step. All changes run against the real VPS Docker daemon.
// This proves scoped rollback; it does NOT change any durable rollout job.
import {spawnSync} from 'node:child_process'
import {QA_HOSTS,removeQaTenantVersionOverride,checksum} from './qa-tenant-scoped-route.mjs'
const allowed=[...QA_HOSTS.keys()]
const host=process.argv[2]
const apply=process.argv[3]==='--apply'
if(!allowed.includes(host)||!['--rehearse','--apply'].includes(process.argv[3]))
  throw Error('Usage: node qa-tenant-scoped-rollback-rehearsal.mjs <exact-qa-host> --rehearse|--apply')
const peer=allowed.find(v=>v!==host)
const originalSha='ddbb869e228ac0d78d3a985daba3fb7059bb0530'
const fallbackSha='9041ed0fc0908badfd1ceb9d638215caef5e431b'
const gateway='hi5central-test-gateway'
const configVolume='hi5central-test_gateway_runtime_config'
const backupVolume='hi5central_qa_route_rollback_backups'
const backup='test-scoped-rehearsal-'+Date.now()+'.Caddyfile'
const watchdog='h5c-test-scoped-route-watch-'+Date.now()
const call=(args,input)=>{
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024})
 if(r.status!==0)throw Error('docker error: '+(r.stderr||r.stdout||'').slice(-600))
 return r.stdout
}
const sql=query=>call(['exec','-i','hi5central-postgres','sh','-c',
 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],query).trim()
const publicSha=host=>{
 const r=spawnSync('curl',['-fsS','--max-time','8','https://'+host+'/api/v1/updates/version'],
 {encoding:'utf8',timeout:10000})
 if(r.status!==0)throw Error('Public route unavailable for '+host)
 return JSON.parse(r.stdout).sha
}
const gatewayBytes=()=>call(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
const volumeExec=(cmd,input)=>call(['run','--rm','-i','--network','none',
  '--mount','type=volume,source='+configVolume+',target=/gateway',
  '--mount','type=volume,source='+backupVolume+',target=/backup',
  'busybox:1.36','sh','-c',cmd],input)
const validate=caddy=>call(['run','--rm','-i','--network','none',
 '--entrypoint','sh','caddy:2.11.4-alpine','-c',
 'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],caddy)
let armed=false,modified=false,restored=false,complete=false
const restore=()=>{
 volumeExec('set -e; cp /backup/'+backup+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile')
 call(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
 modified=false
 if(publicSha(host)!==originalSha||publicSha(peer)!==originalSha)
   throw Error('Gateway rollback did not restore both current SHA values.')
 restored=true
}
try{
 if(sql('SELECT paused FROM platform_release_rollout_control WHERE singleton=true;')!=='t')
  throw Error('Global rollout switch is not paused.')
 const old=gatewayBytes(),before=checksum(old)
 if(publicSha(host)!==originalSha||publicSha(peer)!==originalSha)
  throw Error('Both current tenant routes must serve the same official QA release.')
 const plan=removeQaTenantVersionOverride({config:old,host})
 validate(plan.config)
 volumeExec('set -eu; cat > /backup/'+backup+'; chmod 600 /backup/'+backup,
   old)
 const saved=volumeExec('cat /backup/'+backup)
 if(checksum(saved)!==before)throw Error('Backup bytes mismatch.')
 // Independent TTL watchdog. The recovery volume remains after the test.
 const script='sleep 120; if [ ! -e /backup/'+backup+'.done ]; then '+
    'cp /backup/'+backup+' /gateway/Caddyfile; '+
    'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi'
 call(['run','-d','--rm','--name',watchdog,'--network','none',
    '--mount','type=volume,source='+configVolume+',target=/gateway',
    '--mount','type=volume,source='+backupVolume+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',script])
 armed=true
 // CAS: byte-for-byte original snapshot must still be active.
 volumeExec('set -eu; cmp /gateway/Caddyfile /backup/'+backup+
    '; cat > /gateway/Caddyfile',plan.config)
 modified=true
 call(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
 if(publicSha(host)!==fallbackSha||publicSha(peer)!==originalSha)
  throw Error('Scoped rollback did not isolate the selected tenant.')
 console.log('SCOPED_ROLLBACK_VERIFIED',host,'->',fallbackSha.slice(0,8),'peer',originalSha.slice(0,8))
 if(!apply){
   restore()
   if(checksum(gatewayBytes())!==before)throw Error('Final gateway checksum mismatch.')
   console.log('RESTORED_BOTH_TENANTS',originalSha)
 }else{
   console.log('SCOPED_ROLLBACK_APPLIED',host,'previous='+fallbackSha,'peer='+originalSha)
 }
 volumeExec('touch /backup/'+backup+'.done')
 complete=true
 console.log('RESTORE_SNAPSHOT',backup,'sha256',before)
}catch(error){
 console.error('SCOPED_ROLLBACK_TEST_FAILED',error.message)
 if(modified)try{restore();console.error('FULL_CURRENT_STATE_RECOVERED')}catch(e){
   console.error('RECOVERY_FAILED_WATCHDOG_ACTIVE',e.message)}
 process.exitCode=1
}finally{
 if(armed&&(!modified||complete))try{call(['stop','-t','1',watchdog])}catch{}
}
