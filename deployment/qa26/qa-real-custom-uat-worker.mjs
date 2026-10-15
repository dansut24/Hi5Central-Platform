#!/usr/bin/env node
// A dedicated, durable QA UAT operator. NEVER touches Managed UAT, Live, RMM.
// A matching, verified Test rollout with 2-minute QA-specific soak must
// succeed before the Custom UAT job may be claimed from the shared queue.
import {spawnSync} from 'node:child_process'
import {activeTenantMaintenanceWindow} from '../../services/api/src/releaseRolloutPlanner.js'

const TARGET=process.env.H5C_QA_TARGET_SHA
const PREVIOUS=process.env.H5C_QA_PREVIOUS_SHA
const REF=process.env.H5C_QA_RELEASE_REF
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SNAP=/^uat-before-real-route-[0-9]+[.]Caddyfile$/
if(!SHA.test(String(TARGET||''))||!SHA.test(String(PREVIOUS||''))
  ||REF!=='qa26-real-dev-'+TARGET.slice(0,12))
  throw Error('Exact approved Dev release and prior version are required.')
const TEST_HOST='https://h5c-custom-qa26-test.hi5central.com/api/v1/updates/version'
const UAT_HOST='https://h5c-custom-qa26-uat.hi5central.com/api/v1/updates/version'
const CENTRAL_UAT='https://uat-api.hi5central.com/api/v1/updates/version'
const command=(binary,args,input,timeout=30000)=>{
  const r=spawnSync(binary,args,{encoding:'utf8',input,timeout,maxBuffer:1024*1024})
  if(r.status!==0)throw Error(binary+' failed: '+String(r.stderr||r.stdout||'').slice(-500))
  return r.stdout.trim()
}
const sql=query=>command('docker',['exec','-i','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -A -t -v ON_ERROR_STOP=1'],query)
const http=url=>JSON.parse(command('curl',['-fsS','--max-time','8',url])).sha
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function claim(){
  const output=sql([
    'BEGIN;',
    'WITH guard AS (SELECT singleton FROM platform_release_rollout_control',
    'WHERE singleton=true AND paused=false),',
    'pick AS (SELECT j.id FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
    'JOIN guard ON true',
    "WHERE j.status='scheduled' AND j.environment='uat'",
    "AND j.release_ref='"+REF+"'",
    "AND j.build_sha='"+TARGET+"'",
    "AND j.previous_build_sha='"+PREVIOUS+"'",
    "AND t.slug='h5c-custom-qa26' AND t.status='active'",
    "AND p.update_mode='admin_controlled'",
    'AND j.scheduled_at<=now() AND j.attempt_count<j.max_attempts',
    'AND EXISTS (SELECT 1 FROM tenant_release_rollout_jobs jt',
    'WHERE jt.tenant_id=j.tenant_id AND jt.environment=\'test\'',
    'AND jt.build_sha=j.build_sha AND jt.status=\'succeeded\'',
    "AND jt.completed_at<=now()-interval '2 minutes')",
    'ORDER BY j.scheduled_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED),',
    'claimed AS (UPDATE tenant_release_rollout_jobs j SET',
    "status='running',attempt_count=attempt_count+1,",
    'lease_token=gen_random_uuid(),lease_fence=lease_fence+1,',
    "lease_expires_at=now()+interval '8 minutes',updated_at=now()",
    'FROM pick WHERE j.id=pick.id RETURNING j.*),',
    'audit AS (INSERT INTO tenant_release_rollout_events',
    '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
    "SELECT id,tenant_id,environment,build_sha,'claimed',lease_fence,",
    "jsonb_build_object('operator','qa26-real-custom-uat-v1') FROM claimed",
    'RETURNING job_id)',
    'SELECT json_build_object(',
    "'id',c.id,'tenantId',c.tenant_id,'environment',c.environment,",
    "'buildSha',c.build_sha,'previousSha',c.previous_build_sha,",
    "'duration',c.expected_duration_minutes,'token',c.lease_token,",
    "'fence',c.lease_fence,'expiresAt',c.lease_expires_at,",
    "'maintenance',p.maintenance_window,'blackouts',p.blackout_periods)::text",
    'FROM claimed c JOIN tenant_release_preferences p ON p.tenant_id=c.tenant_id',
    'JOIN audit a ON a.job_id=c.id;',
    'COMMIT;',
  ].join('\n'))
  if(!output)return null
  const j=JSON.parse(output)
  if(!UUID.test(String(j.id||''))||!UUID.test(String(j.tenantId||''))
    ||!UUID.test(String(j.token||''))||!Number.isSafeInteger(Number(j.fence))
    ||j.environment!=='uat'||j.buildSha!==TARGET||j.previousSha!==PREVIOUS)
    throw Error('Leased job identity or release does not match expected Custom UAT.')
  return j
}
function finish(job,outcome,details={}){
  if(!['succeeded','failed','rolled_back'].includes(outcome)
    ||!UUID.test(String(job.id))||!UUID.test(String(job.token)))
    throw Error('Invalid completion identity.')
  const fence=Number(job.fence)
  if(!Number.isSafeInteger(fence)||fence<1)throw Error('Invalid lease fence.')
  const json=JSON.stringify(details)
  if(!/^[A-Za-z0-9 _.,{}":-]*$/.test(json)||json.length>1400)
    throw Error('Invalid audit details.')
  const event=outcome==='succeeded'?'verified':outcome
  const result=sql([
    'BEGIN;',
    'WITH updated AS (UPDATE tenant_release_rollout_jobs SET',
    "status='"+outcome+"',lease_token=NULL,lease_expires_at=NULL,",
    'completed_at=now(),updated_at=now()',
    "WHERE id='"+job.id+"' AND status='running'",
    "AND lease_token='"+job.token+"' AND lease_fence="+fence,
    'AND lease_expires_at>now()',
    'RETURNING id,tenant_id,environment,build_sha,lease_fence),',
    'audit AS (INSERT INTO tenant_release_rollout_events',
    '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
    "SELECT id,tenant_id,environment,build_sha,'"+event+"',lease_fence,",
    "'"+json+"'::jsonb FROM updated RETURNING job_id)",
    'SELECT count(*) FROM updated JOIN audit ON audit.job_id=updated.id;',
    'COMMIT;',
  ].join('\n'))
  if(result!=='1')throw Error('UAT durable completion rejected stale lease: '+result)
}
async function execute(){
  const job=claim()
  if(!job){console.log('NO_DUE_CUSTOM_UAT_JOB_OR_PAUSED');return}
  console.log('CLAIMED_CUSTOM_UAT_JOB',job.id,job.buildSha.slice(0,12))
  let backup=null
  try{
    const window=activeTenantMaintenanceWindow({
      policy:job.maintenance,now:new Date(),
      durationMinutes:Number(job.duration),blackouts:job.blackouts,
    })
    if(!window.allowed)throw Error('Outside active UAT window: '+window.reason)
    if(new Date(job.expiresAt)<=new Date())throw Error('Worker lease expired.')
    if(http(TEST_HOST)!==TARGET||http(UAT_HOST)!==PREVIOUS
      ||http(CENTRAL_UAT)!==PREVIOUS
      ||http('https://dev-api.hi5central.com/api/v1/updates/version')!==TARGET)
      throw Error('Actual Dev/Test/UAT release versions fail strict promotion preflight.')
    const run=spawnSync('node',
      ['deployment/qa26/qa-real-custom-uat-release.mjs'],
      {encoding:'utf8',timeout:210000,maxBuffer:2*1024*1024,
       env:{...process.env,H5C_QA_KEEP_ON_SUCCESS:'1'}})
    for(const line of String(run.stdout||'').split('\n')){
      if(line.startsWith('QA_UAT_ROUTE_PROMOTED '))console.log(line)
      if(line.startsWith('QA_UAT_ROLLBACK_SNAPSHOT '))backup=line.split(' ')[1]
    }
    if(run.status!==0)throw Error('Actual UAT deployment failed: '+String(run.stderr||'').slice(-400))
    if(!SNAP.test(String(backup||'')))throw Error('Missing persistent Custom UAT backup.')
    if(http(UAT_HOST)!==TARGET||http(CENTRAL_UAT)!==PREVIOUS)
      throw Error('Custom UAT public route attestation failed after deployment.')
    finish(job,'succeeded',{snapshot:backup,target:'h5c-custom-qa26-uat'})
    console.log('CUSTOM_UAT_DURABLE_RELEASE_SUCCEEDED',job.id,'backup='+backup)
  }catch(error){
    console.error('CUSTOM_UAT_DURABLE_RELEASE_FAILED',job.id,error.message)
    let recovered=false
    if(backup)try{
      command('node',['deployment/qa26/qa-real-custom-uat-restore.mjs',
        backup,TARGET,PREVIOUS],undefined,90000)
      recovered=true
    }catch(e){console.error('CUSTOM_UAT_RECOVERY_FAILED',e.message)}
    try{finish(job,recovered?'rolled_back':'failed',{reason:'uat-operator-error'})}
    catch(e){console.error('UAT_AUDIT_COMPLETION_FAILED',e.message)}
    throw error
  }
}
const mode=process.argv[2]||'--once'
if(!['--once','--loop'].includes(mode))throw Error('Usage: --once or --loop')
do{
  try{await execute()}catch(e){
    console.error('UAT_WORKER_ERROR',e.message)
    if(mode==='--once')process.exitCode=1
  }
  if(mode==='--loop')await sleep(30000)
}while(mode==='--loop')
