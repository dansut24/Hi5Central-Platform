import assert from 'node:assert/strict'
import {configuredPoolBoundary,checkPoolTenantRequest} from '../src/runtimePoolTenantGuard.js'

const boundary=configuredPoolBoundary({
  VERSIONED_POOL_TENANT_SLUG:'testing-test',
  VERSIONED_POOL_PUBLIC_HOST:'testing-test.hi5central.com',
  RUNTIME_ENVIRONMENT:'test',
})
const base={boundary,host:'testing-test.hi5central.com',
  origin:'https://testing-test.hi5central.com',
  authenticated:false,sessionSlug:null,method:'POST'}
for(const path of [
 '/api/v1/auth/login-secure',
 '/api/v1/auth/mfa/setup',
 '/api/v1/auth/mfa/verify',
 '/api/v1/auth/login',
]) {
  assert.equal(checkPoolTenantRequest({...base,path}).allowed,true,path+' must be reachable before login')
}
assert.equal(checkPoolTenantRequest({...base,path:'/api/v1/updates/version',method:'GET'}).allowed,true)
for(const path of ['/api/v1/settings','/api/v1/auth/mfa/disable','/api/v1/auth/session','/api/v1/auth/environment-access']) {
  assert.equal(checkPoolTenantRequest({...base,path}).allowed,false,path+' must remain protected')
}
assert.equal(checkPoolTenantRequest({...base,path:'/api/v1/auth/login-secure',host:'other.hi5central.com'}).status,421)
assert.equal(checkPoolTenantRequest({...base,path:'/api/v1/auth/login-secure',origin:'https://other.hi5central.com'}).status,403)
assert.equal(checkPoolTenantRequest({...base,path:'/api/v1/settings',authenticated:true,sessionSlug:'testing'}).status,403)
assert.equal(checkPoolTenantRequest({...base,path:'/api/v1/settings',authenticated:true,sessionSlug:'testing-test'}).allowed,true)
console.log('PASS: Test/UAT secure login bootstrap with cross-tenant and settings restrictions')
