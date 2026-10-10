// Integration regression: one email account owns multiple isolated tenants.
// Runs only against an ephemeral CI Postgres/Redis instance; never Production.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'

const base = process.env.SIGNUP_TEST_BASE_URL || 'http://127.0.0.1:3001'
const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('Ephemeral DATABASE_URL required')
const client = new pg.Client({connectionString})
await client.connect()
const id = randomUUID().replaceAll('-', '').slice(0, 10)
const email = `same-email-${id}@example.invalid`
const password = `Strong-Test-Passphrase-${id}-2026`
const tenantA = `first-${id}`, tenantB = `second-${id}`, tenantWrong = `rejected-${id}`
const hash = value => createHash('sha256').update(value).digest('hex')
const req = async (payload) => {
  const r = await fetch(base+'/api/v1/auth/signup', {
    method: 'POST',
    headers: {'content-type':'application/json','origin':'https://hi5central.com'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(15_000),
  })
  return {status:r.status,body:await r.json()}
}
const body = (slug,pw) => ({companyName:'Automated Signup CI',tenantSlug:slug,name:'CI Test Owner',email,password:pw,modules:['itsm','rmm']})
try {
  const initial = await req(body(tenantA,password))
  assert.equal(initial.status,201,JSON.stringify(initial.body))
  assert.equal(initial.body.status,'pending_verification')
  const user = await client.query('SELECT id,name,password_hash FROM users WHERE email=$1',[email])
  assert.equal(user.rowCount,1)
  const originalHash = hash(user.rows[0].password_hash)
  const originalName = user.rows[0].name
  const wrong = await req(body(tenantWrong,'Incorrect-Test-Passphrase-2026'))
  assert.equal(wrong.status,401,JSON.stringify(wrong.body))
  assert.equal((await client.query('SELECT count(*)::int n FROM tenants WHERE slug=$1',[tenantWrong])).rows[0].n,0)
  const second = await req(body(tenantB,password))
  assert.equal(second.status,201,JSON.stringify(second.body))
  assert.equal(second.body.tenant.slug,tenantB)
  assert.equal((await client.query('SELECT count(*)::int n FROM users WHERE email=$1',[email])).rows[0].n,1)
  assert.equal((await client.query('SELECT count(*)::int n FROM tenant_memberships WHERE user_id=$1',[user.rows[0].id])).rows[0].n,2)
  const updated = await client.query('SELECT name,password_hash FROM users WHERE id=$1',[user.rows[0].id])
  assert.equal(hash(updated.rows[0].password_hash),originalHash,'original password hash must never change')
  assert.equal(updated.rows[0].name,originalName,'original identity name must never change')
  const memberships=await client.query('SELECT t.slug,m.status,m.role FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.slug',[user.rows[0].id])
  assert.deepEqual(memberships.rows.map(x=>x.slug),[tenantA,tenantB].sort())
  assert(memberships.rows.every(x=>x.role==='owner'&&x.status==='pending_verification'))
  assert.equal((await client.query('SELECT count(*)::int n FROM user_email_verifications v JOIN tenants t ON v.tenant_id=t.id WHERE t.slug IN ($1,$2)',[tenantA,tenantB])).rows[0].n,2)
  const duplicate=await req(body(tenantB,password))
  assert.equal(duplicate.status,409)
  console.log('PASS: one user, two tenant memberships, isolated pending verification, no password/name overwrite, wrong password rejected, duplicate slug blocked')
} finally {
  await client.end()
}
