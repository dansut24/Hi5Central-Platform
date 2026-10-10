import test from 'node:test'
import assert from 'node:assert/strict'
import {validateManagedSignupRequest} from '../src/managedSignupValidation.js'
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
 assert.match(src,/MANAGED_SIGNUP_REQUESTS_ENABLED/)
 assert.match(src,/MANAGED_SIGNUP_SMTP_APPROVED/)
 assert.match(src,/INSERT INTO managed_public_signup_requests/)
 assert.doesNotMatch(src,/INSERT INTO (?:users|tenants|tenant_memberships|sessions)/)
 assert.doesNotMatch(src,/requested\.policy/)
 const legacy=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
 assert.match(legacy,/MANAGED_LEGACY_SIGNUP_ALLOWED/)
 assert.match(legacy,/MANAGED_SIGNUP_REQUEST_REQUIRED/)
})
test('Signup requests are only enabled in reviewed private pilot',()=>{
 const src=readFileSync(new URL('../src/managedPublicSignup.js',import.meta.url),'utf8')
 assert.match(src,/process\.env\.MANAGED_SIGNUP_REQUESTS_ENABLED==='true'/)
 assert.match(src,/deployment\.apiUrl==='https:\/\/pilot-control-api\.hi5central\.com'/)
})
