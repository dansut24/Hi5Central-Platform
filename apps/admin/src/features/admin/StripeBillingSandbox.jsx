import { useEffect, useState } from 'react'

const statusReasons = {
  sandbox_disabled: 'Sandbox integration is disabled on the API.',
  test_key_required: 'A server-side Stripe test key is required.',
  expected_account_required: 'Pin the expected Stripe sandbox account ID on the API.',
  account_mismatch: 'The configured test key belongs to another Stripe account.',
  verification_failed: 'Stripe could not verify the sandbox account.',
}

export function StripeSandboxStatus({ request }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    request('/billing/stripe/status')
      .then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [request])
  return <div className="rmm-card">
    <div className="rmm-card-heading"><div>
      <span className="rmm-eyebrow">STRIPE · TEST MODE ONLY</span>
      <h2>Stripe sandbox connection</h2>
      <p>{error ? error : !data ? 'Checking API configuration…' : data.connected
        ? 'Sandbox account verified. No live payments or subscription changes are enabled.'
        : (statusReasons[data.reason] || 'Stripe sandbox is not connected to this API.')}</p>
    </div></div>
    <small>ChatGPT's Stripe connection does not install API credentials on the Hi5Central server. Billing remains manual until separately approved.</small>
  </div>
}

export function RmmBillingPreview({ tenant, request }) {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function inspect() {
    setLoading(true)
    setError('')
    try { setResult(await request('/billing/tenants/' + encodeURIComponent(tenant.id) + '/preview')) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  return <details className="h5a-billing-preview">
    <summary>RMM 30-day billable-device preview</summary>
    <p>This is an estimate as of the time checked, not a saved billing-cycle snapshot or invoice.</p>
    <button type="button" className="rmm-secondary compact" onClick={inspect} disabled={loading}>
      {loading ? 'Checking devices…' : result ? 'Refresh device eligibility' : 'Check device eligibility'}
    </button>
    {error ? <div className="h5a-page-error">{error}</div> : null}
    {result ? <div className="h5a-billing-grid">
      <div><small>Billable RMM devices</small><strong>{result.rmm.billable_devices}</strong></div>
      <div><small>RMM not enabled</small><strong>{result.rmm.module_disabled_devices}</strong></div>
      <div><small>Disabled</small><strong>{result.rmm.disabled_devices}</strong></div>
      <div><small>Offline over 30 days</small><strong>{result.rmm.stale_devices}</strong></div>
      <div><small>Never checked in</small><strong>{result.rmm.never_checked_in_devices}</strong></div>
      <div><small>Total enrolled</small><strong>{result.rmm.total_devices}</strong></div>
      <div><small>Stripe sandbox</small><strong>{result.stripe.linked ? 'Tenant linked' : 'Not linked'}</strong></div>
    </div> : null}
    {result ? <small>Checked {new Date(result.rmm.as_of).toLocaleString()}. Stripe invoice generated: No.</small> : null}
  </details>
}

export function StripeWebhookReceipts({ request }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const data = await request('/billing/stripe/events?limit=20')
      setRows(data.receipts || [])
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div className="rmm-card">
    <div className="rmm-card-heading">
      <div>
        <span className="rmm-eyebrow">STRIPE SANDBOX · WEBHOOK AUDIT</span>
        <h2>Verified payment events</h2>
        <p>Only signed events received by Hi5Central appear here. This is separate from the Stripe Dashboard and does not modify tenant access.</p>
      </div>
      <button type="button" className="rmm-secondary compact" onClick={refresh} disabled={busy}>
        {busy ? 'Checking…' : 'Load events'}
      </button>
    </div>
    {error ? <div className="h5a-page-error">{error}</div> : null}
    {rows && rows.length === 0 ? <p>No signed Stripe events received yet. Configure the sandbox webhook destination to start recording events.</p> : null}
    {rows && rows.length > 0 ? <div className="h5a-table-wrap"><table>
      <thead><tr><th>Received</th><th>Event</th><th>Link</th><th>Paid value</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{new Date(row.receivedAt).toLocaleString()}</td>
        <td>{row.type}</td>
        <td>{row.resolution}</td>
        <td>{row.amountPaidPence == null ? '—' : new Intl.NumberFormat('en-GB',{
          style:'currency',currency:(row.currency || 'gbp').toUpperCase()
        }).format(row.amountPaidPence / 100)}</td>
      </tr>)}</tbody>
    </table></div> : null}
    <small>Zero-value trial invoices are not payment revenue. Signed events alone never activate a tenant.</small>
  </div>
}

