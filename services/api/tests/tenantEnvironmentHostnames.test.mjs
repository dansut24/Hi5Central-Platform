import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isValidCustomerSlug,
  customerEnvironmentHostnames,
  classifyManagedCustomerHostname,
} from '../src/tenantEnvironmentHostnames.js'

test('one customer has three distinct managed hostnames', () => {
  assert.deepEqual(customerEnvironmentHostnames('acme'), {
    live: 'acme.hi5central.com',
    uat: 'acmeuat.hi5central.com',
    test: 'acmetest.hi5central.com',
  })
  for (const [environment, hostname] of Object.entries(customerEnvironmentHostnames('acme'))) {
    assert.deepEqual(classifyManagedCustomerHostname(hostname), { tenantSlug: 'acme', environment })
  }
})

test('managed tenant slugs cannot collide with environment suffixes or system URLs', () => {
  for (const slug of ['acmeuat', 'acmetest', 'acme-test', 'dev', 'admin', 'api', 'uat', 'test', 'acme-portal', 'acme-rmm', 'a--b']) {
    assert.equal(isValidCustomerSlug(slug), false, slug)
  }
  assert.equal(isValidCustomerSlug('acme-ltd'), true)
})

test('do not interpret infrastructure hostnames as customer environments', () => {
  for (const host of ['admin.hi5central.com', 'dev.hi5central.com', 'api.hi5central.com', 'dev-api.hi5central.com', 'acme.other.com', 'acme.uat.hi5central.com']) {
    assert.equal(classifyManagedCustomerHostname(host), null, host)
  }
})

test('normalise case but never map a UAT/Test host to Production', () => {
  assert.deepEqual(classifyManagedCustomerHostname('ACMEUAT.HI5CENTRAL.COM'), {
    tenantSlug: 'acme',
    environment: 'uat',
  })
  assert.deepEqual(classifyManagedCustomerHostname('acmetest.hi5central.com'), {
    tenantSlug: 'acme',
    environment: 'test',
  })
  assert.notDeepEqual(
    classifyManagedCustomerHostname('acmeuat.hi5central.com'),
    classifyManagedCustomerHostname('acme.hi5central.com'),
  )
})
