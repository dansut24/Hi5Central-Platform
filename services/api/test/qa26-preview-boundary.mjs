import assert from 'node:assert/strict'
import test from 'node:test'
import {qa26StagingActive,qa26TenantAllowed,qa26ExpectedOrigins,qa26CanServe,qa26SessionMatchesOrigin,qa26ServiceDirectoryHeaders} from '../src/qa26Staging.js'
import {tenantSlugFromHostname,tenantMayServeWorkspace} from '../src/tenantSlugPolicy.js'
import {mfaRequiredFor,loginRequiresMfa,sandboxPolicyRequiresMfa,sessionNeedsMfa,securitySettings} from '../src/securityPolicy.js'
test('QA preview is explicitly opt-in and limits the exact two QA slugs',()=>{
 assert.equal(qa26StagingActive({}),false)
 assert.equal(qa26StagingActive({QA26_STAGING_MODE:'true'}),true)
 assert.equal(qa26TenantAllowed('h5c-managed-qa26'),true)
 assert.equal(qa26TenantAllowed('h5c-custom-qa26'),true)
 assert.equal(qa26TenantAllowed('testing'),false)
 assert.equal(qa26TenantAllowed('h5c-managed-qa26-extra'),false)
})
test('QA origin per-environment deny by default, but internal Live service permitted with independent Bearer check',()=>{
 assert.equal(qa26ExpectedOrigins('live').length,2)
 assert.deepEqual(qa26ExpectedOrigins('uat'),['https://h5c-custom-qa26-uat.hi5central.com'])
 assert.equal(qa26CanServe('https://h5c-managed-qa26-uat.hi5central.com','uat','/api/v1/organisation'),false)
 assert.equal(qa26CanServe('https://h5c-custom-qa26-uat.hi5central.com','uat','/api/v1/organisation'),true)
 assert.equal(qa26CanServe('https://h5c-custom-qa26-uat.hi5central.com','test','/api/v1/organisation'),false)
 assert.equal(qa26CanServe('https://other-tenant.hi5central.com','live','/api/v1/organisation'),false)
 assert.equal(qa26CanServe('','live','/api/v1/internal/organisation/directory-snapshot'),true)
 assert.equal(qa26CanServe('','test','/api/v1/internal/organisation/directory-snapshot'),false)
 assert.deepEqual(qa26ServiceDirectoryHeaders(false),{})
 assert.deepEqual(qa26ServiceDirectoryHeaders(true),{'X-Hi5-QA26-Internal':'pr69'})
})

test('authenticated QA preview session must belong to the exact origin and environment',()=>{
 assert.equal(qa26SessionMatchesOrigin('h5c-managed-qa26','https://h5c-managed-qa26.hi5central.com','live'),true)
 assert.equal(qa26SessionMatchesOrigin('h5c-custom-qa26','https://h5c-custom-qa26.hi5central.com','live'),true)
 assert.equal(qa26SessionMatchesOrigin('h5c-managed-qa26-test','https://h5c-managed-qa26-test.hi5central.com','test'),true)
 assert.equal(qa26SessionMatchesOrigin('h5c-custom-qa26-uat','https://h5c-custom-qa26-uat.hi5central.com','uat'),true)
 assert.equal(qa26SessionMatchesOrigin('h5c-managed-qa26-test','https://h5c-custom-qa26-test.hi5central.com','test'),false)
 assert.equal(qa26SessionMatchesOrigin('testing-test','https://h5c-managed-qa26-test.hi5central.com','test'),false)
 assert.equal(qa26SessionMatchesOrigin('h5c-managed-qa26-uat','https://h5c-managed-qa26-uat.hi5central.com','uat'),false)
 assert.equal(qa26SessionMatchesOrigin('h5c-custom-qa26-test','https://h5c-custom-qa26-uat.hi5central.com','uat'),false)
 assert.equal(qa26SessionMatchesOrigin('h5c-custom-qa26','https://h5c-custom-qa26.hi5central.com','test'),false)
 assert.equal(qa26SessionMatchesOrigin('', 'https://h5c-custom-qa26.hi5central.com','live'),false)
 assert.equal(qa26SessionMatchesOrigin('h5c-custom-qa26','', 'live'),false)
})

test('dynamic tenant workspace hostname is canonical, strict and explicitly reserved-name safe',()=>{
 const reserved=new Set(['admin','api','rmm','test','uat','dev','signup'])
 const host='hi5central.com'
 assert.equal(tenantSlugFromHostname('h5c-managed-qa26.hi5central.com',host,reserved),'h5c-managed-qa26')
 assert.equal(tenantSlugFromHostname('NewCustomer.hi5central.com',host,reserved),'newcustomer')
 assert.equal(tenantSlugFromHostname('hello.hi5central.com',host,reserved),'hello')
 for (const bad of [
   'admin.hi5central.com','api.hi5central.com','signup.hi5central.com',
   'h5c-managed-qa26-rmm.hi5central.com',
   'h5c-managed-qa26-portal.hi5central.com',
   'h5c-managed-qa26-test.hi5central.com',
   'h5c-custom-qa26-uat.hi5central.com',
   'other.example.com','foo.hi5central.com.evil.tld',
   'foo.bar.hi5central.com','foo--bar.hi5central.com',
   'foo.hi5central.com:443','https://foo.hi5central.com',
 ])assert.equal(tenantSlugFromHostname(bad,host,reserved),null,bad)
 assert.equal(tenantSlugFromHostname('',host,reserved),null)
 assert.equal(tenantSlugFromHostname('hello.hi5central.com','',reserved),null)
})

test('tenant workspace availability respects archived lifecycle without blocking email verification',()=>{
 assert.equal(tenantMayServeWorkspace({status:'active'}),true)
 assert.equal(tenantMayServeWorkspace({status:'active',lifecycle_status:'active'}),true)
 assert.equal(tenantMayServeWorkspace({status:'active',lifecycle_status:'archived'}),false)
 assert.equal(tenantMayServeWorkspace({status:'active',lifecycle_status:'purge_pending'}),false)
 assert.equal(tenantMayServeWorkspace({status:'inactive'}),false)
 assert.equal(tenantMayServeWorkspace(null),false)
})

test('QA26 Live identity cannot issue a password-only session that its own restore route revokes',()=>{
 for(const role of ['owner','admin','agent','requester']){
  const account={
   onboarding_completed_at:'2026-10-12T00:00:00.000Z',
   tenant_role:role,
   configuration:{security:{requireMfa:false}},
  }
  assert.equal(securitySettings(account).requireMfa,true)
  assert.equal(mfaRequiredFor(account),true)
  assert.equal(loginRequiresMfa(account),true)
  assert.equal(sandboxPolicyRequiresMfa(account),true)
  assert.equal(sessionNeedsMfa({...account,mfa_verified_at:null}),true)
  assert.equal(sessionNeedsMfa({...account,mfa_verified_at:'2026-10-14T20:00:00.000Z'}),false)
 }
 const bootstrap={onboarding_completed_at:null,tenant_role:'owner',configuration:{}}
 assert.equal(mfaRequiredFor(bootstrap),false)
 assert.equal(sessionNeedsMfa(bootstrap),false)
})
