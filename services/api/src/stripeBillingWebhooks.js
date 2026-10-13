import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { withTransaction } from './db.js'
import { deployment } from './deploymentConfig.js'
import { stripeSandboxConfiguration } from './stripeBillingSandbox.js'

const MAX_BODY_BYTES = 256 * 1024
const SIGNATURE_TOLERANCE_SECONDS = 300
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9]+$/
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/
const STRIPE_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/
const STRIPE_INVOICE_ID = /^in_[A-Za-z0-9]+$/
const RELEVANT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.succeeded',
  'charge.failed',
])

/** Signature verification must use the original bytes, never a JSON re-serialization. */
export function verifyStripeWebhookSignature(rawBody, header, webhookSecret, nowMs = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) return false
  if (typeof header !== 'string' || !/^whsec_[A-Za-z0-9_-]+$/.test(webhookSecret || '')) return false
  const values = header.split(',').map(part => part.trim().split('='))
  const timestamps = values.filter(part => part.length === 2 && part[0] === 't')
  const signatures = values.filter(part => part.length === 2 && part[0] === 'v1')
  if (timestamps.length !== 1 || signatures.length === 0) return false
  const rawTimestamp = timestamps[0][1]
  if (!/^\d{10,12}$/.test(rawTimestamp)) return false
  const timestamp = Number(rawTimestamp)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false

  const expected = createHmac('sha256', webhookSecret)
    .update(rawTimestamp).update('.').update(rawBody).digest()
  return signatures.some(signature => {
    const hex = signature[1]
    return /^[0-9a-fA-F]{64}$/.test(hex)
      && timingSafeEqual(expected, Buffer.from(hex, 'hex'))
  })
}

function validId(raw, pattern) {
  const value = typeof raw === 'string' ? raw : (raw && typeof raw.id === 'string' ? raw.id : '')
  return pattern.test(value) ? value : null
}

export function normaliseStripeWebhookEvent(event) {
  if (!event || event.livemode !== false || !STRIPE_EVENT_ID.test(event.id || '')
    || typeof event.type !== 'string' || !Number.isSafeInteger(event.created)
    || event.created < 0 || !event.data?.object || typeof event.data.object !== 'object'
    || Array.isArray(event.data.object)) return null
  const item = event.data.object
  const subscriptionId = validId(item.subscription, STRIPE_SUBSCRIPTION_ID)
    || (event.type.startsWith('customer.subscription.') ? validId(item.id, STRIPE_SUBSCRIPTION_ID) : null)
  const invoiceId = validId(item.invoice, STRIPE_INVOICE_ID)
    || (event.type.startsWith('invoice.') ? validId(item.id, STRIPE_INVOICE_ID) : null)
  const amount = event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded'
    ? Number(item.amount_paid)
    : null
  return {
    eventId: event.id,
    type: event.type.slice(0, 130),
    created: event.created,
    customerId: validId(item.customer, STRIPE_CUSTOMER_ID),
    subscriptionId,
    invoiceId,
    amountPaidPence: Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
    currency: typeof item.currency === 'string' && /^[a-z]{3}$/.test(item.currency) ? item.currency : null,
    supported: RELEVANT_EVENTS.has(event.type),
  }
}

