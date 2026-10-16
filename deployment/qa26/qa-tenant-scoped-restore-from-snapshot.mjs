#!/usr/bin/env node
// Safely rollback one QA tenant from its own pre-deployment Caddy snapshot.
// Another tenant may have updated in the interim: its CURRENT route is kept.
import {spawnSync} from 'node:child_process'
import {QA_HOSTS,checksum,restoreQaTenantFromSnapshot} from './qa-tenant-scoped-route.mjs'
const [host,snapshot,expectedCurrent,expectedPrevious]=process.argv.slice(2)
const SHA=/^[a-f0-9]{40}$/
if(!QA_HOSTS.has(host)||!/^test-before-real-route-[0-9]+[.]Caddyfile$/.test(String(snapshot||''))
  ||!SHA.test(String(expectedCurrent||''))||!SHA.test(String(expectedPrevious||'')))
  throw Error('Usage: scoped-restore <qa-test-host> <exact-backup> <current-sha40> <previous-sha40>')
const gateway='hi5central-test-gateway'
const gatewayVol='hi5central-test_gateway_runtime_config'
const backupVol='hi5central_qa_route_rollback_backups'
const stamp=Date.now()
const safety='test-scoped-revert-safety-'+stamp+'.Caddyfile'
const guard='hi5central-scope-guard-'+stamp
const peer=[...QA_HOSTS.keys()].find(x=>x!==host)
const run=(args,input)=>{
  const x=spawnSync('docker',args,{input,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024})
  if(x.status!==0)throw Error('Docker '+args.slice(0,2).join(' ')+' failed: '+String(x.stderr||'').slice(-500))
  return x.stdout
}
const volume=(command,input)=>run(['run','--rm','-i','--network','none',
  '--mount','type=volume,source='+gatewayVol+',target=/gateway',
  '--mount','type=volume,source='+backupVol+',target=/backup',
  'busybox:1.36','sh','-c',command],input)
const route=host=>{
  const x=spawnSync('curl',['-fsS','--max-time','8','https://'+host+'/api/v1/updates/version'],
    {encoding:'utf8',timeout:12000})
  if(x.status!==0)throw Error('Public version request failed for '+host)
  return JSON.parse(x.stdout).sha
}
const gatewayBytes=()=>run(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
let armed=false,changed=false,complete=false,peerSha=null,original=null
function recover(){
  volume('cp /backup/'+safety+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile')
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  changed=false
}
try{
  original=gatewayBytes()
  const oldBackup=volume('test -s /backup/'+snapshot+' && cat /backup/'+snapshot)
  const plan=restoreQaTenantFromSnapshot({current:original,snapshot:oldBackup,host})
  if(route(host)!==expectedCurrent)throw Error('Current tenant SHA differs from expected failed deployment.')
  peerSha=route(peer)
  if(!SHA.test(peerSha))throw Error('Unverified other tenant build revision.')
  run(['run','--rm','-i','--network','none','--entrypoint','sh','caddy:2.11.4-alpine',
      '-c','cat >/tmp/config && caddy adapt --config /tmp/config --adapter caddyfile >/dev/null'],
      plan.config)
  volume('set -eu; cat >/backup/'+safety+'; chmod 600 /backup/'+safety,original)
  if(checksum(volume('cat /backup/'+safety))!==checksum(original))
    throw Error('Scoped rollback safety snapshot is not byte-identical.')
  const timer='sleep 120; if [ ! -e /backup/'+safety+'.done ]; then '+
    'cp /backup/'+safety+' /gateway/Caddyfile; '+
    'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; fi'
  run(['run','-d','--rm','--name',guard,'--network','none',
    '--mount','type=volume,source='+gatewayVol+',target=/gateway',
    '--mount','type=volume,source='+backupVol+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',timer])
  armed=true
  volume('set -eu; cmp /gateway/Caddyfile /backup/'+safety+
    '; cat > /gateway/Caddyfile',plan.config)
  changed=true
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  if(route(host)!==expectedPrevious||route(peer)!==peerSha)
    throw Error('One-tenant recovery did not preserve correct new/peer versions.')
  volume('touch /backup/'+safety+'.done')
  complete=true
  console.log('SCOPED_HOST_ROLLBACK_PASS',host,expectedCurrent.slice(0,12),'->',expectedPrevious.slice(0,12),'peer',peerSha.slice(0,12))
  console.log('ROLLBACK_SAFETY_SNAPSHOT',safety)
}catch(error){
  console.error('SCOPED_HOST_ROLLBACK_FAILED',error.message)
  if(changed)try{recover();console.error('ORIGINAL_GATEWAY_RECOVERED')}
    catch(e){console.error('RECOVERY_WATCHDOG_PENDING',e.message)}
  process.exitCode=1
}finally{
  if(armed&&(!changed||complete))try{run(['stop','-t','1',guard])}catch{}
}
