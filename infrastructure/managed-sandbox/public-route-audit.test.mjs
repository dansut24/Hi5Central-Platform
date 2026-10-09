import test from 'node:test'
import assert from 'node:assert/strict'
import { auditRouteEvidence } from './public-route-audit.mjs'

function evidence(hostname,kind,status=404){
  return {hostname,class:kind,addresses:['192.0.2.1'],
    tlsAuthorized:true,httpStatus:status,setCookie:false,locationHost:null}
}
test('public TLS reports cannot constitute operator approval',()=>{
  const result=auditRouteEvidence([
    evidence('pilot-uat-api.hi5central.com','pilot-api-unpublished',404),
    evidence('pilotexampleuat.hi5central.com','unapproved-customer',404),
  ])
  assert.equal(result.approvalAllowed,false)
  assert.equal(result.ready,false)
  assert.deepEqual(result.flags,[])
})
test('an unapproved customer 200 or redirect is a fail-closed wildcard route finding',()=>{
  for(const status of [200,302,307]){
    const result=auditRouteEvidence([
      evidence('pilotexampleuat.hi5central.com','unapproved-customer',status)
    ])
    assert.ok(result.flags.some(x=>x.includes('unapproved customer hostname')))
    assert.equal(result.approvalAllowed,false)
  }
})
test('a pilot API that already returns 200 before deployment must be investigated',()=>{
  const result=auditRouteEvidence([
    evidence('pilot-test-api.hi5central.com','pilot-api-unpublished',200),
  ])
  assert.ok(result.flags.some(x=>x.includes('already responds successfully')))
})
test('invalid TLS, missing DNS, cookie and production redirects generate distinct warnings',()=>{
  const values=[
    {...evidence('pilotexampletest.hi5central.com','unapproved-customer'),tlsAuthorized:false},
    {...evidence('pilotexampleuat.hi5central.com','unapproved-customer'),addresses:[]},
    {...evidence('pilotexampleuat.hi5central.com','unapproved-customer'),setCookie:true},
    {...evidence('pilotexampleuat.hi5central.com','unapproved-customer',302),locationHost:'hi5central.com'},
    {...evidence('pilotexampleuat.hi5central.com','unapproved-customer'),error:'ECONNRESET'},
  ]
  const flags=auditRouteEvidence(values).flags
  assert.ok(flags.some(x=>x.includes('certificate not validated')))
  assert.ok(flags.some(x=>x.includes('DNS resolution failed')))
  assert.ok(flags.some(x=>x.includes('sets a cookie')))
  assert.ok(flags.some(x=>x.includes('fallback redirect')))
  assert.ok(flags.some(x=>x.includes('HTTPS probe failed')))
})
