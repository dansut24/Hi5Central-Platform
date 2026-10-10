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
        location:response.headers.get('location')||'',
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
  companyName:'Missing owner',slug:'missingowner',modules:{itsm:true}
},cookie).status,400,'First owner is still required at registration')
assert.equal(call('POST','/api/platform/v1/tenants',{
  companyName:'Premature update setting',slug:'premature',ownerName:'Test Owner',
  ownerEmail:'owner@example.invalid',updateMode:'hi5_managed'
},cookie).status,400,'Admin must not pick the update method before onboarding')
const managed=call('POST','/api/platform/v1/tenants',{
  companyName:'Synthetic Future Managed Customer',slug:'pilotmanagedci',
  ownerName:'Managed First Owner',ownerEmail:'managed-owner@example.invalid',
  modules:{itsm:true,selfService:true,rmm:false},
},cookie)
assert.equal(managed.status,201,JSON.stringify(managed.data))
const custom=call('POST','/api/platform/v1/tenants',{
  companyName:'Synthetic Future Custom Customer',slug:'pilotcustomci',
  ownerName:'Custom First Owner',ownerEmail:'custom-owner@example.invalid',
  modules:{itsm:true,selfService:true,rmm:false},
},cookie)
assert.equal(custom.status,201,JSON.stringify(custom.data))
const undecided=sql(`SELECT t.slug,p.onboarding_selection_pending,
  p.live_auto_promote,p.customer_uat_opt_in
  FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id
  WHERE t.slug IN('pilotmanagedci','pilotcustomci') ORDER BY t.slug`)
assert.match(undecided,/pilotcustomci\\|t\\|f\\|f/)
assert.match(undecided,/pilotmanagedci\\|t\\|f\\|f/)
assert.equal(sql('SELECT COUNT(*) FROM tenant_environment_provision_requests').split('\\n').at(-1),'0',
  'No customer can be assigned UAT before the onboarding choice')
assert.equal(sql(`SELECT count(*) FROM tenant_initial_owner_onboarding_intents`).split('\\n').at(-1),'2')
assert.equal(sql(`SELECT count(*) FROM tenant_memberships`).split('\\n').at(-1),'0')
assert.equal(sql(`SELECT provisioning_status FROM tenant_environment_instances e
 JOIN tenants t ON t.id=e.tenant_id WHERE t.slug='pilotcustomci'
 AND e.environment='live'`).split('\\n').at(-1),'pending')
assert.equal(custom.data.onboarding.uatQueued,false)
assert.equal(custom.data.onboarding.updateChoicePending,true)
assert.equal(managed.data.onboarding.updateChoicePending,true)
assert.equal(managed.data.onboarding.productionActivated,false)
assert.equal(custom.data.onboarding.invitationSent,false)
console.log('PHASE25_SIGNUP_ONLY_NO_UPDATE_CHOICE: PASS (both new tenants undecided; no UAT queue, no auto Production)')
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
  'Unprovisioned tenant without owner update choice must not promote configuration')
assert.equal(noUatPush.data.eligibleForExecution,false)
assert.match(noUatPush.data.blockers.join(' '),/UAT/)
assert.equal(call('POST',`/api/platform/v1/tenants/${customId}/config-promotions/preflight`,
  {keys:['credentials']},cookie).status,409,'Never push secrets')
const request=call('POST',`/api/platform/v1/tenants/${customId}/environments/uat/provision`,{},cookie)
assert.equal(request.status,202,JSON.stringify(request.data))
assert.equal(request.data.provisioningStarted,false,
  'UAT may only be requested explicitly until the authenticated owner selects a policy')
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
assert.equal(visibleCustom.customer_uat_opt_in,false)
assert.equal(visibleCustom.update_selection_pending,true)
console.log('PHASE25_UAT_NOT_AT_REGISTRATION: PASS (independent operator queue only after explicit request; onboarding pending)')
console.log('PHASE21_CUSTOMER_PROMOTION_BLOCKED: PASS (no UAT activation, no Live config write, secrets denied)')

// A public request is NOT a tenant. Only a verified request can be converted
// by the independent Admin after matching every customer and update choice.
const publicPost=call('POST','/api/v1/public/signup-requests',{
  tenantSlug:'synthetic-nosmtp',companyName:'Synthetic No SMTP',
  name:'No Delivery',email:'no-delivery@example.invalid',
  modules:{itsm:true,rmm:false}
},null,'https://hi5central.com')
assert.equal(publicPost.status,503,'No verified SMTP means no new signup requests')
assert.equal(sql('SELECT count(*) FROM managed_public_signup_requests').split('\\n').at(-1),'0')
const requestedSlug='pilot-signup-ci'
const oneTimeEmailToken=randomBytes(32).toString('base64url')
const oneTimeEmailDigest=createHash('sha256').update(oneTimeEmailToken).digest('hex')
sql(`INSERT INTO managed_public_signup_requests
 (tenant_slug,company_name,owner_name,owner_email,modules,verification_hash,
  verification_expires_at,status,verified_at)
 VALUES('${requestedSlug}','Signup Test Customer','Signup Owner',
  'signup-owner@example.invalid',
  '{"itsm":true,"selfService":true,"rmm":false}'::jsonb,
  '${oneTimeEmailDigest}',now()+interval '24 hours',
  'awaiting_email',null)`)
