import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CheckCircle2, MonitorCog, Wrench } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'
import './MarketingApp.css'

const API_BASE = window.__HI5_API_BASE__
const DEPLOYMENT = deploymentConfig()

function slugFromCompany(value = '') {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function Header() {
  return (
    <header className="marketing-header">
      <div className="marketing-shell marketing-header-inner">
        <a className="marketing-brand" href="/" aria-label="Hi5Central home">
          <img src="/hi5central-logo.png" alt="" />
          <span>Hi5Central</span>
        </a>
        <a className="marketing-button marketing-button-small" href="/">Back to website</a>
      </div>
    </header>
  )
}

export function SignupPage() {
  const [form, setForm] = useState({
    companyName: '', tenantSlug: '', name: '', email: '', password: '', confirmPassword: '', itsm: true, rmm: false,
  })
  const [slugTouched, setSlugTouched] = useState(false)
  const [slugStatus, setSlugStatus] = useState('idle')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)
  const [resendState, setResendState] = useState('idle')

  useEffect(() => {
    document.title = 'Create your Hi5Central workspace'
    const params = new URLSearchParams(window.location.search)
    if (params.get('verification') === 'invalid') {
      setError('That verification link is invalid, expired or has already been used. Create a new workspace or resend verification from the confirmation screen.')
    }
  }, [])

  const tenantPreview = useMemo(() => DEPLOYMENT.tenancyMode === 'single' ? DEPLOYMENT.rootDomain : `${form.tenantSlug || 'your-company'}.${DEPLOYMENT.rootDomain}`, [form.tenantSlug])

  function updateField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value }
      if (field === 'companyName' && !slugTouched) next.tenantSlug = slugFromCompany(value)
      return next
    })
    if (field === 'tenantSlug') {
      setSlugTouched(true)
      setSlugStatus('idle')
    }
    setError('')
  }

  async function checkSlug() {
    const slug = slugFromCompany(form.tenantSlug)
    if (!slug || slug.length < 3) {
      setSlugStatus('invalid')
      return
    }
    setForm((current) => ({ ...current, tenantSlug: slug }))
    setSlugStatus('checking')
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/tenant-slug/${encodeURIComponent(slug)}`)
      const data = await response.json()
      setSlugStatus(data.available ? 'available' : 'unavailable')
    } catch {
      setSlugStatus('unknown')
    }
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (form.password !== form.confirmPassword) return setError('Your passwords do not match.')
    if (!form.itsm && !form.rmm) return setError('Select at least one Hi5Central product.')

    setSubmitting(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: form.companyName,
          tenantSlug: form.tenantSlug,
          name: form.name,
          email: form.email,
          password: form.password,
          modules: [form.itsm ? 'itsm' : null, form.rmm ? 'rmm' : null].filter(Boolean),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'We could not create your workspace.')
      setCreated(data)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function resend() {
    if (!created?.admin?.email || !created?.tenant?.slug) return
    setResendState('sending')
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: created.admin.email, tenantSlug: created.tenant.slug }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Could not resend verification.')
      }
      setResendState('sent')
    } catch {
      setResendState('failed')
    }
  }

  if (created) {
    const delivered = created.verificationDelivery === 'sent'
    return (
      <div className="marketing-site marketing-signup-site">
        <Header />
        <main className="marketing-signup-wrap">
          <section className="marketing-signup-success">
            <div className="marketing-success-icon"><CheckCircle2 size={28} /></div>
            <span className="marketing-eyebrow">Workspace created</span>
            <h1>Check your email to activate Hi5Central.</h1>
            <p>
              We created <strong>{created.tenant?.companyName}</strong> and reserved <strong>{created.tenant?.tenantUrl || tenantPreview}</strong> for you.
            </p>
            <div className="marketing-created-urls">
              <div><span>ITSM workspace</span><strong>{created.tenant?.tenantUrl}</strong></div>
              <div><span>Self-service portal</span><strong>{created.tenant?.portalUrl}</strong></div>
              {created.tenant?.rmmUrl ? <div><span>RMM workspace</span><strong>{created.tenant.rmmUrl}</strong></div> : null}
            </div>
            <div className="marketing-notice">
              {delivered
                ? `A one-time verification link has been sent to ${created.admin?.email}. It expires in 24 hours.`
                : `Your tenant was created, but the verification email could not be confirmed as delivered. Use resend after the mail service has been checked.`}
            </div>
            {resendState === 'sent' ? <div className="marketing-notice">A fresh verification email has been requested.</div> : null}
            {resendState === 'failed' ? <div className="marketing-form-error">We could not resend the verification email. Please try again shortly.</div> : null}
            <button className="marketing-button" onClick={resend} disabled={resendState === 'sending'} type="button">
              {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
            </button>
            <a className="marketing-text-link" href="/">Back to Hi5Central <ArrowRight size={16} /></a>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="marketing-site marketing-signup-site">
      <Header />
      <main className="marketing-signup-wrap">
        <section className="marketing-signup-copy">
          <span className="marketing-eyebrow">Create your workspace</span>
          <h1>Start with the products you need.</h1>
          <p>Your tenant URL, administrator account and product selection are created together. Verify your email, complete onboarding and enter the workspace automatically.</p>
          <div className="marketing-signup-points">
            <span><CheckCircle2 size={18} /> Dedicated tenant workspace</span>
            <span><CheckCircle2 size={18} /> Matching self-service portal</span>
            <span><CheckCircle2 size={18} /> Secure owner identity</span>
          </div>
        </section>

        <form className="marketing-signup-card" onSubmit={submit}>
          <div className="marketing-form-heading"><span>Hi5Central signup</span><strong>{tenantPreview}</strong></div>

          <label><span>Company name</span><input value={form.companyName} onChange={(event) => updateField('companyName', event.target.value)} required minLength={2} maxLength={120} autoComplete="organization" /></label>
          <label>
            <span>Tenant URL</span>
            <div className="marketing-slug-field">
              <input value={form.tenantSlug} onChange={(event) => updateField('tenantSlug', event.target.value)} onBlur={checkSlug} required minLength={3} maxLength={48} spellCheck="false" />
              <span>.hi5central.com</span>
            </div>
            <small className={`marketing-slug-status is-${slugStatus}`}>
              {slugStatus === 'checking' ? 'Checking availability…' : null}
              {slugStatus === 'available' ? 'Available' : null}
              {slugStatus === 'unavailable' ? 'That tenant URL is not available.' : null}
              {slugStatus === 'invalid' ? 'Use at least 3 letters, numbers or hyphens.' : null}
              {slugStatus === 'unknown' ? 'Availability will be checked when you submit.' : null}
            </small>
          </label>

          <div className="marketing-product-choice-heading">Products</div>
          <div className="marketing-product-choice-grid">
            <label className={`marketing-product-choice ${form.itsm ? 'is-selected' : ''}`}><input type="checkbox" checked={form.itsm} onChange={(event) => updateField('itsm', event.target.checked)} /><Wrench size={19} /><span><strong>ITSM</strong><small>Service desk + Portal</small></span></label>
            <label className={`marketing-product-choice ${form.rmm ? 'is-selected' : ''}`}><input type="checkbox" checked={form.rmm} onChange={(event) => updateField('rmm', event.target.checked)} /><MonitorCog size={19} /><span><strong>RMM</strong><small>Endpoint management</small></span></label>
          </div>

          <div className="marketing-form-grid">
            <label><span>Your name</span><input value={form.name} onChange={(event) => updateField('name', event.target.value)} required autoComplete="name" /></label>
            <label><span>Work email</span><input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} required autoComplete="email" /></label>
          </div>
          <div className="marketing-form-grid">
            <label><span>Password</span><input type="password" value={form.password} onChange={(event) => updateField('password', event.target.value)} required minLength={12} autoComplete="new-password" /><small>Use at least 12 characters.</small></label>
            <label><span>Confirm password</span><input type="password" value={form.confirmPassword} onChange={(event) => updateField('confirmPassword', event.target.value)} required minLength={12} autoComplete="new-password" /></label>
          </div>

          {error ? <div className="marketing-form-error">{error}</div> : null}
          <button className="marketing-button marketing-submit" type="submit" disabled={submitting || slugStatus === 'unavailable'}>{submitting ? 'Creating workspace…' : 'Create workspace'}{!submitting ? <ArrowRight size={18} /> : null}</button>
          <p className="marketing-form-footnote">By creating a workspace you agree to use Hi5Central for legitimate business administration and support purposes.</p>
        </form>
      </main>
    </div>
  )
}
