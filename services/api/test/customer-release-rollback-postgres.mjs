// Real Postgres17 ten-tenant customer rollback isolation and hold acceptance.
// Runs ONLY on disposable, local hi5_rollout_ci. No Production hosts or devices.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import pg from 'pg'
import {requestCustomerRollback,readCustomerRollback} from '../src/customerReleaseRollback.js'
import {claimNextCustomerRollback,completeCustomerRollback,failCustomerRollback} from '../src/customerReleaseRollbackExecution.js'

const u=new URL(process.env.DATABASE_URL||'postgres://invalid/invalid')
if(u.pathname!=='/hi5_rollout_ci'||!['127.0.0.1','localhost'].includes(u.hostname))
 throw Error('Customer rollback database test refuses all non-isolated PostgreSQL connections.')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3})
const now=new Date()
const A=randomBytes(20).toString('hex')
const B=randomBytes(20).toString('hex')
const C=randomBytes(20).toString('hex')
const D=randomBytes(20).toString('hex')
const suffix=randomUUID().slice(0,8)
const note='New application build prevents the organisation resolving incidents reliably; request prior verified ITSM version.'
async function tx(fn){
 const db=await pool.connect()
 try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result}
 catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}
 finally{db.release()}
}
test('ten genuine SQL tenant boundaries: customer rollback holds only its own Live environment',async()=>{
 try{
  const user=(await pool.query([
    'INSERT INTO users(email,name,password_hash,email_verified_at)',
    'VALUES($1,$2,$3,now()) RETURNING id',
  ].join(' '),['rollback-ci-'+suffix+'@example.invalid','QA rollback actor '+suffix,'synthetic-only'])).rows[0].id
  const poolName='h5rollbackci-'+suffix
  const predecessorPool=poolName+'-previous'
  await pool.query([
    'INSERT INTO platform_runtime_pools',
    '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at)',
    "VALUES($1,'live',$2,$3,$4,'verified',now(),now())",
  ].join(' '),[predecessorPool,B,'ci-predecessor-api.invalid','ci-predecessor-web.invalid'])
  await pool.query([
    'INSERT INTO platform_runtime_pools',
    '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at)',
    "VALUES($1,'live',$2,$3,$4,'verified',now(),now())",
  ].join(' '),[poolName,A,'ci-only-api.invalid','ci-only-web.invalid'])
  await pool.query([
    'INSERT INTO platform_release_rollback_compatibility',
    '(from_build_sha,to_build_sha,state,schema_backward_compatible,',
    'immutable_images_verified,recovery_snapshot_verified,reviewed_by,reviewed_at,expires_at,evidence,reason)',
    "VALUES($1,$2,'approved',true,true,true,$3,now()-interval '5 minutes',",
    "now()+interval '1 day',$4::jsonb,$5)",
  ].join(' '),[A,B,user,JSON.stringify({
    schemaChecked:true,previousImagePulled:true,recoveryTestPassed:true,ciSynthetic:true,
  }),'Disposable CI proof of backward compatibility, not a Production authorisation'])
  const tenants=[]
  for(let i=0;i<10;i++){
   const slug='rollback-ci-'+suffix+'-'+(i<5?'managed':'custom')+'-'+i
   const t=(await pool.query(
    "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
    [slug,'Fictional rollback QA tenant '+i])).rows[0]
   const modules={itsm:true,rmm:i===4||i===9}
   await pool.query([
    'INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_completed_at,',
    'onboarding_data,configuration,tenant_url,portal_url,rmm_url)',
    "VALUES($1,$2::jsonb,'complete',now(),$3::jsonb,$3::jsonb,$4,$5,$6)",
   ].join(' '),[t.id,JSON.stringify(modules),JSON.stringify({company:{displayName:slug}}),
     'https://'+slug+'.example.invalid',
     'https://'+slug+'-portal.example.invalid',
     modules.rmm?'https://'+slug+'-rmm.example.invalid':null])
   await pool.query([
    'UPDATE tenant_release_preferences SET update_mode=$2,',
    'test_auto_sync=true,uat_auto_stage=$3,live_auto_promote=$4,',
    'maintenance_window=$5::jsonb WHERE tenant_id=$1',
   ].join(' '),[t.id,i<5?'hi5_managed':'admin_controlled',
    i>=5,i<5,JSON.stringify({timezone:'Europe/London',start:'01:00',end:'05:00',
     days:['mon','tue','wed','thu','fri','sat','sun']})])
   await pool.query([
    'INSERT INTO tenant_runtime_assignments',
    "(tenant_id,environment,pool_id,build_sha,generation,activated_at)",
    "VALUES($1,'live',$2,$3,$4,now())",
   ].join(' '),[t.id,poolName,A,i+1])
   await pool.query([
    'INSERT INTO tenant_runtime_route_attestations',
    '(tenant_id,environment,pool_id,build_sha,public_host,state,checked_at)',
    "VALUES($1,'live',$2,$3,$4,'active',now())",
   ].join(' '),[t.id,poolName,A,slug+'.hi5central.com'])
   await pool.query([
    'INSERT INTO tenant_release_rollout_jobs',
    '(tenant_id,environment,build_sha,status,previous_build_sha,scheduled_at,',
    'completed_at,expected_duration_minutes)',
    "VALUES($1,'live',$2,'succeeded',$3,now()-interval '2 hours',",
    "now()-interval '1 hour',15)",
   ].join(' '),[t.id,A,B])
   await pool.query([
    'INSERT INTO tenant_release_rollout_jobs',
    '(tenant_id,environment,build_sha,status,scheduled_at,expected_duration_minutes)',
    "VALUES($1,'live',$2,'pending',now()+interval '1 day',15)",
   ].join(' '),[t.id,C])
   tenants.push({...t,slug,managed:i<5,hasRmm:modules.rmm})
  }
  assert.equal(tenants.filter(t=>t.managed).length,5)
  assert.equal(tenants.filter(t=>t.hasRmm).length,2)
  // Reject arbitrary versions, invalid requests, cross-tenant host or
  // unreconciled schema compatibility BEFORE any hold is persisted.
  await assert.rejects(tx(db=>requestCustomerRollback({
   db,tenantId:tenants[0].id,userId:user,expectedCurrentSha:A,
   targetBuildSha:D,confirmed:true,reason:note})),/Production changed/)
  assert.equal((await pool.query(
   'SELECT count(*)::int n FROM tenant_release_upgrade_holds WHERE tenant_id=$1',
   [tenants[0].id])).rows[0].n,0)
  const cohortResults=[]
  for(const t of tenants){
   const r=await tx(db=>requestCustomerRollback({
    db,tenantId:t.id,userId:user,expectedCurrentSha:A,targetBuildSha:B,
    confirmed:true,reason:note}))
   assert.equal(r.productionChanged,false)
   assert.equal(r.cancelledForwardJobs,1)
   assert.equal(r.state,'requested')
   cohortResults.push(r)
   const own=await readCustomerRollback({db:pool,tenantId:t.id})
   assert.equal(own.hold.active,true)
   assert.equal(own.availability.available,false)
   assert.equal(own.recent.length,1)
   assert.equal(own.recent[0].target_build_sha,B)
   const stillRoute=(await pool.query([
    'SELECT build_sha FROM tenant_runtime_assignments',
    "WHERE tenant_id=$1 AND environment='live'",
   ].join(' '),[t.id])).rows[0]
   assert.equal(stillRoute.build_sha,A,'No browser/API request can apply a Docker/Caddy version')
   // The per-tenant SQL trigger also rejects direct privileged-worker
   // scheduling, not only the user-facing React/Node guard.
   await assert.rejects(pool.query([
    'INSERT INTO tenant_release_rollout_jobs',
    '(tenant_id,environment,build_sha,status,scheduled_at)',
    "VALUES($1,'live',$2,'pending',now())",
   ].join(' '),[t.id,D]),/upgrades are held/i)
   // Test remains independently updateable; hold applies to Live ONLY.
   await pool.query([
    'INSERT INTO tenant_release_rollout_jobs',
    '(tenant_id,environment,build_sha,status,scheduled_at)',
    "VALUES($1,'test',$2,'pending',now())",
   ].join(' '),[t.id,D])
   await assert.rejects(tx(db=>requestCustomerRollback({
    db,tenantId:t.id,userId:user,expectedCurrentSha:A,targetBuildSha:B,
    confirmed:true,reason:note})),/rollback is already pending/i)
  }
  assert.equal(cohortResults.length,10)
  const all=await pool.query([
   'SELECT state,count(*)::int n FROM tenant_release_customer_rollback_requests',
   'WHERE id=ANY($1::uuid[]) GROUP BY state',
  ].join(' '),[cohortResults.map(r=>r.id)])
  assert.deepEqual(all.rows,[{state:'requested',n:10}])
  const cancelled=await pool.query([
   'SELECT count(*)::int n FROM tenant_release_rollout_jobs',
   'WHERE tenant_id=ANY($1::uuid[]) AND build_sha=$2',
   "AND environment='live' AND status='cancelled'",
  ].join(' '),[tenants.map(t=>t.id),C])
  assert.equal(cancelled.rows[0].n,10)
  const events=await pool.query([
   'SELECT count(*)::int n FROM tenant_release_customer_rollback_events',
   'WHERE request_id=ANY($1::uuid[]) AND event_type=$2',
  ].join(' '),[cohortResults.map(r=>r.id),'requested'])
  assert.equal(events.rows[0].n,10)
  assert.equal((await pool.query(
   'SELECT paused FROM platform_release_rollout_control WHERE singleton=true'
  )).rows[0].paused,true,'CI must never unpause the global rollout')
  // Exercise the real PostgreSQL claim under an isolated ROLLBACK-only
  // transaction. No customer, host, or durable global pause change.
  const db=await pool.connect()
  try{
   await db.query('BEGIN')
   await db.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true')
   const selected=await claimNextCustomerRollback(db,{now:new Date()})
   assert(selected,'A reviewed, held rollback request must be claimable')
   assert.equal(selected.state,'running')
   assert.equal(selected.source_build_sha,A)
   assert.equal(selected.target_build_sha,B)
   const others=await db.query([
    'SELECT count(*)::int n FROM tenant_release_customer_rollback_requests',
    "WHERE id=ANY($1::uuid[]) AND id<>$2 AND state='requested'",
   ].join(' '),[cohortResults.map(r=>r.id),selected.id])
   assert.equal(others.rows[0].n,9,'Other customer requests are untouched')
   // POSITIVE SQL STATE-MACHINE proof only: this synthetic host observation
   // does NOT attest to any actual Docker/Caddy customer rollback. Use a
   // SAVEPOINT and restore it after asserting a complete exact-tenant commit.
   await db.query('SAVEPOINT synthetic_rollback_success')
   await db.query([
     'INSERT INTO platform_runtime_pools',
     '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at)',
     "VALUES($1,'live',$2,$3,$4,'verified',now(),now())",
   ].join(' '),[poolName+'-prior',B,'ci-only-api.invalid','ci-only-web.invalid'])
   const generation=Number(selected.source_route_generation)+1
   const completed=await completeCustomerRollback(db,{
    requestId:selected.id,now:new Date(),proof:{status:'rollback_verified',
     requestId:selected.id,tenantId:selected.tenant_id,environment:'live',
     sourceBuildSha:A,observedBuildSha:B,routeGeneration:generation,
     checkedAt:new Date().toISOString(),apiHealthy:true,
     frontendHealthy:true,gatewaySourceAgreed:true,tenantScopedRouteOnly:true},
   })
   assert.equal(completed.state,'verified')
   assert.equal(completed.upgradeHoldPreserved,true)
   const post=await db.query([
    'SELECT a.build_sha,a.generation,v.build_sha AS route_sha',
    'FROM tenant_runtime_assignments a',
    'JOIN tenant_runtime_route_attestations v',
    "ON v.tenant_id=a.tenant_id AND v.environment='live'",
    "WHERE a.tenant_id=$1 AND a.environment='live'",
   ].join(' '),[selected.tenant_id])
   assert.equal(post.rows[0].build_sha,B)
   assert.equal(post.rows[0].route_sha,B)
   assert.equal(Number(post.rows[0].generation),generation)
   const peers=await db.query([
    'SELECT count(*)::int n FROM tenant_runtime_assignments',
    "WHERE environment='live' AND tenant_id<>$1",
    'AND tenant_id=ANY($2::uuid[]) AND build_sha=$3',
   ].join(' '),[selected.tenant_id,tenants.map(t=>t.id),A])
   assert.equal(peers.rows[0].n,9,'Previous-version recovery never mutates peer routes')
   const afterHold=await db.query(
    'SELECT active FROM tenant_release_upgrade_holds WHERE tenant_id=$1',
    [selected.tenant_id])
   assert.equal(afterHold.rows[0].active,true)
   await db.query('ROLLBACK TO SAVEPOINT synthetic_rollback_success')
   // With the successful synthetic path undone, invalid host proof MUST
   // continue to be refused and the hold preserved.
   await assert.rejects(completeCustomerRollback(db,{
    requestId:selected.id,now:new Date(),proof:{status:'rollback_verified',
     requestId:selected.id,tenantId:selected.tenant_id,environment:'live',
     sourceBuildSha:A,observedBuildSha:B,routeGeneration:999,
     checkedAt:new Date().toISOString(),apiHealthy:true,
     frontendHealthy:true,gatewaySourceAgreed:false,tenantScopedRouteOnly:true},
   }),/gateway isolation/)
   // Exercise the full metadata success transition with an isolated,
   // synthetic trusted-host proof. No production routing authority is used.
   const verified=await completeCustomerRollback(db,{
    requestId:selected.id,now:new Date(),
    proof:{status:'rollback_verified',
     requestId:selected.id,tenantId:selected.tenant_id,environment:'live',
     sourceBuildSha:A,observedBuildSha:B,routeGeneration:999,
     checkedAt:new Date().toISOString(),apiHealthy:true,
     frontendHealthy:true,gatewaySourceAgreed:true,tenantScopedRouteOnly:true},
   })
   assert.equal(verified.state,'verified')
   assert.equal(verified.upgradeHoldPreserved,true)
   const updatedAssignment=(await db.query([
    'SELECT build_sha,generation,pool_id FROM tenant_runtime_assignments',
    "WHERE tenant_id=$1 AND environment='live'",
   ].join(' '),[selected.tenant_id])).rows[0]
   assert.equal(updatedAssignment.build_sha,B)
   assert.equal(Number(updatedAssignment.generation),999)
   assert.equal(updatedAssignment.pool_id,predecessorPool)
   const updatedRoute=(await db.query([
    'SELECT build_sha,pool_id,state FROM tenant_runtime_route_attestations',
    "WHERE tenant_id=$1 AND environment='live'",
   ].join(' '),[selected.tenant_id])).rows[0]
   assert.equal(updatedRoute.build_sha,B)
   assert.equal(updatedRoute.pool_id,predecessorPool)
   assert.equal(updatedRoute.state,'active')
   const history=await db.query([
    'SELECT event_type FROM tenant_release_customer_rollback_events',
    'WHERE request_id=$1 ORDER BY occurred_at,id',
   ].join(' '),[selected.id])
   assert.deepEqual(history.rows.map(x=>x.event_type),
    ['requested','started','verified'])
   const othersAfter=await db.query([
    'SELECT count(*)::int n FROM tenant_runtime_assignments',
    "WHERE tenant_id<>$1 AND build_sha=$2 AND environment='live'",
    'AND tenant_id=ANY($3::uuid[])',
   ].join(' '),[selected.tenant_id,A,tenants.map(t=>t.id)])
   assert.equal(othersAfter.rows[0].n,9)
   const held=await db.query(
    'SELECT active FROM tenant_release_upgrade_holds WHERE tenant_id=$1',
    [selected.tenant_id])
   assert.equal(held.rows[0].active,true)
   assert.equal((await failCustomerRollback(db,{
    requestId:selected.id,reason:'Attempt to change a verified terminal request',
   })).changed,false,'Terminal success cannot be overwritten as failed.')
   // A second independent tenant remains eligible for its own failing
   // rollback request: customer-scoped isolation holds across outcomes.
   const second=await claimNextCustomerRollback(db,{now:new Date()})
   assert(second&&second.id!==selected.id)
   const failure=await failCustomerRollback(db,{
    requestId:second.id,reason:'Disposable CI host evidence intentionally rejected'})
   assert.equal(failure.upgradeHoldPreserved,true)
   assert.equal((await db.query('SELECT active FROM tenant_release_upgrade_holds WHERE tenant_id=$1',
    [second.tenant_id])).rows[0].active,true)
  }finally{
   await db.query('ROLLBACK').catch(()=>{})
   db.release()
  }
  assert.equal((await pool.query(
   'SELECT paused FROM platform_release_rollout_control WHERE singleton=true'
  )).rows[0].paused,true)
  console.log(JSON.stringify({type:'CUSTOMER_TENANT_ROLLBACK_POSTGRES_CI_PASS',
   isolated:true,tenants:10,managed:5,custom:5,rmmEntitled:2,
   rollbackRequests:10,perTenantHolds:10,cancelledLiveJobs:10,
   crossTenantMutations:0,hostRouteChanges:0,globalPaused:true,
   actualHostRollbackPerformed:false}))
 }finally{await pool.end()}
})
