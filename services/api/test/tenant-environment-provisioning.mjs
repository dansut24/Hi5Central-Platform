import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { Hono } from 'hono'
import { registerEnvironmentHandoffRoutes, issueEnvironmentTicket } from '../src/environmentHandoff.js'
import { hashPassword } from '../src/password.js'
import { pool } from '../src/db.js'
import { provisionTenantSandboxes } from '../src/tenantEnvironmentProvisioner.js'

const { Client }=pg
const testDb=process.env.TENANT_TEST_DATABASE_URL
const uatDb=process.env.TENANT_UAT_DATABASE_URL
if(!testDb||!uatDb)throw Error('Two isolated test databases are required')
const suffix=randomBytes(5).toString('hex'), slug='sandbox-'+suffix
const userEmail='sandbox-'+suffix+'@example.invalid'
const userPw='SandboxAccountPass-'+suffix+'!'
const source=pool
const clients=[new Client({connectionString:testDb}),new Client({connectionString:uatDb})]
for(const c of clients)await c.connect()
try {
  const t=await source.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",[slug,'Sandbox Test Organisation'])
  const tenantId=t.rows[0].id
  const u=await source.query("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id",[userEmail,'Sandbox Owner',await hashPassword(userPw)])
  const userId=u.rows[0].id
  await source.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[tenantId,userId])
  const settings={company:{displayName:'Source Branding'},theme:{accent:'#224466'},security:{requireMfa:false}}
  await source.query(`INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)
    VALUES($1,'{"itsm":true,"rmm":true}'::jsonb,'complete',now(),$2::jsonb,$2::jsonb,$3,$4,$5)`,
    [tenantId,JSON.stringify(settings),'https://'+slug+'.hi5central.com','https://'+slug+'-portal.hi5central.com','https://'+slug+'-rmm.hi5central.com'])
  await source.query("INSERT INTO tenant_release_preferences(tenant_id,update_mode) VALUES($1,'admin_controlled') ON CONFLICT(tenant_id) DO NOTHING",[tenantId])
  const cfg={source,targets:{test:testDb,uat:uatDb}}
  const ready=await provisionTenantSandboxes(tenantId,cfg)
  assert.equal(ready.test.status,'ready',JSON.stringify(ready))
  assert.equal(ready.uat.status,'ready',JSON.stringify(ready))
  for(const [i,env] of ['test','uat'].entries()) {
    const db=clients[i]
    const t=await db.query(`SELECT t.slug,ts.tenant_url,ts.configuration,ts.onboarding_step
      FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id WHERE t.id=$1`,[tenantId])
    assert.equal(t.rowCount,1,'tenant must exist in '+env)
    assert.equal(t.rows[0].slug,slug+'-'+env)
    assert.equal(t.rows[0].tenant_url,'https://'+slug+'-'+env+'.hi5central.com')
    assert.equal(t.rows[0].onboarding_step,'complete')
    assert.equal(t.rows[0].configuration.company.displayName,'Source Branding')
    const member=await db.query('SELECT role,status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])
    assert.equal(member.rows[0].role,'owner')
    assert.equal(member.rows[0].status,'active')
    const identity=await db.query('SELECT email,password_hash FROM users WHERE id=$1',[userId])
    assert.equal(identity.rows[0].email,userEmail)
    assert.equal(identity.rows[0].password_hash,'environment-sso-only','environment users must use the central one-time identity handoff')
  }
  // Test-only configuration is modified, then a retry must not overwrite sandbox data.
  await clients[0].query(`UPDATE tenant_settings SET configuration='{"sandbox":"customised"}'::jsonb WHERE tenant_id=$1`,[tenantId])
  const again=await provisionTenantSandboxes(tenantId,cfg)
  assert.equal(again.test.status,'ready')
  assert.equal(again.uat.status,'ready')
  const persistent=await clients[0].query('SELECT configuration FROM tenant_settings WHERE tenant_id=$1',[tenantId])
  assert.equal(persistent.rows[0].configuration.sandbox,'customised')
  const statuses=await source.query('SELECT environment,status FROM tenant_environment_state WHERE tenant_id=$1',[tenantId])
  assert.deepEqual(statuses.rows.sort((a,b)=>a.environment.localeCompare(b.environment)),[
    {environment:'live',status:'ready'}, {environment:'test',status:'ready'}, {environment:'uat',status:'ready'},
  ])
  // Only trusted service calls may redeem a ticket, and a ticket can be
  // used once for exactly one environment. The URL fragment never reaches
  // the static site/server in an HTTP request.
  process.env.ENV_IDENTITY_SHARED_SECRET='test-ci-identity-secret-longer-than-thirty-two-chars'
  const app=new Hono()
  registerEnvironmentHandoffRoutes(app)
  const issued=await issueEnvironmentTicket(tenantId,userId,'test',{source,verified:true})
  assert(issued.startsWith('https://'+slug+'-test.hi5central.com/#hi5_environment_ticket='))
  const ticket=new URLSearchParams(issued.split('#')[1]).get('hi5_environment_ticket')
  const redeemBody=JSON.stringify({ticket,environment:'test'})
  const unauthorised=await app.request('/api/v1/internal/environment-handoff/redeem',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer invalid'},body:redeemBody,
  })
  assert.equal(unauthorised.status,401)
  const wrongEnv=await app.request('/api/v1/internal/environment-handoff/redeem',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.ENV_IDENTITY_SHARED_SECRET},
    body:JSON.stringify({ticket,environment:'uat'}),
  })
  assert.equal(wrongEnv.status,401)
  const authorised=await app.request('/api/v1/internal/environment-handoff/redeem',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.ENV_IDENTITY_SHARED_SECRET},
    body:redeemBody,
  })
  assert.equal(authorised.status,200) 
  const redeemed=await authorised.json()
  assert.equal(redeemed.tenantSlug,slug+'-test')
  assert.equal(redeemed.userId,userId)
  assert.equal(redeemed.mfaVerified,true)
  const replay=await app.request('/api/v1/internal/environment-handoff/redeem',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.ENV_IDENTITY_SHARED_SECRET},
    body:redeemBody,
  })
  assert.equal(replay.status,401,'single-use ticket must reject replay')

  // No customer data: source has not been copied wholesale into either sandbox.
  const unrelated=await source.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,'Unrelated company','active') RETURNING id",['unrelated-'+suffix])
  for(const db of clients){
    const r=await db.query('SELECT count(*)::int AS n FROM tenants WHERE id=$1',[unrelated.rows[0].id])
    assert.equal(r.rows[0].n,0)
  }
  console.log('PASS: 2 environment DBs, separate tenant data, owner login identity, correct URLs, retry preservation, no unrelated tenant copy')
}finally {
  for(const c of clients)await c.end().catch(()=>{})
  await source.end()
}
