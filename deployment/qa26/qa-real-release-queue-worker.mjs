#!/usr/bin/env node
/**
 * QA26 REAL scheduled rollout operator: central PostgreSQL queue -> official
 * API/web images -> tenant-scoped real Test gateway -> public HTTPS proof.
 *
 * Limited to exactly two named QA tenants and the TEST environment.
 * Not a Live, Custom UAT or RMM operator. No fake signoffs or Dev release
 * publication. The main application release scheduler remains a separate PR.
 *
 * Operations: --once (claim one due job), --loop (poll every 30 seconds).
 * Run on the authorised VPS Docker host, or a dedicated trusted Docker
 * operator with node, docker CLI, curl and Git checkout available.
 */
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {activeTenantMaintenanceWindow} from '../../services/api/src/releaseRolloutPlanner.js'

const ACCEPTED=new Map([
  ['h5c-managed-qa26','h5c-managed-qa26-test.hi5central.com'],
  ['h5c-custom-qa26','h5c-custom-qa26-test.hi5central.com'],
])
const TARGET='ddbb869e228ac0d78d3a985daba3fb7059bb0530'
const REF='qa26-real-test-v1'
const UUID=/^[a-f0-9-]{36}$/
const SHA=/^[a-f0-9]{40}$/
const snapshot=/^test-before-real-route-[0-9]+[.]Caddyfile$/
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const command=(binary,args,{input,timeout=30000}={})=>{
  const out=spawnSync(binary,args,{encoding:'utf8',input,timeout,maxBuffer:1024*1024})
  if(out.status!==0)throw Error(binary+' failed: '+String(out.stderr||'').slice(-500))
  return out.stdout.trim()
}
const sql=query=>command('docker',['exec','-i','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -q -v ON_ERROR_STOP=1'],{input:query,timeout:20000})

