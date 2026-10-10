import test from 'node:test'
import assert from 'node:assert/strict'
import {validateManagedSignupRequest,managedSignupRequestEnabled} from '../src/managedPublicSignup.js'
import {readFileSync} from 'node:fs'

function request(updateMode='admin_controlled'){
  return {companyName:'Acme Pilot',tenantSlug:'acmepilot',name:'Acme Owner',
    email:'Owner@Example.invalid',modules:{itsm:true,rmm:false},updateMode,
    deploymentDay:'fri',deploymentTime:'22:30',deploymentTimezone:'Europe/London',
    customerUatOptIn:false}
}
test('Public Custom signup queues its own UAT and never accepts password',()=>{
 const got=validateManagedSignupRequest(request())
 assert.equal(got.slug,'acmepilot')
 assert.equal(got.ownerEmail,'owner@example.invalid')
 assert.equal(got.policy.updateMode,'admin_controlled')
 assert.equal(got.policy.customerUatOptIn,true)
 assert.equal(got.policy.liveAutoPromote,false)
})
test('Public Managed signup needs no customer UAT',()=>{
 const got=validateManagedSignupRequest(request('hi5_managed'))
 assert.equal(got.policy.customerUatOptIn,false)
 assert.equal(got.policy.liveAutoPromote,true)
 assert.deepEqual(got.policy.maintenanceWindow,{timezone:'Europe/London',
  days:['fri'],start:'22:30',end:'00:30'})
})
test('Reserved UAT/Test names, malformed schedule, bogus email and bot honeypot are rejected',()=>{
 for(const patch of [
  {tenantSlug:'acmeuat'},{tenantSlug:'acmetest'},{tenantSlug:'api'},
  {email:'bad-email'},{updateMode:''},{updateMode:'instant'},
  {updateMode:'hi5_managed',deploymentTime:'25:00'},
  {website:'https://spam.invalid'},
  {companyName:''},{name:''},{modules:{itsm:false,rmm:false}}
 ]){
  assert.throws(()=>validateManagedSignupRequest({...request('hi5_managed'),...patch}),
    Error,JSON.stringify(patch))
 }
})
test('Public API must never create tenant, account or browser session',()=>{
 const src=readFileSync(new URL('../src/managedPublicSignup.js',import.meta.url),'utf8')
 assert.match(src,/MANAGED_SIGNUP_REQUESTS_ENABLED/)
 assert.match(src,/MANAGED_SIGNUP_SMTP_APPROVED/)
 assert.match(src,/INSERT INTO managed_public_signup_requests/)
 assert.doesNotMatch(src,/INSERT INTO (?:users|tenants|tenant_memberships|sessions)/)
 const legacy=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
 assert.match(legacy,/MANAGED_LEGACY_SIGNUP_ALLOWED/)
 assert.match(legacy,/MANAGED_SIGNUP_REQUEST_REQUIRED/)
})
test('Signup requests must be expressly enabled only in reviewed private pilot',()=>{
 assert.equal(managedSignupRequestEnabled(),false)
})
