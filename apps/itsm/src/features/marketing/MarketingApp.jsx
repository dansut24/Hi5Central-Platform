import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Globe2,
  MonitorCog,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react'
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

function Brand() {
  return (
    <a className="marketing-brand" href="/" aria-label="Hi5Central home">
      <img src="/hi5central-logo.png" alt="" />
      <span>Hi5Central</span>
    </a>
  )
}

function SiteHeader() {
  return (
    <header className="marketing-header">
      <div className="marketing-shell marketing-header-inner">
        <Brand />
        <nav className="marketing-nav" aria-label="Primary navigation">
          <a href="/#products">Products</a>
          <a href="/#platform">Platform</a>
          <a href="/#why-hi5">Why Hi5Central</a>
        </nav>
        <a className="marketing-button marketing-button-small" href="/signup">
          Start free <ArrowRight size={16} />
        </a>
      </div>
    </header>
  )
}

function MarketingHome() {
  useEffect(() => {
    document.title = 'Hi5Central | ITSM and RMM, connected'
  }, [])

  return (
    <div className="marketing-site">
      <SiteHeader />

      <main>
        <section className="marketing-hero">
          <div className="marketing-shell marketing-hero-grid">
            <div className="marketing-hero-copy">
              <div className="marketing-kicker"><Sparkles size={15} /> One connected IT operations platform</div>
              <h1>Run IT. Support people. Control every endpoint.</h1>
              <p className="marketing-lead">
                Hi5Central brings modern IT service management and remote monitoring together without forcing them into one product. Buy ITSM, RMM, or both — and connect the context when you need it.
              </p>
              <div className="marketing-hero-actions">
                <a className="marketing-button" href="/signup">Create your workspace <ArrowRight size={18} /></a>
                <a className="marketing-text-link" href="#products">Explore the platform <ArrowRight size={16} /></a>
              </div>
              <div className="marketing-proof-row">
                <span><CheckCircle2 size={17} /> Technician workspace</span>
                <span><CheckCircle2 size={17} /> Self-service portal</span>
                <span><CheckCircle2 size={17} /> Endpoint management</span>
              </div>
            </div>

            <div className="marketing-hero-panel" aria-label="Hi5Central platform preview">
              <div className="marketing-preview-topbar">
                <span className="marketing-preview-dot" />
                <span>Hi5Central</span>
                <span className="marketing-preview-live">Live</span>
              </div>
              <div className="marketing-preview-grid">
                <div className="marketing-preview-card marketing-preview-card-wide">
                  <span>Service health</span>
                  <strong>96.8%</strong>
                  <small>Across requests, incidents and managed devices</small>
                </div>
                <div className="marketing-preview-card">
                  <span>Open incidents</span>
                  <strong>23</strong>
                  <small>4 high priority</small>
                </div>
                <div className="marketing-preview-card">
                  <span>Devices online</span>
                  <strong>181</strong>
                  <small>98.4% reachable</small>
                </div>
                <div className="marketing-preview-bridge">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>ITSM ↔ RMM context</strong>
                    <span>Turn endpoint alerts into service records with the device, user and diagnostic context already attached.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="marketing-section" id="products">
          <div className="marketing-shell">
            <div className="marketing-section-heading">
              <span className="marketing-eyebrow">Products</span>
              <h2>Separate products. One ecosystem.</h2>
              <p>Use the parts you need today and connect them when your operation grows.</p>
            </div>

            <div className="marketing-product-grid">
              <article className="marketing-product-card">
                <div className="marketing-product-icon"><Wrench size={22} /></div>
                <span className="marketing-product-label">Hi5Central ITSM</span>
                <h3>A modern service desk built around the way your teams actually work.</h3>
                <p>Incidents, requests, changes, problems, knowledge, projects, rota, calendar, live chat and powerful service workflows.</p>
                <ul>
                  <li><Check size={16} /> Personalised technician workspace</li>
                  <li><Check size={16} /> Service catalogue and approvals</li>
                  <li><Check size={16} /> Automation-ready workflows</li>
                </ul>
              </article>

              <article className="marketing-product-card">
                <div className="marketing-product-icon"><MonitorCog size={22} /></div>
                <span className="marketing-product-label">Hi5Central RMM</span>
                <h3>See, support and automate your managed estate from anywhere.</h3>
                <p>Inventory, monitoring, remote access, patching, software, policies, jobs and automation across your managed devices.</p>
                <ul>
                  <li><Check size={16} /> Sites, groups and saved views</li>
                  <li><Check size={16} /> Monitoring policy inheritance</li>
                  <li><Check size={16} /> Native unattended remote access</li>
                </ul>
              </article>

              <article className="marketing-product-card marketing-product-card-accent">
                <div className="marketing-product-icon"><Globe2 size={22} /></div>
                <span className="marketing-product-label">Hi5Central Portal</span>
                <h3>Give every user a clean, branded front door to IT.</h3>
                <p>Your self-service portal stays separate from the technician workspace while sharing the same service catalogue, requests and knowledge.</p>
                <ul>
                  <li><Check size={16} /> Dedicated tenant portal URL</li>
                  <li><Check size={16} /> Request tracking and knowledge</li>
                  <li><Check size={16} /> Mobile-first self service</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section className="marketing-section marketing-section-soft" id="platform">
          <div className="marketing-shell marketing-platform-grid">
            <div>
              <span className="marketing-eyebrow">Platform</span>
              <h2>Built for a connected operating model.</h2>
              <p className="marketing-platform-copy">
                A device can raise an alert in RMM, create an incident in ITSM, carry the assigned user and site context with it, and give the technician a direct path back to the managed endpoint.
              </p>
            </div>
            <div className="marketing-flow">
              <div><MonitorCog size={19} /><span>Endpoint alert</span></div>
              <ArrowRight size={18} />
              <div><Wrench size={19} /><span>ITSM incident</span></div>
              <ArrowRight size={18} />
              <div><ShieldCheck size={19} /><span>Resolved with context</span></div>
            </div>
          </div>
        </section>

        <section className="marketing-section" id="why-hi5">
          <div className="marketing-shell marketing-why-grid">
            <div className="marketing-section-heading marketing-section-heading-left">
              <span className="marketing-eyebrow">Why Hi5Central</span>
              <h2>Modern enough to feel simple. Structured enough to scale.</h2>
            </div>
            <div className="marketing-benefits">
              <article><strong>Tenant-first</strong><span>Every organisation receives its own workspace and portal identity from day one.</span></article>
              <article><strong>Responsive everywhere</strong><span>Desktop, tablet and mobile are treated as first-class product surfaces.</span></article>
              <article><strong>Integration-ready</strong><span>ITSM, RMM, APIs and future directory integrations share a deliberate platform boundary.</span></article>
              <article><strong>Built to automate</strong><span>Policies, workflows and scoped targeting are part of the data model, not afterthoughts.</span></article>
            </div>
          </div>
        </section>

        <section className="marketing-cta">
          <div className="marketing-shell marketing-cta-inner">
            <div>
              <span className="marketing-eyebrow">Start building your workspace</span>
              <h2>Create your Hi5Central tenant in minutes.</h2>
            </div>
            <a className="marketing-button marketing-button-light" href="/signup">Start free <ArrowRight size={18} /></a>
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <div className="marketing-shell marketing-footer-inner">
          <Brand />
          <span>ITSM and RMM, connected.</span>
          <span>© {new Date().getFullYear()} Hi5Central</span>
        </div>
      </footer>
    </div>
  )
}

