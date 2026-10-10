import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CheckCircle2, MonitorCog, Wrench } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'
import './MarketingApp.css'

const API_BASE = window.__HI5_API_BASE__
const DEPLOYMENT = deploymentConfig()
const SINGLE_TENANT = DEPLOYMENT.tenancyMode === 'single'
const MANAGED_SIGNUP = DEPLOYMENT.deploymentMode === 'managed' && !SINGLE_TENANT
const SELF_HOST_SINGLE = DEPLOYMENT.deploymentMode === 'self_hosted' && SINGLE_TENANT

function slugFromCompany(value = '') {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function initialSetupToken() {
  if (!SELF_HOST_SINGLE || typeof window === 'undefined') return ''
  const hash = String(window.location.hash || '').replace(/^#/, '')
  return new URLSearchParams(hash).get('setup') || ''
}

function Header() {
  return (
    <header className="marketing-header">
      <div className="marketing-shell marketing-header-inner">
        <a className="marketing-brand" href="/" aria-label="Hi5Central home">
          <img src="/hi5central-logo.png" alt="" />
          <span>Hi5Central</span>
        </a>
        <a className="marketing-button marketing-button-small" href="/">Back</a>
      </div>
    </header>
  )
}

export function SignupPage() {
  const [setupToken, setSetupToken] = useState(initialSetupToken)
  const [form, setForm] = useState({
    companyName: '',
    tenantSlug: SINGLE_TENANT ? DEPLOYMENT.primaryTenantSlug : '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    updateMode: '',
    deploymentDay: 'sun',
    deploymentTime: '02:00',
    deploymentTimezone: 'Europe/London',
    customerUatOptIn: false,
    itsm: true,
    rmm: Boolean(DEPLOYMENT.rmmUrl),
  })
  const [slugTouched, setSlugTouched] = useState(SINGLE_TENANT)
  const [slugStatus, setSlugStatus] = useState(SINGLE_TENANT ? 'available' : 'idle')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)
  const [resendState, setResendState] = useState('idle')

  useEffect(() => {
    document.title = SELF_HOST_SINGLE ? 'Set up Hi5Central' : 'Create your Hi5Central workspace'
    const params = new URLSearchParams(window.location.search)
    if (params.get('verification') === 'received') {
      setCreated({status:'verified',verificationRequired:true})
    }
    if (params.get('verification') === 'invalid') {
      setError('That verification link is invalid, expired or has already been used.')
    }
    if (SELF_HOST_SINGLE && window.location.hash) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
    }
  }, [])

  const tenantPreview = useMemo(() => {
    if (SINGLE_TENANT) return DEPLOYMENT.appUrl || DEPLOYMENT.rootDomain
    return `${form.tenantSlug || 'your-company'}.${DEPLOYMENT.rootDomain}`
  }, [form.tenantSlug])

  function updateField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value }
      if (!SINGLE_TENANT && field === 'companyName' && !slugTouched) next.tenantSlug = slugFromCompany(value)
      return next
    })
    if (!SINGLE_TENANT && field === 'tenantSlug') {
      setSlugTouched(true)
      setSlugStatus('idle')
    }
    setError('')
  }

  async function checkSlug() {
    if (SINGLE_TENANT) {
      setSlugStatus('available')
      return
    }
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
    if (!MANAGED_SIGNUP && form.password !== form.confirmPassword) return setError('Your passwords do not match.')
    if (MANAGED_SIGNUP && !['hi5_managed','admin_controlled'].includes(form.updateMode))
      return setError('Select Managed or Custom updates before continuing.')
    if (!form.itsm && !form.rmm) return setError('Select at least one Hi5Central product.')
    if (SELF_HOST_SINGLE && !setupToken) return setError('Enter the initial setup code shown by the Hi5Central installer.')

    setSubmitting(true)
    try {
      const response = await fetch(`${API_BASE}${MANAGED_SIGNUP?'/api/v1/public/signup-requests':'/api/v1/auth/signup'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: form.companyName,
          tenantSlug: form.tenantSlug,
          name: form.name,
          email: form.email,
          password: form.password,
          modules: MANAGED_SIGNUP?undefined:[form.itsm ? 'itsm' : null, form.rmm ? 'rmm' : null].filter(Boolean),
          setupToken: SELF_HOST_SINGLE ? setupToken : undefined,
          updateMode: MANAGED_SIGNUP?form.updateMode:undefined,
          deploymentDay: MANAGED_SIGNUP?form.deploymentDay:undefined,
          deploymentTime: MANAGED_SIGNUP?form.deploymentTime:undefined,
          deploymentTimezone: MANAGED_SIGNUP?form.deploymentTimezone:undefined,
          customerUatOptIn: MANAGED_SIGNUP?form.customerUatOptIn:undefined,
          modules: MANAGED_SIGNUP?{itsm:form.itsm,rmm:form.rmm}:undefined,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'We could not create your workspace.')

      if (!MANAGED_SIGNUP && data.verificationRequired === false && data.status === 'active') {
        window.location.replace('/onboarding')
        return
      }
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
    const pendingManaged = MANAGED_SIGNUP
    return (
      <div className="marketing-site marketing-signup-site">
        <Header />
        <main className="marketing-signup-wrap">
          <section className="marketing-signup-success">
            <div className="marketing-success-icon"><CheckCircle2 size={28} /></div>
            <span className="marketing-eyebrow">{pendingManaged?'Customer signup':'Workspace created'}</span>
            <h1>{pendingManaged?(created.status==='verified'?'Email verified — request received.':'Check your email to verify your request.'):'Check your email to activate Hi5Central.'}</h1>
            <p>{pendingManaged
              ? 'Your request is being reviewed. No Production or UAT environment has been activated, and you do not have a workspace login yet.'
              : <>We created <strong>{created.tenant?.companyName}</strong> and reserved <strong>{created.tenant?.tenantUrl || tenantPreview}</strong> for you.</>}
            </p>
            {!pendingManaged?<div className="marketing-created-urls">
              <div><span>ITSM workspace</span><strong>{created.tenant?.tenantUrl}</strong></div>
              <div><span>Self-service portal</span><strong>{created.tenant?.portalUrl}</strong></div>
              {created.tenant?.rmmUrl ? <div><span>RMM workspace</span><strong>{created.tenant.rmmUrl}</strong></div> : null}
            </div>:null}
            <div className="marketing-notice">
              {pendingManaged
                ? created.status==='verified'
                  ? 'We have your verified request. An approved operator will prepare your customer environment and send your secure owner invitation when it is ready.'
                  : 'A verification link has been sent to your email address. Following verification, our team will review your requested customer URL and update options.'
                :delivered
                ? `A one-time verification link has been sent to ${created.admin?.email}. It expires in 24 hours.`
                : 'Your tenant was created, but the verification email could not be delivered. Check SMTP configuration and resend.'}
            </div>
            {resendState === 'sent' ? <div className="marketing-notice">A fresh verification email has been requested.</div> : null}
            {resendState === 'failed' ? <div className="marketing-form-error">We could not resend the verification email.</div> : null}
            {!pendingManaged?<button className="marketing-button" onClick={resend} disabled={resendState === 'sending'} type="button">
              {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
            </button>:null}
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
          <span className="marketing-eyebrow">{SELF_HOST_SINGLE ? 'First-time setup' : 'Create your workspace'}</span>
          <h1>{SELF_HOST_SINGLE ? 'Create your Hi5Central administrator.' : 'Start with the products you need.'}</h1>
          <p>
            {SELF_HOST_SINGLE
              ? 'Your installation is running. Create the first organisation and owner account to continue to onboarding.'
              : MANAGED_SIGNUP
                ? 'Request a managed customer workspace. Verify your email first; then we prepare your environment and send your secure first-owner invitation. Nothing is deployed automatically.'
                : 'Your tenant URL, administrator account and product selection are created together. Verify your email, complete onboarding and enter the workspace automatically.'}
          </p>
          <div className="marketing-signup-points">
            <span><CheckCircle2 size={18} /> {SINGLE_TENANT ? 'Single-organisation workspace' : 'Dedicated tenant workspace'}</span>
            <span><CheckCircle2 size={18} /> Matching self-service portal</span>
            <span><CheckCircle2 size={18} /> Secure owner identity</span>
          </div>
        </section>

        <form className="marketing-signup-card" onSubmit={submit}>
          <div className="marketing-form-heading"><span>Hi5Central setup</span><strong>{tenantPreview}</strong></div>

          {SELF_HOST_SINGLE && !setupToken ? (
            <label>
              <span>Initial setup code</span>
              <input
                type="password"
                value={setupToken}
                onChange={(event) => { setSetupToken(event.target.value.trim()); setError('') }}
                required
                autoComplete="off"
              />
              <small>Use the setup code printed by ./install.sh.</small>
            </label>
          ) : null}

          <label><span>Organisation name</span><input value={form.companyName} onChange={(event) => updateField('companyName', event.target.value)} required minLength={2} maxLength={120} autoComplete="organization" /></label>

          {!SINGLE_TENANT ? (
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
          ) : null}

          <div className="marketing-product-choice-heading">Products</div>
          <div className="marketing-product-choice-grid">
            <label className={`marketing-product-choice ${form.itsm ? 'is-selected' : ''}`}><input type="checkbox" checked={form.itsm} onChange={(event) => updateField('itsm', event.target.checked)} /><Wrench size={19} /><span><strong>ITSM</strong><small>Service desk + Portal</small></span></label>
            <label className={`marketing-product-choice ${form.rmm ? 'is-selected' : ''}`}><input type="checkbox" checked={form.rmm} onChange={(event) => updateField('rmm', event.target.checked)} /><MonitorCog size={19} /><span><strong>RMM</strong><small>Endpoint management</small></span></label>
          </div>

          {MANAGED_SIGNUP?<section className="marketing-signup-updates">
            <div className="marketing-product-choice-heading">Keeping Hi5Central up to date</div>
            <p>Choose how approved web-platform releases reach your Production. Customer-specific settings and records are never automatically copied across environments.</p>
            <div className="marketing-update-choice-grid" role="group" aria-label="Update management">
              <button type="button" className={`marketing-update-choice ${form.updateMode==='hi5_managed'?'is-selected':''}`}
                onClick={()=>updateField('updateMode','hi5_managed')}>
                <strong>Managed (recommended)</strong><span>Hi5Central updates Production in your selected window. Your own UAT is optional.</span>
              </button>
              <button type="button" className={`marketing-update-choice ${form.updateMode==='admin_controlled'?'is-selected':''}`}
                onClick={()=>updateField('updateMode','admin_controlled')}>
                <strong>Custom — manual approval</strong><span>Use your own UAT to review each release and approve UAT → Production.</span>
              </button>
            </div>
            {form.updateMode==='hi5_managed'?<div className="marketing-form-grid">
              <label><span>Update day</span><select value={form.deploymentDay} onChange={e=>updateField('deploymentDay',e.target.value)}>
                {['mon','tue','wed','thu','fri','sat','sun'].map((day,i)=><option value={day} key={day}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]}</option>)}
              </select></label>
              <label><span>Start time</span><input type="time" value={form.deploymentTime} onChange={e=>updateField('deploymentTime',e.target.value)}/></label>
              <label><span>Timezone</span><select value={form.deploymentTimezone} onChange={e=>updateField('deploymentTimezone',e.target.value)}>
                {['Europe/London','Europe/Dublin','UTC','Europe/Paris','Europe/Berlin','America/New_York','America/Chicago','America/Los_Angeles','Asia/Dubai','Asia/Singapore','Australia/Sydney'].map(zone=><option key={zone} value={zone}>{zone}</option>)}
              </select></label>
              <label><span>Optional customer UAT</span><input type="checkbox" checked={form.customerUatOptIn} onChange={e=>updateField('customerUatOptIn',e.target.checked)}/> I want a dedicated UAT too</label>
            </div>:null}
            {form.updateMode==='admin_controlled'?<div className="marketing-notice">A dedicated customer UAT is required. Promotion to Production needs manual approval.</div>:null}
          </section>:null}

          <div className="marketing-form-grid">
            <label><span>Your name</span><input value={form.name} onChange={(event) => updateField('name', event.target.value)} required autoComplete="name" /></label>
            <label><span>Email</span><input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} required autoComplete="email" /></label>
          </div>
          {!MANAGED_SIGNUP?<div className="marketing-form-grid">
            <label><span>Password</span><input type="password" value={form.password} onChange={(event) => updateField('password', event.target.value)} required minLength={12} autoComplete="new-password" /><small>Use at least 12 characters.</small></label>
            <label><span>Confirm password</span><input type="password" value={form.confirmPassword} onChange={(event) => updateField('confirmPassword', event.target.value)} required minLength={12} autoComplete="new-password" /></label>
          </div>:null

          {error ? <div className="marketing-form-error">{error}</div> : null}
          <button className="marketing-button marketing-submit" type="submit" disabled={submitting || slugStatus === 'unavailable' || (MANAGED_SIGNUP&&!form.updateMode)}>
            {submitting ? 'Submitting…' : SELF_HOST_SINGLE ? 'Create administrator' : MANAGED_SIGNUP?'Request customer workspace':'Create workspace'}
            {!submitting ? <ArrowRight size={18} /> : null}
          </button>
          <p className="marketing-form-footnote">
            {SELF_HOST_SINGLE
              ? 'The setup code is only accepted while this installation has no tenant.'
              : MANAGED_SIGNUP
                ? 'Your email verification confirms the signup request, not a live workspace. Owner invitations follow independent environment setup.'
                : 'By creating a workspace you agree to use Hi5Central for legitimate business administration and support purposes.'}
          </p>
        </form>
      </main>
    </div>
  )
}
