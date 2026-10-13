import { pool } from './db.js'

// Intentional hard stop: this module never uses Stripe live-mode credentials
// and exposes no Stripe POST/mutation paths.
export function stripeSandboxConfiguration(env = process.env) {
  const mode = String(env.STRIPE_BILLING_MODE || '').trim().toLowerCase()
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim()
  const expectedAccountId = String(env.STRIPE_EXPECTED_ACCOUNT_ID || '').trim()
  if (mode !== 'sandbox') return { configured: false, reason: 'sandbox_disabled' }
  if (!/^(sk|rk)_test_/.test(secretKey)) return { configured: false, reason: 'test_key_required' }
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId)) {
    return { configured: false, reason: 'expected_account_required' }
  }
  return { configured: true, secretKey, expectedAccountId }
}

async function readStripeAccount(configuration) {
  const response = await fetch('https://api.stripe.com/v1/account', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + configuration.secretKey },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('stripe_account_verification_failed')
  const account = await response.json()
  if (account.id !== configuration.expectedAccountId) {
    throw new Error('stripe_account_mismatch')
  }
  return { verified: true, country: account.country || null }
}

const ROLES = new Set(['owner', 'admin', 'billing'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function registerStripeBillingReadRoutes(app, requireAdmin) {
  app.get('/api/platform/v1/billing/stripe/status', async (c) => {
    const auth = await requireAdmin(c, ROLES)
    if (auth.error) return auth.error
    const configuration = stripeSandboxConfiguration()
    if (!configuration.configured) {
      return c.json({ mode: 'sandbox', connected: false, reason: configuration.reason })
    }
    try {
      const account = await readStripeAccount(configuration)
      return c.json({ mode: 'sandbox', connected: true, country: account.country })
    } catch (error) {
      // Never return a Stripe secret, the raw upstream response, or provider account IDs.
      console.warn('[stripe-sandbox] read-only account verification failed', {
        reason: error.message === 'stripe_account_mismatch' ? 'account_mismatch' : 'verification_failed',
      })
      return c.json({ mode: 'sandbox', connected: false, reason: error.message === 'stripe_account_mismatch'
        ? 'account_mismatch' : 'verification_failed' })
    }
  })

  app.get('/api/platform/v1/billing/tenants/:id/stripe/reconcile-preview', async c => {
    const auth = await requireAdmin(c, ROLES)
    if (auth.error) return auth.error
    const tenantId = String(c.req.param('id') || '')
    if (!UUID.test(tenantId)) return c.json({ error: 'Invalid tenant ID.' }, 400)
    const tenant = await pool.query('SELECT id FROM tenants WHERE id=$1', [tenantId])
    if (!tenant.rowCount) return c.json({ error: 'Tenant not found.' }, 404)
    const link = await pool.query(
      "SELECT stripe_customer_id FROM tenant_stripe_billing_links WHERE tenant_id=$1 AND mode='test'",
      [tenantId],
    )
    const customerId = link.rows[0]?.stripe_customer_id
    if (!customerId) {
      return c.json({ mode:'sandbox',linked:false,subscriptions:[],invoices:[],
        note:'No explicit test-mode customer mapping exists. Nothing has been synchronized.' })
    }
    const cfg = stripeSandboxConfiguration()
    if (!cfg.configured) return c.json({ error:'Stripe sandbox is not configured.',reason:cfg.reason },409)
    try {
      await readStripeAccount(cfg)
      const stripeGet = async endpoint => {
        const response = await fetch('https://api.stripe.com/v1/' + endpoint, {
          method:'GET',headers:{Authorization:'Bearer ' + cfg.secretKey},signal:AbortSignal.timeout(8000),
        })
        if (!response.ok) throw new Error('stripe_read_failed')
        return response.json()
      }
      const customerParam = encodeURIComponent(customerId)
      const [subscriptionsPage, invoicesPage] = await Promise.all([
        stripeGet('subscriptions?customer=' + customerParam + '&status=all&limit=50'),
        stripeGet('invoices?customer=' + customerParam + '&limit=50'),
      ])
      const subscriptions = (subscriptionsPage.data || [])
        .filter(item => item.livemode === false && item.customer === customerId)
        .map(item => ({
          id:item.id,status:item.status,trialEnd:item.trial_end || null,
          cancelAtPeriodEnd:Boolean(item.cancel_at_period_end),
          items:(item.items?.data || []).map(row => ({
            priceId:row.price?.id || null, quantity:row.quantity == null ? null : Number(row.quantity),
            currency:row.price?.currency || null,unitAmountPence:row.price?.unit_amount ?? null,
            billingInterval:row.price?.recurring?.interval || null,
          })),
        }))
      const invoices = (invoicesPage.data || [])
        .filter(item => item.livemode === false && item.customer === customerId)
        .map(item => ({
          id:item.id,status:item.status,number:item.number || null,
          totalPence:item.total ?? null,amountPaidPence:item.amount_paid ?? null,
          amountRemainingPence:item.amount_remaining ?? null,currency:item.currency || null,
          createdAt:item.created ? new Date(item.created*1000).toISOString() : null,
        }))
      return c.json({mode:'sandbox',linked:true,customerId,subscriptions,invoices,
        note:'Read-only current Stripe test-mode records. No tenant billing or entitlements changed.'})
    } catch {
      return c.json({error:'Unable to reconcile Stripe sandbox records.'},503)
    }
  })

  app.get('/api/platform/v1/billing/stripe/payments', async c => {
    const auth = await requireAdmin(c, ROLES)
    if (auth.error) return auth.error
    const cfg = stripeSandboxConfiguration()
    if (!cfg.configured) return c.json({ error: 'Stripe sandbox is not configured.', reason: cfg.reason }, 409)
    const max = Number(c.req.query('limit') || 20)
    const limit = Number.isInteger(max) ? Math.max(1,Math.min(max,40)) : 20
    try {
      await readStripeAccount(cfg) // Pin API key to the explicitly authorized sandbox.
      const response = await fetch('https://api.stripe.com/v1/payment_intents?limit=' + limit, {
        method:'GET',headers:{Authorization:'Bearer ' + cfg.secretKey},signal:AbortSignal.timeout(8000),
      })
      if (!response.ok) return c.json({ error: 'Stripe sandbox payments unavailable.' }, 503)
      const page = await response.json()
      const payments = (page.data || []).filter(item => item.livemode === false)
        .map(item => ({
          id: item.id, status: item.status, currency: item.currency,
          amountPence: Number(item.amount || 0), amountReceivedPence: Number(item.amount_received || 0),
          customerId: typeof item.customer === 'string' ? item.customer : null,
          createdAt: item.created ? new Date(item.created * 1000).toISOString() : null,
        }))
      return c.json({ mode:'sandbox', payments, hasMore:Boolean(page.has_more) })
    } catch {
      return c.json({ error: 'Stripe sandbox payments unavailable.' }, 503)
    }
  })

  app.get('/api/platform/v1/billing/stripe/events', async c => {
    const auth = await requireAdmin(c, ROLES)
    if (auth.error) return auth.error
    const max = Number(c.req.query('limit') || 20)
    const limit = Number.isInteger(max) ? Math.max(1, Math.min(40, max)) : 20
    const results = await pool.query(
      `SELECT stripe_event_id,event_type,event_created_at,received_at,
              stripe_customer_id,stripe_subscription_id,stripe_invoice_id,
              tenant_id,resolution,amount_paid_pence,currency
         FROM stripe_sandbox_webhook_events
        ORDER BY received_at DESC LIMIT $1`, [limit],
    )
    return c.json({
      mode: 'sandbox',
      receipts: results.rows.map(row => ({
        id: row.stripe_event_id, type: row.event_type,
        eventCreatedAt: row.event_created_at, receivedAt: row.received_at,
        customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id,
        invoiceId: row.stripe_invoice_id, tenantId: row.tenant_id,
        resolution: row.resolution, amountPaidPence: row.amount_paid_pence == null
          ? null : Number(row.amount_paid_pence), currency: row.currency,
      })),
      note: 'Signed event receipts only. No automatic tenant entitlement updates.',
    })
  })

  app.get('/api/platform/v1/billing/tenants/:id/preview', async (c) => {
    const auth = await requireAdmin(c, ROLES)
    if (auth.error) return auth.error
    const tenantId = String(c.req.param('id') || '')
    if (!UUID.test(tenantId)) return c.json({ error: 'Invalid tenant ID.' }, 400)
    const tenant = await pool.query(
      `SELECT t.id, t.slug, t.company_name, ts.modules,
              cs.billing_status, cs.billing_cycle, cs.trial_ends_at, cs.renewal_at
         FROM tenants t
         JOIN tenant_settings ts ON ts.tenant_id=t.id
         LEFT JOIN tenant_commercial_settings cs ON cs.tenant_id=t.id
        WHERE t.id=$1`,
      [tenantId],
    )
    if (!tenant.rowCount) return c.json({ error: 'Tenant not found.' }, 404)
    const modules = tenant.rows[0].modules || {}
    const [usage, link] = await Promise.all([
      pool.query(
        `WITH classified AS (
           SELECT CASE
             WHEN NOT $2::boolean THEN 'module_disabled'
             WHEN disabled_at IS NOT NULL THEN 'disabled'
             WHEN GREATEST(last_authenticated_at,last_telemetry_at,websocket_connected_at) IS NULL
               THEN 'never_checked_in'
             WHEN GREATEST(last_authenticated_at,last_telemetry_at,websocket_connected_at)
                  < now() - interval '30 days' THEN 'stale'
             ELSE 'billable'
           END AS reason
           FROM rmm_agent_devices WHERE tenant_id=$1
         )
         SELECT count(*)::int AS total_devices,
                count(*) FILTER (WHERE reason='billable')::int AS billable_devices,
                count(*) FILTER (WHERE reason='module_disabled')::int AS module_disabled_devices,
                count(*) FILTER (WHERE reason='disabled')::int AS disabled_devices,
                count(*) FILTER (WHERE reason='stale')::int AS stale_devices,
                count(*) FILTER (WHERE reason='never_checked_in')::int AS never_checked_in_devices,
                now() AS as_of, now() - interval '30 days' AS eligible_since
         FROM classified`,
        [tenantId, Boolean(modules.rmm)],
      ),
      pool.query(
        `SELECT link.mode,link.stripe_customer_id,link.stripe_subscription_id,link.updated_at,
                (SELECT count(*)::int FROM tenant_stripe_subscription_links sub
                  WHERE sub.tenant_id=link.tenant_id AND sub.mode='test') AS extra_subscription_count
           FROM tenant_stripe_billing_links link WHERE link.tenant_id=$1`,
        [tenantId],
      ),
    ])
    return c.json({
      tenant: {
        id: tenant.rows[0].id,
        slug: tenant.rows[0].slug,
        companyName: tenant.rows[0].company_name,
        modules: { itsm: Boolean(modules.itsm), rmm: Boolean(modules.rmm) },
        billingStatus: tenant.rows[0].billing_status || 'trial',
        billingCycle: tenant.rows[0].billing_cycle || 'monthly',
        trialEndsAt: tenant.rows[0].trial_ends_at,
        renewalAt: tenant.rows[0].renewal_at,
      },
      rmm: { ...usage.rows[0], estimated: true, rule: 'last_verified_check_in_within_30_days' },
      stripe: {
        mode: 'sandbox',
        linked: Boolean(link.rows[0]?.stripe_customer_id),
        hasSubscription: Boolean(link.rows[0]?.stripe_subscription_id || Number(link.rows[0]?.extra_subscription_count || 0) > 0),
      },
      invoiceGenerated: false,
    })
  })
}
