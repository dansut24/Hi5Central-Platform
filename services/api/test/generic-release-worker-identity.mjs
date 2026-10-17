// Actual PostgreSQL connection and generic process preflight security tests.
// Run ONLY on GitHub's disposable hi5_rollout_ci PostgreSQL instance.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import pg from 'pg'
import {assertRestrictedGenericDatabaseIdentity} from '../src/releaseWorkerIdentity.js'

test('generic planner/executor fail closed on superuser and accept only separate scoped logins',async()=>{
 const dsn=process.env.DATABASE_URL||''
 assert(new URL(dsn).pathname==='/hi5_rollout_ci',
  'Refusing to run role-creation tests against a non-CI database')
 const admin=new pg.Client({connectionString:dsn})
 await admin.connect()
 const planner='hi5_release_generic_planner'
 const worker='hi5_release_generic_exec_uat'
 const password='synthetic_ci_only_credential'
 const url=role=>{const u=new URL(dsn);u.username=role;u.password=password;return u.toString()}
 const launch=(file,env)=>spawnSync(process.execPath,['src/'+file,'--preflight'],{
   cwd:process.cwd(),encoding:'utf8',timeout:12000,
   env:{...process.env,DATABASE_URL:env.dsn,...env.config}
 })
 let plannerDb,workerDb
 try{
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(admin,{kind:'planner'}),
   /dedicated restricted login/)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(admin,{kind:'executor',stage:'uat'}),
   /dedicated restricted login/)
  await admin.query("CREATE ROLE "+planner+" LOGIN PASSWORD '"+password+"'")
  await admin.query("CREATE ROLE "+worker+" LOGIN PASSWORD '"+password+"'")
  await admin.query('GRANT USAGE ON SCHEMA public TO '+planner+', '+worker)
  await admin.query(
   'GRANT EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) TO '+worker)
  plannerDb=new pg.Client({connectionString:url(planner)})
  workerDb=new pg.Client({connectionString:url(worker)})
  await plannerDb.connect()
  await workerDb.connect()
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(plannerDb,{kind:'planner'}),
   /requires database-verified Test quality gate permission/)
  await admin.query(
   'GRANT EXECUTE ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer) TO '+planner)
  const p=await assertRestrictedGenericDatabaseIdentity(plannerDb,{kind:'planner'})
  const w=await assertRestrictedGenericDatabaseIdentity(workerDb,{kind:'executor',stage:'uat'})
  assert.equal(p.canDirectlyUnpause,false)
  assert.equal(w.canDirectlyUnpause,false)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(plannerDb,{kind:'executor',stage:'uat'}),
   /dedicated restricted login/)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(workerDb,{kind:'planner'}),
   /dedicated restricted login/)
  await admin.query(
   'GRANT EXECUTE ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer) TO '+worker)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(workerDb,{kind:'executor',stage:'uat'}),
   /executor must never create Test quality gates/)
  await admin.query(
   'REVOKE EXECUTE ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer) FROM '+worker)
  await admin.query(
   'REVOKE EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) FROM '+worker)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(workerDb,{kind:'executor',stage:'uat'}),
   /requires the reviewed, audited pause-only permission/)
  await admin.query(
   'GRANT EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) TO '+worker)
  await admin.query(
   'GRANT EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) TO '+planner)
  await assert.rejects(
   assertRestrictedGenericDatabaseIdentity(plannerDb,{kind:'planner'}),
   /planner must never hold emergency execution permissions/)
  await admin.query(
   'REVOKE EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) FROM '+planner)
  await assert.rejects(
   workerDb.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true'),
   /permission denied/i)
  await assert.rejects(
   plannerDb.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true'),
   /permission denied/i)

  const superuserWorker=launch('tenantReleaseExecutor.mjs',{
   dsn,config:{RELEASE_GATEWAY:'uat',RELEASE_WORKER_SCOPE:'generic',
   RELEASE_GENERIC_WORKER_ACK:'reviewed-stage-approval-only'}})
  assert.notEqual(superuserWorker.status,0,'Superuser executor must be refused')
  const superuserPlanner=launch('releaseFanoutDaemon.mjs',{
   dsn,config:{RELEASE_PLANNER_SCOPE:'generic',
   RELEASE_GENERIC_PLANNING_ACK:'reviewed-stage-approvals-only'}})
  assert.notEqual(superuserPlanner.status,0,'Superuser planner must be refused')

  const restrictedWorker=launch('tenantReleaseExecutor.mjs',{
   dsn:url(worker),config:{RELEASE_GATEWAY:'uat',RELEASE_WORKER_SCOPE:'generic',
   RELEASE_GENERIC_WORKER_ACK:'reviewed-stage-approval-only'}})
  assert.equal(restrictedWorker.status,0,
    'Actual least-privilege executor preflight: '+restrictedWorker.stderr.slice(-300))
  assert.match(restrictedWorker.stdout,/GENERIC_RELEASE_EXECUTOR_PREFLIGHT_PASS/)

  const restrictedPlanner=launch('releaseFanoutDaemon.mjs',{
   dsn:url(planner),config:{RELEASE_PLANNER_SCOPE:'generic',
   RELEASE_GENERIC_PLANNING_ACK:'reviewed-stage-approvals-only'}})
  assert.equal(restrictedPlanner.status,0,
    'Actual least-privilege planner preflight: '+restrictedPlanner.stderr.slice(-300))
  assert.match(restrictedPlanner.stdout,/RELEASE_PLANNER_PREFLIGHT_PASS/)

  console.log('GENERIC_REAL_CONNECTION_IDENTITY_AND_CI_PREFLIGHT_PASS')
 }finally{
  await plannerDb?.end().catch(()=>{})
  await workerDb?.end().catch(()=>{})
  await admin.query('REVOKE EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) FROM '+worker).catch(()=>{})
  await admin.query('REVOKE EXECUTE ON FUNCTION public.hi5_release_record_verified_test_gate(text,integer) FROM '+planner).catch(()=>{})
  await admin.query('REVOKE USAGE ON SCHEMA public FROM '+planner+', '+worker).catch(()=>{})
  await admin.query('DROP ROLE IF EXISTS '+planner).catch(()=>{})
  await admin.query('DROP ROLE IF EXISTS '+worker).catch(()=>{})
  await admin.end()
 }
})
