import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, CheckCircle2, Cloud, LockKeyhole, ShieldCheck } from 'lucide-react'
import WorkspaceRuntime from '../runtime/WorkspaceRuntime.jsx'
import { OnboardingWizard } from '../features/onboarding/OnboardingWizard.jsx'
import { ProductionSettingsWorkspace } from '../features/settings/ProductionSettingsWorkspace.jsx'
import { ProductionIdentityBridge } from './ProductionIdentityBridge.jsx'
import { ProductionFirstLoginExperience } from './ProductionFirstLoginExperience.jsx'
import { ProductionProfileWorkspace } from './ProductionProfileWorkspace.jsx'
import { resolveTenantSurface } from '../lib/tenantSurface.js'
import {
  clearProductionSession,
  normaliseAccent,
  saveAccent,
  saveDensity,
  saveProductionSession,
  saveSidebarMode,
  saveTheme,
} from '../services/runtimeState.js'
import { hydrateProductionServiceRequests } from '../services/productionServiceRequests.js'
import { takeProductionAuthHandoff } from './productionSessionBridge.js'
import './ProductionWorkspaceBootstrap.css'

const API_BASE = window.__HI5_API_BASE__
const PRODUCTION_SESSION_KEY = 'hi5central-production-session-v1'
const TENANT_RUNTIME_CONFIG_KEY = 'hi5central-tenant-runtime-config-v1'
const SESSION_BOOTSTRAP_TIMEOUT_MS = 8000
const SANDBOX_SESSION_RESTORE_TIMEOUT_MS = 3500

function hasMatchingEnvironmentSession(tenantSlug) {
  try {
    const session = JSON.parse(window.localStorage.getItem(PRODUCTION_SESSION_KEY) || 'null')
    return session?.source === 'production' && session.tenantSlug === tenantSlug
  } catch {
    return false
  }
}

const ONBOARDING_SNAPSHOT_KEY = 'hi5central-onboarding-snapshot-v1'
const ONBOARDING_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000
const FIRST_LOGIN_HANDOFF_KEY = 'hi5central-first-login-required-v1'
const ORGANISATION_CACHE_KEYS = {
  people: 'hi5central-organisation-people-v1',
  teams: 'hi5central-organisation-teams-v1',
  departments: 'hi5central-organisation-departments-v1',
  sites: 'hi5central-organisation-sites-v1',
}

function firstLoginHandoffRequired(session) {
  try {
    const raw = window.sessionStorage.getItem(FIRST_LOGIN_HANDOFF_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    const age = Date.now() - Number(parsed?.createdAt || 0)
    const matches = age >= 0
      && age <= 30 * 60 * 1000
      && parsed?.tenantSlug === session?.tenant?.slug
      && (!parsed?.userId || parsed.userId === session?.user?.id)

    if (!matches) window.sessionStorage.removeItem(FIRST_LOGIN_HANDOFF_KEY)
    return matches
  } catch {
    try { window.sessionStorage.removeItem(FIRST_LOGIN_HANDOFF_KEY) } catch { /* best effort */ }
    return false
  }
}

function initials(name = '') {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'HC'
}

function effectiveSettings(apiSession) {
  return apiSession?.settings && Object.keys(apiSession.settings).length
    ? apiSession.settings
    : apiSession?.onboarding?.data || {}
}

function sessionHasPermission(apiSession, permission) {
  const effective = apiSession?.access?.effectivePermissions || []
  const grants = apiSession?.access?.permissions || []
  if (effective.includes(permission) || grants.includes('*') || grants.includes(permission)) return true
  return grants.some((grant) => grant.endsWith('*') && permission.startsWith(grant.slice(0, -1)))
}

function toWorkspaceSession(apiSession) {
  return {
    role: 'analyst',
    source: 'production',
    tenantRole: apiSession.user.tenantRole,
    userId: apiSession.user.id,
    tenantId: apiSession.tenant.id,
    tenantSlug: apiSession.tenant.slug,
    name: apiSession.user.name,
    initials: initials(apiSession.user.name),
    username: apiSession.user.email,
    tenant: apiSession.tenant,
    user: apiSession.user,
    access: apiSession.access,
    platformAccess: apiSession.platformAccess || {},
    security: apiSession.security,
    preferences: apiSession.preferences || null,
    onboarding: apiSession.onboarding,
    settings: effectiveSettings(apiSession),
  }
}

function applyTenantPreferences(apiSession) {
  const configuration = effectiveSettings(apiSession)
  const theme = configuration.theme || {}
  const itsm = configuration.itsm || {}
  const preferences = apiSession?.preferences || {}
  const appearance = preferences.appearance || {}
  const navigation = preferences.navigation || {}

  const resolvedTheme = ['system', 'light', 'dark'].includes(appearance.theme)
    ? appearance.theme
    : theme.mode
  const resolvedAccent = appearance.accentMode === 'personal'
    ? normaliseAccent(appearance.accent)
    : normaliseAccent(theme.accent)

  if (['system', 'light', 'dark'].includes(resolvedTheme)) saveTheme(resolvedTheme)
  saveAccent(resolvedAccent)
  if (['comfortable', 'compact'].includes(appearance.density)) saveDensity(appearance.density)
  if (['expanded', 'collapsed', 'hidden'].includes(navigation.sidebarMode)) saveSidebarMode(navigation.sidebarMode)

  try {
    window.localStorage.setItem(TENANT_RUNTIME_CONFIG_KEY, JSON.stringify({
      tenantSlug: apiSession?.tenant?.slug || '',
      theme: {
        mode: theme.mode || 'system',
        accent: normaliseAccent(theme.accent),
        brandName: theme.brandName || apiSession?.tenant?.companyName || '',
        portalTitle: theme.portalTitle || 'IT Help Centre',
      },
      recordNumbering: {
        mode: itsm.numberingMode || 'default',
        prefixes: itsm.recordPrefixes || {},
        digits: itsm.recordDigits || '5',
      },
      microsoft365: configuration.users?.microsoft365 || {},
      itsm,
      rmm: configuration.rmm || {},
    }))
  } catch {
    // Local runtime preferences bridge server settings into the workspace shell.
  }
}

function cacheOrganisationSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  for (const [collection, storageKey] of Object.entries(ORGANISATION_CACHE_KEYS)) {
    const items = snapshot[collection]
    if (Array.isArray(items)) window.localStorage.setItem(storageKey, JSON.stringify(items))
  }
  window.dispatchEvent(new CustomEvent('hi5-organisation-hydrated', { detail: snapshot }))
}

