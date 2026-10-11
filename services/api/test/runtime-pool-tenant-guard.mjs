import assert from 'node:assert/strict'
import {configuredPoolBoundary,checkPoolTenantRequest} from '../src/runtimePoolTenantGuard.js'
const boundary=configuredPoolBoundary({
 VERSIONED_POOL_TENANT_SLUG:'testing-uat',
 VERSIONED_POOL_PUBLIC_HOST:'testing-uat.hi5central.com',RUNTIME_ENVIRONMENT:'uat'})
assert.equal(boundary.slug,'testing-uat')
assert.equal(configuredPoolBoundary({RUNTIME_ENVIRONMENT:'uat'}),null)
assert.throws(()=>configuredPoolBoundary({VERSIONED_POOL_TENANT_SLUG:'testing-uat',
 VERSIONED_POOL_PUBLIC_HOST:'test2-uat.hi5central.com',RUNTIME_ENVIRONMENT:'uat'}),/Invalid/)
assert.throws(()=>configuredPoolBoundary({VERSIONED_POOL_TENANT_SLUG:'testing-uat',
 VERSIONED_POOL_PUBLIC_HOST:'testing-uat.hi5central.com',RUNTIME_ENVIRONMENT:'live'}),/Invalid/)
const base={boundary,host:boundary.host,origin:boundary.origin,
 sessionSlug:'testing-uat',authenticated:true,path:'/api/v1/incidents',method:'GET'}
assert.equal(checkPoolTenantRequest(base).allowed,true)
assert.equal(checkPoolTenantRequest({...base,method:'POST'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,host:'test2-uat.hi5central.com'}).status,421)
assert.equal(checkPoolTenantRequest({...base,host:'testing-uat.hi5central.com.evil.org'}).status,421)
assert.equal(checkPoolTenantRequest({...base,origin:'https://test2-uat.hi5central.com'}).status,403)
assert.equal(checkPoolTenantRequest({...base,referer:'https://test2-uat.hi5central.com/incidents'}).status,403)
assert.equal(checkPoolTenantRequest({...base,authenticated:true,sessionSlug:'test2-uat'}).status,403)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:''}).status,401)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/auth/login',method:'POST'}).status,401)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/updates/version',method:'GET'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/auth/tenant-state/testing-uat',method:'GET'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/incidents',method:'OPTIONS'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/incidents',method:'GET',origin:''}).status,401)
assert.equal(checkPoolTenantRequest({...base,boundary:null}).allowed,true)

// The real UAT login screen uses /login-secure, then optional MFA before
// issuing a session. A central one-time SSO ticket is another pre-session flow.
const anonymous={...base,authenticated:false,sessionSlug:''}
for(const [method,path] of [
  ['POST','/api/v1/auth/login-secure'],
  ['POST','/api/v1/auth/mfa/setup'],
  ['POST','/api/v1/auth/mfa/verify'],
  ['POST','/api/v1/auth/environment-handoff'],
  ['POST','/api/v1/auth/logout'],
  ['GET','/api/v1/auth/session'],
  ['GET','/api/v1/updates/version'],
  ['GET','/api/v1/auth/tenant-state/testing-uat'],
  ['GET','/api/v1/auth/tenant-slug/testing-uat'],
]) {
  assert.equal(checkPoolTenantRequest({...anonymous,method,path}).allowed,true,
    'Expected canary bootstrap request to pass: '+method+' '+path)
}
for(const [method,path] of [
  ['POST','/api/v1/auth/login'], // Legacy password-only bypass is not allowed.
  ['GET','/api/v1/auth/login-secure'],
  ['POST','/api/v1/auth/session'],
  ['GET','/api/v1/auth/mfa/verify'],
  ['POST','/api/v1/updates/version'],
  ['GET','/api/v1/auth/tenant-state/test2-uat'],
  ['GET','/api/v1/auth/tenant-slug/test2-uat'],
  ['POST','/api/v1/auth/signup'],
  ['GET','/api/v1/auth/mfa/setup'],
  ['GET','/api/v1/auth/login-secure/extra'],
  ['POST','/api/v1/incidents'],
]) {
  assert.equal(checkPoolTenantRequest({...anonymous,method,path}).status,401,
    'Expected unauthenticated request to be blocked: '+method+' '+path)
}
// Even public bootstrap requests must remain bound to the exact tenant host,
// browser origin and referer. An existing other-tenant session is never trusted.
for(const path of ['/api/v1/auth/login-secure','/api/v1/auth/mfa/verify']) {
  const request={...anonymous,path,method:'POST'}
  assert.equal(checkPoolTenantRequest({...request,host:'test2-uat.hi5central.com'}).status,421)
  assert.equal(checkPoolTenantRequest({...request,origin:'https://test2-uat.hi5central.com'}).status,403)
  assert.equal(checkPoolTenantRequest({...request,referer:'https://test2-uat.hi5central.com/'}).status,403)
  assert.equal(checkPoolTenantRequest({...request,authenticated:true,sessionSlug:'test2-uat'}).status,403)
}

console.log('PASS: pool canary host/session/origin isolation; shared runtime unchanged')
