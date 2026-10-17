// Ten-tenant certification: real SQL and scheduling in disposable GitHub CI DB ONLY.
// No Production signups, releases, host writes, routing changes, or RMM deployments.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import pg from 'pg'
import {fanoutCertifiedRelease,nextCustomerReleaseStage,scheduledCustomerRelease} from '../src/certifiedReleaseFanout.js'

const dbUrl=process.env.DATABASE_URL||''
const url=new URL(dbUrl)
if(url.pathname!=='/hi5_rollout_ci'||!['localhost','127.0.0.1'].includes(url.hostname))
 throw Error('Ten-tenant certification is restricted to disposable local hi5_rollout_ci only.')
const pool=new pg.Pool({connectionString:dbUrl,max:3})
const sha=randomBytes(20).toString('hex')
const suffix=randomUUID().slice(0,8)
const evidence={build:true,ci:true,security:true,migrations:true,smoke:true}
const zones=['Europe/London','UTC','America/New_York','Europe/Berlin','Asia/Tokyo']
const days=['mon','tue','wed','thu','fri','sat','sun']

async function transaction(fn){
 const c=await pool.connect()
 try{
  await c.query('BEGIN')
  const result=await fn(c)
  await c.query('COMMIT')
  return result
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
 finally{c.release()}
}
async function countJobs(stage){
 const r=await pool.query(
  'SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE build_sha=$1 AND environment=$2',
  [sha,stage])
 return r.rows[0].n
}
async function approve(actor,stage){
 await pool.query([
  'INSERT INTO platform_release_generic_stage_approvals',
  '(build_sha,environment,planning_enabled,execution_enabled,approved_by,',
  'approved_at,expires_at,evidence,reason)',
  "VALUES($1,$2,true,false,$3,now()-interval '1 hour',",
  "now()+interval '1 day',$4::jsonb,'Disposable 10-tenant CI planning-only approval')",
 ].join(' '),[sha,stage,actor,JSON.stringify({ci:true,cohort:10})])
}
async function completeSyntheticStage(stage,rows,completed){
 for(const row of rows){
  const found=await pool.query([
   'UPDATE tenant_release_rollout_jobs SET status=\'succeeded\',',
   'attempt_count=1,lease_fence=1,completed_at=$3,updated_at=now()',
   'WHERE tenant_id=$1 AND build_sha=$2 AND environment=$4',
   "AND status='scheduled' RETURNING id",
  ].join(' '),[row.id,sha,completed,stage])
  assert.equal(found.rowCount,1,'Expected precisely one scheduled synthetic CI '+stage+' job')
  await pool.query([
   'INSERT INTO tenant_release_rollout_events',
   '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
   "VALUES($1,$2,$3,$4,'verified',1,$5::jsonb)",
  ].join(' '),[found.rows[0].id,row.id,stage,sha,
   JSON.stringify({ciOnly:true,notAHostVerification:true})])
 }
}
test('10 provisioned CI tenants: 5 Managed and 5 Custom; two also RMM; correct upgrade stages',async()=>{
 try{
  const now=new Date(),published=new Date(now.getTime()-3*3600000)
  // Earlier CI tests may already have onboarded eligible tenants. Generic
  // release fanout must include them too, not silently restrict itself to 10.
  const previous=(await pool.query([
   'SELECT count(*)::int n FROM tenants t',
   'JOIN tenant_settings s ON s.tenant_id=t.id',
   "WHERE t.status='active' AND s.onboarding_completed_at IS NOT NULL",
   "AND COALESCE((s.modules->>'itsm')::boolean,false)=true",
  ].join(' '))).rows[0].n
  const actor=(await pool.query(
   'INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id',
   ['ten-cohort-'+suffix+'@example.invalid','Ten-tenant CI reviewer','ci-only'])).rows[0].id
  await pool.query([
   'INSERT INTO platform_certified_application_releases',
   '(build_sha,status,ci_run_url,evidence,approved_by,approved_at)',
   "VALUES($1,'approved',$2,$3::jsonb,$4,$5)",
  ].join(' '),[sha,
   'https://github.com/dansut24/Hi5Central-Platform/actions/runs/1234567890',
   JSON.stringify(evidence),actor,published])
  await pool.query([
   'INSERT INTO hi5central_published_release_notes',
   '(build_sha,version_label,title,entries,published_at)',
   'VALUES($1,$2,$3,$4::jsonb,$5)',
  ].join(' '),[sha,'0.0-ci-10','Synthetic ten-tenant release','[]',published])

  const tenants=[]
  for(let i=0;i<10;i++){
   const managed=i<5
   const hasRmm=i===4||i===9
   const mode=managed?'hi5_managed':'admin_controlled'
   const slug='ten-ci-'+suffix+'-'+(managed?'managed':'custom')+'-'+i
   const tenant=(await pool.query(
    "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
    [slug,'Synthetic CI tenant '+i])).rows[0]
   const modules={itsm:true,rmm:hasRmm}
   await pool.query([
    'INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,',
    'onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)',
    "VALUES($1,$2::jsonb,'complete',now(),$3::jsonb,$3::jsonb,$4,$5,$6)",
   ].join(' '),[tenant.id,JSON.stringify(modules),
    JSON.stringify({company:{displayName:'Synthetic CI '+i}}),
    'https://'+slug+'.example.invalid',
    'https://'+slug+'.example.invalid/portal',
    hasRmm?'https://'+slug+'-rmm.example.invalid':null])
   const maintenance={timezone:zones[i%zones.length],start:'01:00',
    end:'05:00',days}
   await pool.query([
    'UPDATE tenant_release_preferences SET update_mode=$2,',
    'test_auto_sync=true,uat_auto_stage=$3,live_auto_promote=$4,',
    'live_delay_hours=0,maintenance_window=$5::jsonb WHERE tenant_id=$1',
   ].join(' '),[tenant.id,mode,!managed,managed,JSON.stringify(maintenance)])
   tenants.push({...tenant,mode,slug,managed,hasRmm,maintenance})
  }
  assert.equal(tenants.filter(t=>t.managed).length,5)
  assert.equal(tenants.filter(t=>!t.managed).length,5)
  assert.equal(tenants.filter(t=>t.hasRmm).length,2)

  const request={sha,scope:'generic',limit:3,now}
  await assert.rejects(transaction(c=>fanoutCertifiedRelease(c,request)),
   /No explicit staff-approved generic release planning stage/)
  assert.equal(await countJobs('test'),0,'Default-deny must schedule zero jobs')
  await approve(actor,'test')
  const emptyPilot=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(emptyPilot.scanned,previous,
   'Pilot access is limited to the pre-existing explicitly admitted CI tenants')
  assert.equal(emptyPilot.queued,previous,
   'The new ten unapproved tenants must not be discovered by pilot fanout')
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.build_sha=$1 AND t.slug LIKE $2",
   [sha,'ten-ci-'+suffix+'-%'])).rows[0].n,0,
   'None of the ten new cohort members is admitted without explicit permission')
  // Only actual pilot cohort IDs may be admitted. The previously created
  // eligible CI tenants are also included to verify this is generic, not
  // a hardcoded ten-slug scheduler.
  const eligible=(await pool.query([
   'SELECT t.id FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id',
   "WHERE t.status='active' AND s.onboarding_completed_at IS NOT NULL",
   "AND COALESCE((s.modules->>'itsm')::boolean,false)=true",
  ].join(' '))).rows
  assert.equal(eligible.length,previous+10)
  for(const t of eligible){
   await pool.query([
    'INSERT INTO platform_release_generic_pilot_tenants',
    '(tenant_id,enabled,approved_by,approved_at,reason)',
    "VALUES($1,true,$2,now(),'Explicitly approved disposable CI pilot cohort')",
   ].join(' '),[t.id,actor])
  }
  const first=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(first.scanned,previous+10,
   'All ten cohort tenants AND pre-existing eligible customers discovered')
  assert.equal(first.queued,10,
   'Only newly authorised pilot tenants are scheduled after pre-existing pilot jobs')
  assert.equal(await countJobs('test'),previous+10)
  assert.equal(await countJobs('uat'),0)
  assert.equal(await countJobs('live'),0)
  const repeated=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(repeated.queued,0,'Repeat scan must not duplicate Test jobs')
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_events WHERE build_sha=$1 AND event_type='scheduled'",
   [sha])).rows[0].n,previous+10)
  assert.equal((await pool.query([
   'SELECT count(*)::int n FROM tenant_release_rollout_jobs j',
   'JOIN tenant_settings s ON s.tenant_id=j.tenant_id',
   "WHERE j.build_sha=$1 AND j.environment='test'",
   "AND COALESCE((s.modules->>'rmm')::boolean,false)=true",
  ].join(' '),[sha])).rows[0].n,2,
  'Two RMM-entitled tenants retain ITSM Test; no RMM agent actions are queued')

  await approve(actor,'uat')
  await approve(actor,'live')
  const beforeTest=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(beforeTest.queued,0,'No UAT or Live before matching Test completion')

  const completed=new Date(now.getTime()-95*60000)
  await completeSyntheticStage('test',tenants,completed)
  const canaries=[tenants[0],tenants[5]]
  for(const t of canaries){
   await pool.query([
    'INSERT INTO platform_release_canary_tenants(tenant_id,enabled,assigned_by)',
    'VALUES($1,true,$2)',
   ].join(' '),[t.id,actor])
  }
  const passed=(await pool.query(
   'SELECT public.hi5_release_record_verified_test_gate($1,30) AS ok',
   [sha])).rows[0].ok
  assert.equal(passed,true,'Only two designated, distinct, fenced and soaked CI Test canaries')
  assert.equal((await pool.query(
   'SELECT passed_canary_count FROM platform_release_test_qa_gates WHERE build_sha=$1',
   [sha])).rows[0].passed_canary_count,2)
  const next=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(next.queued,10,'Five Managed Live plus five Custom UAT')
  assert.equal(await countJobs('uat'),5)
  assert.equal(await countJobs('live'),5)
  const wrongStages=(await pool.query([
   'SELECT t.slug,j.environment,p.update_mode',
   'FROM tenant_release_rollout_jobs j',
   'JOIN tenants t ON t.id=j.tenant_id',
   'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
   'WHERE j.build_sha=$1 AND',
   "((p.update_mode='hi5_managed' AND j.environment='uat') OR",
   "(p.update_mode='admin_controlled' AND j.environment='live'))",
  ].join(' '),[sha])).rows
  assert.deepEqual(wrongStages,[],
   'Managed must never receive UAT and Custom must never receive unapproved Live')

  const custom=tenants.filter(t=>!t.managed)
  await completeSyntheticStage('uat',custom,new Date(now.getTime()-35*60000))
  const beforeAcceptance=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(beforeAcceptance.queued,0,
   'No Custom Live without real customer UAT acceptance and schedule')
  assert.equal(await countJobs('live'),5)

  // Policy-path positive/negative checks: synthetic offers stand in for the
  // separate authenticated tenant-admin UAT acceptance workflow, not DB approvals.
  for(const t of custom){
   const jobs=[
    {environment:'test',build_sha:sha,status:'succeeded',completed_at:completed},
    {environment:'uat',build_sha:sha,status:'succeeded',
     completed_at:new Date(now.getTime()-35*60000)},
   ]
   const tenant={id:t.id,status:'active',itsm:true,mode:t.mode,
    maintenance:t.maintenance,blackouts:[],uatAutoStage:true}
   const uatOffer={build_sha:sha,state:'uat_accepted',
    uat_accepted_at:new Date(now.getTime()-10*60000),uat_accepted_by:actor}
   const liveOffer={build_sha:sha,state:'scheduled',
    promotion_approved_at:new Date(now.getTime()-8*60000),
    promotion_approved_by:actor,maintenance_not_before:new Date(now.getTime()+15*60000)}
   const denied=nextCustomerReleaseStage({tenant,sha,publishedAt:published,
    approvedAt:published,jobs,gate:{build_sha:sha,state:'passed',
     passed_at:now,passed_canary_count:2},uatOffer:null,liveOffer,now})
   assert.equal(denied.stage,null,'UAT acceptance cannot be skipped')
   const approved=nextCustomerReleaseStage({tenant,sha,publishedAt:published,
    approvedAt:published,jobs,gate:null,uatOffer,liveOffer,now})
   assert.equal(approved.stage,'live')
   const schedule=scheduledCustomerRelease({decision:approved,tenant,sha,now})
   assert.equal(schedule.status,'scheduled')
   assert(new Date(schedule.scheduledAt)>=new Date(liveOffer.maintenance_not_before))
  }
  // A new tenant arriving AFTER release certification must be discovered on
  // the next planner scan, but not before its standard onboarding completes.
  // RMM-only tenants must not receive ITSM release jobs.
  async function lateTenant(label,modules,completedOnboarding){
   const slug='ten-ci-'+suffix+'-'+label
   const row=(await pool.query(
    "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
    [slug,'Late CI tenant '+label])).rows[0]
   await pool.query([
    'INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,',
    'onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)',
    'VALUES($1,$2::jsonb,$3,$4,$5::jsonb,$5::jsonb,$6,$7,$8)',
   ].join(' '),[row.id,JSON.stringify(modules),
    completedOnboarding?'complete':'company',
    completedOnboarding?now:null,
    JSON.stringify({company:{displayName:'Late CI '+label}}),
    'https://'+slug+'.example.invalid',
    'https://'+slug+'.example.invalid/portal',
    modules.rmm?'https://'+slug+'-rmm.example.invalid':null])
   await pool.query([
    'UPDATE tenant_release_preferences SET update_mode=$2,',
    'test_auto_sync=true,uat_auto_stage=true,live_auto_promote=false,',
    'maintenance_window=$3::jsonb WHERE tenant_id=$1',
   ].join(' '),[row.id,'admin_controlled',JSON.stringify({
    timezone:'Europe/London',start:'01:00',end:'05:00',days})])
   return row
  }
  const late=await lateTenant('late-itsm',{itsm:true,rmm:false},false)
  const rmmOnly=await lateTenant('rmm-only',{itsm:false,rmm:true},true)
  for(const row of [late,rmmOnly]){
   await pool.query([
    'INSERT INTO platform_release_generic_pilot_tenants',
    '(tenant_id,enabled,approved_by,approved_at,reason)',
    "VALUES($1,true,$2,now(),'Reviewed disposable late-onboarding pilot entry')",
   ].join(' '),[row.id,actor])
  }
  const incomplete=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(incomplete.queued,0,
   'Incomplete onboarding and RMM-only subscription must not receive ITSM jobs')
  await pool.query(
   'UPDATE tenant_settings SET onboarding_step=$2,onboarding_completed_at=now() WHERE tenant_id=$1',
   [late.id,'complete'])
  const afterOnboarding=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(afterOnboarding.queued,1,
   'New fully onboarded ITSM tenant must be discovered by existing release')
  assert.equal(await countJobs('test'),previous+11)
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2",
   [late.id,sha])).rows[0].n,1)
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2",
   [rmmOnly.id,sha])).rows[0].n,0)
  assert.equal((await transaction(c=>fanoutCertifiedRelease(c,request))).queued,0,
   'Repeat post-onboarding scan must not duplicate tenant jobs')

  const outsidePilot=await lateTenant('future-itsm',{itsm:true,rmm:false},true)
  assert.equal((await transaction(c=>fanoutCertifiedRelease(c,request))).queued,0,
   'A completed but unapproved tenant cannot bypass pilot admission')
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2",
   [outsidePilot.id,sha])).rows[0].n,0)
  await assert.rejects(pool.query([
   "UPDATE platform_release_generic_scope_control SET mode='all_onboarded',",
   'approved_by=$1,approved_at=now(),updated_at=now(),',
   "evidence='{}'::jsonb,reason=$2 WHERE singleton=true",
  ].join(' '),[actor,'Not independently approved for all tenants']),
  /violates check constraint/i,
  'All-onboarded scope must require recorded ten-tenant and independent security evidence')
  await pool.query([
   "UPDATE platform_release_generic_scope_control SET mode='all_onboarded',",
   'approved_by=$1,approved_at=now(),updated_at=now(),',
   'evidence=$2::jsonb,reason=$3 WHERE singleton=true',
  ].join(' '),[actor,JSON.stringify({
   tenTenantAcceptance:true,independentSecurityReview:true,ciOnly:true
  }),'Both independent acceptance proofs are synthetic CI fixtures'])
  const general=await transaction(c=>fanoutCertifiedRelease(c,request))
  assert.equal(general.queued,1,'New legitimate tenant auto-discovers certified release after approved general enablement')
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2",
   [outsidePilot.id,sha])).rows[0].n,1)
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2",
   [rmmOnly.id,sha])).rows[0].n,0,
   'RMM-only subscriptions never get ITSM jobs even after general enablement')
  assert((await pool.query(
   "SELECT count(*)::int n FROM platform_release_generic_scope_audit WHERE target='scope'",
  )).rows[0].n>=1,'General scope transition must be audited')

  const approvals=(await pool.query(
   'SELECT environment,planning_enabled,execution_enabled FROM platform_release_generic_stage_approvals WHERE build_sha=$1',
   [sha])).rows
  assert.equal(approvals.length,3)
  assert(approvals.every(x=>x.planning_enabled&&!x.execution_enabled),
   'CI planning grants never authorise host execution')
  assert.equal((await pool.query(
   'SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0].paused,true)
  console.log(JSON.stringify({type:'GENERIC_TEN_TENANT_POSTGRES_CI_PASS',
   synthetic:true,managed:5,custom:5,rmmEntitled:2,
   testJobs:10,customUatJobs:5,managedLiveJobs:5,unapprovedCustomLiveJobs:0,
   canaryProofs:2,maintenanceTimezones:zones.length,globalPaused:true,
   executionApprovals:0,lateOnboardedItSMJobs:1,rmmOnlyItSMJobs:0,
   approvedGeneralNewTenantJobs:1,noHostActions:true}))
 }finally{await pool.end()}
})
