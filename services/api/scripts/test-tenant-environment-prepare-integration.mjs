import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'

// Integration test is intentionally runnable ONLY against a disposable local
// GitHub Actions PostgreSQL container. Never point it at VPS databases.
const pgAdminUrl = process.env.HI5_EPHEMERAL_PG_URL
if (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.HI5_PROVISIONING_TEST_SCOPE !== 'isolated-github-actions'
  || !pgAdminUrl) {
  throw new Error('Only the isolated GitHub Actions provisioning test runner may execute this file.')
}
const baseUrl = new URL(pgAdminUrl)
if (!['127.0.0.1','localhost'].includes(baseUrl.hostname)
  || baseUrl.pathname !== '/postgres' || baseUrl.username !== 'postgres'
  || baseUrl.protocol !== 'postgresql:') {
  throw new Error('Integration PostgreSQL must be the ephemeral localhost postgres database.')
}

const suffix = randomBytes(4).toString('hex')
const dbNames = Object.freeze({
  control: 'h5ci_control_' + suffix,
  uat: 'h5ci_uat_' + suffix,
  test: 'h5ci_test_' + suffix,
})
const requestIds = Object.freeze({
  uat:'11111111-1111-4111-8111-111111111111',
  test:'22222222-2222-4222-8222-222222222222',
})
const tenantIds = Object.freeze({
  uat:'33333333-3333-4333-8333-333333333333',
  test:'44444444-4444-4444-8444-444444444444',
})
const instanceIds = Object.freeze({
  control:'55555555-5555-4555-8555-555555555555',
  uat:'66666666-6666-4666-8666-666666666666',
  test:'77777777-7777-4777-8777-777777777777',
})
const workerPath = fileURLToPath(new URL('./tenant-environment-prepare.mjs',import.meta.url))
const rootDomain = 'hi5central.com'
const fixtures = [
  '../migrations/core/001_core.sql',
  '../migrations/platform-admin/116_tenant_environment_instances.sql',
  '../migrations/platform-admin/132_tenant_environment_provision_requests.sql',
  '../migrations/platform-admin/133_managed_runtime_database_identity.sql',
  '../migrations/platform-admin/134_managed_environment_tenant_bootstrap.sql',
  '../migrations/platform-admin/135_managed_control_plane_identity.sql',
  '../migrations/platform-admin/136_isolated_tenant_hostname_trigger.sql',
  '../migrations/platform-admin/137_managed_environment_invitations.sql',
]

