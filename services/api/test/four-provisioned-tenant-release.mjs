// True provisioned four-tenant CI fixture, not four in-memory objects.
//
// Reuses production signup/onboarding PostgreSQL tables and the existing
// tenantEnvironmentProvisioner against three disposable CI databases.
// It then queues one synthetic *approved release descriptor* through the real
// rollout planner and durable queue. No external signup, email, DNS, Caddy,
// Stripe or customer traffic is created by this isolated test.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Client} from 'pg'
import {pool} from '../src/db.js'
import {provisionTenantSandboxes} from '../src/tenantEnvironmentProvisioner.js'
import {planReleaseCohort} from '../src/releaseRolloutPlanner.js'
import {enqueueReleasePlans,claimDueRollouts} from '../src/tenantReleaseQueue.js'

const testUrl=process.env.TENANT_TEST_DATABASE_URL
const uatUrl=process.env.TENANT_UAT_DATABASE_URL
if(!testUrl||!uatUrl||!process.env.DATABASE_URL)
  throw Error('This test requires three independent disposable PostgreSQL databases.')
const testDb=new Client({connectionString:testUrl})
const uatDb=new Client({connectionString:uatUrl})
const releaseSha='d'.repeat(40)
const when=new Date('2026-10-15T10:00:00Z')
const policy={timezone:'Europe/London',days:['thu'],start:'12:00',end:'14:00'}
const modes=['hi5_managed','admin_controlled','hi5_managed','admin_controlled']
const slugs=[],tenants=[]
const suffix=randomUUID().slice(0,8)
const approvedDescriptor={sha:releaseSha,published:true,humanApproved:true,
  ciPassed:true,migrationCompatible:true,securityPassed:true,
  publishedAt:'2026-10-15T09:00:00Z',
  expectedDeployMinutes:15,testSoakMinutes:30,managedDelayMinutes:30}
async function tx(fn){
  const db=await pool.connect()
  try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result}
  catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
}
await testDb.connect()
await uatDb.connect()
try{
  for(let i=0;i<4;i++){
    const managed=modes[i]==='hi5_managed'
    const slug='qa-ci-'+suffix+'-'+(managed?'managed':'custom')+'-'+i
    slugs.push(slug)
    const created=await pool.query(
      "INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",
      [slug,'SYNTHETIC QA '+i])
    const id=created.rows[0].id
    const email='qa-ci-'+suffix+'-'+i+'@example.invalid'
    const user=await pool.query(
      'INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id',
      [email,'QA Owner '+i,'synthetic-not-for-login'])
    await pool.query(
      "INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",
      [id,user.rows[0].id])
    const modules={itsm:true,rmm:true}
    await pool.query([
      'INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,',
      'onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)',
      "VALUES($1,$2::jsonb,'complete',now(),$3::jsonb,$3::jsonb,$4,$5,$6)",
    ].join(' '),[id,JSON.stringify(modules),
      JSON.stringify({company:{displayName:'Synthetic QA '+i}}),
      'https://'+slug+'.hi5central.com',
      'https://'+slug+'.hi5central.com/portal',
      'https://'+slug+'-rmm.hi5central.com'])
    await pool.query([
      'INSERT INTO tenant_release_preferences',
      '(tenant_id,update_mode,maintenance_window) VALUES($1,$2,$3::jsonb)',
      'ON CONFLICT(tenant_id) DO UPDATE SET',
      'update_mode=EXCLUDED.update_mode,maintenance_window=EXCLUDED.maintenance_window',
    ].join(' '),[id,modes[i],JSON.stringify(policy)])
    const provisioned=await provisionTenantSandboxes(id,{
      source:pool,targets:{test:testUrl,uat:uatUrl},
    })
    assert.equal(provisioned.test?.status,'ready',slug+' Test provisioning failed')
    if(managed)assert.deepEqual(Object.keys(provisioned),['test'],
      slug+' Managed must not have UAT')
    else assert.equal(provisioned.uat?.status,'ready',
      slug+' Custom UAT provisioning failed')
    const test=await testDb.query(
      'SELECT t.slug,ts.modules,ts.rmm_url FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id WHERE t.id=$1',
      [id])
    assert.equal(test.rows[0]?.slug,slug+'-test')
    assert.equal(test.rows[0]?.modules?.rmm,false)
    assert.equal(test.rows[0]?.rmm_url,null)
    const uat=await uatDb.query('SELECT slug FROM tenants WHERE id=$1',[id])
    assert.equal(uat.rowCount,managed?0:1)
    if(!managed)assert.equal(uat.rows[0].slug,slug+'-uat')
    // No tenant ever receives another tenant's projected identity.
    const member=await testDb.query([
      'SELECT u.email,u.password_hash FROM users u JOIN tenant_memberships m',
      'ON m.user_id=u.id WHERE m.tenant_id=$1',
    ].join(' '),[id])
    assert.equal(member.rowCount,1)
    assert.equal(member.rows[0].email,email)
    assert.equal(member.rows[0].password_hash,'environment-sso-only')
    tenants.push({id,mode:modes[i],itsm:true,status:'active',maintenance:policy})
  }
  const plans=planReleaseCohort({tenants,release:approvedDescriptor,now:when,gates:{}})
  assert.equal(plans.length,4)
  assert(plans.every(p=>p.stage==='test'&&p.status==='scheduled'))
  assert.equal(new Set(plans.map(p=>p.idempotencyKey)).size,4)
  const created=await tx(db=>enqueueReleasePlans(db,{plans,releaseRef:'qa-fixture-release-only'}))
  assert.equal(created.length,4)
  assert(created.every(x=>x.state==='pending'))
  assert((await tx(db=>enqueueReleasePlans(db,{plans,releaseRef:'qa-fixture-release-only'})))
    .every(x=>x.reused),'Release replay must be idempotent')
  const matched=await pool.query(
    'SELECT tenant_id,environment,build_sha,status FROM tenant_release_rollout_jobs WHERE tenant_id=ANY($1::uuid[])',
    [tenants.map(x=>x.id)])
  assert.equal(matched.rowCount,4)
  assert(matched.rows.every(x=>x.environment==='test'&&x.build_sha===releaseSha))
  // Default global pause remains enabled. Creating QA tenants must never
  // accidentally start a route worker or place anything into Production.
  const claimed=await tx(db=>claimDueRollouts(db,{now:new Date('2026-10-15T11:30:00Z')}))
  assert.equal(claimed.paused,true)
  assert.equal(claimed.claimed.length,0)
  for(const row of tenants.filter(t=>t.mode==='hi5_managed')){
    assert.equal((await uatDb.query('SELECT 1 FROM tenants WHERE id=$1',[row.id])).rowCount,0)
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM tenant_release_rollout_jobs WHERE tenant_id=$1 AND environment='uat'",
      [row.id])).rows[0].n,0)
  }
  console.log('PASS: 4 REAL DB-backed synthetic tenants provisioned through production code; Managed Test only, Custom Test+UAT, 4 isolated scheduled Test release jobs, idempotent and paused, 0 customer routing changes.')
}finally{
  await testDb.end().catch(()=>{})
  await uatDb.end().catch(()=>{})
  await pool.end().catch(()=>{})
}
