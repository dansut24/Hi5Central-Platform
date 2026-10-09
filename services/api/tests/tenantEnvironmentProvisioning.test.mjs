import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionRequestEligibility } from '../src/tenantEnvironmentProvisioning.js'

const base = {
  deploymentMode: 'managed',
  tenancyMode: 'multi',
  tenantSlug: 'acme',
  environment: 'uat',
  status: 'pending',
  tenantStatus: 'active',
}

test('managed customer with pending UAT/Test reservation may queue operator provisioning', () => {
  for(const environment of ['uat','test']) {
    assert.equal(provisionRequestEligibility({...base,environment}).allowed,true)
  }
})

test('internal Dev, self-hosted and single-tenant modes cannot queue customer provisioning', () => {
  for (const scenario of [
    {tenantSlug:'dev'},
    {tenantSlug:'acmeuat'},
    {tenantSlug:'acmetest'},
    {deploymentMode:'self_hosted'},
    {tenancyMode:'single'},
  ]) assert.equal(provisionRequestEligibility({...base,...scenario}).allowed,false)
})

test('never queue Production provisioning or already-ready sandboxes', () => {
  for (const scenario of [
    {environment:'live'},
    {status:'ready'},
    {status:'provisioning'},
    {status:'suspended'},
    {tenantStatus:'suspended'},
  ]) assert.equal(provisionRequestEligibility({...base,...scenario}).allowed,false)
})

test('failed sandbox may be retried through audited operator queue', () => {
  assert.equal(provisionRequestEligibility({...base,environment:'test',status:'failed'}).allowed,true)
})
