// Integration-only: disposable GitHub Actions PostgreSQL 17 service.
// This exercises the real, generic claim/lease/fence/failure/rollback state
// transitions, NOT a customer VPS or an actual Caddy host cutover.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomBytes,randomUUID} from 'node:crypto'
import {enqueueReleasePlans,activateNextPendingRollout,claimDueRollouts,
 finishRollout} from '../src/tenantReleaseQueue.js'
const {Pool}=pg
const sha=randomBytes(20).toString('hex')
const suffix=randomUUID().slice(0,7)
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4})
const maintenance={
 timezone:'Europe/London',start:'00:00',end:'23:59',
 days:['mon','tue','wed','thu','fri','sat','sun'],
}
async function tx(fn){
 const c=await pool.connect()
 try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
 finally{c.release()}
}

test('generic two-tenant queue: paused kill switch, exact approval, durable success, rollback and audit',async()=>{
 assert(process.env.DATABASE_URL?.includes('hi5_rollout_ci'),
  'NEVER run this integration test on any real customer database')
 const users=[],tenants=[]
 const due=new Date(Date.now()-300000)
 let aborted=false
 try{
  const actor=(await pool.query([
   'INSERT INTO users(email,name,password_hash,email_verified_at)',
   'VALUES($1,$2,$3,now()) RETURNING id'
  ].join(' '),['generic-recovery-ci-'+suffix+'@example.invalid',
   'Generic Recovery Test Actor','CI only'])).rows[0].id
  users.push(actor)
  await pool.query([
   'INSERT INTO platform_certified_application_releases',
   '(build_sha,status,ci_run_url,evidence,approved_by,approved_at)',
   "VALUES($1,'approved',$2,$3::jsonb,$4,now())",
  ].join(' '),[sha,'https://github.com/dansut24/Hi5Central-Platform/actions/runs/1234567890',
   JSON.stringify({build:true,ci:true,security:true,migrations:true,smoke:true}),actor])
  for(const mode of ['hi5_managed','admin_controlled']){
   const row=(await pool.query(
    "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
    ['generic-recovery-ci-'+suffix+'-'+(mode==='hi5_managed'?'managed':'custom'),
     'Isolated Rollback CI'])).rows[0]
   tenants.push({id:row.id,mode})
   await pool.query([
    'UPDATE tenant_release_preferences SET update_mode=$2,test_auto_sync=true,',
    'uat_auto_stage=$3,live_auto_promote=$4,maintenance_window=$5::jsonb',
    'WHERE tenant_id=$1',
   ].join(' '),[row.id,mode,mode==='admin_controlled',mode==='hi5_managed',
    JSON.stringify(maintenance)])
  }
  const plans=tenants.map(t=>({tenantId:t.id,stage:'test',status:'scheduled',
   buildSha:sha,scheduledAt:due.toISOString(),expectedDurationMinutes:10}))
  const initial=await tx(db=>enqueueReleasePlans(db,{plans,releaseRef:'ci-generic-failover'}))
  assert(initial.every(x=>x.state==='pending'))
  for(const t of tenants){
   const activated=await tx(db=>activateNextPendingRollout(db,{tenantId:t.id,environment:'test'}))
   assert.equal(activated.activated,true)
  }
  // The global paused switch always wins, even if a future scope is valid.
  const before=await tx(db=>claimDueRollouts(db,{now:due,environment:'test',limit:2}))
  assert.equal(before.paused,true)
  assert.equal(before.claimed.length,0)
  await pool.query([
   'INSERT INTO platform_release_generic_stage_approvals',
   '(build_sha,environment,planning_enabled,execution_enabled,',
   'approved_by,approved_at,expires_at,evidence)',
   "VALUES($1,'test',true,false,$2,now()-interval '1 minute',",
   "now()+interval '3 days',$3::jsonb)",
  ].join(' '),[sha,actor,JSON.stringify({ciReview:'generic-rollback'})])
  // Even with global unpause in disposable CI, planning-only approval
  // must never allow a single worker claim.
  await pool.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true')
  const noExecution=await tx(db=>claimDueRollouts(db,{now:due,environment:'test',limit:2}))
  assert.equal(noExecution.claimed.length,0)
  await pool.query([
   'UPDATE platform_release_generic_stage_approvals',
   'SET execution_enabled=true,updated_at=now()',
   "WHERE build_sha=$1 AND environment='test'",
  ].join(' '),[sha])
  const now=new Date()
  const claimed=await tx(db=>claimDueRollouts(db,{now,environment:'test',limit:2,leaseSeconds:120}))
  assert.equal(claimed.claimed.length,2)
  assert.deepEqual(new Set(claimed.claimed.map(j=>j.tenantId)),
   new Set(tenants.map(x=>x.id)))
  const [good,fail]=claimed.claimed
  await assert.rejects(tx(db=>finishRollout(db,{
   jobId:good.id,leaseToken:randomUUID(),leaseFence:good.leaseFence,
   outcome:'succeeded',proof:{tenantId:good.tenantId,environment:'test',
    buildSha:sha,routeGeneration:1,checkedAt:now.toISOString()},now:new Date(),
  })),/stale|Lease expired/)
  const proof={tenantId:good.tenantId,environment:'test',buildSha:sha,
   routeGeneration:1,checkedAt:now.toISOString()}
  const successful=await tx(db=>finishRollout(db,{
   jobId:good.id,leaseToken:good.leaseToken,leaseFence:good.leaseFence,
   outcome:'succeeded',proof,now:new Date(),
  }))
  assert.equal(successful.outcome,'succeeded')
  // Simulated failed host rollout: watchdog verified a restored route;
  // its only permitted durable result is rolled_back at the same lease fence.
  const restored=await tx(db=>finishRollout(db,{
   jobId:fail.id,leaseToken:fail.leaseToken,leaseFence:fail.leaseFence,
   outcome:'rolled_back',now:new Date(),
  }))
  assert.equal(restored.outcome,'rolled_back')
  const states=(await pool.query([
   'SELECT status,attempt_count,lease_token,lease_expires_at',
   'FROM tenant_release_rollout_jobs WHERE build_sha=$1 ORDER BY status',
  ].join(' '),[sha])).rows
  assert.deepEqual(states.map(x=>x.status),['rolled_back','succeeded'])
  assert(states.every(x=>x.attempt_count===1&&!x.lease_token&&!x.lease_expires_at))
  const events=(await pool.query([
   'SELECT event_type,fence,count(*)::int n FROM tenant_release_rollout_events',
   'WHERE build_sha=$1 GROUP BY event_type,fence ORDER BY event_type',
  ].join(' '),[sha])).rows
  assert.equal(events.find(x=>x.event_type==='verified')?.n,1)
  assert.equal(events.find(x=>x.event_type==='rolled_back')?.n,1)
  assert(events.filter(x=>['verified','rolled_back'].includes(x.event_type))
   .every(x=>Number(x.fence)===1))
  // An old worker cannot issue a second successful completion.
  await assert.rejects(tx(db=>finishRollout(db,{
   jobId:fail.id,leaseToken:fail.leaseToken,leaseFence:fail.leaseFence,
   outcome:'succeeded',proof:{...proof,tenantId:fail.tenantId},
   now:new Date(),
  })),/stale|Lease expired/)
  // Cancelled/revoked approval must stop any newly scheduled work.
  await pool.query([
   'UPDATE platform_release_generic_stage_approvals',
   'SET execution_enabled=false,planning_enabled=false,updated_at=now()',
   "WHERE build_sha=$1 AND environment='test'",
  ].join(' '),[sha])
  const audit=(await pool.query(
   'SELECT count(*)::int n FROM platform_release_generic_approval_audit WHERE build_sha=$1',
   [sha])).rows[0]
  assert(audit.n>=3)
  const after=await tx(db=>claimDueRollouts(db,{now:new Date(),environment:'test',limit:2}))
  assert.equal(after.claimed.length,0)
  assert.equal((await pool.query(
   'SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0].paused,
   false,'Synthetic CI unpause is explicit and will be reset before cleanup')
  console.log(JSON.stringify({status:'GENERIC_ROLLBACK_CI_PASS',
   syntheticTenants:tenants.length,claimed:2,verified:1,rolledBack:1,
   staleLeaseBlocked:true,adminAuditRows:audit.n}))
 }finally{
  // CI database only: do not alter a real customer DB, and restore global
  // pause BEFORE removing any fixture. Exit cleanup is best-effort.
  await pool.query('UPDATE platform_release_rollout_control SET paused=true WHERE singleton=true').catch(()=>{})
  await pool.query('DELETE FROM platform_release_generic_stage_approvals WHERE build_sha=$1',[sha]).catch(()=>{})
  await pool.query('DELETE FROM platform_release_generic_approval_audit WHERE build_sha=$1',[sha]).catch(()=>{})
  for(const t of tenants)await pool.query('DELETE FROM tenants WHERE id=$1',[t.id]).catch(()=>{})
  await pool.query('DELETE FROM platform_certified_application_releases WHERE build_sha=$1',[sha]).catch(()=>{})
  for(const user of users)await pool.query('DELETE FROM users WHERE id=$1',[user]).catch(()=>{})
  await pool.end()
 }
})
