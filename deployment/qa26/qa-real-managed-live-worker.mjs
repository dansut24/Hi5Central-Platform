#!/usr/bin/env node
import {heartbeat} from './qa-worker-heartbeat.mjs'
// Durable Managed QA Production worker: exact Test-canary release, only named
// QA26 Managed tenant, maintenance window, QA soak/approval, fenced DB lease.
// This is NOT general customer Live automation; remains disabled by default.
import {spawnSync} from 'node:child_process'
import {activeTenantMaintenanceWindow} from '../../services/api/src/releaseRolloutPlanner.js'

const SHA='4a363cf9054b0b3667fd450f36e354b704ec2166'
const REF='qa26-real-dev-4a363cf9054b'
const PREVIOUS='f51d2e634e450e03214f10d845f90f73f7b2d506'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const run=(bin,args,input,ms=30000)=>{
 const p=spawnSync(bin,args,{encoding:'utf8',input,timeout:ms,maxBuffer:3*1024*1024})
 if(p.status!==0)throw Error(bin+' failed: '+String(p.stderr||p.stdout||'').slice(-440))
 return p.stdout.trim()
}
const sql=text=>run('docker',['exec','-i','hi5central-postgres','sh','-c',
 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -t -A -q -v ON_ERROR_STOP=1'],text)
const httpsVersion=url=>JSON.parse(run('curl',['-fsS','--max-time','8',url])).sha
const host='h5c-managed-qa26.hi5central.com'
function claim(){
 const output=sql([
 'BEGIN;',
 'WITH global_switch AS (SELECT singleton FROM platform_release_rollout_control',
 'WHERE singleton=true AND paused=false),',
 'canaries AS (SELECT build_sha FROM tenant_release_rollout_jobs j',
 "JOIN tenants t ON t.id=j.tenant_id WHERE j.environment='test'",
 "AND j.build_sha='"+SHA+"' AND j.status='succeeded'",
 "AND t.slug IN ('h5c-managed-qa26','h5c-custom-qa26')",
 'GROUP BY build_sha HAVING count(DISTINCT t.id)>=2),',
 'pick AS (SELECT j.id FROM tenant_release_rollout_jobs j',
 'JOIN tenants t ON t.id=j.tenant_id',
 'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
 'JOIN global_switch ON true JOIN canaries ON canaries.build_sha=j.build_sha',
 "WHERE j.environment='live' AND j.status='scheduled'",
 "AND j.release_ref='"+REF+"' AND j.build_sha='"+SHA+"'",
 "AND j.previous_build_sha='"+PREVIOUS+"'",
 "AND t.slug='h5c-managed-qa26' AND t.status='active'",
 "AND p.update_mode='hi5_managed' AND p.live_auto_promote=true",
 "AND p.live_delay_hours=0",
 'AND j.scheduled_at<=now() AND j.attempt_count<j.max_attempts',
 'AND EXISTS (SELECT 1 FROM tenant_release_rollout_jobs uat',
 "JOIN tenants custom_t ON custom_t.id=uat.tenant_id",
 "WHERE custom_t.slug='h5c-custom-qa26' AND uat.environment='uat'",
 "AND uat.build_sha=j.build_sha AND uat.status='succeeded')",
 'ORDER BY j.scheduled_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED),',
 'updated AS (UPDATE tenant_release_rollout_jobs j SET',
 "status='running',attempt_count=attempt_count+1,",
 'lease_token=gen_random_uuid(),lease_fence=lease_fence+1,',
 "lease_expires_at=now()+interval '8 minutes',updated_at=now()",
 'FROM pick WHERE j.id=pick.id RETURNING j.*),',
 'events AS (INSERT INTO tenant_release_rollout_events',
 '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
 "SELECT id,tenant_id,environment,build_sha,'claimed',lease_fence,",
 "jsonb_build_object('operator','qa26-real-managed-live-v1','qaOnly',true)",
 'FROM updated RETURNING job_id)',
 'SELECT json_build_object(',
 "'id',j.id,'token',j.lease_token,'fence',j.lease_fence,",
 "'buildSha',j.build_sha,'previous',j.previous_build_sha,",
 "'duration',j.expected_duration_minutes,'expiresAt',j.lease_expires_at,",
 "'maintenance',p.maintenance_window,'blackouts',p.blackout_periods)::text",
 'FROM updated j JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
 'JOIN events e ON e.job_id=j.id;',
 'COMMIT;'
 ].join('\n'))
 if(!output)return null
 const j=JSON.parse(output)
 if(!UUID.test(String(j.id))||!UUID.test(String(j.token))
  ||!Number.isSafeInteger(Number(j.fence))||j.buildSha!==SHA||j.previous!==PREVIOUS)
  throw Error('Managed Live job mismatched exact allowlist or lease fence.')
 return j
}
function finish(job,outcome,details={}){
 if(!UUID.test(String(job.id))||!UUID.test(String(job.token))
   ||!['succeeded','failed','rolled_back'].includes(outcome))
   throw Error('Invalid Managed Production completion.')
 const fence=Number(job.fence),json=JSON.stringify(details)
 if(!Number.isSafeInteger(fence)||fence<=0
   ||json.length>1200||!/^[A-Za-z0-9 _.,{}":-]*$/.test(json))
   throw Error('Invalid managed release audit metadata.')
 const event=outcome==='succeeded'?'verified':outcome
 const result=sql([
  'BEGIN;',
  'WITH updated AS (UPDATE tenant_release_rollout_jobs',
  "SET status='"+outcome+"',lease_token=NULL,lease_expires_at=NULL,",
  'completed_at=now(),updated_at=now()',
  "WHERE id='"+job.id+"' AND status='running'",
  "AND lease_token='"+job.token+"' AND lease_fence="+fence,
  'AND lease_expires_at>now()',
  'RETURNING id,tenant_id,environment,build_sha,lease_fence),',
  'events AS (INSERT INTO tenant_release_rollout_events',
  '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
  "SELECT id,tenant_id,environment,build_sha,'"+event+"',lease_fence,",
  "'"+json+"'::jsonb FROM updated RETURNING job_id)",
  'SELECT count(*) FROM updated JOIN events ON events.job_id=updated.id;',
  'COMMIT;'
 ].join('\n'))
 if(result!=='1')throw Error('Managed Live durable completion rejected stale lease.')
}
async function execute(){
 const j=claim()
 if(!j){console.log('NO_DUE_MANAGED_QA_LIVE_JOB_OR_PAUSED');return}
 console.log('CLAIMED_REAL_MANAGED_LIVE_JOB',j.id,SHA.slice(0,12))
 let snapshot=null
 try{
  const window=activeTenantMaintenanceWindow({
   policy:j.maintenance,now:new Date(),durationMinutes:Number(j.duration),
   blackouts:j.blackouts,
  })
  if(!window.allowed)throw Error('Not inside Managed tenant maintenance window: '+window.reason)
  if(new Date(j.expiresAt)<=new Date())throw Error('Leased job timed out.')
  if(httpsVersion('https://dev-api.hi5central.com/api/v1/updates/version')!==SHA
   ||httpsVersion('https://h5c-managed-qa26-test.hi5central.com/api/v1/updates/version')!==SHA
   ||httpsVersion('https://h5c-custom-qa26-test.hi5central.com/api/v1/updates/version')!==SHA
   ||httpsVersion('https://h5c-custom-qa26-uat.hi5central.com/api/v1/updates/version')!==SHA)
   throw Error('Expected Dev/Test/UAT canary revision not currently served.')
  if(httpsVersion('https://'+host+'/release-manifest.json')!==PREVIOUS)
   throw Error('Managed Production previous frontend changed: refusing cutover.')
  const p=spawnSync('node',
   ['deployment/qa26/qa-live-dual-source-managed.mjs',SHA,'--apply'],
   {encoding:'utf8',timeout:200000,maxBuffer:3*1024*1024,
    env:{...process.env,H5C_QA_MANAGED_PROD_APPROVED:'yes'}})
  for(const line of String(p.stdout||'').split('\n')){
   const match=line.match(/^RECOVERY_SNAPSHOTS (managed-live-[0-9]{12,16})[.]live[.]Caddyfile/)
   if(match)snapshot=match[1]
   if(line.startsWith('QA_MANAGED_PRODUCTION_APPLIED'))console.log(line)
  }
  if(p.status!==0)throw Error('Host Managed canary returned error: '+String(p.stderr||'').slice(-320))
  if(!/^managed-live-[0-9]{12,16}$/.test(String(snapshot||'')))
   throw Error('Managed Production gateway snapshot missing.')
  if(httpsVersion('https://'+host+'/api/v1/updates/version')!==SHA
    ||httpsVersion('https://'+host+'/release-manifest.json')!==SHA)
   throw Error('Public Managed Production release attestation failed after cutover.')
  finish(j,'succeeded',{snapshot,tenant:'h5c-managed-qa26',qaOnly:true})
  console.log('MANAGED_QA_LIVE_DURABLE_SUCCESS',j.id,snapshot)
 }catch(error){
  console.error('MANAGED_QA_LIVE_FAILED',j.id,error.message)
  let restored=false
  if(snapshot&&httpsVersion('https://'+host+'/release-manifest.json')===SHA)
   try{run('node',['deployment/qa26/qa-live-dual-source-restore.mjs',snapshot],undefined,120000);restored=true}
   catch(e){console.error('MANAGED_PROD_SCOPED_RESTORE_FAILED',e.message)}
  else
   try{restored=httpsVersion('https://'+host+'/release-manifest.json')===PREVIOUS}
   catch{}
  try{finish(j,restored?'rolled_back':'failed',{reason:'qa-managed-live-execution-error'})}
  catch(e){console.error('MANAGED_LIVE_DB_FINISH_FAILED',e.message)}
  throw error
 }
}
const mode=process.argv[2]||'--once'
if(!['--once','--loop'].includes(mode))throw Error('Use --once or --loop.')
do{
 try{heartbeat('qa26-managed-live-release-operator','idle',SHA);await execute()}catch(e){
  console.error('MANAGED_LIVE_WORKER_ERROR',e.message)
  if(mode==='--once')process.exitCode=1
 }
 if(mode==='--loop')await sleep(30000)
}while(mode==='--loop')