export function stripeWebhookConfiguration(env = process.env) {
  const sandbox = stripeSandboxConfiguration(env)
  if (!sandbox.configured) return { enabled: false, reason: sandbox.reason }
  // Never accept Stripe events in UAT, Test pool, or self-hosted runtime.
  if (deployment.deploymentMode !== 'managed' || deployment.runtimeEnvironment !== 'live') {
    return { enabled: false, reason: 'central_managed_api_only' }
  }
  if (String(env.STRIPE_WEBHOOK_ENABLED || '').toLowerCase() !== 'true') {
    return { enabled: false, reason: 'webhook_disabled' }
  }
  const secret = String(env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (!/^whsec_[A-Za-z0-9_-]+$/.test(secret)) return { enabled: false, reason: 'webhook_secret_required' }
  return { enabled: true, secret, expectedAccountId: sandbox.expectedAccountId }
}

/** Record verified sandbox events once. No entitlements, commercial tables, or Stripe writes. */
export async function recordVerifiedSandboxStripeEvent(event, payloadSha256) {
  const normalised = normaliseStripeWebhookEvent(event)
  if (!normalised) throw new Error('invalid_stripe_event')
  return withTransaction(async db => {
    const previous = await db.query(
      'SELECT payload_sha256, resolution FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',
      [normalised.eventId],
    )
    if (previous.rowCount) {
      if (previous.rows[0].payload_sha256 !== payloadSha256) throw new Error('stripe_event_id_collision')
      return { duplicate: true, resolution: previous.rows[0].resolution }
    }
    let tenantId = null
    if (normalised.supported && normalised.customerId) {
      const link = await db.query(
        `SELECT tenant_id FROM tenant_stripe_billing_links
           WHERE mode='test' AND stripe_customer_id=$1
             AND (stripe_subscription_id IS NULL OR $2::text IS NULL OR stripe_subscription_id=$2)
           LIMIT 1`,
        [normalised.customerId, normalised.subscriptionId],
      )
      tenantId = link.rows[0]?.tenant_id || null
    }
    const resolution = !normalised.supported ? 'unsupported' : (tenantId ? 'linked' : 'unmapped')
    const result = await db.query(
      `INSERT INTO stripe_sandbox_webhook_events (
         stripe_event_id,event_type,event_created_at,payload_sha256,
         stripe_customer_id,stripe_subscription_id,stripe_invoice_id,
         tenant_id,resolution,amount_paid_pence,currency
       ) VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING stripe_event_id`,
      [
        normalised.eventId, normalised.type, normalised.created, payloadSha256,
        normalised.customerId, normalised.subscriptionId, normalised.invoiceId,
        tenantId, resolution, normalised.amountPaidPence, normalised.currency,
      ],
    )
    if (!result.rowCount) {
      const concurrent = await db.query(
        'SELECT payload_sha256,resolution FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',
        [normalised.eventId],
      )
      if (concurrent.rows[0]?.payload_sha256 !== payloadSha256) throw new Error('stripe_event_id_collision')
      return { duplicate: true, resolution: concurrent.rows[0].resolution }
    }
    return { duplicate: false, resolution }
  })
}

export function registerStripeBillingWebhookRoutes(app) {
  app.post('/api/platform/v1/billing/stripe/webhook', async c => {
    const settings = stripeWebhookConfiguration()
    if (!settings.enabled) return c.json({ error: 'Not found.' }, 404)
    if (!String(c.req.header('content-type') || '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'JSON required.' }, 415)
    }
    const length = Number(c.req.header('content-length') || 0)
    if (length > MAX_BODY_BYTES) return c.json({ error: 'Payload too large.' }, 413)
    const raw = Buffer.from(await c.req.arrayBuffer())
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'Payload too large.' }, 413)
    if (!verifyStripeWebhookSignature(raw, c.req.header('stripe-signature'), settings.secret)) {
      return c.json({ error: 'Invalid webhook signature.' }, 400)
    }
    let event
    try { event = JSON.parse(raw.toString('utf8')) } catch { return c.json({ error: 'Invalid event JSON.' }, 400) }
    if (event?.account && event.account !== settings.expectedAccountId) {
      return c.json({ error: 'Stripe account mismatch.' }, 403)
    }
    if (!normaliseStripeWebhookEvent(event)) return c.json({ error: 'Sandbox event required.' }, 400)
    const payloadSha256 = createHash('sha256').update(raw).digest('hex')
    try {
      const receipt = await recordVerifiedSandboxStripeEvent(event, payloadSha256)
      return c.json({ received: true, duplicate: receipt.duplicate })
    } catch (error) {
      if (error.message === 'stripe_event_id_collision') return c.json({ error: 'Conflicting event identifier.' }, 409)
      if (error.message === 'invalid_stripe_event') return c.json({ error: 'Invalid event.' }, 400)
      throw error // Retry on database outages, rather than acknowledging a lost event.
    }
  })
}
