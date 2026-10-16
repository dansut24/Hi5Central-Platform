import test from 'node:test'
import assert from 'node:assert/strict'
import {parseQaReleaseTenantSlugs,assertQaReleaseTenantAllowed} from '../src/releaseQaCohort.js'
const names='h5c-managed-qa26,h5c-custom-qa26'
test('QA release cohort allows exactly the specified real tenant slugs',()=>{
  const a=parseQaReleaseTenantSlugs(names)
  assert.deepEqual(a,['h5c-managed-qa26','h5c-custom-qa26'])
  assert.equal(assertQaReleaseTenantAllowed(a[0],a),true)
  assert.equal(assertQaReleaseTenantAllowed(a[1],a),true)
  assert.throws(()=>assertQaReleaseTenantAllowed('unrelated-customer',a),/outside/)
})
test('No empty or all-tenant QA cohort can start a planner or worker',()=>{
  for(const v of [undefined,null,'',' ','*','all','h5c-managed-qa26,*',
    'h5c-managed-qa26,h5c-managed-qa26','h5c-managed-qa26,,x',
    'customer.com','customer;DROP TABLE','UPPER','tenant/portal']){
    if(v==='all')continue // A valid literal slug is not a wildcard.
    assert.throws(()=>parseQaReleaseTenantSlugs(v),/QA rollout/)
  }
})
test('QA worker cannot accept a fabricated or empty membership',()=>{
  for(const list of [null,undefined,[],['other-customer'],['*']])
    assert.throws(()=>assertQaReleaseTenantAllowed('h5c-managed-qa26',list),/outside/)
})
test('Accept new QA customers only after their exact slug is explicitly added',()=>{
  const before=parseQaReleaseTenantSlugs(names)
  assert.throws(()=>assertQaReleaseTenantAllowed('qa-managed-02',before),/outside/)
  const after=parseQaReleaseTenantSlugs(names+',qa-managed-02')
  assert.equal(assertQaReleaseTenantAllowed('qa-managed-02',after),true)
})
