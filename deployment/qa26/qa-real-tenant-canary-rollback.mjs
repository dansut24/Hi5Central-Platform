#!/usr/bin/env node
// Real QA VPS route proof: versioned API+web on Test DB, temporary tenant
// route, HTTP verification and unconditional rollback with independent watchdog.
// No Live DB, public Caddyfile, RMM, UAT or unrelated tenant modifications.
// Run on an authorised host with docker socket access. No env/secrets printed.
import {execFileSync,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const TEST_SHA='9041ed0fc0908badfd1ceb9d638215caef5e431b'
const CANDIDATE_SHA='ddbb869e228ac0d78d3a985daba3fb7059bb0530'
const gateway='hi5central-test-gateway'
const target='h5c-managed-qa26-test.hi5central.com'
const control='h5c-custom-qa26-test.hi5central.com'
const configVolume='hi5central-test_gateway_runtime_config'
const backupVolume='hi5central_qa_route_rollback_backups'
const network='hi5central-test_hi5internal'
const pool='hi5pool-test-qa-rollback-ddbb'
const containers=[pool+'-api',pool+'-web']
const stamp=Date.now().toString()
const stage='h5c-qa-stage-'+stamp
const watchdog='h5c-qa-rollback-watch-'+stamp
const temp=mkdtempSync(join(tmpdir(),'hi5-qa-real-'))
const sha=s=>createHash('sha256').update(s).digest('hex')
let backupName='',watchdogRunning=false,stageExists=false
let changed=false
const run=(args,input)=>{
  const result=spawnSync('docker',args,{encoding:'utf8',input,timeout:120000,
    maxBuffer:16*1024*1024})
  if(result.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+
    ' failed ('+result.status+'): '+String(result.stderr||'').slice(-700))
  return result.stdout.trim()
}
const inspect=name=>JSON.parse(run(['inspect',name]))[0]
const jsonImage=(image)=>{
  const data=JSON.parse(run(['image','inspect',image]))[0]
  if(data.Config?.Labels?.['org.opencontainers.image.revision']!==CANDIDATE_SHA)
    throw Error('Official immutable image revision label mismatch: '+image)
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function publicSha(host,expected,tries=12){
  for(let i=0;i<tries;i++){
    const result=spawnSync('curl',['-fsS','--max-time','7',
      'https://'+host+'/api/v1/updates/version'],{encoding:'utf8',timeout:10000})
    try{
      if(result.status===0&&JSON.parse(result.stdout).sha===expected)return
    }catch{}
    await sleep(850)
  }
  throw Error(host+' did not serve expected SHA '+expected.slice(0,8))
}
function clone(source,name,image,memory){
  const original=inspect(source)
  const spec=original.Config
  const args=['run','-d','--name',name,'--network',network,
    '--restart','no','--memory',memory,'--pids-limit','300',
    '--security-opt','no-new-privileges:true']
  if(spec.User)args.push('--user',spec.User)
  if(spec.WorkingDir)args.push('--workdir',spec.WorkingDir)
  for(const env of spec.Env||[])args.push('--env',env)
  for(const m of original.Mounts||[]){
    if(m.Type!=='volume')throw Error('Unexpected API bind-mount layout.')
    args.push('--mount','type=volume,source='+m.Name+',target='+m.Destination+
      (m.RW?'':',readonly'))
  }
  args.push(image)
  // Official image uses the same image default Entrypoint/Cmd as source.
  run(args)
}
function waitHealthy(name){
  return new Promise(async(resolve,reject)=>{
    for(let i=0;i<35;i++){
      const x=inspect(name)
      const state=x.State?.Health?.Status
      if(state==='healthy'){resolve();return}
      if(state==='unhealthy'||x.State?.Running===false)break
      await sleep(1000)
    }
    reject(Error('Official candidate did not become healthy: '+name))
  })
}
function validated(config){
  const r=spawnSync('docker',['run','--rm','-i','--network','none',
    '--entrypoint','sh','caddy:2.11.4-alpine','-c',
    'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile >/dev/null'],
    {input:config,encoding:'utf8',timeout:45000})
  if(r.status!==0)throw Error('Caddy config invalid: '+(r.stderr||'').slice(-1000))
}
function writeContainerFile(filename,value){
  const path=join(temp,filename)
  writeFileSync(path,value,{mode:0o600})
  run(['cp',path,stage+':/tmp/'+filename])
}
function originalFromVolume(){
  return run(['exec',gateway,'cat','/etc/caddy/Caddyfile'])+'\n'
}
function saveOriginal(config){
  run(['volume','create',backupVolume])
  run(['create','--name',stage,'--network','none',
    '--mount','type=volume,source='+configVolume+',target=/gateway',
    '--mount','type=volume,source='+backupVolume+',target=/backup',
    'busybox:1.36','sleep','900'])
  stageExists=true
  writeContainerFile('expected.Caddyfile',config)
  const script='set -eu; cmp /gateway/Caddyfile /tmp/expected.Caddyfile; '+
    'cp /gateway/Caddyfile /backup/'+backupName+'; '+
    'chmod 0600 /backup/'+backupName+'; '+
    'test -s /backup/'+backupName
  run(['start',stage])
  run(['exec',stage,'sh','-c',script])
}
function startWatchdog(){
  // Independent Docker container restores the original QA gateway even if
  // this Node process/SSH session disappears during the switch.
  const script='sleep 150; if [ ! -e /backup/'+backupName+'.done ]; then '+
    'cp /backup/'+backupName+' /gateway/Caddyfile; '+
    'docker exec '+gateway+' caddy reload --config /etc/caddy/Caddyfile '+
    '--adapter caddyfile >/dev/null 2>&1 || true; '+
    'fi'
  run(['run','-d','--rm','--name',watchdog,'--network','none',
    '--mount','type=volume,source='+configVolume+',target=/gateway',
    '--mount','type=volume,source='+backupVolume+',target=/backup',
    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    'docker:27-cli','sh','-c',script])
  watchdogRunning=true
}
function activate(config){
  writeContainerFile('next.Caddyfile',config)
  run(['exec',stage,'sh','-c',
    'cmp /gateway/Caddyfile /backup/'+backupName+
    ' && cp /tmp/next.Caddyfile /gateway/Caddyfile'])
  changed=true
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
}
function restore(){
  if(!backupName||!stageExists)return
  run(['exec',stage,'sh','-c',
    'cp /backup/'+backupName+' /gateway/Caddyfile'])
  run(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
  changed=false
}
function markRecovered(){
  run(['exec',stage,'sh','-c',
    'touch /backup/'+backupName+'.done'])
}
try{
  const images=[
    'ghcr.io/dansut24/hi5central-platform-api:sha-'+CANDIDATE_SHA,
    'ghcr.io/dansut24/hi5central-platform-itsm:sha-'+CANDIDATE_SHA,
  ]
  for(const image of images)jsonImage(image)
  const baseline=originalFromVolume()
  const baselineHash=sha(baseline)
  const originalTag=inspect('hi5central-test-control-server-1').Config.Image
  if(!originalTag.endsWith(TEST_SHA))throw Error('Unexpected running Test baseline.')
  if(containers.some(name=>{
    try{return Boolean(inspect(name))}catch{return false}
  }))throw Error('Previous QA candidate pool exists: inspect before retry.')
  backupName='test-before-real-route-'+stamp+'.Caddyfile'
  console.log('BASELINE_SHA256 '+baselineHash)
  console.log('WATCHDOG_RESTORE_SOURCE '+backupVolume+'/'+backupName)
  validated(baseline)
  await publicSha(target,TEST_SHA)
  await publicSha(control,TEST_SHA)
  clone('hi5central-test-control-server-1',containers[0],images[0],'512m')
  clone('hi5central-test-itsm-web-1',containers[1],images[1],'256m')
  await Promise.all(containers.map(waitHealthy))
  const needle='http://test.hi5central.com {'
  if(baseline.split(needle).length!==2)throw Error('QA Test site boundary ambiguous.')
  const injection=[
    '  # TEST ONLY: one tenant routed to candidate; everything else stays on the current Test pool',
    '  @qaRealCandidate header X-Forwarded-Host '+target,
    '  handle @qaRealCandidate {',
    '    @qaRealApi path /api/*',
    '    handle @qaRealApi {',
    '      reverse_proxy '+containers[0]+':3001',
    '    }',
    '    handle {',
    '      reverse_proxy '+containers[1]+':80',
    '    }',
    '  }',
  ].join('\n')
  const next=baseline.replace(needle,needle+'\n'+injection)
  validated(next)
  saveOriginal(baseline)
  startWatchdog()
  activate(next)
  console.log('GATEWAY_SWITCH_APPLIED '+target+' -> '+CANDIDATE_SHA.slice(0,8))
  await publicSha(target,CANDIDATE_SHA,20)
  await publicSha(control,TEST_SHA,20)
  console.log('REAL_HOST_HTTP_VERIFIED_TARGET_AND_UNCHANGED_PEER')
  restore()
  await publicSha(target,TEST_SHA,20)
  await publicSha(control,TEST_SHA,20)
  if(sha(originalFromVolume())!==baselineHash)
    throw Error('Restored Caddyfile differs from original.')
  markRecovered()
  console.log('ROLLBACK_PASS original route restored and verified, SHA256 '+baselineHash)
}catch(error){
  console.error('REAL_QA_TEST_FAILURE '+error.message)
  if(changed)try{
    restore()
    await publicSha(target,TEST_SHA,20)
    await publicSha(control,TEST_SHA,20)
    markRecovered()
    console.error('AUTOMATIC_ROLLBACK_CONFIRMED')
  }catch(e){console.error('AUTOMATIC_ROLLBACK_FAILED; independent 150s watchdog still active:',e.message)}
  process.exitCode=1
}finally{
  if(watchdogRunning&&!changed){
    try{run(['stop','-t','1',watchdog])}catch{}
  }
  if(stageExists&&!changed)try{run(['rm','-f',stage])}catch{}
  for(const name of containers){
    if(!changed)try{run(['rm','-f',name])}catch{}
  }
  rmSync(temp,{recursive:true,force:true})
}
