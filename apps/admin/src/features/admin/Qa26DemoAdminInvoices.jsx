import { useEffect, useState } from 'react'

const QA26 = new Set(['h5c-managed-qa26','h5c-custom-qa26'])
const cash = pence => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format((Number(pence)||0)/100)

export function Qa26DemoAdminInvoices({ tenant, request }) {
  const [result,setResult]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const slug=tenant?.slug

  async function inspect() {
    if (!QA26.has(slug)) return
    setBusy(true);setError('')
    try {
      const data=await request('/billing/qa26/tenants/'+encodeURIComponent(tenant.id)+'/demo')
      if (data.demo!==true || data.realPayments!==false || data.tenant?.id!==tenant.id) {
        throw new Error('Verified QA-only demo response required.')
      }
      setResult(data)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  useEffect(()=>{setResult(null);setError('')},[tenant.id,slug])
  if (!QA26.has(slug)) return null

  return <details className="h5a-billing-preview">
    <summary>QA26 fake invoices and payment status</summary>
    <p><strong>DEMO / NO REAL MONEY:</strong> Shared mock invoice ledger, visible to this tenant owner under Settings → Subscription. No Stripe customer is linked.</p>
    <button type="button" className="rmm-secondary compact" onClick={inspect} disabled={busy}>
      {busy?'Loading fake invoices…':result?'Refresh fake invoices':'View fake invoices'}
    </button>
    {error?<p role="alert">{error}</p>:null}
    {result ? <>
      <div className="h5a-billing-grid">
        <div><small>Demo outstanding</small><strong>{cash(result.totals.openPence)}</strong></div>
        <div><small>Demo marked paid</small><strong>{cash(result.totals.paidPence)}</strong></div>
        <div><small>Billing mode</small><strong>Simulation only</strong></div>
      </div>
      <div className="h5a-table-wrap"><table>
        <thead><tr><th>Fake invoice</th><th>Issued</th><th>Due</th><th>Status</th><th>Amount</th><th>Balance</th></tr></thead>
        <tbody>{result.invoices.map(invoice=><tr key={invoice.key}>
          <td>{invoice.number}</td><td>{invoice.issuedOn}</td><td>{invoice.dueOn}</td>
          <td>{invoice.status==='payment_failed'?'Declined (fake)':invoice.status+' (fake)'}</td>
          <td>{cash(invoice.amountPence)}</td><td>{cash(invoice.amountRemainingPence)}</td>
        </tr>)}</tbody>
      </table></div>
      <small>Quantities are fictional. VAT is not calculated. The tenant owner may simulate paid or declined outcomes, but no real Stripe transaction occurs.</small>
    </>:null}
  </details>
}