function dbUrl(name) {
  const u = new URL(pgAdminUrl)
  u.pathname = '/' + dbNames[name]
  return u.toString()
}
async function query(name,sql,params=[]) {
  const client = new pg.Client({ connectionString: dbUrl(name),connectionTimeoutMillis:4000 })
  try {await client.connect();return await client.query(sql,params)} finally {await client.end()}
}
async function createFixtures(name) {
  const client = new pg.Client({connectionString:dbUrl(name)})
  try {
    await client.connect()
    for (const filename of fixtures) {
      const sql=await readFile(new URL(filename,import.meta.url),'utf8')
      await client.query(sql)
    }
  } finally { await client.end() }
}
function worker(env,flag,options={}) {
  const slug=env==='uat'?'acme':'bravo'
  const vars={
    ...process.env,
    CONTROL_DATABASE_URL:dbUrl('control'),
    TARGET_DATABASE_URL:dbUrl(env),
    TARGET_ENVIRONMENT:env,
    ROOT_DOMAIN:rootDomain,
    PROVISION_REQUEST_ID:requestIds[env],
    CONFIRM_TENANT_BOOTSTRAP:slug+':'+env+':'+requestIds[env],
    ...options,
  }
  const result=spawnSync(process.execPath,[workerPath,flag],{
    env:vars,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  })
  return { code:result.status,stdout:result.stdout,stderr:result.stderr,
    json: result.status===0 ? JSON.parse(result.stdout) : null }
}
async function counts(env) {
  const t=await query(env,
    `SELECT (SELECT COUNT(*)::int FROM tenants) AS tenants,
            (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM tenant_memberships) AS memberships,
            (SELECT COUNT(*)::int FROM user_email_verifications) AS verifications,
            (SELECT COUNT(*)::int FROM managed_environment_tenant_bootstrap) AS provenance,
            (SELECT COUNT(*)::int FROM tenant_environment_instances) AS environment_rows`)
  return t.rows[0]
}
async function setup() {
  const admin=new pg.Client({connectionString:pgAdminUrl})
  try {
    await admin.connect()
    for (const name of Object.values(dbNames)) {
      await admin.query('CREATE DATABASE "'+name+'"')
    }
  } finally {await admin.end()}
  for (const name of Object.keys(dbNames)) await createFixtures(name)
  await query('control',
    `INSERT INTO managed_control_plane_identity
      (deployment_mode,tenancy_mode,root_domain,instance_id,verified_by)
      VALUES ('managed','multi',$1,$2,'isolated-ci-operator')`,
    [rootDomain,instanceIds.control])
  for(const env of ['uat','test']) {
    await query(env,
      `INSERT INTO managed_runtime_database_identity
         (environment,root_domain,instance_id,verified_by)
       VALUES ($1,$2,$3,'isolated-ci-operator')`,
      [env,rootDomain,instanceIds[env]])
    const slug=env==='uat'?'acme':'bravo'
    await query('control',
      `INSERT INTO tenants(id,slug,company_name,status)
       VALUES ($1,$2,$3,'active')`,
      [tenantIds[env],slug,slug+' Company'])
    await query('control',
      `INSERT INTO tenant_settings (tenant_id,modules,onboarding_step,tenant_url,portal_url)
       VALUES ($1,$2::jsonb,'complete',$3,$4)`,
      [tenantIds[env],JSON.stringify({itsm:true,rmm:true,selfService:true}),
        'https://'+slug+'.hi5central.com','https://'+slug+'-portal.hi5central.com'])
    await query('control',
      `INSERT INTO tenant_environment_provision_requests (id,tenant_id,environment,state)
       VALUES ($1,$2,$3,'requested')`,
      [requestIds[env],tenantIds[env],env])
  }
}
async function cleanup() {
  const admin=new pg.Client({connectionString:pgAdminUrl})
  try {
    await admin.connect()
    for(const db of Object.values(dbNames)) {
      await admin.query('DROP DATABASE IF EXISTS "'+db+'" WITH (FORCE)')
    }
  } finally {await admin.end()}
}