export function StripeSandboxPayments({ request }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function load() {
    setBusy(true)
    setError('')
    try { setResult(await request('/billing/stripe/payments?limit=20')) }
    catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div className="rmm-card">
    <div className="rmm-card-heading">
      <div>
        <span className="rmm-eyebrow">STRIPE · VERIFIED READ-ONLY TEST PAYMENTS</span>
        <h2>Recent sandbox payments</h2>
        <p>Read directly from Stripe in test mode. Payments are not automatically linked to tenants or used to provision access.</p>
      </div>
      <button type="button" className="rmm-secondary compact" onClick={load} disabled={busy}>
        {busy ? 'Checking…' : 'Load payments'}
      </button>
    </div>
    {error ? <div className="h5a-page-error">{error}</div> : null}
    {result && result.payments.length === 0 ? <p>No sandbox payment attempts found.</p> : null}
    {result && result.payments.length > 0 ? <div className="h5a-table-wrap"><table>
      <thead><tr><th>Created</th><th>Payment ID</th><th>Status</th><th>Amount paid</th></tr></thead>
      <tbody>{result.payments.map(payment => <tr key={payment.id}>
        <td>{payment.createdAt ? new Date(payment.createdAt).toLocaleString() : '—'}</td>
        <td><code>{payment.id}</code></td>
        <td>{payment.status}</td>
        <td>{new Intl.NumberFormat('en-GB',{style:'currency',currency:(payment.currency||'gbp').toUpperCase()}).format(
          (payment.status==='succeeded'?payment.amountReceivedPence:0)/100)}</td>
      </tr>)}</tbody>
    </table></div> : null}
    <small>Only succeeded payments contribute to this amount column. This screen reads the Stripe sandbox; it is not an invoice or tax report.</small>
  </div>
}

export function StripeTenantReconciliation({ tenant, request }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function inspect() {
    setBusy(true)
    setError('')
    try {
      setResult(await request('/billing/tenants/' + encodeURIComponent(tenant.id) + '/stripe/reconcile-preview'))
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  function money(value, currency='gbp') {
    if (value == null) return '—'
    return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency.toUpperCase()}).format(Number(value)/100)
  }
  return <details className="h5a-billing-preview">
    <summary>Stripe sandbox subscription and invoice reconciliation</summary>
    <p>Reads a tenant's explicitly linked Stripe test customer only. Nothing is written to tenant billing settings.</p>
    <button type="button" className="rmm-secondary compact" disabled={busy} onClick={inspect}>
      {busy ? 'Checking Stripe…' : result ? 'Refresh Stripe records' : 'Inspect Stripe records'}
    </button>
    {error ? <div className="h5a-page-error">{error}</div> : null}
    {result && !result.linked ? <p>No Stripe test customer is explicitly linked to this tenant. No automatic linkage will be made.</p> : null}
    {result?.linked ? <>
      <p>Stripe customer: <code>{result.customerId}</code></p>
      <div className="h5a-table-wrap"><table>
        <thead><tr><th>Subscription</th><th>Status</th><th>Billing items</th></tr></thead>
        <tbody>{result.subscriptions.map(item => <tr key={item.id}>
          <td><code>{item.id}</code></td><td>{item.status}</td>
          <td>{item.items.map(row => (row.quantity ?? '—') + ' × ' + money(row.unitAmountPence,row.currency||'gbp') + ' / ' + (row.billingInterval||'cycle')).join('; ')}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="h5a-table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Status</th><th>Paid</th><th>Remaining</th></tr></thead>
        <tbody>{result.invoices.map(invoice => <tr key={invoice.id}>
          <td>{invoice.number || invoice.id}</td><td>{invoice.status}</td>
          <td>{money(invoice.amountPaidPence,invoice.currency||'gbp')}</td>
          <td>{money(invoice.amountRemainingPence,invoice.currency||'gbp')}</td>
        </tr>)}</tbody>
      </table></div>
      <small>{result.note}</small>
    </> : null}
  </details>
}
