import test from 'node:test'
import assert from 'node:assert/strict'
import {validateManagedSignupRequest,approvedManagedSignupRuntime} from '../src/managedSignupValidation.js'
import {readFileSync} from 'node:fs'
function request(){return {companyName:'Acme Pilot',tenantSlug:'acmepilot',
  name:'Acme Owner',email:'Owner@Example.invalid',
  modules:{itsm:true,rmm:false}}}
test('Signup records only customer identity and selected products',()=>{
 const got=validateManagedSignupRequest(request())
 assert.equal(got.slug,'acmepilot')
 assert.equal(got.ownerEmail,'owner@example.invalid')
 assert.deepEqual(got.modules,{itsm:true,selfService:true,rmm:false})
 assert.equal(Object.hasOwn(got,'policy'),false)
})
test('Update method, UAT and schedule are only allowed in onboarding',()=>{
 for(const patch of [
  {updateMode:'hi5_managed'},{updateMode:'admin_controlled'},
  {customerUatOptIn:true},{deploymentDay:'wed'},
  {deploymentTime:'02:00'},{deploymentTimezone:'Europe/London'},
  {maintenanceWindow:{days:['sun'],start:'01:00'}},
 ]){
  assert.throws(()=>validateManagedSignupRequest({...request(),...patch}),
    /during customer onboarding/,JSON.stringify(patch))
 }
})
test('Reserved tenant names and invalid contact details are rejected',()=>{
 for(const patch of [
  {tenantSlug:'acmeuat'},{tenantSlug:'acmetest'},{tenantSlug:'api'},
  {email:'bad-email'},{website:'https://spam.invalid'},
  {companyName:''},{name:''},{modules:{itsm:false,rmm:false}}
 ]){
  assert.throws(()=>validateManagedSignupRequest({...request(),...patch}),
    Error,JSON.stringify(patch))
 }
})
test('Public signup queues email verification, never creates tenant/account/session',()=>{
 const src=readFileSync(new URL('../src/managedPublicSignup.js',import.meta.url),'utf8')
 assert.match(src,/approvedManagedSignupRuntime/)
 assert.match(src,/MANAGED_SIGNUP_SMTP_APPROVED/)
 assert.match(src,/INSERT INTO managed_public_signup_requests/)
 assert.doesNotMatch(src,/INSERT INTO (?:users|tenants|tenant_memberships|sessions)/)
 assert.doesNotMatch(src,/requested\.policy/)
 const legacy=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
 assert.match(legacy,/MANAGED_LEGACY_SIGNUP_ALLOWED/)
 assert.match(legacy,/MANAGED_SIGNUP_REQUEST_REQUIRED/)
})
test('Production signup requires matching public hosts, mailbox allowlist and explicit opt-in',()=>{
 const env={
  MANAGED_SIGNUP_REQUESTS_ENABLED:'true',
  MANAGED_SIGNUP_LIVE_APPROVED:'true',
  MANAGED_SIGNUP_TEST_ONLY:'true',
  MANAGED_SIGNUP_TEST_EMAIL:'approved@example.invalid',
  DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
 }
 const config={runtimeEnvironment:'live',rootDomain:'hi5central.com',
  apiUrl:'https://api.hi5central.com',adminUrl:'https://admin.hi5central.com'}
 assert.equal(approvedManagedSignupRuntime(env,config),true)
 for(const override of [
  {MANAGED_SIGNUP_REQUESTS_ENABLED:'false'},
  {MANAGED_SIGNUP_LIVE_APPROVED:'false'},
  {MANAGED_SIGNUP_TEST_ONLY:'false'},
  {MANAGED_SIGNUP_TEST_EMAIL:''},
  {TENANCY_MODE:'single'},
  {DEPLOYMENT_MODE:'self_hosted'},
 ]){
  assert.equal(approvedManagedSignupRuntime({...env,...override},config),false,
   JSON.stringify(override))
 }
 for(const changed of [
  {apiUrl:'https://pilot-control-api.hi5central.com'},
  {adminUrl:'https://pilot-admin.hi5central.com'},
  {runtimeEnvironment:'uat'},
  {runtimeEnvironment:'test'},
  {rootDomain:'another.example'},
 ]){
  assert.equal(approvedManagedSignupRuntime(env,{...config,...changed}),false,JSON.stringify(changed))
 }
 const src=readFileSync(new URL('../src/managedPublicSignup.js',import.meta.url),'utf8')
 assert.match(src,/requested.ownerEmail!==approved/)
 assert.match(src,/MANAGED_SIGNUP_SMTP_APPROVED!=='true'/)
 const mailer=readFileSync(new URL('../src/mailer.js',import.meta.url),'utf8')
 assert.match(mailer,/MANAGED_SIGNUP_LIVE_APPROVED==='true'/)
})

test('The earlier isolated signup canary is not implicitly a public production authorisation',()=>{
 const cfg={runtimeEnvironment:'live',rootDomain:'hi5central.com',
  apiUrl:'https://pilot-control-api.hi5central.com',
  adminUrl:'https://pilot-admin.hi5central.com'}
 const env={MANAGED_SIGNUP_REQUESTS_ENABLED:'true',
  DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi'}
 assert.equal(approvedManagedSignupRuntime(env,cfg),true)
 assert.equal(approvedManagedSignupRuntime(
  {...env,MANAGED_SIGNUP_LIVE_APPROVED:'true'},cfg),false)
})