function SignupPage() {
  const [form, setForm] = useState({
    companyName: '',
    tenantSlug: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    itsm: true,
    rmm: false,
  })
  const [slugTouched, setSlugTouched] = useState(false)
  const [slugStatus, setSlugStatus] = useState('idle')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)

  useEffect(() => {
    document.title = 'Create your Hi5Central workspace'
  }, [])

  const tenantPreview = useMemo(() => {
    if (DEPLOYMENT.tenancyMode === 'single') return DEPLOYMENT.rootDomain
    const slug = form.tenantSlug || 'your-company'
    return `${slug}.${DEPLOYMENT.rootDomain}`
  }, [form.tenantSlug])

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

    if (form.password !== form.confirmPassword) {
      setError('Your passwords do not match.')
      return
    }
    if (!form.itsm && !form.rmm) {
      setError('Select at least one Hi5Central product.')
      return
    }

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

  if (created) {
    return (
      <div className="marketing-site marketing-signup-site">
        <SiteHeader />
        <main className="marketing-signup-wrap">
          <section className="marketing-signup-success">
            <div className="marketing-success-icon"><CheckCircle2 size={28} /></div>
            <span className="marketing-eyebrow">Workspace created</span>
            <h1>One final step: verify your email.</h1>
            <p>
              We created <strong>{created.tenant?.companyName}</strong> and reserved <strong>{created.tenant?.slug}.hi5central.com</strong> for you.
            </p>
            <div className="marketing-created-urls">
              <div><span>ITSM workspace</span><strong>{created.tenant?.tenantUrl}</strong></div>
              <div><span>Self-service portal</span><strong>{created.tenant?.portalUrl}</strong></div>
              {created.tenant?.rmmUrl ? <div><span>RMM workspace</span><strong>{created.tenant.rmmUrl}</strong></div> : null}
            </div>
            <div className="marketing-notice">
              Email verification delivery is the next production service being connected. Your tenant is safely held in a pending-verification state until that step is complete.
            </div>
            <a className="marketing-text-link" href="/">Back to Hi5Central <ArrowRight size={16} /></a>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="marketing-site marketing-signup-site">
      <SiteHeader />
      <main className="marketing-signup-wrap">
        <section className="marketing-signup-copy">
          <span className="marketing-eyebrow">Create your workspace</span>
          <h1>Start with the products you need.</h1>
          <p>Your tenant URL, administrator account and product selection are created together. You can add more Hi5Central products later.</p>
          <div className="marketing-signup-points">
            <span><CheckCircle2 size={18} /> Dedicated tenant workspace</span>
            <span><CheckCircle2 size={18} /> Matching self-service portal</span>
            <span><CheckCircle2 size={18} /> One connected identity foundation</span>
          </div>
        </section>

        <form className="marketing-signup-card" onSubmit={submit}>
          <div className="marketing-form-heading">
            <span>Hi5Central signup</span>
            <strong>{tenantPreview}</strong>
          </div>

          <label>
            <span>Company name</span>
            <input value={form.companyName} onChange={(event) => updateField('companyName', event.target.value)} required minLength={2} maxLength={120} autoComplete="organization" />
          </label>

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
            <label className={`marketing-product-choice ${form.itsm ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={form.itsm} onChange={(event) => updateField('itsm', event.target.checked)} />
              <Wrench size={19} />
              <span><strong>ITSM</strong><small>Service desk + Portal</small></span>
            </label>
            <label className={`marketing-product-choice ${form.rmm ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={form.rmm} onChange={(event) => updateField('rmm', event.target.checked)} />
              <MonitorCog size={19} />
              <span><strong>RMM</strong><small>Endpoint management</small></span>
            </label>
          </div>

          <div className="marketing-form-grid">
            <label>
              <span>Your name</span>
              <input value={form.name} onChange={(event) => updateField('name', event.target.value)} required autoComplete="name" />
            </label>
            <label>
              <span>Work email</span>
              <input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} required autoComplete="email" />
            </label>
          </div>

          <div className="marketing-form-grid">
            <label>
              <span>Password</span>
              <input type="password" value={form.password} onChange={(event) => updateField('password', event.target.value)} required minLength={12} autoComplete="new-password" />
              <small>Use at least 12 characters.</small>
            </label>
            <label>
              <span>Confirm password</span>
              <input type="password" value={form.confirmPassword} onChange={(event) => updateField('confirmPassword', event.target.value)} required minLength={12} autoComplete="new-password" />
            </label>
          </div>

          {error ? <div className="marketing-form-error">{error}</div> : null}

          <button className="marketing-button marketing-submit" type="submit" disabled={submitting || slugStatus === 'unavailable'}>
            {submitting ? 'Creating workspace…' : 'Create workspace'}
            {!submitting ? <ArrowRight size={18} /> : null}
          </button>

          <p className="marketing-form-footnote">By creating a workspace you agree to use Hi5Central for legitimate business administration and support purposes.</p>
        </form>
      </main>
    </div>
  )
}

export function MarketingApp() {
  const path = window.location.pathname
  return path === '/signup' || path.startsWith('/signup/') ? <SignupPage /> : <MarketingHome />
}
