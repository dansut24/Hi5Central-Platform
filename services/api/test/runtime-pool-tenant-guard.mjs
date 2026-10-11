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
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/auth/login',method:'POST'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/updates/version',method:'GET'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/auth/tenant-state/testing-uat',method:'GET'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/incidents',method:'OPTIONS'}).allowed,true)
assert.equal(checkPoolTenantRequest({...base,authenticated:false,sessionSlug:'',path:'/api/v1/incidents',method:'GET',origin:''}).status,401)
assert.equal(checkPoolTenantRequest({...base,boundary:null}).allowed,true)
console.log('PASS: pool canary host/session/origin isolation; shared runtime unchanged')