test('provisioning worker prepares only isolated suspended tenants and safely retries',async t=>{
  t.after(cleanup)
  await setup()

  await t.test('check is read-only; unconfirmed writes fail',async()=>{
    const result=worker('uat','--check')
    assert.equal(result.code,0,result.stderr)
    assert.equal(result.json.result,'eligible_to_prepare')
    const rejected=worker('uat','--apply',{CONFIRM_TENANT_BOOTSTRAP:'incorrect'})
    assert.notEqual(rejected.code,0)
    assert.deepEqual(await counts('uat'),{
      tenants:0,users:0,memberships:0,verifications:0,provenance:0,environment_rows:0,
    })
    const control=await query('control',
      'SELECT state FROM tenant_environment_provision_requests WHERE id=$1',[requestIds.uat])
    assert.equal(control.rows[0].state,'requested')
  })

  await t.test('apply creates suspended UAT identity and claims request, never opens access',async()=>{
    const result=worker('uat','--apply')
    assert.equal(result.code,0,result.stderr)
    assert.equal(result.json.result,'identity_prepared')
    assert.equal(result.json.ready,false)
    assert.equal(result.json.routingEnabled,false)
    assert.deepEqual(await counts('uat'),{
      tenants:1,users:0,memberships:0,verifications:0,provenance:1,environment_rows:0,
    })
    const local=await query('uat',
      `SELECT t.status,t.slug,s.rmm_url,s.tenant_url,s.modules,b.control_request_id,b.stage
         FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id
         JOIN managed_environment_tenant_bootstrap b ON b.local_tenant_id=t.id`)
    assert.equal(local.rows[0].status,'suspended')
    assert.equal(local.rows[0].rmm_url,null)
    assert.equal(local.rows[0].modules.rmm,false)
    assert.equal(local.rows[0].tenant_url,'https://acmeuat.hi5central.com')
    assert.equal(local.rows[0].control_request_id,requestIds.uat)
    assert.equal(local.rows[0].stage,'identity_prepared')
    const control=await query('control',
      `SELECT q.state,e.provisioning_status FROM tenant_environment_provision_requests q
         JOIN tenant_environment_instances e ON e.tenant_id=q.tenant_id AND e.environment=q.environment
         WHERE q.id=$1`,[requestIds.uat])
    assert.deepEqual(control.rows[0],{state:'claimed',provisioning_status:'provisioning'})
  })

  await t.test('repeat apply is idempotent; no duplicated tenants or records',async()=>{
    const result=worker('uat','--apply')
    assert.equal(result.code,0,result.stderr)
    assert.equal(result.json.result,'already_prepared')
    assert.equal((await counts('uat')).tenants,1)
    assert.equal((await counts('uat')).provenance,1)
  })

  await t.test('tampered local identity rejects retry instead of overwriting',async()=>{
    await query('uat',"UPDATE tenants SET status='active' WHERE slug='acme'")
    const result=worker('uat','--apply')
    assert.notEqual(result.code,0)
    assert.match(result.stderr,/unrecognised or altered tenant identity/)
    assert.equal((await counts('uat')).tenants,1)
    await query('uat',"UPDATE tenants SET status='suspended' WHERE slug='acme'")
  })

  await t.test('wrong target environment and wrong database identity block writes',async()=>{
    const wrongTarget=worker('test','--apply',{TARGET_DATABASE_URL:dbUrl('uat')})
    assert.notEqual(wrongTarget.code,0)
    assert.equal((await counts('test')).tenants,0)
    await query('test',"UPDATE managed_runtime_database_identity SET environment='uat'")
    const mismatch=worker('test','--apply')
    assert.notEqual(mismatch.code,0)
    assert.equal((await counts('test')).tenants,0)
    await query('test',"UPDATE managed_runtime_database_identity SET environment='test'")
  })

  await t.test('unattested central control plane rejects provisioning',async()=>{
    await query('control','DELETE FROM managed_control_plane_identity')
    const rejected=worker('test','--apply')
    assert.notEqual(rejected.code,0)
    assert.match(rejected.stderr,/Control-plane identity verification failed/)
    assert.equal((await counts('test')).tenants,0)
    await query('control',
      `INSERT INTO managed_control_plane_identity
        (deployment_mode,tenancy_mode,root_domain,instance_id,verified_by)
       VALUES ('managed','multi',$1,$2,'isolated-ci-operator')`,
       [rootDomain,instanceIds.control])
  })

  await t.test('partially committed target is suspended and requires manual reconciliation',async()=>{
    const inserted=await query('test',
      `INSERT INTO tenants (slug,company_name,status)
       VALUES ('bravo','bravo Company','suspended') RETURNING id`)
    const localId=inserted.rows[0].id
    await query('test',
      `INSERT INTO tenant_settings
         (tenant_id,modules,onboarding_step,tenant_url,portal_url,rmm_url)
       VALUES ($1,$2::jsonb,'company',$3,$4,NULL)`,
      [localId,JSON.stringify({itsm:true,selfService:true,rmm:false}),
       'https://bravotest.hi5central.com','https://bravotest-portal.hi5central.com'])
    await query('test',
      `INSERT INTO managed_environment_tenant_bootstrap
         (control_request_id,control_tenant_id,local_tenant_id,environment,database_instance_id,expected_hostname)
       VALUES ($1,$2,$3,'test',$4,'bravotest.hi5central.com')`,
      [requestIds.test,tenantIds.test,localId,instanceIds.test])
    const rejected=worker('test','--apply')
    assert.notEqual(rejected.code,0)
    assert.match(rejected.stderr,/control-plane request state is inconsistent/)
    assert.equal((await counts('test')).tenants,1)
    const pending=await query('control','SELECT state FROM tenant_environment_provision_requests WHERE id=$1',[requestIds.test])
    assert.equal(pending.rows[0].state,'requested')
    // Only this test fixture is reconciled; a live operator would require
    // manual review and must never automatically delete or activate it.
    await query('test','DELETE FROM managed_environment_tenant_bootstrap WHERE local_tenant_id=$1',[localId])
    await query('test','DELETE FROM tenant_settings WHERE tenant_id=$1',[localId])
    await query('test','DELETE FROM tenants WHERE id=$1',[localId])
  })

  await t.test('Test can prepare independently without creating UAT records',async()=>{
    const result=worker('test','--apply')
    assert.equal(result.code,0,result.stderr)
    assert.equal(result.json.result,'identity_prepared')
    assert.equal((await counts('uat')).tenants,1)
    assert.equal((await counts('test')).tenants,1)
    const row=await query('test','SELECT status,slug FROM tenants')
    assert.deepEqual(row.rows[0],{status:'suspended',slug:'bravo'})
    assert.equal((await counts('test')).environment_rows,0)
  })
})
