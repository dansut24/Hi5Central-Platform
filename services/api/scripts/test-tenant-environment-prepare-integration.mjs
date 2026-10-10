import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createClient } from 'redis'
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
const activationPath=fileURLToPath(new URL('./tenant-environment-activate.mjs',import.meta.url))
const ownerInvitationPath=fileURLToPath(new URL('./tenant-environment-owner-invite.mjs',import.meta.url))
const httpTestPath=fileURLToPath(new URL('./test-sandbox-lifecycle-http.mjs',import.meta.url))
const redisPorts={uat:55438,test:55439}
const redisInstanceIds={uat:'88888888-8888-4888-8888-888888888888',test:'99999999-9999-4999-8999-999999999999'}
function redisUrl(env){return `redis://127.0.0.1:${redisPorts[env]}`}
function operator(env,flag,extra={}) {
  const slug=env==='uat'?'acme':'bravo'
  const envs={...process.env,CONTROL_DATABASE_URL:dbUrl('control'),
    TARGET_DATABASE_URL:dbUrl(env),TARGET_ENVIRONMENT:env,ROOT_DOMAIN:rootDomain,
    TENANT_SLUG:slug,TARGET_REDIS_URL:redisUrl(env),
    ACTIVATION_OPERATOR:'operator-two',INDEPENDENT_REVIEWER:'reviewer-one',
    CONFIRM_SANDBOX_ACTIVATION:`${slug}:${env}:${requestIds[env]}:${flag.slice(2)}`,
    ...extra,
  }
  const result=spawnSync(process.execPath,[activationPath,flag],{
    env:envs,encoding:'utf8',timeout:20000,maxBuffer:1024*1024,
  })
  return {code:result.status,stdout:result.stdout,stderr:result.stderr,
    json:result.status===0?JSON.parse(result.stdout):null}
}
function initialOwner(env,flag,extra={}){
  const slug=env==='uat'?'acme':'bravo'
  const envs={...process.env,
    TARGET_DATABASE_URL:dbUrl(env),TARGET_ENVIRONMENT:env,
    ROOT_DOMAIN:rootDomain,TENANT_SLUG:slug,
    INITIAL_OWNER_EMAIL:`first-owner-${env}@example.invalid`,
    INITIAL_OWNER_NAME:'First Sandbox Owner',
    OWNER_INVITATION_OPERATOR:'isolated-ci-invitation-operator',
    CONFIRM_SANDBOX_OWNER_INVITATION:`${slug}:${env}:${extra.tenantId||''}`,
    CONFIRM_SANDBOX_OWNER_CANCELLATION:`${slug}:${env}:${extra.tenantId||''}:first-owner-${env}@example.invalid:cancel`,
    SMTP_HOST:'127.0.0.1',SMTP_PORT:'55440',
    SMTP_USER:'isolated-ci@example.invalid',SMTP_PASSWORD:'isolated-ci-only',
    ...extra,
  }
  return envs
}
function processAsync(script,args,env,timeout=20000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{env,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout)
    child.stdout.on('data',v=>stdout+=String(v))
    child.stderr.on('data',v=>stderr+=String(v))
    child.on('error',reject)
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,
      json:code===0?JSON.parse(stdout):null})})
  })
}
function smtpSink() {
  const messages=[]
  const server=createServer(socket=>{
    socket.setEncoding('utf8')
    socket.write('220 hi5central-isolated-ci-smtp ESMTP\r\n')
    let buffer='',inData=false,data=''
    socket.on('data',chunk=>{
      buffer+=chunk
      let stop
      while((stop=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,stop).replace(/\r$/,'')
        buffer=buffer.slice(stop+1)
        if(inData){
          if(line==='.'){
            messages.push(data)
            data='';inData=false
            socket.write('250 accepted for ephemeral test\r\n')
          }else data+=(line.startsWith('..')?line.slice(1):line)+'\n'
        }else if(/^EHLO|^HELO/i.test(line))socket.write('250-hi5-isolated\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
        else if(/^AUTH PLAIN/i.test(line))socket.write('235 Authentication successful\r\n')
        else if(/^AUTH LOGIN/i.test(line))socket.write('334 VXNlcm5hbWU6\r\n')
        else if(/^MAIL FROM|^RCPT TO|^RSET/i.test(line))socket.write('250 OK\r\n')
        else if(/^DATA/i.test(line)){inData=true;socket.write('354 Send data\r\n')}
        else if(/^QUIT/i.test(line)){socket.write('221 Closing\r\n');socket.end()}
        else if(/^NOOP/i.test(line))socket.write('250 OK\r\n')
        else socket.write('235 OK\r\n')
      }
    })
  })
  return {server,messages}
}
async function attestedRedis(env){
  const client=createClient({url:redisUrl(env)})
  await client.connect()
  await client.set('hi5central:managed:runtime:identity',JSON.stringify({
    environment:env,rootDomain,databaseInstanceId:instanceIds[env],
    redisInstanceId:redisInstanceIds[env],verifiedBy:'isolated-ci-operator',
    verifiedAt:new Date().toISOString(),
  }))
  await client.quit()
}
function httpWorker(env,flag,opts={}){
  return processAsync(httpTestPath,[flag],{
    ...process.env,GITHUB_ACTIONS:'true',
    HI5_PROVISIONING_TEST_SCOPE:'isolated-github-actions',
    DATABASE_URL:dbUrl(env),REDIS_URL:redisUrl(env),
    RUNTIME_ENVIRONMENT:env,DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
    ROOT_DOMAIN:rootDomain,COOKIE_DOMAIN:'',
    MFA_ENCRYPTION_KEY:'b'.repeat(64),
    ...opts,
  },30000)
}

const rootDomain = 'hi5central.com'
const fixtures = [
  '../migrations/core/001_core.sql',
  '../migrations/identity-access/002_auth_activation.sql',
  '../migrations/core/003_tenant_configuration.sql',
  '../migrations/identity-access/008_mfa_security.sql',
  '../migrations/identity-access/015_user_preferences.sql',
  '../migrations/identity-access/026_stackable_rbac.sql',
  '../migrations/platform-admin/082_platform_admin_control_plane.sql',
  '../migrations/identity-access/118_global_user_experience.sql',
  '../migrations/platform-admin/116_tenant_environment_instances.sql',
  '../migrations/platform-admin/132_tenant_environment_provision_requests.sql',
  '../migrations/platform-admin/133_managed_runtime_database_identity.sql',
  '../migrations/platform-admin/134_managed_environment_tenant_bootstrap.sql',
  '../migrations/platform-admin/135_managed_control_plane_identity.sql',
  '../migrations/platform-admin/136_isolated_tenant_hostname_trigger.sql',
  '../migrations/platform-admin/137_managed_environment_invitations.sql',
  '../migrations/platform-admin/138_managed_environment_activation_audit.sql',
  '../migrations/platform-admin/139_managed_owner_invitation_audit.sql',
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
  await t.test('isolated Redis binding and two-person operator approve/activate; no implicit DNS',async()=>{
    const unbound=operator('uat','--check')
    assert.notEqual(unbound.code,0,'Unattested Redis must block operator')
    await attestedRedis('uat')
    await attestedRedis('test')
    const wrong=operator('uat','--check',{TARGET_REDIS_URL:redisUrl('test')})
    assert.notEqual(wrong.code,0,'Another environment Redis must reject the request')
    const check=operator('uat','--check')
    assert.equal(check.code,0,check.stderr)
    assert.equal(check.json.tenantStatus,'suspended')
    assert.equal(check.json.controlPlaneReady,false)
    assert.equal(check.json.dnsChanged,false)
    const samePeople=operator('uat','--approve',{
      ACTIVATION_OPERATOR:'same-person',INDEPENDENT_REVIEWER:'same-person',
    })
    assert.notEqual(samePeople.code,0)
    const noConfirm=operator('uat','--approve',{CONFIRM_SANDBOX_ACTIVATION:'WRONG'})
    assert.notEqual(noConfirm.code,0)
    const approved=operator('uat','--approve',{
      ACTIVATION_OPERATOR:'operator-one',INDEPENDENT_REVIEWER:'reviewer-one',
    })
    assert.equal(approved.code,0,approved.stderr)
    assert.equal((await query('uat',"SELECT count(*)::int AS count FROM managed_environment_access_approvals WHERE state='approved'")).rows[0].count,1)
    const before=operator('uat','--check')
    assert.equal(before.json.tenantStatus,'suspended','Approval alone must not activate')
    const badReview=operator('uat','--activate',{INDEPENDENT_REVIEWER:'stranger'})
    assert.notEqual(badReview.code,0)
    const selfApproval=operator('uat','--activate',{ACTIVATION_OPERATOR:'operator-one'})
    assert.notEqual(selfApproval.code,0,'Original approving operator must not activate')
    const activated=operator('uat','--activate')
    assert.equal(activated.code,0,activated.stderr)
    assert.equal(activated.json.controlPlaneReady,false)
    assert.equal(activated.json.dnsChanged,false)
    assert.equal((await query('uat',"SELECT status FROM tenants WHERE slug='acme'")).rows[0].status,'active')
    assert.equal((await query('test','SELECT status FROM tenants WHERE slug=\'bravo\'')).rows[0].status,'suspended')
    const audits=await query('uat','SELECT action,operator_id,independent_reviewer_id FROM managed_environment_activation_audit ORDER BY created_at')
    assert.deepEqual(audits.rows.map(x=>x.action),['approve','activate'])
    const control=await query('control',`SELECT q.state,e.provisioning_status FROM tenant_environment_provision_requests q
      JOIN tenant_environment_instances e ON e.tenant_id=q.tenant_id AND e.environment=q.environment WHERE q.id=$1`,[requestIds.uat])
    assert.deepEqual(control.rows[0],{state:'claimed',provisioning_status:'provisioning'})
  })

  let activeCookie=''
  await t.test('first-owner email invitation, replay rejection and real TOTP HTTP sign-in',async()=>{
    const local=(await query('uat',"SELECT id FROM tenants WHERE slug='acme'")).rows[0]
    const notConfirmed=await processAsync(ownerInvitationPath,['--apply'],
      initialOwner('uat','--apply',{tenantId:local.id,CONFIRM_SANDBOX_OWNER_INVITATION:'wrong'}))
    assert.notEqual(notConfirmed.code,0)
    assert.equal((await query('uat','SELECT count(*)::int AS c FROM managed_environment_invitations')).rows[0].c,0)
    const dry=await processAsync(ownerInvitationPath,['--check'],
      initialOwner('uat','--check',{tenantId:local.id}))
    assert.equal(dry.code,0,dry.stderr)
    const smtp=smtpSink()
    await new Promise((resolve,reject)=>{
      smtp.server.once('error',reject)
      smtp.server.listen(55440,'127.0.0.1',resolve)
    })
    let delivered,cancelledToken
    try {
      // Issue an initial link, cancel it and prove it cannot be redeemed.
      const first=await processAsync(ownerInvitationPath,['--apply'],
        initialOwner('uat','--apply',{tenantId:local.id}),30000)
      assert.equal(first.code,0,first.stderr)
      assert.equal(first.json.result,'invitation_sent')
      assert.equal(smtp.messages.length,1,'Initial link delivered to isolated inbox')
      const firstMail=smtp.messages[0].replace(/=\n/g,'').replace(/=3D/gi,'=')
      const firstMatch=firstMail.match(/accept-invitation\?token=([A-Za-z0-9_-]{43})/)
      assert.ok(firstMatch,'First invite must contain a one-time token')
      cancelledToken=firstMatch[1]
      assert.ok(!first.stdout.includes(cancelledToken),'Raw token must not appear in operator output')

      const noConfirmation=await processAsync(ownerInvitationPath,['--cancel'],
        initialOwner('uat','--cancel',{tenantId:local.id,CONFIRM_SANDBOX_OWNER_CANCELLATION:'wrong'}))
      assert.notEqual(noConfirmation.code,0,'Wrong cancellation confirmation must fail')
      const badEmail=await processAsync(ownerInvitationPath,['--cancel'],
        initialOwner('uat','--cancel',{tenantId:local.id,
          INITIAL_OWNER_EMAIL:'not-the-owner@example.invalid',
          CONFIRM_SANDBOX_OWNER_CANCELLATION:`acme:uat:${local.id}:not-the-owner@example.invalid:cancel`}))
      assert.notEqual(badEmail.code,0,'Wrong invitee email cannot cancel an invitation')

      const cancelled=await processAsync(ownerInvitationPath,['--cancel'],
        initialOwner('uat','--cancel',{tenantId:local.id}))
      assert.equal(cancelled.code,0,cancelled.stderr)
      assert.equal(cancelled.json.result,'invitation_cancelled')
      assert.equal((await query('uat',
        "SELECT count(*)::int AS c FROM managed_environment_invitations WHERE revoked_at IS NOT NULL")).rows[0].c,1)
      const cancellationReplay=await processAsync(ownerInvitationPath,['--cancel'],
        initialOwner('uat','--cancel',{tenantId:local.id}))
      assert.notEqual(cancellationReplay.code,0,'Cancellation may not succeed twice')
      const denied=await httpWorker('uat','--cancelled',{HI5_TEST_INVITE_TOKEN:cancelledToken})
      assert.equal(denied.code,0,denied.stderr)
      assert.equal(denied.json.cancelledInvitationRejected,true)

      // A newly issued token is unique and remains redeemable after cancellation.
      delivered=await processAsync(ownerInvitationPath,['--apply'],
        initialOwner('uat','--apply',{tenantId:local.id}),30000)
    }finally{
      await new Promise(resolve=>smtp.server.close(resolve))
    }
    assert.equal(delivered.code,0,delivered.stderr)
    assert.equal(delivered.json.result,'invitation_sent')
    assert.equal(smtp.messages.length,2,'Two links delivered; first is cancelled')
    const emailBody=smtp.messages[1].replace(/=\n/g,'').replace(/=3D/gi,'=')
    const match=emailBody.match(/accept-invitation\?token=([A-Za-z0-9_-]{43})/)
    assert.ok(match,'Reissued invitation must contain its own one-time token')
    assert.notEqual(match[1],cancelledToken,'Reissued link must use a fresh token')
    assert.ok(!delivered.stdout.includes(match[1]))
    const audits=await query('uat',
      'SELECT action FROM managed_owner_invitation_audit ORDER BY created_at,id')
    assert.deepEqual(audits.rows.map(row=>row.action),['issued','cancelled','issued'])
    const http=await httpWorker('uat','--accept-mfa',{HI5_TEST_INVITE_TOKEN:match[1]})
    assert.equal(http.code,0,http.stderr)
    const cancelAccepted=await processAsync(ownerInvitationPath,['--cancel'],
      initialOwner('uat','--cancel',{tenantId:local.id}))
    assert.notEqual(cancelAccepted.code,0,'Accepted owner invitations cannot be cancelled')
    assert.equal(http.json.authenticated,true)
    activeCookie=http.json.cookie
    assert.equal((await query('uat','SELECT count(*)::int AS c FROM auth_sessions WHERE revoked_at IS NULL')).rows[0].c,1)
    assert.equal((await query('uat','SELECT count(*)::int AS c FROM managed_environment_invitations WHERE accepted_at IS NOT NULL')).rows[0].c,1)
    assert.equal((await query('test','SELECT count(*)::int AS c FROM users')).rows[0].c,0)
  })

  await t.test('suspending the tenant revokes sessions, unused invites and all future logins',async()=>{
    const local=(await query('uat',"SELECT id FROM tenants WHERE slug='acme'")).rows[0]
    await query('uat',`INSERT INTO managed_environment_invitations
       (tenant_id,email,name,role,token_hash,expires_at)
       VALUES ($1,'pending@example.invalid','Pending Invite','requester',$2,now()+interval '24 hours')`,
       [local.id,'a'.repeat(64)])
    const suspended=operator('uat','--suspend')
    assert.equal(suspended.code,0,suspended.stderr)
    assert.equal((await query('uat',"SELECT status FROM tenants WHERE slug='acme'")).rows[0].status,'suspended')
    assert.equal((await query('uat','SELECT count(*)::int AS c FROM auth_sessions WHERE revoked_at IS NULL')).rows[0].c,0)
    assert.equal((await query('uat','SELECT count(*)::int AS c FROM managed_environment_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL')).rows[0].c,0)
    const attempt=await httpWorker('uat','--revoked',{HI5_TEST_SESSION_COOKIE:activeCookie})
    assert.equal(attempt.code,0,attempt.stderr)
    assert.equal(attempt.json.loginDenied,true)
    const audit=await query('uat','SELECT action FROM managed_environment_activation_audit ORDER BY created_at')
    assert.deepEqual(audit.rows.map(r=>r.action),['approve','activate','suspend'])
    assert.equal((await query('test','SELECT count(*)::int AS c FROM managed_environment_invitations')).rows[0].c,0)
  })

})
