import { useEffect, useState } from 'react'
import './Qa26DemoBilling.css'

// Use the exact QA tenant hostname. Normal workspace APIs may use the shared
// Test/UAT API hostname, but this fake ledger must stay on the QA-only route.
const DEMO_API_ORIGIN = window.location.origin

const QA_TENANTS = new Set(['h5c-managed-qa26','h5c-custom-qa26'])
const money = (pence) => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format((Number(pence)||0)/100)
const date = (value) => value ? new Date(value).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—'

export function Qa26DemoBilling({ session }) {
  const slug = session?.tenant?.slug
  const [data,setData] = useState(null)
  const [error,setError] = useState('')
  const [loading,setLoading] = useState(false)
  const [processing,setProcessing] = useState('')
  const [message,setMessage] = useState('')
  const allowed = QA_TENANTS.has(slug) && ['owner','admin'].includes(session?.user?.tenantRole)
  const mfa = Boolean(session?.security?.mfaVerified)

  async function load() {
    if (!allowed || !mfa) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch(DEMO_API_ORIGIN + '/api/v1/qa26/demo-billing', { credentials:'include' })
      const result = await response.json().catch(()=>({}))
      if (!response.ok) throw new Error(result.error || 'Demo billing is unavailable.')
      if (result.demo !== true || result.realPayments !== false) throw new Error('A verified simulation response is required.')
      setData(result)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  useEffect(() => {
    let cancelled=false
    if (allowed && mfa) {
      fetch(DEMO_API_ORIGIN + '/api/v1/qa26/demo-billing',{credentials:'include'})
        .then(async response=>{
          const result=await response.json().catch(()=>({}))
          if (!response.ok) throw new Error(result.error || 'Demo billing is unavailable.')
          if (!cancelled) setData(result)
        })
        .catch(err=>{if(!cancelled)setError(err.message)})
    }
    return ()=>{cancelled=true}
  },[slug,allowed,mfa])

  async function simulate(invoice,outcome) {
    const action = outcome==='succeeded' ? 'MARK AS PAID (FAKE)' : 'SIMULATE A DECLINE (FAKE)'
    if (!window.confirm(action + '\n\nThis is a QA simulation only. No card details, Stripe charges or real invoices are involved.')) return
    setProcessing(invoice.key)
    setError('')
    setMessage('')
    try {
      const response=await fetch(DEMO_API_ORIGIN + '/api/v1/qa26/demo-billing/' + encodeURIComponent(invoice.key) + '/simulate',{
        method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({outcome}),
      })
      const result=await response.json().catch(()=>({}))
      if (!response.ok) throw new Error(result.error || 'Could not simulate the payment.')
      setMessage(result.alreadyPaid ? 'This demo invoice was already marked paid.' :
        outcome==='succeeded' ? 'Simulation complete: invoice marked paid. No money moved.' :
        'Simulation complete: payment declined. Invoice remains outstanding.')
      await load()
    } catch(e) {setError(e.message)} finally {setProcessing('')}
  }

  if (!QA_TENANTS.has(slug)) return null
  if (!allowed) return <section className="qa26-billing"><h2>Billing and invoices</h2><p>Only this tenant's owner or administrator can view QA billing.</p></section>
  if (!mfa) return <section className="qa26-billing"><h2>Billing and invoices</h2><p>Complete MFA to access the QA billing demonstration.</p></section>

  return <section className="qa26-billing">
    <div className="qa26-billing-heading">
      <div><span className="qa26-demo-label">QA26 SANDBOX · FAKE MONEY</span>
        <h2>Invoices and payments</h2>
        <p>Explore the future Hi5Central invoice experience. This page never charges a card or changes a subscription.</p></div>
      <button type="button" onClick={load} disabled={loading||Boolean(processing)}>{loading?'Loading…':'Refresh'}</button>
    </div>
    {error ? <p className="qa26-billing-error" role="alert">{error}</p> : null}
    {message ? <p className="qa26-billing-message" role="status">{message}</p> : null}
    {!data && !error ? <p>Loading example invoices…</p> : null}
    {data ? <>
      <div className="qa26-billing-totals">
        <div><small>Example outstanding</small><strong>{money(data.totals?.openPence)}</strong></div>
        <div><small>Example paid</small><strong>{money(data.totals?.paidPence)}</strong></div>
        <div><small>Payment environment</small><strong>Simulation only</strong></div>
      </div>
      {data.invoices.map(invoice=><article key={invoice.key} className="qa26-invoice">
        <div className="qa26-invoice-top"><div><small>{invoice.number}</small><h3>{money(invoice.amountPence)}</h3>
          <p>Issued {date(invoice.issuedOn)} · Due {date(invoice.dueOn)}</p></div>
          <span className={'qa26-state qa26-state-'+invoice.status}>{invoice.status==='payment_failed'?'Declined (demo)':invoice.status==='paid'?'Paid (demo)':'Awaiting payment (demo)'}</span>
        </div>
        <div className="qa26-line-items">{invoice.items.map(item=><div key={item.title}>
          <span>{item.title}</span><strong>{money(item.quantity*item.unitPence)}</strong></div>)}</div>
        <p className="qa26-tax-note">Illustrative GBP amounts exclude any VAT. Device quantities are examples, not live RMM billing snapshots.</p>
        {invoice.status!=='paid' ? <div className="qa26-actions">
          <button type="button" disabled={Boolean(processing)} onClick={()=>simulate(invoice,'succeeded')}>
            {processing===invoice.key?'Simulating…':'Simulate payment'}
          </button>
          <button type="button" className="qa26-secondary" disabled={Boolean(processing)} onClick={()=>simulate(invoice,'declined')}>
            Simulate decline
          </button>
        </div>:<small>No real payment has occurred. {invoice.paidAt ? 'Demo marked paid: '+date(invoice.paidAt) : ''}</small>}
      </article>)}
      <p className="qa26-demo-disclaimer">{data.notice}</p>
    </> : null}
  </section>
}
