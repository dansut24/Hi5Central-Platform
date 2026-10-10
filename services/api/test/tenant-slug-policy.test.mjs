import test from 'node:test'
import assert from 'node:assert/strict'
import { validExistingTenantSlug, validNewTenantSlug } from '../src/tenantSlugPolicy.js'

test('provisioned Test/UAT aliases are valid for tenant lookup and authentication', () => {
  for (const slug of ['testenv-test','testenv-uat','contoso-test','contoso-uat','test2-test','testcustomer-uat']) {
    assert.equal(validExistingTenantSlug(slug),true,slug)
    assert.equal(validNewTenantSlug(slug),false,slug)
  }
})
test('new signups cannot impersonate reserved environment hostnames', () => {
  const reserved=new Set(['api','admin','test','uat'])
  for(const slug of ['api','admin','example-test','example-uat','foobar-portal','foobar-rmm','a--z']) {
    assert.equal(validNewTenantSlug(slug,reserved),false,slug)
  }
  for(const slug of ['testenv','contoso','bobs-comp','test2','newcompany']) {
    assert.equal(validNewTenantSlug(slug,reserved),true,slug)
    assert.equal(validExistingTenantSlug(slug),true,slug)
  }
})
test('existing tenant identifiers cannot have malformed or overflowing slugs', () => {
  for(const slug of ['','a','bad_domain','../admin','bad.host','Xyz-test','tenant--test', 'x'.repeat(49)]) {
    assert.equal(validExistingTenantSlug(slug),false,slug)
  }
})
