import assert from 'node:assert/strict'
import test from 'node:test'
import {qa26StagingActive,qa26TenantAllowed,qa26ExpectedOrigins,qa26CanServe,qa26ServiceDirectoryHeaders} from '../src/qa26Staging.js'
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
