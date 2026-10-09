import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTenantSurface,markManagedWorkspaceVerified } from '../src/lib/tenantSurface.js'

const locationFor = hostname => ({
  hostname, origin: `https://${hostname}`, pathname: '/', search: '',
})

test('managed production, UAT and Test resolve to different surfaces', () => {
  globalThis.window = { __HI5_CONFIG__: { tenancyMode: 'multi', rootDomain: 'hi5central.com' } }
  const production = resolveTenantSurface(locationFor('acme.hi5central.com'))
  const uat = resolveTenantSurface(locationFor('acmeuat.hi5central.com'))
  const sandbox = resolveTenantSurface(locationFor('acmetest.hi5central.com'))
  assert.equal(production.kind, 'workspace')
  assert.equal(production.tenantSlug, 'acme')
  assert.deepEqual([uat.kind, uat.tenantSlug, uat.environment], ['environment-pending', 'acme', 'uat'])
  assert.deepEqual([sandbox.kind, sandbox.tenantSlug, sandbox.environment], ['environment-pending', 'acme', 'test'])
})

test('unprovisioned alternate product hostnames also fail closed', () => {
  globalThis.window = { __HI5_CONFIG__: { tenancyMode: 'multi', rootDomain: 'hi5central.com' } }
  assert.equal(resolveTenantSurface(locationFor('acmeuat-rmm.hi5central.com')).kind, 'environment-pending')
  assert.equal(resolveTenantSurface(locationFor('acmetest-portal.hi5central.com')).kind, 'environment-pending')
})

test('legacy Dev single-tenant hostname remains a workspace', () => {
  globalThis.window = {
    __HI5_CONFIG__: {
      tenancyMode: 'single',
      primaryTenantSlug: 'dev',
      appUrl: 'https://dev.hi5central.com',
      rootDomain: 'hi5central.com',
    },
  }
  const surface = resolveTenantSurface(locationFor('dev.hi5central.com'))
  assert.equal(surface.kind, 'workspace')
  assert.equal(surface.tenantSlug, 'dev')
})

test('self-hosted MSP does not inherit managed tenant suffix rules', () => {
  globalThis.window = {
    __HI5_CONFIG__: { tenancyMode: 'multi', deploymentMode: 'self_hosted', rootDomain: 'msp.example.com' },
  }
  const surface = resolveTenantSurface(locationFor('acmetest.msp.example.com'))
  assert.equal(surface.kind, 'workspace')
  assert.equal(surface.tenantSlug, 'acmetest')
})

test('only the exact verified UAT workspace hostname transitions from pending to workspace',()=>{
  globalThis.window = { __HI5_CONFIG__:{tenancyMode:'multi',deploymentMode:'managed',rootDomain:'hi5central.com',runtimeEnvironment:'uat'} }
  markManagedWorkspaceVerified({hostname:'acmeuat.hi5central.com',tenantSlug:'acme',environment:'uat'})
  assert.equal(resolveTenantSurface(locationFor('acmeuat.hi5central.com')).kind,'workspace')
  assert.equal(resolveTenantSurface(locationFor('acmeuat-rmm.hi5central.com')).kind,'environment-pending')
  assert.equal(resolveTenantSurface(locationFor('acmeuat-portal.hi5central.com')).kind,'environment-pending')
  assert.equal(resolveTenantSurface(locationFor('acmetest.hi5central.com')).kind,'environment-pending')
  assert.equal(resolveTenantSurface(locationFor('otheruat.hi5central.com')).kind,'environment-pending')
  markManagedWorkspaceVerified({hostname:'',tenantSlug:'',environment:''})
  assert.equal(resolveTenantSurface(locationFor('acmeuat.hi5central.com')).kind,'environment-pending')
})