async function hydrateProductionOrganisation() {
  const response = await fetch(`${API_BASE}/api/v1/organisation`, {
    credentials: 'include',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Could not load Organisation data.')
  cacheOrganisationSnapshot(payload)
  return payload
}

async function hydrateOrganisationWithFallback() {
  try {
    return await hydrateProductionOrganisation()
  } catch (error) {
    console.error('Production Organisation hydration failed; using the last local cache.', error)
    window.dispatchEvent(new CustomEvent('hi5-organisation-sync-error', {
      detail: { collection: 'all', message: error.message },
    }))
    return null
  }
}

async function hydrateServiceRequestsWithFallback() {
  try {
    return await hydrateProductionServiceRequests()
  } catch (error) {
    console.error('Production Service Request hydration failed; using the last local cache.', error)
    window.dispatchEvent(new CustomEvent('hi5-service-requests-sync-error', {
      detail: { message: error.message },
    }))
    return null
  }
}

async function hydrateWorkspaceData() {
  const [organisation, serviceRequests] = await Promise.all([
    hydrateOrganisationWithFallback(),
    hydrateServiceRequestsWithFallback(),
  ])
  return { organisation, serviceRequests }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = SESSION_BOOTSTRAP_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), timeoutMs)
  })
  const request = (async () => {
    const response = await fetch(url, options)
    const payload = await response.json().catch(() => ({}))
    return { response, payload }
  })()

  try {
    return await Promise.race([request, timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

function onboardingSnapshotFromSession(apiSession) {
  if (!apiSession?.tenant?.slug || apiSession?.onboarding?.completedAt) return null
  return {
    savedAt: Date.now(),
    authenticated: true,
    user: {
      id: apiSession.user?.id || '',
      name: apiSession.user?.name || '',
      email: apiSession.user?.email || '',
      tenantRole: apiSession.user?.tenantRole || 'owner',
    },
    tenant: {
      id: apiSession.tenant?.id || '',
      slug: apiSession.tenant.slug,
      companyName: apiSession.tenant?.companyName || apiSession.tenant.slug,
      tenantUrl: apiSession.tenant?.tenantUrl || '',
      portalUrl: apiSession.tenant?.portalUrl || '',
      rmmUrl: apiSession.tenant?.rmmUrl || '',
      modules: apiSession.tenant?.modules || {},
    },
    onboarding: {
      step: apiSession.onboarding?.step || 'company',
      completedAt: null,
      data: apiSession.onboarding?.data || {},
    },
    settings: apiSession.settings || apiSession.onboarding?.data || {},
    security: apiSession.security || { mfaVerified: false },
  }
}

function saveOnboardingSnapshot(apiSession) {
  try {
    const snapshot = onboardingSnapshotFromSession(apiSession)
    if (!snapshot) {
      window.sessionStorage.removeItem(ONBOARDING_SNAPSHOT_KEY)
      return
    }
    window.sessionStorage.setItem(ONBOARDING_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Server state remains authoritative when browser storage is unavailable.
  }
}

function clearOnboardingSnapshot() {
  try { window.sessionStorage.removeItem(ONBOARDING_SNAPSHOT_KEY) } catch { /* best effort */ }
}

function readOnboardingSnapshot(expectedSlug) {
  try {
    const raw = window.sessionStorage.getItem(ONBOARDING_SNAPSHOT_KEY)
    if (!raw) return null
    const snapshot = JSON.parse(raw)
    const age = Date.now() - Number(snapshot?.savedAt || 0)
    const valid = snapshot?.authenticated === true
      && snapshot?.tenant?.slug === expectedSlug
      && !snapshot?.onboarding?.completedAt
      && age >= 0
      && age <= ONBOARDING_SNAPSHOT_MAX_AGE_MS

    if (!valid) {
      window.sessionStorage.removeItem(ONBOARDING_SNAPSHOT_KEY)
      return null
    }
    return snapshot
  } catch {
    clearOnboardingSnapshot()
    return null
  }
}

function resolvedLoadingTheme() {
  let preferred = null
  try {
    const saved = JSON.parse(window.localStorage.getItem('hi5central-theme-mode') || 'null')
    if (['system', 'light', 'dark'].includes(saved)) preferred = saved
  } catch { /* best effort */ }

  if (!preferred) {
    try {
      const tenantRuntime = JSON.parse(window.localStorage.getItem(TENANT_RUNTIME_CONFIG_KEY) || '{}')
      const tenantMode = tenantRuntime?.theme?.mode
      if (['system', 'light', 'dark'].includes(tenantMode)) preferred = tenantMode
    } catch { /* best effort */ }
  }

  preferred ||= 'system'
  return preferred === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (preferred === 'dark' ? 'dark' : 'light')
}

function LoadingScreen({ delayed, onRetry }) {
  if (!delayed) {
    return (
      <main className="hi5-loading-shell" data-theme={resolvedLoadingTheme()} aria-label="Loading Hi5Central">
        <img className="hi5-loading-mark" src="/hi5central-logo.png" alt="" />
      </main>
    )
  }

  return (
    <main className="hi5-loading-shell" data-theme={resolvedLoadingTheme()} aria-label="Hi5Central session restore delayed">
      <div className="hi5-loading-recovery">
        <img className="hi5-loading-mark" src="/hi5central-logo.png" alt="" />
        <span>Session restore is taking longer than expected.</span>
        <div className="production-auth-loading-actions">
          <button type="button" onClick={onRetry}>Retry session</button>
          <button type="button" onClick={() => {
            clearOnboardingSnapshot()
            clearProductionSession()
            window.location.replace('/login?fresh=1')
          }}>Sign in again</button>
        </div>
      </div>
    </main>
  )
}

function ProductionLogin({ tenant, onAuthenticated }) {
  const [form, setForm] = useState({ email: '', password: '' })
  const [passwordStep, setPasswordStep] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [authMethod, setAuthMethod] = useState('')
  const [microsoftAvailable, setMicrosoftAvailable] = useState(false)
  const [mfaFlow, setMfaFlow] = useState(null)
  const [mfaSetup, setMfaSetup] = useState(null)
  const [mfaCode, setMfaCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [authenticatedPayload, setAuthenticatedPayload] = useState(null)

  useEffect(() => {
    let active = true
    fetch(`${API_BASE}/api/v1/auth/microsoft/status/${encodeURIComponent(tenant.slug)}`, { credentials: 'include' })
      .then(async (response) => ({ response, payload: await response.json().catch(() => ({})) }))
      .then(({ response, payload }) => { if (active) setMicrosoftAvailable(Boolean(response.ok && payload.configured && payload.connected && payload.ssoEnabled)) })
      .catch(() => { if (active) setMicrosoftAvailable(false) })
    return () => { active = false }
  }, [tenant.slug])

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('microsoft')
    if (reason === 'not_assigned') setError('That Microsoft account is not linked to a Hi5Central user with workspace access.')
    else if (reason && reason !== 'connected') setError('Microsoft sign-in could not be completed. Try again or use your Hi5Central password.')
  }, [])

  async function beginMfa(payload) {
    const flow = {
      challengeToken: payload.challengeToken,
      setupRequired: Boolean(payload.setupRequired),
      tenant: payload.tenant,
      user: payload.user,
    }
    setMfaFlow(flow)
    setMfaSetup(null)
    setMfaCode('')
    setRecoveryCodes([])
    setAuthenticatedPayload(null)

    if (!flow.setupRequired) return
    const response = await fetch(`${API_BASE}/api/v1/auth/mfa/setup`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: flow.challengeToken, tenantSlug: tenant.slug }),
    })
    const setupPayload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(setupPayload.error || 'Could not start MFA setup.')
    setMfaSetup(setupPayload)
  }

  function resetPasswordSignIn() {
    setPasswordStep(false)
    setForm((current) => ({ ...current, password: '' }))
    setAuthMethod('')
    setMfaFlow(null)
    setMfaSetup(null)
    setMfaCode('')
    setRecoveryCodes([])
    setAuthenticatedPayload(null)
    setError('')
  }

  async function confirmSecureSession() {
    // Confirm the browser actually retained its HttpOnly login cookie before
    // navigating to a first-login flow or any authenticated workspace.
    const response = await fetch(`${API_BASE}/api/v1/auth/session`, {
      credentials: 'include',
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload?.authenticated || payload.tenant?.slug !== tenant.slug) {
      throw new Error('Sign-in succeeded, but the browser did not retain the secure session. Allow cookies for the Hi5Central API and sign in again.')
    }
    return payload
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    const email = form.email.trim()
    if (!email) {
      setError('Enter your email address to continue.')
      return
    }

    if (!passwordStep) {
      setSubmitting(true)
      setAuthMethod('checking')
      try {
        const response = await fetch(`${API_BASE}/api/v1/auth/microsoft/discover/${encodeURIComponent(tenant.slug)}?email=${encodeURIComponent(email)}`, { credentials: 'include' })
        const payload = await response.json().catch(() => ({}))
        if (response.ok && payload.method === 'microsoft') {
          setAuthMethod('microsoft')
          const params = new URLSearchParams({ tenantSlug: tenant.slug, returnTo: window.location.pathname || '/', loginHint: email })
          window.location.href = `${API_BASE}/api/v1/auth/microsoft/start?${params.toString()}`
          return
        }
        setForm((current) => ({ ...current, email }))
        setPasswordStep(true)
        setAuthMethod('password')
      } catch {
        setPasswordStep(true)
        setAuthMethod('password')
      } finally {
        setSubmitting(false)
      }
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/login-secure`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantSlug: tenant.slug, email, password: form.password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Sign in failed.')

      if (payload.mfaRequired) {
        await beginMfa(payload)
        return
      }
      if (!payload.authenticated) throw new Error('Hi5Central could not complete sign in.')
      await onAuthenticated(await confirmSecureSession())
    } catch (loginError) {
      setError(loginError.message || 'Sign in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function verifyMfa(event) {
    event.preventDefault()
    if (!mfaFlow?.challengeToken || !mfaCode.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: mfaFlow.challengeToken, code: mfaCode.trim(), tenantSlug: tenant.slug }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'MFA verification failed.')

      if (Array.isArray(payload.recoveryCodes) && payload.recoveryCodes.length) {
        setAuthenticatedPayload(payload)
        setRecoveryCodes(payload.recoveryCodes)
        return
      }
      await onAuthenticated(await confirmSecureSession())
    } catch (verifyError) {
      setError(verifyError.message || 'MFA verification failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function continueAfterRecoveryCodes() {
    setSubmitting(true)
    setError('')
    try {
      if (!authenticatedPayload?.authenticated) throw new Error('The authenticated session is no longer available.')
      await onAuthenticated(await confirmSecureSession())
    } catch (continueError) {
      setError(continueError.message || 'Could not open the Hi5Central workspace.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="production-auth-shell">
      <div className="production-auth-layout">
        <section className="production-auth-copy">
          <img src="/hi5central-logo.png" alt="" />
          <span className="production-auth-kicker"><ShieldCheck size={15} /> Secure tenant sign-in</span>
          <h1>Welcome back to {tenant.companyName || tenant.slug}.</h1>
          <p>Enter your email address and Hi5Central will use the sign-in method configured by your organisation.</p>
          <div className="production-auth-points">
            <span><CheckCircle2 size={17} /> Tenant-isolated session</span>
            <span><CheckCircle2 size={17} /> HttpOnly secure cookie</span>
            <span><CheckCircle2 size={17} /> Organisation-managed sign-in</span>
          </div>
        </section>

        <form className="production-auth-card" onSubmit={mfaFlow ? verifyMfa : submit}>
          <div className="production-auth-card-heading">
            <span className="production-auth-icon">{mfaFlow ? <ShieldCheck size={19} /> : <LockKeyhole size={19} />}</span>
            <div>
              <span>{mfaFlow ? (mfaFlow.setupRequired ? 'Set up multi-factor authentication' : 'Multi-factor authentication') : 'Hi5Central ITSM'}</span>
              <strong>{tenant.slug}.hi5central.com</strong>
            </div>
          </div>

          {!mfaFlow && tenant.status === 'pending_verification' ? (
            <div className="production-auth-notice">This workspace is waiting for its owner email to be verified. Use the verification email sent during signup before signing in.</div>
          ) : null}

          {recoveryCodes.length ? (
            <>
              <div className="production-auth-notice">
                MFA is enabled. Save these recovery codes somewhere secure. Each code can be used once.
              </div>
              <div className="production-auth-recovery-grid">
                {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
              </div>
              {error ? <div className="production-auth-error">{error}</div> : null}
              <button disabled={submitting} onClick={continueAfterRecoveryCodes} type="button">
                {submitting ? 'Opening Hi5Central…' : 'I have saved these codes'}{!submitting ? <ArrowRight size={17} /> : null}
              </button>
            </>
          ) : mfaFlow ? (
            <>
              <p className="production-auth-method-note">
                {mfaFlow.setupRequired
                  ? 'Add Hi5Central to your authenticator app, then enter the six-digit code to finish setup.'
                  : 'Enter the six-digit code from your authenticator app, or an unused recovery code.'}
              </p>
              {mfaFlow.setupRequired ? (
                mfaSetup ? (
                  <div className="production-auth-mfa-setup">
                    <span>Authenticator setup key</span>
                    <code>{mfaSetup.secret}</code>
                    <small>Issuer: Hi5Central · Account: {mfaSetup.account}</small>
                    <a href={mfaSetup.otpauthUri}>Open in authenticator app</a>
                  </div>
                ) : <div className="production-auth-notice">Preparing authenticator setup…</div>
              ) : null}
              <label>
                <span>{mfaFlow.setupRequired ? 'Six-digit authenticator code' : 'Authenticator or recovery code'}</span>
                <input
                  autoComplete="one-time-code"
                  autoFocus
                  inputMode={mfaFlow.setupRequired ? 'numeric' : 'text'}
                  maxLength={mfaFlow.setupRequired ? 6 : 20}
                  placeholder={mfaFlow.setupRequired ? '000000' : '000000 or recovery code'}
                  required
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                />
              </label>
              {error ? <div className="production-auth-error">{error}</div> : null}
              <button disabled={submitting || !mfaCode.trim() || (mfaFlow.setupRequired && !mfaSetup)} type="submit">
                {submitting ? 'Verifying…' : mfaFlow.setupRequired ? 'Verify and enable MFA' : 'Verify and sign in'}
                {!submitting ? <ArrowRight size={17} /> : null}
              </button>
              <button className="production-auth-secondary-action" disabled={submitting} onClick={resetPasswordSignIn} type="button">Back to sign in</button>
            </>
          ) : (
            <>
              <label>
                <span>Email address</span>
                <input type="email" autoComplete="username" required value={form.email} onChange={(event) => { setForm((current) => ({ ...current, email: event.target.value })); if (passwordStep) setPasswordStep(false); setError('') }} />
              </label>

              {passwordStep ? <label>
                <span>Password</span>
                <input type="password" autoComplete="current-password" required autoFocus value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
              </label> : <p className="production-auth-method-note">Your organisation may continue with Microsoft 365 or ask for your Hi5Central password.</p>}

              {error ? <div className="production-auth-error">{error}</div> : null}

              <button type="submit" disabled={submitting || tenant.status !== 'active'}>
                {submitting ? (authMethod === 'microsoft' ? 'Opening Microsoft…' : passwordStep ? 'Signing in…' : 'Checking sign-in…') : passwordStep ? 'Sign in' : 'Continue'}
                {!submitting ? <ArrowRight size={17} /> : null}
              </button>
              {passwordStep ? <button className="production-auth-secondary-action" type="button" onClick={resetPasswordSignIn}>Use a different email</button> : null}
              {microsoftAvailable ? <>
                <div className="production-auth-divider"><span>or</span></div>
                <button className="production-auth-microsoft" type="button" onClick={() => { const params = new URLSearchParams({ tenantSlug: tenant.slug, returnTo: window.location.pathname || '/' }); window.location.href = `${API_BASE}/api/v1/auth/microsoft/start?${params.toString()}` }}><Cloud size={17} /> Sign in with Microsoft</button>
              </> : null}
              <a href="https://hi5central.com">Back to hi5central.com</a>
            </>
          )}
        </form>
      </div>
    </div>
  )
}

function ProductionSettingsLayer({ currentPath, session, onSessionChange }) {
  const [target, setTarget] = useState(null)

  useEffect(() => {
    let mountedTarget = null

    const attach = () => {
      const nextTarget = document.querySelector('.content-frame')
      if (!(nextTarget instanceof HTMLElement)) return false

      if (mountedTarget && mountedTarget !== nextTarget) {
        mountedTarget.classList.remove('production-settings-mounted')
      }

      mountedTarget = nextTarget
      mountedTarget.classList.add('production-settings-mounted')
      setTarget(nextTarget)
      return true
    }

    if (attach()) {
      return () => mountedTarget?.classList.remove('production-settings-mounted')
    }

    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      mountedTarget?.classList.remove('production-settings-mounted')
    }
  }, [])

  if (!target) return null

  return createPortal(
    <ProductionSettingsWorkspace
      currentPath={currentPath}
      onSessionChange={onSessionChange}
      session={session}
    />,
    target,
  )
}

function ProductionProfileLayer({ session }) {
  const [target, setTarget] = useState(null)

  useEffect(() => {
    let mountedTarget = null
    const attach = () => {
      const nextTarget = document.querySelector('.content-frame')
      if (!(nextTarget instanceof HTMLElement)) return false
      if (mountedTarget && mountedTarget !== nextTarget) mountedTarget.classList.remove('production-profile-mounted')
      mountedTarget = nextTarget
      mountedTarget.classList.add('production-profile-mounted')
      setTarget(nextTarget)
      return true
    }
    if (attach()) return () => mountedTarget?.classList.remove('production-profile-mounted')
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mountedTarget?.classList.remove('production-profile-mounted')
    }
  }, [])

  if (!target) return null
  return createPortal(<ProductionProfileWorkspace session={session} />, target)
}

export function ProductionWorkspaceBootstrap() {
  const surface = useMemo(() => resolveTenantSurface(), [])
  const cachedOnboarding = useMemo(() => readOnboardingSnapshot(surface.tenantSlug), [surface.tenantSlug])
  const [serverSession, setServerSession] = useState(() => cachedOnboarding)
  const [tenantState, setTenantState] = useState(() => cachedOnboarding ? {
    managed: true,
    slug: cachedOnboarding.tenant.slug,
    companyName: cachedOnboarding.tenant.companyName,
    status: 'active',
  } : null)
  const [loading, setLoading] = useState(() => !cachedOnboarding)
  const [bootstrapError, setBootstrapError] = useState('')
  const [environmentLoginHandled,setEnvironmentLoginHandled]=useState(false)
  const [environmentAccessError,setEnvironmentAccessError]=useState('')
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const [bootstrapDelayed, setBootstrapDelayed] = useState(false)
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname)
  const onboardingRoute = currentPath === '/onboarding' || currentPath.startsWith('/onboarding/')

  useEffect(() => {
    if (!loading) return undefined
    const watchdog = window.setTimeout(() => {
      setBootstrapError('Hi5Central could not finish restoring the secure session.')
      setBootstrapDelayed(true)
      setTenantState((current) => current || {
        managed: true,
        slug: surface.tenantSlug,
        companyName: surface.tenantName,
        status: 'active',
        unavailable: true,
      })
      setLoading(false)
    }, 10000)
    return () => window.clearTimeout(watchdog)
  }, [bootstrapAttempt, loading, surface.tenantName, surface.tenantSlug]) // Workspace bootstrap watchdog

  useEffect(() => {
    const notify = () => setCurrentPath(window.location.pathname)
    const originalPushState = window.history.pushState
    const originalReplaceState = window.history.replaceState

    window.history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args)
      notify()
      return result
    }
    window.history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args)
      notify()
      return result
    }

    window.addEventListener('popstate', notify)
    window.addEventListener('hi5-routechange', notify)

    return () => {
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      window.removeEventListener('popstate', notify)
      window.removeEventListener('hi5-routechange', notify)
    }
  }, [])

  useEffect(() => {
    let active = true
    const delayedTimer = window.setTimeout(() => {
      if (active) setBootstrapDelayed(true)
    }, 5000)

    function acceptBootstrapPayload(payload) {
      if (!active || payload?.tenant?.slug !== surface.tenantSlug) return false

      applyTenantPreferences(payload)
      if (payload.onboarding?.completedAt) {
        clearOnboardingSnapshot()
        saveProductionSession(toWorkspaceSession(payload))
        void hydrateWorkspaceData()
      } else {
        saveOnboardingSnapshot(payload)
      }
      setServerSession(payload)
      setTenantState({
        managed: true,
        slug: payload.tenant.slug,
        companyName: payload.tenant.companyName,
        status: 'active',
      })
      return true
    }

    async function bootstrap() {
      const ticket = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('hi5_environment_ticket')
      const directSso = new URLSearchParams(window.location.search).get('environment_sso') === '1'
      const environmentHost=/^(.+)-(test|uat)$/.exec(surface.tenantSlug)
      const centralLoginUrl = environmentHost
        ? `https://${environmentHost[1]}.${deploymentConfig().rootDomain}/login?environment=${environmentHost[2]}`
        : ''
      // Each environment owns its login screen. UAT/Test authenticate the
      // supplied credentials and MFA with Production *server-to-server*.
      // Never route an unauthenticated browser through the Live login page.
      if(!ticket && !directSso && environmentHost
          && (window.location.pathname === '/login'
            || !hasMatchingEnvironmentSession(surface.tenantSlug))){
        clearOnboardingSnapshot()
        clearProductionSession()
        setServerSession(null)
        setTenantState({
          managed:true,
          slug:surface.tenantSlug,
          companyName:surface.tenantName,
          status:'active',
        })
        setBootstrapError('')
        setBootstrapDelayed(false)
        setLoading(false)
        return
      }
      if (ticket) {
        // Fragment is never sent in HTTP requests or referrers. Exchange it
        // once with the corresponding Test/UAT API, then restore normally.
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
        try {
          const {response,payload}=await fetchJsonWithTimeout(`${API_BASE}/api/v1/auth/environment-handoff`,{
            method:'POST',
            credentials:'include',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ticket}),
          })
          if (!response.ok) throw new Error(payload?.error || 'Environment login link could not be used.')
        } catch(error) {
          if(active){
            setBootstrapError(error?.message || 'Please reopen this environment from your Live workspace.')
            setTenantState({
              managed:true,slug:surface.tenantSlug,companyName:surface.tenantName,
              status:'active',unavailable:true,
            })
            setLoading(false)
          }
          return
        }
      }
      setLoading(!cachedOnboarding)
      setBootstrapError('')
      setBootstrapDelayed(false)

      try {
        const freshLogin = window.location.pathname === '/login'
          && new URLSearchParams(window.location.search).get('fresh') === '1'

        if (!freshLogin) {
          const handoff = takeProductionAuthHandoff()
          if (handoff && acceptBootstrapPayload(handoff)) return
        }

        if (freshLogin) {
          clearOnboardingSnapshot()
          clearProductionSession()
          const { response: stateResponse, payload: statePayload } = await fetchJsonWithTimeout(
            `${API_BASE}/api/v1/auth/tenant-state/${encodeURIComponent(surface.tenantSlug)}`,
            { cache: 'no-store' },
          )
          if (!stateResponse.ok) throw new Error(statePayload?.error || 'TENANT_STATE_FAILED')
          if (active) setTenantState(statePayload)
          return
        }

        const sessionEndpoint = onboardingRoute
          ? `${API_BASE}/api/v1/onboarding/session`
          : `${API_BASE}/api/v1/auth/session`
        const { response, payload } = await fetchJsonWithTimeout(sessionEndpoint, {
          credentials: 'include',
          cache: 'no-store',
        }, environmentHost ? SANDBOX_SESSION_RESTORE_TIMEOUT_MS : SESSION_BOOTSTRAP_TIMEOUT_MS)

        if (response.ok && acceptBootstrapPayload(payload)) {
          if (directSso) {
            window.history.replaceState(null, '',window.location.pathname)
          }
          return
        }
        if(directSso && environmentHost){
          throw new Error('Safari did not establish the environment session. Reopen it from your Live workspace.')
        }

        if (ticket && environmentHost){
          // A completed one-time exchange must establish a real sandbox
          // session. Never silently loop back through central login when the
          // browser did not retain the environment cookie.
          throw new Error('The environment sign-in did not establish a session. Please reopen UAT/Test from your Live workspace.')
        }

        if (cachedOnboarding && (response.status === 401 || response.status === 403)) {
          clearOnboardingSnapshot()
          setServerSession(null)
        }

        clearProductionSession()

        const { response: stateResponse, payload: statePayload } = await fetchJsonWithTimeout(
          `${API_BASE}/api/v1/auth/tenant-state/${encodeURIComponent(surface.tenantSlug)}`,
          { cache: 'no-store' },
        )

        if (!stateResponse.ok) throw new Error(statePayload?.error || 'TENANT_STATE_FAILED')

        if (statePayload?.setupRequired) {
          window.location.replace('/signup')
          return
        }


        if (active) setTenantState(statePayload)
      } catch (error) {
        console.error('Production session bootstrap failed.', error)

        if (environmentHost && !ticket && !directSso){
          // Session loss must always recover to the *same environment's*
          // login page; never redirect to Live or lock the screen.
          clearOnboardingSnapshot()
          clearProductionSession()
          setServerSession(null)
          setTenantState({managed:true,slug:surface.tenantSlug,
            companyName:surface.tenantName,status:'active'})
          setBootstrapError('')
          return
        }

        if (!cachedOnboarding) {
          clearProductionSession()
        }

        if (active) {
          setBootstrapError(
            error?.message === 'REQUEST_TIMEOUT'
              ? 'Hi5Central could not restore the session within the allowed time.'
              : (directSso || error?.message?.includes('environment sign-in')
                ? error.message
                : 'Hi5Central could not restore this session.'),
          )

          if (!cachedOnboarding) {
            setTenantState({
              managed: true,
              slug: surface.tenantSlug,
              companyName: surface.tenantName,
              status: 'active',
              unavailable: true,
            })
          }
        }
      } finally {
        window.clearTimeout(delayedTimer)
        if (active) {
          setLoading(false)
          setBootstrapDelayed(false)
        }
      }
    }

    bootstrap()
    return () => {
      active = false
      window.clearTimeout(delayedTimer)
    }
  }, [bootstrapAttempt, cachedOnboarding, onboardingRoute, surface.tenantName, surface.tenantSlug])

  useEffect(()=>{
    if (!serverSession?.onboarding?.completedAt||environmentLoginHandled)return
    const env=new URLSearchParams(window.location.search).get('environment')
    if(!['test','uat'].includes(env))return
    if(/-(test|uat)$/.test(surface.tenantSlug))return
    setEnvironmentLoginHandled(true)
    fetch(`${API_BASE}/api/v1/auth/environment-access`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({environment:env}),
    }).then(async response=>{
      const payload=await response.json().catch(()=>({}))
      if(!response.ok)throw Error(payload.error||'You have not been granted access to this environment.')
      if(!payload.url)throw Error('The environment login could not be started.')
      window.location.replace(payload.url)
    }).catch(error=>{
      setEnvironmentAccessError(error.message)
      window.history.replaceState({},'', '/dashboard')
    })
  },[serverSession?.onboarding?.completedAt,environmentLoginHandled,surface.tenantSlug])

  useEffect(() => {
    if (!serverSession) return

    applyTenantPreferences(serverSession)

    if (serverSession.onboarding?.completedAt) {
      saveProductionSession(toWorkspaceSession(serverSession))
      if (window.location.pathname === '/onboarding') {
        window.location.replace('/dashboard')
        return
      }
      return
    }

    if (window.location.pathname !== '/onboarding') {
      window.history.replaceState({}, '', '/onboarding')
    }
  }, [serverSession])

  useEffect(() => {
    if (!serverSession?.onboarding?.completedAt) return
    const oldPersonalSettings = currentPath === '/settings/profile' || currentPath === '/settings/workspace'
    const deniedTenantSettings = currentPath.startsWith('/settings') && !sessionHasPermission(serverSession, 'settings.view')
    if (!oldPersonalSettings && !deniedTenantSettings) return
    if (window.location.pathname === '/profile') return
    window.history.replaceState({}, '', '/profile')
    setCurrentPath('/profile')
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.dispatchEvent(new CustomEvent('hi5-routechange', { detail: { path: '/profile', replace: true } }))
  }, [currentPath, serverSession])

  useEffect(() => {
    if (!serverSession?.onboarding?.completedAt) return undefined

    let closing = false
    const timer = window.setInterval(async () => {
      if (closing) return
      const localProductionSession = window.localStorage.getItem(PRODUCTION_SESSION_KEY)
      if (localProductionSession) return

      closing = true
      try {
        await fetch(`${API_BASE}/api/v1/auth/logout`, {
          method: 'POST',
          credentials: 'include',
        })
      } catch {
        // The local session is already gone; continue to the production login screen.
      }

      clearProductionSession()
      setTenantState((current) => ({
        managed: true,
        slug: current?.slug || surface.tenantSlug,
        companyName: current?.companyName || serverSession.tenant?.companyName || surface.tenantName,
        status: 'active',
      }))
      setServerSession(null)
      if (window.location.pathname !== '/login') {
        window.history.replaceState({}, '', '/login')
      }
    }, 300)

    return () => window.clearInterval(timer)
  }, [serverSession, surface.tenantName, surface.tenantSlug])

  async function acceptSession(nextSession) {
    const onboardingJustCompleted = Boolean(
      nextSession.onboarding?.completedAt
        && serverSession
        && !serverSession.onboarding?.completedAt,
    )

    if (onboardingJustCompleted) {
      try {
        window.sessionStorage.setItem(FIRST_LOGIN_HANDOFF_KEY, JSON.stringify({
          tenantSlug: nextSession.tenant?.slug || '',
          userId: nextSession.user?.id || '',
          createdAt: Date.now(),
        }))
      } catch {
        // The server preference state remains authoritative if session storage is unavailable.
      }
    }

    applyTenantPreferences(nextSession)
    if (nextSession.onboarding?.completedAt) {
      clearOnboardingSnapshot()
      saveProductionSession(toWorkspaceSession(nextSession))
      void hydrateWorkspaceData()
    } else {
      saveOnboardingSnapshot(nextSession)
    }
    setServerSession(nextSession)
    setTenantState({
      managed: true,
      slug: nextSession.tenant.slug,
      companyName: nextSession.tenant.companyName,
      status: 'active',
    })
  }

  function acceptUserExperience(nextExperience) {
    setServerSession((current) => {
      if (!current) return current
      return {
        ...current,
        preferences: nextExperience?.preferences || current.preferences || null,
        userExperience: {
          ...(current.userExperience || {}),
          firstLoginCompletedAt: nextExperience?.firstLoginCompletedAt || new Date().toISOString(),
          platformGuidance: nextExperience?.platformGuidance || current.userExperience?.platformGuidance || {},
          platformCoachmarksCompletedAt: nextExperience?.platformCoachmarksCompletedAt || null,
          platformGettingStartedDismissedAt: nextExperience?.platformGettingStartedDismissedAt || null,
        },
      }
    })
  }

  if (loading) {
    return (
      <LoadingScreen
        delayed={bootstrapDelayed}
        tenantName={surface.tenantName}
        onRetry={() => setBootstrapAttempt((current) => current + 1)}
      />
    )
  }

  if (serverSession && !serverSession.onboarding?.completedAt) {
    return <OnboardingWizard session={serverSession} onSessionChange={acceptSession} />
  }

  if (
    serverSession?.onboarding?.completedAt
      && (
        !serverSession.userExperience?.firstLoginCompletedAt
        || firstLoginHandoffRequired(serverSession)
      )
  ) {
    return (
      <ProductionFirstLoginExperience
        blocking
        bootstrapSession={serverSession}
        onExperienceChange={acceptUserExperience}
      />
    )
  }

  if (serverSession?.onboarding?.completedAt) {
    const canViewSettings = sessionHasPermission(serverSession, 'settings.view')
    const settingsOpen = canViewSettings && (currentPath === '/settings' || currentPath.startsWith('/settings/'))
    const profileOpen = currentPath === '/profile'
    const themeKey = effectiveSettings(serverSession)?.theme || {}
    const preferenceKey = serverSession?.preferences || {}
    const appearanceKey = preferenceKey.appearance || {}
    const navigationKey = preferenceKey.navigation || {}
    const workspaceKey = [
      appearanceKey.theme || themeKey.mode || 'system',
      appearanceKey.accentMode === 'personal' ? normaliseAccent(appearanceKey.accent) : normaliseAccent(themeKey.accent),
      appearanceKey.density || 'comfortable',
      navigationKey.sidebarMode || 'expanded',
      themeKey.brandName || serverSession?.tenant?.companyName || '',
      themeKey.portalTitle || 'IT Help Centre',
    ].join(':')

    return (
      <>
        <WorkspaceRuntime key={workspaceKey} />
        {environmentAccessError ? (
          <div role="alert" className="production-auth-environment-error">
            {environmentAccessError} Ask your organisation administrator to enable UAT/Test in People.
          </div>
        ) : null}
        <ProductionIdentityBridge session={serverSession} />
        {settingsOpen ? (
          <ProductionSettingsLayer
            key={workspaceKey}
            currentPath={currentPath}
            onSessionChange={acceptSession}
            session={serverSession}
          />
        ) : null}
        {profileOpen ? <ProductionProfileLayer session={serverSession} /> : null}
        <ProductionFirstLoginExperience
          bootstrapSession={serverSession}
          onExperienceChange={acceptUserExperience}
        />
      </>
    )
  }

  if (tenantState?.managed && tenantState?.unavailable) {
    return (
      <div className="production-auth-shell">
        <div className="production-auth-card production-auth-loading">
          <img src="/hi5central-logo.png" alt="" />
          <strong>We could not restore {surface.tenantName}</strong>
          <span>{bootstrapError || 'The secure session could not be restored.'}</span>
          <div className="production-auth-loading-actions">
            <button type="button" onClick={() => setBootstrapAttempt((current) => current + 1)}>Retry session</button>
            <button type="button" onClick={() => {
              clearOnboardingSnapshot()
              clearProductionSession()
              window.location.replace('/login?fresh=1')
            }}>Sign in again</button>
          </div>
        </div>
      </div>
    )
  }

  if (tenantState?.managed) {
    return <ProductionLogin tenant={tenantState} onAuthenticated={acceptSession} />
  }

  return (
    <div className="production-auth-shell">
      <div className="production-auth-card production-auth-loading">
        <img src="/hi5central-logo.png" alt="" />
        <strong>Tenant unavailable</strong>
        <span>This tenant could not be loaded from the Hi5Central service.</span>
      </div>
    </div>
  )
}