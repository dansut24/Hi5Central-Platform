import test from 'node:test'
import assert from 'node:assert/strict'
import { planRoutes } from './plan-routes.mjs'

test('UAT pilot plan stays on environment-local proxy targets and never maps RMM',()=>{
  const r=planRoutes('uat','acme')
  assert.equal(r.customerWorkspace,'https://acmeuat.hi5central.com')
  assert.equal(r.customerPortal,'https://acmeuat-portal.hi5central.com')
  assert.equal(r.apiOrigin,'https://uat-api.hi5central.com')
  assert.equal(r.expectedProxyTargets.api,'hi5-sandbox-uat-api:3001')
  assert.equal(r.rmmHost,null)
  assert.equal(r.deploymentChanges,false)
})
test('Test pilot cannot reuse UAT hostname or proxy alias',()=>{
  const r=planRoutes('test','acme')
  assert.equal(r.customerWorkspace,'https://acmetest.hi5central.com')
  assert.equal(r.apiOrigin,'https://test-api.hi5central.com')
  assert.equal(r.expectedEdgeNetwork,'hi5central-sandbox-test-edge')
  assert.notEqual(r.expectedProxyTargets.api,planRoutes('uat','acme').expectedProxyTargets.api)
})
test('parallel pilot uses distinct unpublished API origin while keeping tenant host rules strict',()=>{
  for(const env of ['uat','test']){
    const r=planRoutes(env,'acme','hi5central.com','parallel')
    assert.equal(r.routeChannel,'parallel')
    assert.equal(r.apiOrigin,`https://pilot-${env}-api.hi5central.com`)
    assert.equal(r.DNSChanges,false)
    assert.equal(r.TLSChanges,false)
    assert.equal(r.rmmHost,null)
  }
  assert.throws(()=>planRoutes('uat','acme','hi5central.com','unexpected'))
})
test('reserved names, production and arbitrary root domains are rejected',()=>{
  for(const env of ['dev','live','production','']) assert.throws(()=>planRoutes(env,'acme'))
  for(const slug of ['dev','admin','api','acmeuat','acmetest','acme-portal','abc--def','']) {
    assert.throws(()=>planRoutes('uat',slug))
  }
  assert.throws(()=>planRoutes('uat','acme','attacker.example'))
})
