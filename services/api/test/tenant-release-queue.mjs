import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {planReleaseCohort} from '../src/releaseRolloutPlanner.js'
import {enqueueReleasePlans,activateNextPendingRollout,claimDueRollouts,finishRollout} from '../src/tenantReleaseQueue.js'

const {Pool}=pg
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4})
const sha='c'.repeat(40),shaNext='d'.repeat(40)
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
      proof:{tenantId:tenants[3].id,environment:job.environment,
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
    console.log('PASS: four isolated tenants; queued->scheduled->claimed; paused-by-default, idempotent, fenced, attested; next version ordered')
  }finally{
    await pool.query('UPDATE platform_release_rollout_control SET paused=true WHERE singleton=true').catch(()=>{})
    for(const tenant of tenants)await pool.query('DELETE FROM tenants WHERE id=$1',[tenant.id]).catch(()=>{})
    await pool.end()
  }
})
