import test from 'node:test'
import assert from 'node:assert/strict'
import { stripeSandboxConfiguration } from '../src/stripeBillingSandbox.js'

const sandbox = { STRIPE_BILLING_MODE: 'sandbox', STRIPE_EXPECTED_ACCOUNT_ID: 'acct_Test1234' }

test('Stripe integration is disabled by default', () => {
  assert.deepEqual(stripeSandboxConfiguration({}), { configured: false, reason: 'sandbox_disabled' })
})

test('live mode keys never activate Stripe integration', () => {
  const value = stripeSandboxConfiguration({ ...sandbox, STRIPE_SECRET_KEY: 'sk_live_not_accepted' })
  assert.equal(value.configured, false)
  assert.equal(value.reason, 'test_key_required')
})

test('test key without pinned account is rejected', () => {
  const value = stripeSandboxConfiguration({ STRIPE_BILLING_MODE: 'sandbox', STRIPE_SECRET_KEY: 'sk_test_dummy' })
  assert.equal(value.configured, false)
  assert.equal(value.reason, 'expected_account_required')
})

test('valid test key and matching expected account configuration can activate inspection', () => {
  const value = stripeSandboxConfiguration({ ...sandbox, STRIPE_SECRET_KEY: 'sk_test_dummy' })
  assert.equal(value.configured, true)
  assert.equal(value.expectedAccountId, sandbox.STRIPE_EXPECTED_ACCOUNT_ID)
})

test('live key is rejected even when sandbox mode is requested', () => {
  assert.equal(stripeSandboxConfiguration({ ...sandbox, STRIPE_SECRET_KEY: 'rk_live_example' }).configured, false)
})
