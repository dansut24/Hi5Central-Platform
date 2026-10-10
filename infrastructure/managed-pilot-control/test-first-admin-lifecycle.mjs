#!/usr/bin/env node
// Disposable GitHub Actions ONLY. Never run this against a real VPS or
// customer's database; the test creates a fake approval solely in CI storage.
import assert from 'node:assert/strict'
import {randomBytes,createHash,createHmac} from 'node:crypto'
import {spawnSync} from 'node:child_process'

if(process.env.GITHUB_ACTIONS!=='true'||process.env.HI5_PILOT_DISPOSABLE_CI!=='1'
  ||process.argv.slice(2).join(' ')!=='--run --confirm CI_ONLY_FAKE_APPROVALS'){
  throw new Error('Refusing non-disposable pilot first Admin integration test.')
}
const prefix='hi5central-pilot-control'
function run(args,input){
  const result=spawnSync('docker',args,{input,encoding:'utf8',
    maxBuffer:2*1024*1024,timeout:15000})
  if(result.status!==0)
    throw new Error('Isolated pilot integration Docker step failed: '+String(result.stderr).slice(-300))
  return String(result.stdout||'').trim()
}
function sql(query){
  return run(['exec',prefix+'-postgres-1','psql','-U','pilot_user_a',
    '-d','pilot_control_db','-v','ON_ERROR_STOP=1','-At','-c',query])
}
function call(method,path,body,cookie,origin='https://pilot-admin.hi5central.com'){
  const driver=`
    (async()=>{
      let s='';for await(const chunk of process.stdin)s+=String(chunk)
      const request=JSON.parse(s)
      const headers={Origin:request.origin,'content-type':'application/json'}
      if(request.cookie)headers.Cookie=request.cookie
      const response=await fetch('http://127.0.0.1:3001'+request.path,{
        method:request.method,headers,redirect:'manual',
        body:request.body===null?undefined:JSON.stringify(request.body),
        signal:AbortSignal.timeout(6000),
      })
      process.stdout.write(JSON.stringify({
        status:response.status,cookie:response.headers.get('set-cookie')||'',
        data:await response.json().catch(()=>({}))
      }))
    })().catch(()=>{process.exitCode=2})`
  return JSON.parse(run(['exec','-i',prefix+'-api-1','node','-e',driver],
    JSON.stringify({method,path,body,cookie,origin})))
}
function totp(secret){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',bytes=[]
  let bits=0,value=0
  for(const char of secret){
    value=(value<<5)|alphabet.indexOf(char);bits+=5
    if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8}
  }
  const buf=Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest=createHmac('sha1',Buffer.from(bytes)).update(buf).digest()
  return String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0')
}
for(const service of ['postgres','redis','api','admin']){
  const info=JSON.parse(run(['inspect',prefix+'-'+service+'-1']))[0]
  assert.equal(info.Config.Labels['com.docker.compose.project'],prefix)
  assert.deepEqual(info.HostConfig.PortBindings,{})
}
assert.equal(sql('SELECT COUNT(*) FROM users;').split('\n').at(-1),'0')
assert.equal(sql('SELECT COUNT(*) FROM tenants;').split('\n').at(-1),'0')
const scopeId=sql('SELECT scope_id FROM pilot_admin_bootstrap_scope;').split('\n').at(-1)
assert.match(scopeId,/^[0-9a-f-]{36}$/)
const email='first-admin-ci@example.invalid'
const token=randomBytes(32).toString('base64url')
const digest=createHash('sha256').update(token).digest('hex')
sql(`INSERT INTO managed_control_plane_identity
  (singleton,deployment_mode,tenancy_mode,root_domain,instance_id,verified_by)
  VALUES(true,'managed','multi','hi5central.com','${scopeId}','ci-operator/ci-reviewer');
  INSERT INTO pilot_admin_bootstrap_invitations
  (scope_id,email,display_name,token_hash,issued_by,reviewed_by,
   actor_evidence_sha256,reviewer_evidence_sha256,expires_at)
  VALUES('${scopeId}','${email}','Synthetic Pilot Owner','${digest}',
    'ci-operator','ci-reviewer','${randomBytes(32).toString('hex')}',
    '${randomBytes(32).toString('hex')}',now()+interval '24 hours');`)
