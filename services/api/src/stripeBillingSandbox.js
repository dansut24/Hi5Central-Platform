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
    const [usage, link] = await Promise.all([
      pool.query(
        `WITH classified AS (
           SELECT CASE
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
                count(*) FILTER (WHERE reason='disabled')::int AS disabled_devices,
                count(*) FILTER (WHERE reason='stale')::int AS stale_devices,
                count(*) FILTER (WHERE reason='never_checked_in')::int AS never_checked_in_devices,
                now() AS as_of, now() - interval '30 days' AS eligible_since
         FROM classified`,
        [tenantId],
      ),
      pool.query(
        `SELECT mode, stripe_customer_id, stripe_subscription_id, updated_at
         FROM tenant_stripe_billing_links WHERE tenant_id=$1`,
        [tenantId],
      ),
    ])
    const modules = tenant.rows[0].modules || {}
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
        hasSubscription: Boolean(link.rows[0]?.stripe_subscription_id),
      },
      invoiceGenerated: false,
    })
  })
}