assert.equal(sql('SELECT count(*) FROM tenants WHERE slug=\''+requestedSlug+'\'').split('\\n').at(-1),'0')
const verifiedLink=call('GET',
  '/api/v1/public/signup-requests/verify?token='+oneTimeEmailToken,null,null,'https://hi5central.com')
assert.equal(verifiedLink.status,302)
assert.match(verifiedLink.location,/verification=received/)
assert.equal(sql(`SELECT status FROM managed_public_signup_requests WHERE tenant_slug='${requestedSlug}'`).split('\\n').at(-1),'verified')
const replay=call('GET',
  '/api/v1/public/signup-requests/verify?token='+oneTimeEmailToken,null,null,'https://hi5central.com')
assert.equal(replay.status,302)
assert.match(replay.location,/verification=invalid/)
assert.equal(sql(`SELECT count(*) FROM managed_public_signup_audit a
  JOIN managed_public_signup_requests r ON r.id=a.request_id
  WHERE r.tenant_slug='${requestedSlug}' AND a.action='verified'`).split('\\n').at(-1),'1',
  'One-time link cannot verify twice or duplicate its audit event')
const inbox=call('GET','/api/platform/v1/signup-requests',null,cookie)
assert.equal(inbox.status,200)
const signupRequest=inbox.data.items.find(item=>item.tenant_slug===requestedSlug)
assert.ok(signupRequest)
assert.equal(signupRequest.status,'verified')
const draft={companyName:signupRequest.company_name,slug:signupRequest.tenant_slug,
  ownerName:signupRequest.owner_name,ownerEmail:signupRequest.owner_email,
  modules:signupRequest.modules,signupRequestId:signupRequest.id}
const scheduleTampering=call('POST','/api/platform/v1/tenants',{
  ...draft,updateMode:'hi5_managed',deploymentDay:'mon',deploymentTime:'03:00'
},cookie)
assert.equal(scheduleTampering.status,400,
  'Registration must reject update preferences regardless of email verification')
const tampered=call('POST','/api/platform/v1/tenants',{
  ...draft,ownerEmail:'attacker@example.invalid'
},cookie)
assert.equal(tampered.status,409,'Cannot substitute an unverified owner')
const badMaintenance=call('POST','/api/platform/v1/tenants',{
  ...draft,updateMode:'hi5_managed',deploymentDay:'tue',
  deploymentTime:'19:30',deploymentTimezone:'Europe/Paris'
},cookie)
assert.equal(badMaintenance.status,400,'Cannot set a maintenance window before onboarding')
assert.equal(sql(`SELECT count(*) FROM tenants WHERE slug='${requestedSlug}'`).split('\\n').at(-1),'0')
const approved=call('POST','/api/platform/v1/tenants',draft,cookie)
assert.equal(approved.status,201,JSON.stringify(approved.data))
assert.equal(approved.data.onboarding.uatQueued,false)
assert.equal(approved.data.onboarding.updateChoicePending,true)
assert.equal(approved.data.onboarding.invitationSent,false)
assert.equal(approved.data.onboarding.productionActivated,false)
assert.equal(sql(`SELECT status FROM managed_public_signup_requests WHERE id='${signupRequest.id}'`).split('\\n').at(-1),'converted')
assert.equal(call('POST','/api/platform/v1/tenants',draft,cookie).status,409)
assert.equal(sql(`SELECT count(*) FROM tenant_environment_provision_requests q
  JOIN tenants t ON t.id=q.tenant_id WHERE t.slug='${requestedSlug}'
  AND q.environment='uat'`).split('\\n').at(-1),'0')
assert.equal(sql(`SELECT count(*) FROM tenant_memberships m
  JOIN tenants t ON t.id=m.tenant_id WHERE t.slug='${requestedSlug}'`).split('\\n').at(-1),'0')
console.log('PHASE25_SIGNUP_TO_ADMIN_REVIEW: PASS (verified identity, one-time pending tenant, no early UAT or update policy)')
const currentDirect=call('POST','/api/v1/auth/signup',{
  companyName:'Legacy Signup',tenantSlug:'legacypilotsignup',name:'Legacy Owner',
  email:'legacy@example.invalid',password:'VeryStrongExamplePassword345',
  modules:['itsm'],
},null,'https://hi5central.com')
assert.equal(currentDirect.status,403,'Legacy managed signup must be disabled in pilot')
assert.equal(call('POST','/api/platform/v1/auth/logout',{},cookie).status,200)
assert.equal(call('GET','/api/platform/v1/auth/session',null,cookie).status,401)
console.log('PHASE19_DISPOSABLE_FIRST_ADMIN_INVITE_MFA: PASS')
console.log('Invalid and foreign-origin invite denied; one-time acceptance had no session; real TOTP, role access and logout verified.')
