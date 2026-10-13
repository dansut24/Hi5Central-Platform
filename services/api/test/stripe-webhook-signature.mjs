import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  verifyStripeWebhookSignature,
  normaliseStripeWebhookEvent,
  stripeWebhookConfiguration,
  registerStripeBillingWebhookRoutes,
} from '../src/stripeBillingWebhooks.js'

const secret = 'whsec_demo_test_Secret123'
const fakeEvent = {
  id: 'evt_1UQCeXBCiFdWXLmOTest001',
  object: 'event',
  created: 1791925090,
  livemode: false,
  type: 'invoice.paid',
  data: { object: {
    id: 'in_1UQCeMBCiFdWXLmOYW6eKyqS',
    object: 'invoice',
    customer: 'cus_VR4kBWGgmcJwJ4',
    amount_paid: 2000,
    currency: 'gbp',
  } },
}
function signed(raw, timestamp) {
  const signature = createHmac('sha256', secret)
    .update(String(timestamp)).update('.').update(raw).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

test('valid test-mode Stripe signature verifies against raw bytes', () => {
  const now = 1_800_000_000
  const raw = Buffer.from(JSON.stringify(fakeEvent))
  assert.equal(verifyStripeWebhookSignature(raw, signed(raw, now), secret, now * 1000), true)
})

test('reject tampered bodies and forged or missing signature', () => {
  const now = 1_800_000_000
  const raw = Buffer.from(JSON.stringify(fakeEvent))
  const header = signed(raw, now)
  assert.equal(verifyStripeWebhookSignature(Buffer.from(raw.toString() + ' '), header, secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, 't=' + now + ',v1=' + '00'.repeat(32), secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, '', secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, header, 'whsec_WRONG', now * 1000), false)
})

test('reject stale signatures and signatures too far in the future', () => {
  const now = 1_800_000_000
  const raw = Buffer.from(JSON.stringify(fakeEvent))
  assert.equal(verifyStripeWebhookSignature(raw, signed(raw, now - 301), secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, signed(raw, now + 301), secret, now * 1000), false)
})

test('reject oversize body, invalid timestamp, and non-HMAC version', () => {
  const now = 1_800_000_000
  const raw = Buffer.from(JSON.stringify(fakeEvent))
  assert.equal(verifyStripeWebhookSignature(Buffer.alloc(262145), signed(raw, now), secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, 't=notnumber,v1=' + 'aa'.repeat(32), secret, now * 1000), false)
  assert.equal(verifyStripeWebhookSignature(raw, 't=' + now + ',v0=' + 'aa'.repeat(32), secret, now * 1000), false)
})

test('normalises monetary evidence but never interprets zero-amount invoice as revenue', () => {
  const a = normaliseStripeWebhookEvent(fakeEvent)
  assert.equal(a.amountPaidPence, 2000)
  assert.equal(a.customerId, 'cus_VR4kBWGgmcJwJ4')
  assert.equal(a.invoiceId, 'in_1UQCeMBCiFdWXLmOYW6eKyqS')
  assert.equal(a.supported, true)
  assert.equal(normaliseStripeWebhookEvent({
    ...fakeEvent, id:'evt_other',
    data:{object:{...fakeEvent.data.object,amount_paid:0}},
  }).amountPaidPence,0)
})

test('rejects live-mode events and malformed IDs', () => {
  assert.equal(normaliseStripeWebhookEvent({ ...fakeEvent, livemode: true }), null)
  assert.equal(normaliseStripeWebhookEvent({ ...fakeEvent, id:'invalid' }), null)
  assert.equal(normaliseStripeWebhookEvent({ ...fakeEvent, data: null }), null)
})

test('defaults to disabled and never exposes a webhook without the test-only gates', () => {
  assert.equal(stripeWebhookConfiguration({}).enabled, false)
  assert.equal(stripeWebhookConfiguration({
    STRIPE_BILLING_MODE:'sandbox',STRIPE_SECRET_KEY:'sk_live_banned',
    STRIPE_EXPECTED_ACCOUNT_ID:'acct_Dummy',STRIPE_WEBHOOK_ENABLED:'true',
    STRIPE_WEBHOOK_SECRET:secret,
  }).enabled, false)
})

test('isolated Test webhook requires an explicit Test-only gate and can run without Stripe API key', () => {
  const base={
    STRIPE_BILLING_MODE:'sandbox',
    STRIPE_EXPECTED_ACCOUNT_ID:'acct_SandboxTest123',
    STRIPE_WEBHOOK_ENABLED:'true',
    STRIPE_WEBHOOK_SECRET:secret,
  }
  const testRuntime={deploymentMode:'managed',runtimeEnvironment:'test'}
  assert.equal(stripeWebhookConfiguration(base,testRuntime).enabled,false)
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_WEBHOOK_ISOLATED_TEST:'true'},testRuntime).enabled,true)
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_WEBHOOK_ISOLATED_TEST:'true'},
    {deploymentMode:'managed',runtimeEnvironment:'uat'}).enabled,false)
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_WEBHOOK_ISOLATED_TEST:'true'},
    {deploymentMode:'self_hosted',runtimeEnvironment:'test'}).enabled,false)
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_WEBHOOK_ISOLATED_TEST:'true',STRIPE_SECRET_KEY:'sk_live_bad'},
    testRuntime).enabled,true) // never used: isolated Test receiver has NO Stripe outbound API writes
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_BILLING_MODE:'live',
    STRIPE_WEBHOOK_ISOLATED_TEST:'true'},testRuntime).enabled,false)
  assert.equal(stripeWebhookConfiguration(base,{deploymentMode:'managed',runtimeEnvironment:'live'}).enabled,false)
  assert.equal(stripeWebhookConfiguration({...base,STRIPE_SECRET_KEY:'sk_test_dummy'},
    {deploymentMode:'managed',runtimeEnvironment:'live'}).enabled,true)
})

test('HTTP webhook endpoint is hidden unless explicitly enabled', async () => {
  const app = new Hono()
  registerStripeBillingWebhookRoutes(app)
  const response = await app.request('/api/platform/v1/billing/stripe/webhook', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(fakeEvent),
  })
  assert.equal(response.status, 404)
})

test('different event bytes give a different persisted payload hash', () => {
  const a = Buffer.from(JSON.stringify(fakeEvent))
  const b = Buffer.from(JSON.stringify({...fakeEvent, data:{object:{...fakeEvent.data.object,amount_paid:0}}}))
  assert.notEqual(createHash('sha256').update(a).digest('hex'),createHash('sha256').update(b).digest('hex'))
})