assert.equal(call('GET','/api/platform/v1/auth/session',null).status,401)
const password='Phase19-Synthetic-Owner-Strong-Password-1!'
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token:'x'.repeat(43),password}).status,401)
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password},null,'https://untrusted.hi5central.com').status,403)
const accepted=call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password})
assert.equal(accepted.status,200,JSON.stringify(accepted.data))
assert.equal(accepted.data.accepted,true)
assert.equal(accepted.data.mfaRequired,true)
assert.equal(accepted.data.sessionCreated,false)
assert.equal(accepted.cookie,'','First invitation must not create a session')
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password}).status,409)
assert.equal(sql('SELECT COUNT(*) FROM platform_admin_members;').split('\n').at(-1),'1')
assert.equal(call('GET','/api/platform/v1/auth/session',null).status,401)
const login=call('POST','/api/platform/v1/auth/login',{email,password})
assert.equal(login.status,200)
assert.equal(login.data.mfaRequired,true)
assert.equal(login.cookie,'')
const challengeToken=login.data.challengeToken
const setup=call('POST','/api/platform/v1/auth/mfa/setup',{challengeToken})
assert.equal(setup.status,200)
assert.match(setup.data.secret,/^[A-Z2-7]{32}$/)
const code=totp(setup.data.secret)
const wrong=code==='000000'?'000001':'000000'
assert.equal(call('POST','/api/platform/v1/auth/mfa/verify',
  {challengeToken,code:wrong}).status,401)
const verified=call('POST','/api/platform/v1/auth/mfa/verify',
  {challengeToken,code})
assert.equal(verified.status,200,JSON.stringify(verified.data))
assert.equal(verified.data.mfaVerified,true)
assert.equal(verified.data.recoveryCodes.length,10)
assert.match(verified.cookie,/HttpOnly/)
assert.match(verified.cookie,/Secure/)
assert.doesNotMatch(verified.cookie,/Domain=/)
const cookie=verified.cookie.split(';')[0]
assert.equal(call('GET','/api/platform/v1/auth/session',null,cookie).status,200)
assert.equal(call('GET','/api/platform/v1/tenants',null,cookie).status,200)
assert.equal(call('POST','/api/platform/v1/tenants',{
  companyName:'Missing policy',slug:'missingpolicy',modules:{itsm:true}
},cookie).status,400,'Creating a tenant must require an explicit update choice')
assert.equal(call('POST','/api/platform/v1/tenants',{
  companyName:'Invalid time',slug:'invalidtime',updateMode:'hi5_managed',
  deploymentDay:'wed',deploymentTime:'25:00',deploymentTimezone:'Europe/London'
},cookie).status,400)
const managed=call('POST','/api/platform/v1/tenants',{
  companyName:'Synthetic Managed Customer',slug:'pilotmanagedci',
  ownerName:'Managed First Owner',ownerEmail:'managed-owner@example.invalid',
  updateMode:'hi5_managed',deploymentDay:'wed',
  deploymentTime:'21:30',deploymentTimezone:'Europe/London',
  customerUatOptIn:false,modules:{itsm:true,selfService:true,rmm:false},
},cookie)
assert.equal(managed.status,201,JSON.stringify(managed.data))
const custom=call('POST','/api/platform/v1/tenants',{
  companyName:'Synthetic Custom Customer',slug:'pilotcustomci',
  ownerName:'Custom First Owner',ownerEmail:'custom-owner@example.invalid',
  updateMode:'admin_controlled',customerUatOptIn:false,
  modules:{itsm:true,selfService:true,rmm:false},
},cookie)
assert.equal(custom.status,201,JSON.stringify(custom.data))
const modes=sql(`SELECT t.slug,p.update_mode,p.customer_uat_opt_in,
  p.live_auto_promote,p.maintenance_window->>'start'
  FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id
  WHERE t.slug IN('pilotmanagedci','pilotcustomci') ORDER BY t.slug`)
assert.match(modes,/pilotcustomci\\|admin_controlled\\|t\\|f\\|02:00/)
assert.match(modes,/pilotmanagedci\\|hi5_managed\\|f\\|t\\|21:30/)
assert.equal(sql('SELECT COUNT(*) FROM tenant_environment_provision_requests').split('\\n').at(-1),'1',
  'Only the Custom customer must have an automatically queued UAT request')
assert.equal(sql(`SELECT count(*) FROM tenant_environment_provision_requests q
  JOIN tenants t ON t.id=q.tenant_id WHERE t.slug='pilotmanagedci'`).split('\\n').at(-1),'0',
  'Managed customer must not be queued for customer UAT without opt-in')
assert.equal(sql(`SELECT count(*) FROM tenant_initial_owner_onboarding_intents`).split('\\n').at(-1),'2',
  'Both tenants must preserve a pending first-owner contact')
assert.equal(sql(`SELECT count(*) FROM tenant_memberships`).split('\\n').at(-1),'0',
  'Recording owner contact must never create membership')
assert.equal(sql(`SELECT provisioning_status FROM tenant_environment_instances e
  JOIN tenants t ON t.id=e.tenant_id WHERE t.slug='pilotcustomci'
  AND e.environment='live'`).split('\\n').at(-1),'pending',
  'New Production reservation must never appear ready without provisioning')
const reservations=sql(`SELECT e.provisioning_status FROM tenant_environment_instances e
 JOIN tenants t ON t.id=e.tenant_id WHERE t.slug='pilotmanagedci'
 AND e.environment='uat'`)
