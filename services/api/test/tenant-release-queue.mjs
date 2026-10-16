import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {planReleaseCohort} from '../src/releaseRolloutPlanner.js'
import {enqueueReleasePlans,activateNextPendingRollout,claimDueRollouts,finishRollout} from '../src/tenantReleaseQueue.js'

const {Pool}=pg
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4})
const sha='c'.repeat(40),shaNext='d'.repeat(40)
let certifiedBy=null
const start=new Date('2026-10-15T10:00:00Z')
const due=new Date('2026-10-15T11:30:00Z')
const policy={timezone:'Europe/London',days:['thu'],start:'12:00',end:'14:00'}
const release={sha,published:true,humanApproved:true,ciPassed:true,
  migrationCompatible:true,securityPassed:true,publishedAt:'2026-10-15T09:00:00Z',
  expectedDeployMinutes:15,testSoakMinutes:30}
async function tx(fn){
  const db=await pool.connect()
  try{await db.query('BEGIN');const out=await fn(db);await db.query('COMMIT');return out}
  catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
async function seed(){
  const tenants=[]
  const suffix=randomUUID().slice(0,8)
  const auditor=await pool.query(
    'INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id',
    ['release-auditor-'+suffix+'@example.invalid','CI Release Auditor','ci-only'])
  certifiedBy=auditor.rows[0].id
  for(const build of [sha,shaNext])await pool.query([
    'INSERT INTO platform_certified_application_releases',
    '(build_sha,status,ci_run_url,evidence,approved_by,approved_at)',
    "VALUES($1,'approved',$2,$3::jsonb,$4,now())",
  ].join(' '),[build,'https://github.com/dansut24/Hi5Central-Platform/actions/runs/1234567890',
    JSON.stringify({build:true,ci:true,security:true,migrations:true,smoke:true}),certifiedBy])
  for(let i=0;i<4;i++){
    const mode=i%2?'admin_controlled':'hi5_managed'
    const slug='rollout-ci-'+suffix+'-'+i
    const row=await pool.query(
      "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
      [slug,'Rollout CI '+i])
    const id=row.rows[0].id
    await pool.query(
      'INSERT INTO tenant_release_preferences(tenant_id,update_mode,maintenance_window) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET update_mode=excluded.update_mode,maintenance_window=excluded.maintenance_window',
      [id,mode,JSON.stringify(policy)])
    tenants.push({id,mode,itsm:true,status:'active',maintenance:policy})
  }
  return tenants
}
test('isolated four-tenant release queue: idempotency, kill switch, leases, route proof and ordering',async()=>{
  const tenants=await seed()
  try{
    const plans=planReleaseCohort({tenants,release,now:start,gates:{}})
    assert.equal(plans.length,4)
    assert(plans.every(p=>p.stage==='test'&&p.status==='scheduled'))
    assert.equal(new Set(plans.map(p=>p.idempotencyKey)).size,4)
    const recorded=await tx(db=>enqueueReleasePlans(db,{plans,releaseRef:'ci-release-1'}))
    assert.equal(recorded.length,4)
    assert(recorded.every(row=>row.state==='pending'))
    const duplicate=await tx(db=>enqueueReleasePlans(db,{plans,releaseRef:'ci-release-1'}))
    assert(duplicate.every(row=>row.reused===true))
    const events=await pool.query(
      "SELECT count(*)::int AS n FROM tenant_release_rollout_events WHERE tenant_id=ANY($1::uuid[]) AND event_type='scheduled'",
      [tenants.map(t=>t.id)])
    assert.equal(events.rows[0].n,4,'idempotent retry must not duplicate audit events')
    for(const tenant of tenants){
      const first=await tx(db=>activateNextPendingRollout(db,{tenantId:tenant.id,environment:'test'}))
      assert.equal(first.activated,true)
      assert.equal((await tx(db=>activateNextPendingRollout(db,{tenantId:tenant.id,environment:'test'}))).activated,false)
    }
    // A host verification alone cannot mark platform Test as customer-ready;
    // SQL requires human signoff, at least two canary results, and evidence.
    await assert.rejects(pool.query([
      'INSERT INTO platform_release_test_qa_gates',
      '(build_sha,state,passed_canary_count,passed_at)',
      "VALUES($1,'passed',1,now())",
    ].join(' '),[sha]),/constraint/)
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM platform_release_test_qa_gates WHERE build_sha=$1',[sha])).rows[0].n,0)
    const paused=await tx(db=>claimDueRollouts(db,{now:due}))
    assert.equal(paused.paused,true,'global default must block all workers')
    assert.equal(paused.claimed.length,0)
    await pool.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true')
    const leased=await tx(db=>claimDueRollouts(db,{now:due,limit:10}))
    assert.equal(leased.claimed.length,4)
    assert.equal(new Set(leased.claimed.map(v=>v.tenantId)).size,4)
    const secondClaim=await tx(db=>claimDueRollouts(db,{now:due,limit:10}))
    assert.equal(secondClaim.claimed.length,0,'lease must prevent duplicate claims')
    const job=leased.claimed[0]
    const stale=tx(db=>finishRollout(db,{jobId:job.id,leaseToken:randomUUID(),
      leaseFence:job.leaseFence,outcome:'succeeded',now:new Date(due.getTime()+1000),
      proof:{tenantId:job.tenantId,environment:job.environment,
        buildSha:job.buildSha,routeGeneration:1,checkedAt:due.toISOString()}}))
    await assert.rejects(stale,/Lease expired|stale/)
    await assert.rejects(tx(db=>finishRollout(db,{jobId:job.id,leaseToken:job.leaseToken,
      leaseFence:job.leaseFence,outcome:'succeeded',now:new Date(due.getTime()+1000),
      proof:{tenantId:tenants.find(t=>t.id!==job.tenantId).id,environment:job.environment,
        buildSha:job.buildSha,routeGeneration:1,checkedAt:due.toISOString()}})),/route proof/)
    const succeeded=await tx(db=>finishRollout(db,{jobId:job.id,leaseToken:job.leaseToken,
      leaseFence:job.leaseFence,outcome:'succeeded',now:new Date(due.getTime()+1000),
      proof:{tenantId:job.tenantId,environment:job.environment,
        buildSha:job.buildSha,routeGeneration:1,checkedAt:due.toISOString()}}))
    assert.equal(succeeded.outcome,'succeeded')
    // A new version may queue independently but may not run while one is active.
    const follow=planReleaseCohort({tenants,release:{...release,sha:shaNext},
      now:start,gates:{}}).filter(p=>p.tenantId===job.tenantId)
    await tx(db=>enqueueReleasePlans(db,{plans:follow,releaseRef:'ci-release-2'}))
    const activateAfter=await tx(db=>activateNextPendingRollout(db,{tenantId:job.tenantId,environment:'test'}))
    assert.equal(activateAfter.activated,true,'completed rollout must free the next queued version')
    assert.equal(activateAfter.job.build_sha,shaNext)
    const others=await pool.query(
      "SELECT count(*)::int AS n FROM tenant_release_rollout_jobs WHERE tenant_id=ANY($1::uuid[]) AND status='running'",
      [tenants.map(t=>t.id)])
    assert.equal(others.rows[0].n,3,'success of one tenant must not modify other tenant job states')
    // Reuse the exact released SHA after Test passes to create the second
    // tenant-specific wave. Managed has NO UAT job. Custom has NO automatic
    // Live job until the tenant administrator approves the tested UAT build.
    const passedTest={sha,state:'succeeded',completedAt:'2026-10-15T09:00:00Z'}
    const nextWave=planReleaseCohort({tenants,release,now:start,
      gates:{test:passedTest,productionWaveOpen:true}})
    assert.deepEqual(nextWave.map(p=>p.stage),['live','uat','live','uat'])
    const nextJobs=await tx(db=>enqueueReleasePlans(db,{plans:nextWave,releaseRef:'ci-release-1'}))
    assert.equal(nextJobs.length,4)
    assert(nextJobs.every(p=>p.state==='pending'))
    const unapproved=planReleaseCohort({tenants,release,now:start,
      gates:{test:passedTest,uat:{sha,state:'succeeded',completedAt:'2026-10-15T09:45:00Z'},
        productionWaveOpen:true}})
    assert.equal(unapproved.filter(p=>p.mode==='admin_controlled'&&p.stage==='live'&&p.status==='blocked').length,2)
    const approvedTenants=tenants.filter(t=>t.mode==='admin_controlled').map(t=>({
      ...t,uatAcceptance:{sha,approved:true,approvedBy:'qa-owner',approvedAt:'2026-10-15T09:50:00Z'},
    }))
    const approvedPlans=planReleaseCohort({tenants:approvedTenants,release,now:start,
      gates:{test:passedTest,uat:{sha,state:'succeeded',completedAt:'2026-10-15T09:45:00Z'},
        productionWaveOpen:true}})
    assert(approvedPlans.every(p=>p.stage==='live'&&p.status==='scheduled'))
    const customerLive=await tx(db=>enqueueReleasePlans(db,{plans:approvedPlans,releaseRef:'ci-release-1'}))
    assert.equal(customerLive.length,2)
    const total=await pool.query(
      'SELECT environment,count(*)::int AS n FROM tenant_release_rollout_jobs WHERE tenant_id=ANY($1::uuid[]) AND build_sha=$2 GROUP BY environment ORDER BY environment',
      [tenants.map(t=>t.id),sha])
    assert.deepEqual(Object.fromEntries(total.rows.map(x=>[x.environment,x.n])),
      {live:4,test:4,uat:2})
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM tenant_release_rollout_jobs j JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id WHERE j.tenant_id=ANY($1::uuid[]) AND p.update_mode='hi5_managed' AND j.environment='uat'",
      [tenants.map(t=>t.id)])).rows[0].n,0)
    // A newly scheduled follow-up may not be claimed if the same tenant's
    // blackout begins during the expected deployment duration. It is deferred
    // to the next permitted maintenance window rather than retried in a loop.
    const blackoutTenant=tenants.find(t=>t.id===job.tenantId)
    const blackout=[{startsAt:'2026-10-15T11:42:00Z',endsAt:'2026-10-15T12:00:00Z'}]
    await pool.query(
      'UPDATE tenant_release_preferences SET blackout_periods=$2::jsonb WHERE tenant_id=$1',
      [blackoutTenant.id,JSON.stringify(blackout)])
    const delayed=await tx(db=>claimDueRollouts(db,{now:due,limit:10}))
    assert.equal(delayed.claimed.length,0)
    assert.equal(delayed.deferred.length,1)
    assert.match(delayed.deferred[0].reason,/blackout/)
    const backoff=await pool.query(
      'SELECT status,scheduled_at,attempt_count FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND build_sha=$2',
      [blackoutTenant.id,shaNext])
    assert.equal(backoff.rows[0].status,'deferred')
    assert(backoff.rows[0].scheduled_at>due)
    assert.equal(backoff.rows[0].attempt_count,0)
    console.log('PASS: four synthetic tenants flowed Dev release -> Test -> (Managed Live / Custom UAT) -> tenant-approved Custom Live without RMM or cross-tenant leakage; blackout deferral preserved')
  }finally{
    await pool.query('UPDATE platform_release_rollout_control SET paused=true WHERE singleton=true').catch(()=>{})
    for(const tenant of tenants)await pool.query('DELETE FROM tenants WHERE id=$1',[tenant.id]).catch(()=>{})
    await pool.query('DELETE FROM platform_certified_application_releases WHERE build_sha=ANY($1::text[])',[[sha,shaNext]]).catch(()=>{})
    if(certifiedBy)await pool.query('DELETE FROM users WHERE id=$1',[certifiedBy]).catch(()=>{})
    await pool.end()
  }
})