function validateJob(job){
  if(!job||!UUID.test(String(job.id))||!UUID.test(String(job.tenantId))
    ||!UUID.test(String(job.token))||!Number.isInteger(Number(job.fence))
    ||!SHA.test(String(job.buildSha))||job.buildSha!==TARGET
    ||job.environment!=='test'||!ACCEPTED.has(job.slug)
    ||!['hi5_managed','admin_controlled'].includes(job.mode))
    throw Error('Claimed job fails QA-only tenant, release or lease allowlist.')
  if(Number(job.duration)<1||Number(job.duration)>240)
    throw Error('Invalid expected duration.')
  return job
}
function claim(){
  // One atomic PostgreSQL transaction with FOR UPDATE SKIP LOCKED. At most
  // one operator can claim a particular due job across independent workers.
  const text=sql([
    'BEGIN;',
    'WITH guard AS (SELECT singleton FROM platform_release_rollout_control',
    "WHERE singleton=true AND paused=false),",
    'pick AS (SELECT j.id FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'JOIN guard ON true',
    "WHERE j.status='scheduled' AND j.environment='test'",
    "AND j.release_ref='"+REF+"'",
    "AND j.build_sha='"+TARGET+"'",
    "AND t.slug IN ('h5c-managed-qa26','h5c-custom-qa26')",
    'AND t.status=\'active\' AND j.scheduled_at<=now()',
    'AND j.attempt_count<j.max_attempts',
    'ORDER BY j.scheduled_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED),',
    'claimed AS (UPDATE tenant_release_rollout_jobs j SET',
    "status='running',attempt_count=attempt_count+1,",
    'lease_token=gen_random_uuid(),lease_fence=lease_fence+1,',
    "lease_expires_at=now()+interval '8 minutes',updated_at=now()",
    'FROM pick WHERE j.id=pick.id RETURNING j.*),',
    'audit AS (INSERT INTO tenant_release_rollout_events',
    '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
    "SELECT id,tenant_id,environment,build_sha,'claimed',lease_fence,",
    "jsonb_build_object('operator','qa26-real-test-v1') FROM claimed",
    'RETURNING job_id)',
    'SELECT json_build_object(',
    "'id',c.id,'tenantId',c.tenant_id,'slug',t.slug,",
    "'mode',p.update_mode,'environment',c.environment,",
    "'buildSha',c.build_sha,'duration',c.expected_duration_minutes,",
    "'token',c.lease_token,'fence',c.lease_fence,",
    "'scheduledAt',c.scheduled_at,'expiresAt',c.lease_expires_at,",
    "'maintenance',p.maintenance_window,'blackouts',p.blackout_periods)::text",
    'FROM claimed c JOIN tenants t ON t.id=c.tenant_id',
    'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
    'JOIN audit a ON a.job_id=c.id;',
    'COMMIT;',
  ].join('\n'))
  if(!text)return null
  return validateJob(JSON.parse(text))
}
function finish(job,outcome,extra={}){
  const id=String(job.id),token=String(job.token),fence=Number(job.fence)
  if(!UUID.test(id)||!UUID.test(token)||!Number.isInteger(fence)
    ||!['succeeded','failed','rolled_back','deferred'].includes(outcome))
    throw Error('Invalid completion state or job lease.')
  const meta=JSON.stringify(extra)
  // Only machine-authored string fields from strict allowlists and checks.
  if(!/^[A-Za-z0-9_.,:{}" -]*$/.test(meta)||meta.length>1500)
    throw Error('Operator event metadata is invalid.')
  const ev=outcome==='succeeded'?'verified':outcome
  const terminal=outcome==='deferred'?'NULL':'now()'
  const result=sql([
    'BEGIN;',
    'WITH updated AS (UPDATE tenant_release_rollout_jobs',
    "SET status='"+outcome+"',lease_token=NULL,lease_expires_at=NULL,",
    'completed_at='+terminal+',updated_at=now()',
    "WHERE id='"+id+"' AND lease_token='"+token+"'",
    "AND lease_fence="+fence+" AND status='running'",
    'AND lease_expires_at>now() RETURNING id,tenant_id,environment,build_sha,lease_fence),',
    'audit AS (INSERT INTO tenant_release_rollout_events',
    '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
    "SELECT id,tenant_id,environment,build_sha,'"+ev+"',lease_fence,",
    "'"+meta+"'::jsonb FROM updated RETURNING id)",
    'SELECT count(*) FROM updated JOIN audit ON true;',
    'COMMIT;',
  ].join('\n'))
  if(result!=='1')throw Error('Stale lease or failed durable result recording ('+result+').')
}
function rollback(filename){
  if(!snapshot.test(filename))throw Error('Unsafe rollback backup file reference.')
  command('sh',[resolve('deployment/qa26/qa-real-tenant-route-restore.sh'),filename],
    {timeout:60000})
}
async function processOnce(){
  const job=claim()
  if(!job){console.log('NO_DUE_QA_TEST_JOB_OR_PAUSED');return false}
  console.log('CLAIMED_REAL_QA_JOB',job.id,job.slug,job.buildSha.slice(0,8))
  let backup=null
  try{
    const eligible=activeTenantMaintenanceWindow({
      policy:job.maintenance,now:new Date(),
      durationMinutes:Number(job.duration),
      blackouts:job.blackouts,
    })
    if(!eligible.allowed){
      finish(job,'deferred',{reason:'outside-window'})
      console.log('DEFERRED_NOT_IN_WINDOW',eligible.reason)
      return true
    }
    if(new Date(job.expiresAt)<=new Date())throw Error('Lease has expired before host execution.')
    const targetHost=ACCEPTED.get(job.slug)
    const originalHost=[...ACCEPTED.values()].find(host=>host!==targetHost)
    const old=command('curl',['-fsS','--max-time','8','https://'+targetHost+'/api/v1/updates/version'])
    if(JSON.parse(old).sha!=='9041ed0fc0908badfd1ceb9d638215caef5e431b')
      throw Error('Test tenant no longer matches verified release baseline.')
    const peerBefore=JSON.parse(command('curl',['-fsS','--max-time','8',
      'https://'+originalHost+'/api/v1/updates/version']))
    if(!SHA.test(String(peerBefore.sha||'')))
      throw Error('Unverified peer revision before QA route cutover.')
    const worker=spawnSync('node',[resolve('deployment/qa26/qa-real-tenant-canary-rollback.mjs')],
      {encoding:'utf8',timeout:190000,maxBuffer:1024*1024,
        env:{...process.env,H5C_QA_KEEP_ON_SUCCESS:'1',
          H5C_QA_TENANT_HOST:targetHost,H5C_QA_PEER_SHA:peerBefore.sha}})
    for(const line of String(worker.stdout||'').split('\n')){
      if(line.startsWith('QA_ROLLBACK_SNAPSHOT '))backup=line.split(' ')[1]
      if(line.startsWith('QA_ROUTE_PROMOTED '))console.log(line)
    }
    if(worker.status!==0)throw Error('Host version switch failed: '+String(worker.stderr||'').slice(-300))
    if(!snapshot.test(String(backup||'')))throw Error('Missing host rollback snapshot.')
    const served=JSON.parse(command('curl',['-fsS','--max-time','8',
      'https://'+targetHost+'/api/v1/updates/version']))
    const other=JSON.parse(command('curl',['-fsS','--max-time','8',
      'https://'+originalHost+'/api/v1/updates/version']))
    if(served.sha!==TARGET||other.sha!==peerBefore.sha)
      throw Error('Final public route attestation mismatch.')
    finish(job,'succeeded',{snapshot:backup,target:job.slug})
    console.log('REAL_QA_JOB_SUCCEEDED',job.id,job.slug,'rollback='+backup)
    return true
  }catch(e){
    console.error('REAL_QA_JOB_FAILED',job.id,e.message)
    let recovered=false
    if(backup){try{rollback(backup);recovered=true}catch(err){
      console.error('ROUTE_ROLLBACK_FAILED',err.message)}}
    try{finish(job,recovered?'rolled_back':'failed',{reason:'host-execution-failed'})}
    catch(err){console.error('QUEUE_COMPLETION_FAILED',err.message)}
    throw e
  }
}
const mode=process.argv[2]||'--once'
if(!['--once','--loop'].includes(mode))throw Error('Only --once and --loop are supported.')
do{
  try{await processOnce()}
  catch(e){console.error('OPERATOR_ERROR',e.message);if(mode==='--once')process.exitCode=1}
  if(mode==='--loop')await sleep(30000)
}while(mode==='--loop')