assert.ok(!reservations.split('\\n').includes('ready'),
  'Managed customer UAT must not silently become a provisioned runtime')
console.log('PHASE20_CUSTOMER_UPDATE_CHOICES: PASS (Managed optional UAT, Custom required, exact schedule, one Custom-only UAT queue)')
assert.equal(custom.data.onboarding.uatQueued,true)
assert.equal(custom.data.onboarding.productionActivated,false)
assert.equal(custom.data.onboarding.invitationSent,false)
assert.equal(managed.data.onboarding.uatQueued,false)
const customId=custom.data.tenant.id
assert.equal(call('POST',`/api/platform/v1/tenants/${customId}/onboarding-owner`,
  {email:'not-an-email',name:'Owner'},cookie).status,400,
  'Invalid first-owner contacts must be rejected')
sql(`DELETE FROM tenant_initial_owner_onboarding_intents WHERE tenant_id='${customId}'`)
const restored=call('POST',`/api/platform/v1/tenants/${customId}/onboarding-owner`,
  {email:'repaired-owner@example.invalid',name:'Repaired Customer Owner'},cookie)
assert.equal(restored.status,200,JSON.stringify(restored.data))
assert.equal(restored.data.invitationSent,false)
assert.equal(restored.data.accessGranted,false)
assert.equal(sql(`SELECT owner_email FROM tenant_initial_owner_onboarding_intents
 WHERE tenant_id='${customId}'`).split('\\n').at(-1),'repaired-owner@example.invalid')
sql(`UPDATE tenant_initial_owner_onboarding_intents
 SET status='invitation_sent' WHERE tenant_id='${customId}'`)
assert.equal(call('POST',`/api/platform/v1/tenants/${customId}/onboarding-owner`,
 {email:'attacker@example.invalid',name:'Attacker'},cookie).status,409,
 'Once invited the owner cannot be silently replaced')

const noUatPush=call('POST',`/api/platform/v1/tenants/${customId}/config-promotions/preflight`,
  {keys:['theme']},cookie)
assert.equal(noUatPush.status,409,
  'Custom tenant without activated UAT must not promote configuration')
assert.equal(noUatPush.data.eligibleForExecution,false)
assert.match(noUatPush.data.blockers.join(' '),/UAT/)
assert.equal(call('POST',`/api/platform/v1/tenants/${customId}/config-promotions/preflight`,
  {keys:['credentials']},cookie).status,409,'Never push secrets')
const request=call('POST',`/api/platform/v1/tenants/${customId}/environments/uat/provision`,{},cookie)
assert.equal(request.status,200,JSON.stringify(request.data))
assert.equal(request.data.alreadyQueued,true,
  'New Custom tenant must automatically queue UAT once, not duplicate provisioning')
const repeated=call('POST',`/api/platform/v1/tenants/${customId}/environments/uat/provision`,{},cookie)
assert.equal(repeated.status,200)
assert.equal(repeated.data.alreadyQueued,true)
const requestState=sql(`SELECT q.state FROM tenant_environment_provision_requests q
  JOIN tenants t ON t.id=q.tenant_id
  WHERE t.slug='pilotcustomci' AND q.environment='uat'`)
assert.equal(requestState.split('\\n').at(-1),'requested')
const stillDenied=call('POST',`/api/platform/v1/tenants/${customId}/config-promotions/preflight`,
  {keys:['theme','itsm']},cookie)
assert.equal(stillDenied.status,409,
  'Submitting a provisioning request cannot bypass actual UAT isolation validation')
assert.equal(stillDenied.data.eligibleForExecution,false)
const uatReservation=sql(`SELECT e.provisioning_status FROM tenant_environment_instances e
 JOIN tenants t ON t.id=e.tenant_id
 WHERE t.slug='pilotcustomci' AND e.environment='uat'`)
assert.equal(uatReservation.split('\\n').at(-1),'pending')
const state=call('GET','/api/platform/v1/tenants',null,cookie)
assert.equal(state.status,200)
const visibleCustom=state.data.items.find(t=>t.slug==='pilotcustomci')
assert.ok(visibleCustom)
assert.equal(visibleCustom.update_mode,'admin_controlled')
assert.equal(visibleCustom.customer_uat_opt_in,true)
console.log('PHASE21_CUSTOM_TENANT_UAT_REQUEST: PASS (Admin-created tenant and owner contact, UAT automatically queued, no premature UAT)')
console.log('PHASE21_CUSTOMER_PROMOTION_BLOCKED: PASS (no UAT activation, no Live config write, secrets denied)')

assert.equal(call('POST','/api/platform/v1/auth/logout',{},cookie).status,200)
assert.equal(call('GET','/api/platform/v1/auth/session',null,cookie).status,401)
console.log('PHASE19_DISPOSABLE_FIRST_ADMIN_INVITE_MFA: PASS')
console.log('Invalid and foreign-origin invite denied; one-time acceptance had no session; real TOTP, role access and logout verified.')
