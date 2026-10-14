import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { Hono } from 'hono'
import { registerEnvironmentHandoffRoutes, issueEnvironmentTicket } from '../src/environmentHandoff.js'
import { hashPassword } from '../src/password.js'
import { pool } from '../src/db.js'
import { backfillCompletedTenantSandboxes, provisionTenantSandboxes } from '../src/tenantEnvironmentProvisioner.js'
import { assignEnvironmentPermissions, permittedTenantEnvironment, environmentMembers } from '../src/tenantEnvironmentAccess.js'
import { establishEnvironmentSession } from '../src/environmentDirectSession.js'
import { registerOrganisationRoutes } from '../src/organisation.js'
import { readCanonicalDirectory } from '../src/liveDirectoryBridge.js'
import { recordItsmConfigurationChange, listItsmConfigurationChanges } from '../src/itsmConfigurationChanges.js'

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
    const t=await db.query(`SELECT t.slug,ts.tenant_url,ts.configuration,ts.modules,ts.rmm_url,ts.onboarding_step
      FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id WHERE t.id=$1`,[tenantId])
    assert.equal(t.rowCount,1,'tenant must exist in '+env)
    assert.equal(t.rows[0].slug,slug+'-'+env)
    assert.equal(t.rows[0].tenant_url,'https://'+slug+'-'+env+'.hi5central.com')
    assert.equal(t.rows[0].onboarding_step,'complete')
    assert.equal(t.rows[0].configuration.company.displayName,'Source Branding')
    assert.equal(t.rows[0].modules.rmm,false,'RMM must not exist as an ITSM sandbox module')
    assert.equal(t.rows[0].rmm_url,null,'RMM URL must always point to Live, never UAT/Test')
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
  // Live is the user directory authority. Reconciliation updates safe profile
  // projections without copying passwords, MFA secrets or ITSM configuration.
  await source.query('UPDATE users SET name=$2 WHERE id=$1',[userId,'Renamed Live Owner'])
  await provisionTenantSandboxes(tenantId,cfg)
  for(const db of clients){
    const name=await db.query('SELECT name FROM users WHERE id=$1',[userId])
    assert.equal(name.rows[0]?.name,'Renamed Live Owner')
  }
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

  // The Live identity is authoritative. Owners have implicit access; a new
  // user has none until the administrator grants it in People.
  assert.equal(await permittedTenantEnvironment(tenantId,userId,'test'),true)
  assert.equal(await permittedTenantEnvironment(tenantId,userId,'uat'),true)
  const extraEmail='member-'+suffix+'@example.invalid'
  const extra=await source.query(
    "INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,'ci-central-only',now()) RETURNING id",
    [extraEmail,'Additional Member'],
  )
  const memberId=extra.rows[0].id
  await source.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'admin','active')",[tenantId,memberId])
  assert.equal(await permittedTenantEnvironment(tenantId,memberId,'uat'),false)
  assert.equal(await permittedTenantEnvironment(tenantId,memberId,'test'),false)
  await assert.rejects(()=>issueEnvironmentTicket(tenantId,memberId,'uat',{source,verified:true}),/not been granted/)
  await assignEnvironmentPermissions(tenantId,memberId,{test:false,uat:true},userId)
  assert.equal(await permittedTenantEnvironment(tenantId,memberId,'uat'),true)
  assert.equal(await permittedTenantEnvironment(tenantId,memberId,'test'),false)
  const grants=await environmentMembers(tenantId)
  assert(grants.some(m=>m.userId===memberId&&m.uat===true&&m.test===false))
  const localMember=await clients[1].query("SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[tenantId,memberId])
  assert.equal(localMember.rows[0]?.role,'admin','new UAT user must be synced with Live role')
  const uatTokenHash='revoke-test-'+suffix
  await clients[1].query(
    "INSERT INTO auth_sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [tenantId,memberId,uatTokenHash],
  )
  await assignEnvironmentPermissions(tenantId,memberId,{test:false,uat:false},userId)
  assert.equal(await permittedTenantEnvironment(tenantId,memberId,'uat'),false)
  const revoked=await clients[1].query('SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash=$1',[uatTokenHash])
  assert.equal(revoked.rows[0]?.revoked,true,'revoking UAT access must revoke existing UAT sessions')
  await assert.rejects(()=>issueEnvironmentTicket(tenantId,memberId,'uat',{source,verified:true}),/not been granted/)
  await assert.rejects(()=>assignEnvironmentPermissions(tenantId,userId,{test:false,uat:true},userId),/owners must retain/)
  console.log('PASS: central owner defaults, People UAT grant, denial before grant, and instant session revocation')

  // Browser-side UAT ticket exchanges are no longer required for normal
  // sign-in: Live creates a fully scoped session in the UAT database and
  // issues an HttpOnly parent-domain cookie without exposing the token in URL.
  const directApp=new Hono()
  const directSourceSession={
    tenant_id:tenantId,user_id:userId,slug,mfa_verified_at:new Date(),
  }
  directApp.post('/direct',async c=>c.json(
    await establishEnvironmentSession(c,directSourceSession,'uat',{source,targets:{uat:uatDb}}),
  ))
  const direct=await directApp.request('/direct',{method:'POST'})
  assert.equal(direct.status,200)
  const directPayload=await direct.json()
  assert.equal(directPayload.url,'https://'+slug+'-uat.hi5central.com/dashboard?environment_sso=1')
  assert(!directPayload.url.includes('ticket'),'URL must not carry secret tokens')
  const setCookie=direct.headers.get('set-cookie')||''
  assert.match(setCookie,/hi5central_uat_session=/)
  assert.match(setCookie,/httponly/i)
  assert.match(setCookie,/secure/i)
  assert(setCookie.toLowerCase().includes('domain=.hi5central.com'),'Cookie must be scoped to all first-party Hi5Central environments')
  const token=setCookie.match(/hi5central_uat_session=([^;]+)/)?.[1]
  assert(token)
  const tokenDigest=(await import('node:crypto')).createHash('sha256').update(token).digest('hex')
  const child=await clients[1].query(
    'SELECT tenant_id,user_id,mfa_verified_at IS NOT NULL AS mfa FROM auth_sessions WHERE token_hash=$1',
    [tokenDigest],
  )
  assert.equal(child.rows[0]?.tenant_id,tenantId)
  assert.equal(child.rows[0]?.user_id,userId)
  assert.equal(child.rows[0]?.mfa,true)
  const noGrantSession={...directSourceSession,user_id:memberId}
  await assert.rejects(
    ()=>establishEnvironmentSession({
      header:()=>{},req:{header:()=>''}
    },noGrantSession,'uat',{source,targets:{uat:uatDb}}),
    /not been granted/,
  )
  console.log('PASS: Live signs UAT session directly, parent-domain HttpOnly cookie, MFA, no URL tokens, no-grant denial')

  // No customer data: source has not been copied wholesale into either sandbox.
  const unrelated=await source.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,'Unrelated company','active') RETURNING id",['unrelated-'+suffix])
  for(const db of clients){
    const r=await db.query('SELECT count(*)::int AS n FROM tenants WHERE id=$1',[unrelated.rows[0].id])
    assert.equal(r.rows[0].n,0)
  }
  // Existing customers that completed onboarding before release should be
  // provisioned by the explicit one-time backfill, but unfinished tenants not.
  const legacySlug=slug+'-old'
  const legacyTenant=await source.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",[legacySlug,'Already onboarded'])
  const legacyId=legacyTenant.rows[0].id
  await source.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[legacyId,userId])
  await source.query(`INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)
    VALUES($1,'{"itsm":true,"rmm":false}'::jsonb,'complete',now(),'{}','{}',$2,$3,NULL)`,
    [legacyId,'https://'+legacySlug+'.hi5central.com','https://'+legacySlug+'-portal.hi5central.com'])
  await source.query("INSERT INTO tenant_release_preferences(tenant_id,update_mode) VALUES($1,'admin_controlled') ON CONFLICT(tenant_id) DO NOTHING",[legacyId])
  const backfilled=await backfillCompletedTenantSandboxes({source})
  assert.equal(backfilled.tenants,1,'only the additional completed tenant needs reconciliation')
  for(const [i,env] of ['test','uat'].entries()) {
    const result=await clients[i].query('SELECT slug FROM tenants WHERE id=$1',[legacyId])
    assert.equal(result.rows[0]?.slug,legacySlug+'-'+env)
  }
  const repeatBackfill=await backfillCompletedTenantSandboxes({source})
  assert.equal(repeatBackfill.tenants,0,'reconciliation must not create duplicate work')
  // Managed tenants get a Test workspace, never UAT and never RMM sandbox state.
  const managedSlug='managed-'+suffix
  const managedTenant=await source.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,'Managed QA organisation','active') RETURNING id",[managedSlug])
  const managedId=managedTenant.rows[0].id
  await source.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[managedId,userId])
  await source.query(`INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_completed_at,onboarding_data,configuration,tenant_url,portal_url,rmm_url)
    VALUES($1,'{"itsm":true,"rmm":true}'::jsonb,'complete',now(),'{}','{}',$2,$3,$4)`,
    [managedId,'https://'+managedSlug+'.hi5central.com','https://'+managedSlug+'-portal.hi5central.com','https://'+managedSlug+'-rmm.hi5central.com'])
  await source.query("INSERT INTO tenant_release_preferences(tenant_id,update_mode) VALUES($1,'hi5_managed') ON CONFLICT(tenant_id) DO UPDATE SET update_mode='hi5_managed'",[managedId])
  const managed=await provisionTenantSandboxes(managedId,cfg)
  assert.deepEqual(Object.keys(managed),['test'],'managed tenant must not provision UAT')
  assert.equal(managed.test.status,'ready')
  const liveManaged=await source.query('SELECT modules,rmm_url FROM tenant_settings WHERE tenant_id=$1',[managedId])
  assert.equal(liveManaged.rows[0].modules.rmm,true,'Live RMM module must remain enabled')
  assert(liveManaged.rows[0].rmm_url?.includes('-rmm.'))
  const testManaged=await clients[0].query('SELECT modules,rmm_url FROM tenant_settings WHERE tenant_id=$1',[managedId])
  assert.equal(testManaged.rows[0].modules.rmm,false)
  assert.equal(testManaged.rows[0].rmm_url,null)
  assert.equal((await clients[1].query('SELECT 1 FROM tenants WHERE id=$1',[managedId])).rowCount,0)
  assert.equal(await permittedTenantEnvironment(managedId,userId,'uat'),false)
  await assert.rejects(()=>assignEnvironmentPermissions(managedId,userId,{test:true,uat:true},userId,{sync:false}),/does not have a UAT/)
  assert.equal((await environmentMembers(managedId)).find(x=>x.userId===userId).uat,false)
  console.log('PASS: Custom Test+UAT, Managed Test only; shared identity projections, no sandbox RMM and Live RMM preserved')

  // Full integration of the central Live-owned directory: real source tables,
  // service credential validation, current environment grant and read-through.
  const directoryApp=new Hono()
  registerOrganisationRoutes(directoryApp)
  await source.query(
    `INSERT INTO organisation_people(tenant_id,external_key,user_id,name,email)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,external_key)
     DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email`,
    [tenantId,'USR-'+userId.slice(0,12).toUpperCase(),userId,'Renamed Live Owner',userEmail],
  )
  const directoryRequest=(requestedTenantId,requestedUserId,env,token=process.env.ENV_IDENTITY_SHARED_SECRET)=>
    directoryApp.request('/api/v1/internal/organisation/directory-snapshot',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':'Bearer '+token},
      body:JSON.stringify({tenantId:requestedTenantId,userId:requestedUserId,environment:env}),
    })
  const anonymousDirectory=await directoryRequest(tenantId,userId,'uat','invalid-credential')
  assert.equal(anonymousDirectory.status,401,'directory never returns people without service credential')
  const forbiddenDirectory=await directoryRequest(unrelated.rows[0].id,userId,'uat')
  assert.equal(forbiddenDirectory.status,403,'cross-tenant access must be rejected by Live')
  const revokedDirectory=await directoryRequest(tenantId,memberId,'uat')
  assert.equal(revokedDirectory.status,403,'revoked UAT grant must not read Live People')
  const allowedDirectory=await directoryRequest(tenantId,userId,'uat')
  assert.equal(allowedDirectory.status,200,'granted Custom UAT identity may read Live directory')
  const allowedPayload=await allowedDirectory.json()
  assert(allowedPayload.directory.people.some(x=>x.email===userEmail&&x.name==='Renamed Live Owner'))
  const forwarded=await readCanonicalDirectory(tenantId,userId,{
    environment:'uat',apiUrl:'https://identity.example.invalid',
    secret:process.env.ENV_IDENTITY_SHARED_SECRET,
    fetcher:async(url,options)=>directoryApp.request(new URL(url).pathname,{
      method:options.method,headers:options.headers,body:options.body,
    }),
  })
  assert.deepEqual(forwarded,allowedPayload.directory,'sandbox read-through must return the current Live directory')
  console.log('PASS: Live-owned People read-through with real Postgres, active access and cross-tenant isolation')

  // Exercise the audit schema itself against real, fully migrated Live/Test/UAT databases.
  const previousConfig={sla:{targetHours:8},notifications:true}
  const changedConfig={sla:{targetHours:6},notifications:true}
  const recordedUat=await recordItsmConfigurationChange({
    db:clients[1],tenantId,actorUserId:userId,environment:'uat',
    before:previousConfig,after:changedConfig,
  })
  assert.equal(recordedUat.recorded,true)
  const recordedAgain=await recordItsmConfigurationChange({
    db:clients[1],tenantId,actorUserId:userId,environment:'uat',
    before:changedConfig,after:changedConfig,
  })
  assert.equal(recordedAgain.recorded,false,'saving without changes must not generate another event')
  assert.equal((await listItsmConfigurationChanges({
    db:clients[1],tenantId,environment:'uat',
  })).length,1)
  assert.deepEqual(await listItsmConfigurationChanges({
    db:clients[1],tenantId:managedId,environment:'uat',
  }),[],'audit must not leak across tenants')
  assert.equal((await recordItsmConfigurationChange({
    db:clients[0],tenantId,actorUserId:userId,environment:'test',
    before:previousConfig,after:changedConfig,
  })).recorded,false,'Test intentionally has no config change ledger')
  const recordedLive=await recordItsmConfigurationChange({
    db:source,tenantId,actorUserId:userId,environment:'live',
    before:previousConfig,after:changedConfig,
  })
  assert.equal(recordedLive.recorded,true)
  assert.equal((await listItsmConfigurationChanges({
    db:source,tenantId,environment:'live',
  })).length,1)
  const stored=await clients[1].query(
    'SELECT before_sha256,after_sha256,changed_keys FROM itsm_configuration_change_events WHERE tenant_id=$1 AND environment=$2',
    [tenantId,'uat'],
  )
  assert.deepEqual(stored.rows[0].changed_keys,['sla'])
  assert.match(stored.rows[0].before_sha256,/^[a-f0-9]{64}$/)
  assert.match(stored.rows[0].after_sha256,/^[a-f0-9]{64}$/)
  console.log('PASS: migrated Live/UAT ledger, Test untracked, unchanged-write suppression and tenant isolation')

}finally {
  for(const c of clients)await c.end().catch(()=>{})
  await source.end()
}
