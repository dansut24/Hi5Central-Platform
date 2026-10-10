import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import pg from 'pg'
import { hashPassword } from '../src/password.js'
import { createSession } from '../src/session.js'

const { Client } = pg
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const suffix = randomBytes(5).toString('hex')
const slug = 'onboarding-' + suffix
const email = 'onboarding-' + suffix + '@example.invalid'
const initial = { company: { displayName: 'Saved Company' }, theme: { accent: 'blue' },
  users: { source: 'local' }, groups: { firstSite: 'London' }, permissions: { preset: 'balanced' } }
const url = process.env.TEST_API_URL || 'http://127.0.0.1:3001'
const digest = x => createHash('sha256').update(x).digest('hex')
let tenantId, userId, token
try {
  const tenant = await db.query(
    "INSERT INTO tenants (slug,company_name,status) VALUES ($1,$2,'active') RETURNING id",
    [slug, 'Onboarding Regression'],
  )
  tenantId = tenant.rows[0].id
  const user = await db.query(
    'INSERT INTO users (email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
    [email, 'Test Owner', await hashPassword('Ci-Test-Password-2026!')],
  )
  userId = user.rows[0].id
  await db.query(
    "INSERT INTO tenant_memberships (tenant_id,user_id,role,status) VALUES ($1,$2,'owner','active')",
    [tenantId, userId],
  )
  await db.query(
    "INSERT INTO tenant_settings (tenant_id,modules,onboarding_step,onboarding_data,tenant_url,portal_url,rmm_url) VALUES ($1,$2::jsonb,'security',$3::jsonb,$4,$5,$6)",
    [tenantId, JSON.stringify({ itsm: true, rmm: true }), JSON.stringify(initial), 'https://' + slug + '.hi5central.com', 'https://' + slug + '-portal.hi5central.com', 'https://' + slug + '-rmm.hi5central.com'],
  )
  token = await createSession(db, { tenantId, userId, surface: 'workspace' })
  const opts = {headers:{origin:'https://'+slug+'.hi5central.com',
    cookie:'hi5central_session='+token+'; hi5central_dev_session='+token,
    'content-type':'application/json'}}
  async function call(method,route,body) {
    const r = await fetch(url+route, { method, headers:opts.headers, ...(body ? {body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(9000) })
    return { code:r.status, data: await r.json() }
  }
  const session = await call('GET','/api/v1/onboarding/session')
  assert.equal(session.code,200,JSON.stringify(session.data))
  assert.equal(session.data.onboarding.step,'security')
  assert.equal(session.data.onboarding.data.company.displayName,'Saved Company')
  const invalid = await call('POST','/api/v1/onboarding/step',{step:'updates',data:{updateMode:'hi5_managed'}})
  assert.equal(invalid.code,409,'must not skip current security step')
  const security = await call('POST','/api/v1/onboarding/step',
    {step:'security',data:{requireMfa:false,sessionHours:12,passwordPolicy:'strong'}})
  assert.equal(security.code,200,JSON.stringify(security.data))
  assert.equal(security.data.onboarding.step,'updates')
  const bad = await call('POST','/api/v1/onboarding/step',
    {step:'updates',data:{updateMode:'invalid',liveDelayHours:24}})
  assert.equal(bad.code,400,'invalid update modes must be rejected')
  const afterBad = await call('GET','/api/v1/onboarding/session')
  assert.equal(afterBad.data.onboarding.step,'updates','validation must not advance progress')
  const edit = await call('POST','/api/v1/onboarding/save',
    {step:'updates',data:{updateMode:'admin_controlled',liveDelayHours:24,allowEmergencySecurityUpdates:true}})
  assert.equal(edit.code,200,JSON.stringify(edit.data))
  assert.equal(edit.data.onboarding.step,'updates')
  let policy = await db.query('SELECT update_mode,uat_auto_stage,live_auto_promote FROM tenant_release_preferences WHERE tenant_id=$1',[tenantId])
  assert.equal(policy.rows[0].update_mode,'admin_controlled')
  assert.equal(policy.rows[0].uat_auto_stage,false)
  const advance = await call('POST','/api/v1/onboarding/step',
    {step:'updates',data:{updateMode:'hi5_managed',liveDelayHours:48,allowEmergencySecurityUpdates:false}})
  assert.equal(advance.code,200,JSON.stringify(advance.data))
  assert.equal(advance.data.onboarding.step,'itsm')
  const resume = await call('GET','/api/v1/onboarding/session')
  assert.equal(resume.data.onboarding.step,'itsm','refresh should restore saved step')
  assert.equal(resume.data.onboarding.data.company.displayName,'Saved Company','existing data must be preserved')
  assert.equal(resume.data.onboarding.data.updates.updateMode,'hi5_managed')
  policy = await db.query('SELECT update_mode,live_delay_hours,uat_auto_stage,live_auto_promote,allow_emergency_security_updates FROM tenant_release_preferences WHERE tenant_id=$1',[tenantId])
  assert.equal(policy.rows[0].update_mode,'hi5_managed')
  assert.equal(policy.rows[0].live_delay_hours,48)
  assert.equal(policy.rows[0].uat_auto_stage,true)
  assert.equal(policy.rows[0].live_auto_promote,true)
  assert.equal(policy.rows[0].allow_emergency_security_updates,false)
  const previous = await call('POST','/api/v1/onboarding/save',{step:'security',data:{requireMfa:false}})
  assert.equal(previous.code,200,JSON.stringify(previous.data))
  assert.equal(previous.data.onboarding.step,'itsm','editing a past step must not erase progress')
  const wrongSlug = await db.query('SELECT count(*)::int n FROM tenant_release_preferences WHERE tenant_id<>$1',[tenantId])
  assert.equal(wrongSlug.rows[0].n,0,'onboarding must not modify other tenant policies')
  // Model a legacy tenant moved back to Domain & email by migration 119.
  await db.query('BEGIN')
  try {
    const legacySlug = slug + '-legacy'
    const legacyTenant = await db.query("INSERT INTO tenants (slug,company_name,status) VALUES ($1,$2,'active') RETURNING id",
      [legacySlug, 'Previously saved legacy onboarding'])
    const legacyId = legacyTenant.rows[0].id
    await db.query(
      "INSERT INTO tenant_settings (tenant_id,modules,onboarding_step,onboarding_data,tenant_url,portal_url,rmm_url) VALUES ($1,$2::jsonb,'delivery',$3::jsonb,$4,$5,$6)",
      [legacyId, JSON.stringify({ itsm: true, rmm: true }), JSON.stringify(initial),
       'https://' + legacySlug + '.hi5central.com', 'https://' + legacySlug + '-portal.hi5central.com', 'https://' + legacySlug + '-rmm.hi5central.com'],
    )
    const migration = readFileSync(new URL('../migrations/identity-access/139_restore_legacy_onboarding_progress.sql', import.meta.url),'utf8')
    await db.query(migration)
    let result = await db.query('SELECT onboarding_step,onboarding_data FROM tenant_settings WHERE tenant_id=$1',[legacyId])
    assert.equal(result.rows[0].onboarding_step,'security','legacy progress should resume at Security')
    assert.deepEqual(result.rows[0].onboarding_data,initial,'legacy saved answers must be unchanged')
    await db.query(migration)
    result = await db.query('SELECT onboarding_step FROM tenant_settings WHERE tenant_id=$1',[legacyId])
    assert.equal(result.rows[0].onboarding_step,'security','migration must be idempotent')
  } finally {
    await db.query('ROLLBACK')
  }
  console.log('PASS: saved steps preserved; Security -> Updates -> ITSM; refresh resume; Previous edit; invalid input and skipped steps blocked; managed release preferences persisted')
} finally {
  await db.end()
}
