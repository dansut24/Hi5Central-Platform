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
      <div><small>Disabled</small><strong>{result.rmm.disabled_devices}</strong></div>
      <div><small>Offline over 30 days</small><strong>{result.rmm.stale_devices}</strong></div>
      <div><small>Never checked in</small><strong>{result.rmm.never_checked_in_devices}</strong></div>
      <div><small>Total enrolled</small><strong>{result.rmm.total_devices}</strong></div>
      <div><small>Stripe sandbox</small><strong>{result.stripe.linked ? 'Tenant linked' : 'Not linked'}</strong></div>
    </div> : null}
    {result ? <small>Checked {new Date(result.rmm.as_of).toLocaleString()}. Stripe invoice generated: No.</small> : null}
  </details>
}
