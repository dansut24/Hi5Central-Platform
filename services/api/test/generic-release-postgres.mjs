// Runs ONLY inside GitHub's disposable PostgreSQL 17 Actions service.
// Real migrations + real fanout transactions; no Docker/Caddy/host/tenant URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomBytes,randomUUID} from 'node:crypto'
import {fanoutCertifiedRelease} from '../src/certifiedReleaseFanout.js'

const {Pool}=pg
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3})
const sha=randomBytes(20).toString('hex')
const suffix=randomUUID().slice(0,8)
const policy={timezone:'Europe/London',start:'02:00',end:'05:00',
 days:['mon','tue','wed','thu','fri','sat','sun']}
const evidence={build:true,ci:true,security:true,migrations:true,smoke:true}
async function tx(fn){
 const c=await pool.connect()
 try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}
 catch(error){await c.query('ROLLBACK').catch(()=>{});throw error}
 finally{c.release()}
}
test('real PostgreSQL generic fanout is denied by default then schedules two exact Test tenants idempotently',async()=>{
 assert(process.env.DATABASE_URL?.includes('hi5_rollout_ci'),
  'Test must NEVER run against an actual Hi5Central customer database.')
 const actor=(await pool.query(
  "INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id",
  ['generic-ci-'+suffix+'@example.invalid','Synthetic Generic Reviewer','ci-only'])).rows[0].id
 const now=new Date(),publish=new Date(now.getTime()-7200000)
 await pool.query([
  'INSERT INTO platform_certified_application_releases',
  '(build_sha,status,ci_run_url,evidence,approved_by,approved_at)',
  "VALUES($1,'approved',$2,$3::jsonb,$4,$5)",
 ].join(' '),[sha,'https://github.com/dansut24/Hi5Central-Platform/actions/runs/1234567890',
  JSON.stringify(evidence),actor,publish])
 await pool.query([
  'INSERT INTO hi5central_published_release_notes',
  '(build_sha,version_label,title,entries,published_at)',
  'VALUES($1,$2,$3,$4::jsonb,$5)',
 ].join(' '),[sha,'0.0-ci','Synthetic generic Test release',JSON.stringify([]),publish])
 const records=[]
 for(const mode of ['hi5_managed','admin_controlled']){
  const slug='generic-ci-'+suffix+'-'+(mode==='hi5_managed'?'managed':'custom')
  const t=(await pool.query(
   "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
   [slug,'Isolated Generic CI'])).rows[0]
  await pool.query([
   'INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,',
   'onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)',
   "VALUES($1,$2::jsonb,'complete',now(),$3::jsonb,$3::jsonb,$4,$5,NULL)",
  ].join(' '),[t.id,JSON.stringify({itsm:true,rmm:false}),
   JSON.stringify({company:{displayName:'Synthetic Generic'}}),
   'https://'+slug+'.example.invalid',
   'https://'+slug+'.example.invalid/portal'])
  await pool.query([
   'UPDATE tenant_release_preferences SET update_mode=$2,test_auto_sync=true,',
   'uat_auto_stage=$3,live_auto_promote=$4,maintenance_window=$5::jsonb',
   'WHERE tenant_id=$1',
  ].join(' '),[t.id,mode,mode==='admin_controlled',mode==='hi5_managed',
   JSON.stringify(policy)])
  records.push({id:t.id,mode,slug})
 }
 // New migration 169 defaults to a zero-tenant generic pilot. Explicitly
 // approve only these disposable synthetic CI tenant IDs; never production.
 for(const t of records){
  await pool.query([
   'INSERT INTO platform_release_generic_pilot_tenants',
   '(tenant_id,enabled,approved_by,approved_at,reason)',
   "VALUES($1,true,$2,now(),'Explicit disposable CI cohort admission')",
  ].join(' '),[t.id,actor])
 }
 const request={sha,scope:'generic',limit:1,now}
 await assert.rejects(tx(db=>fanoutCertifiedRelease(db,request)),
  /No explicit staff-approved generic release planning stage/)
 assert.equal((await pool.query(
  'SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE build_sha=$1',[sha])).rows[0].n,0)
 await pool.query([
  'INSERT INTO platform_release_generic_stage_approvals',
  '(build_sha,environment,planning_enabled,execution_enabled,approved_by,',
  'approved_at,expires_at,evidence,reason)',
  "VALUES($1,'test',true,false,$2,now()-interval '1 hour',now()+interval '1 day',",
  "$3::jsonb,'Synthetic Test-only approval')",
 ].join(' '),[sha,actor,JSON.stringify({ci:true})])
 const first=await tx(db=>fanoutCertifiedRelease(db,request))
 assert.equal(first.scanned,2)
 assert.equal(first.queued,2)
 const queued=(await pool.query([
  'SELECT t.slug,j.environment,j.status,j.scheduled_at',
  'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
  'WHERE j.build_sha=$1 ORDER BY t.slug',
 ].join(' '),[sha])).rows
 assert.equal(queued.length,2)
 assert(queued.every(j=>j.environment==='test'&&j.status==='scheduled'))
 assert(queued.every(j=>new Date(j.scheduled_at)>now))
 const twice=await tx(db=>fanoutCertifiedRelease(db,request))
 assert.equal(twice.queued,0)
 assert.equal((await pool.query(
  "SELECT count(*)::int n FROM tenant_release_rollout_events WHERE build_sha=$1 AND event_type='scheduled'",[sha])).rows[0].n,2)
 // Simulate fenced completed Test jobs within this DISPOSABLE CI database.
 for(const t of records){
  await pool.query([
   "UPDATE tenant_release_rollout_jobs SET status='succeeded',completed_at=$2,",
   'attempt_count=1,lease_fence=1 WHERE tenant_id=$1 AND build_sha=$3',
   "AND environment='test'",
  ].join(' '),[t.id,now,sha])
  const job=(await pool.query(
   "SELECT id FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2 AND environment='test'",
   [t.id,sha])).rows[0]
  await pool.query([
   'INSERT INTO tenant_release_rollout_events',
   '(job_id,tenant_id,environment,build_sha,event_type,fence)',
   "VALUES($1,$2,'test',$3,'verified',1)",
  ].join(' '),[job.id,t.id,sha])
 }
 await pool.query([
  'INSERT INTO platform_release_generic_stage_approvals',
  '(build_sha,environment,planning_enabled,execution_enabled,approved_by,',
  'approved_at,expires_at,evidence,reason)',
  "VALUES($1,'uat',true,false,$2,now()-interval '1 hour',now()+interval '1 day',",
  "$3::jsonb,'Synthetic Custom UAT approval')",
 ].join(' '),[sha,actor,JSON.stringify({ci:true})])
 const advanced=await tx(db=>fanoutCertifiedRelease(db,{
  ...request,now:new Date(now.getTime()+3600000),
 }))
 assert.equal(advanced.queued,1,'Only Custom should receive UAT; Managed Live must await Test gate')
 const envs=(await pool.query([
  'SELECT p.update_mode,j.environment,count(*)::int n',
  'FROM tenant_release_rollout_jobs j',
  'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
  'WHERE j.build_sha=$1 GROUP BY p.update_mode,j.environment',
  'ORDER BY p.update_mode,j.environment',
 ].join(' '),[sha])).rows
 assert.deepEqual(envs.map(x=>[x.update_mode,x.environment,x.n]),[
  ['admin_controlled','test',1],
  ['admin_controlled','uat',1],
  ['hi5_managed','test',1],
 ])
 assert.equal((await pool.query(
  'SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0].paused,true)
 const approvals=(await pool.query(
  'SELECT count(*)::int n FROM platform_release_generic_approval_audit WHERE build_sha=$1',[sha])).rows[0].n
 assert.equal(approvals,2,'Every real stage planning approval has a PostgreSQL audit event')
 // The database, not an unattended planner-supplied JSON object, must
 // derive a passed QA gate from two distinct designated, fenced Test jobs.
 const early=(await pool.query(
  'SELECT public.hi5_release_record_verified_test_gate($1,30) AS passed',[sha])).rows[0]
 assert.equal(early.passed,false,'No designation or soak means no QA gate')
 for(const tenant of records){
  await pool.query(
   'INSERT INTO platform_release_canary_tenants(tenant_id,enabled,assigned_by) VALUES($1,true,$2)',
   [tenant.id,actor])
 }
 const unsoaked=(await pool.query(
  'SELECT public.hi5_release_record_verified_test_gate($1,30) AS passed',[sha])).rows[0]
 assert.equal(unsoaked.passed,false,'Designation alone must not bypass the 30 minute soak')
 await pool.query(
  "UPDATE tenant_release_rollout_jobs SET completed_at=now()-interval '61 minutes' WHERE build_sha=$1 AND environment='test'",
  [sha])
 const passed=(await pool.query(
  'SELECT public.hi5_release_record_verified_test_gate($1,30) AS passed',[sha])).rows[0]
 assert.equal(passed.passed,true,'Two verified Test canaries and real soak must pass')
 const evidenceRow=(await pool.query(
  'SELECT state,passed_canary_count,accepted_by,evidence FROM platform_release_test_qa_gates WHERE build_sha=$1',
  [sha])).rows[0]
 assert.equal(evidenceRow.state,'passed')
 assert.equal(evidenceRow.passed_canary_count,2)
 assert.equal(evidenceRow.accepted_by,null,'Never impersonate a staff approver')
 assert.equal(evidenceRow.evidence.source,'two-verified-designated-test-canaries')
 assert.equal(evidenceRow.evidence.verifiedJobIds.length,2)
 assert.equal((await pool.query(
  'SELECT public.hi5_release_record_verified_test_gate($1,30) AS passed',[sha])).rows[0].passed,true)
 assert.equal((await pool.query(
  'SELECT count(*)::int n FROM platform_release_test_qa_gates WHERE build_sha=$1',
  [sha])).rows[0].n,1,'Gate creation must be idempotent')
 console.log(JSON.stringify({type:'GENERIC_FANOUT_POSTGRES_CI_PASS',
  discovered:2,testJobs:2,customUatJobs:1,managedLiveJobs:0,
  duplicateEvents:0,approvalAuditEvents:approvals,globalPaused:true}))
 await pool.end()
})
