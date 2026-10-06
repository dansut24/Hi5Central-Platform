import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, CheckCircle2, Cloud, LockKeyhole, ShieldCheck } from 'lucide-react'
import WorkspaceRuntime from '../runtime/WorkspaceRuntime.jsx'
import { OnboardingWizard } from '../features/onboarding/OnboardingWizard.jsx'
import { ProductionSettingsWorkspace } from '../features/settings/ProductionSettingsWorkspace.jsx'
import { ProductionIdentityBridge } from './ProductionIdentityBridge.jsx'
import { ProductionProfileWorkspace } from './ProductionProfileWorkspace.jsx'
import { resolveTenantSurface } from '../lib/tenantSurface.js'
import {
  clearProductionSession,
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
const ORGANISATION_CACHE_KEYS = {
  people: 'hi5central-organisation-people-v1',
  teams: 'hi5central-organisation-teams-v1',
  departments: 'hi5central-organisation-departments-v1',
  sites: 'hi5central-organisation-sites-v1',
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
    && ['amber', 'cyan', 'blue', 'violet', 'emerald', 'rose'].includes(appearance.accent)
      ? appearance.accent
      : theme.accent

  if (['system', 'light', 'dark'].includes(resolvedTheme)) saveTheme(resolvedTheme)
  if (['amber', 'cyan', 'blue', 'violet', 'emerald', 'rose'].includes(resolvedAccent)) saveAccent(resolvedAccent)
  if (['comfortable', 'compact'].includes(appearance.density)) saveDensity(appearance.density)
  if (['expanded', 'collapsed', 'hidden'].includes(navigation.sidebarMode)) saveSidebarMode(navigation.sidebarMode)

  try {
    window.localStorage.setItem(TENANT_RUNTIME_CONFIG_KEY, JSON.stringify({
      tenantSlug: apiSession?.tenant?.slug || '',
      theme: {
        mode: theme.mode || 'system',
        accent: theme.accent || 'amber',
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

function LoadingScreen({ tenantName, delayed, onRetry }) {
  return (
    <div className="production-auth-shell">
      <div className="production-auth-card production-auth-loading">
        <img src="/hi5central-logo.png" alt="" />
        <strong>Opening {tenantName}</strong>
        <span>{delayed ? 'Session restore is taking longer than expected.' : 'Checking your secure Hi5Central session…'}</span>
        <div className="production-auth-loading-actions">
          <button type="button" onClick={onRetry}>Retry session</button>
          <button type="button" onClick={() => window.location.replace('/login')}>Sign in again</button>
        </div>
      </div>
    </div>
  )
}

function ProductionLogin({ tenant, onAuthenticated }) {
  const [form, setForm] = useState({ email: '', password: '' })
  const [passwordStep, setPasswordStep] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [authMethod, setAuthMethod] = useState('')
  const [microsoftAvailable, setMicrosoftAvailable] = useState(false)

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
      const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantSlug: tenant.slug, email, password: form.password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Sign in failed.')
      await onAuthenticated(payload)
    } catch (loginError) {
      setError(loginError.message)
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

        <form className="production-auth-card" onSubmit={submit}>
          <div className="production-auth-card-heading">
            <span className="production-auth-icon"><LockKeyhole size={19} /></span>
            <div><span>Hi5Central ITSM</span><strong>{tenant.slug}.hi5central.com</strong></div>
          </div>

          {tenant.status === 'pending_verification' ? (
            <div className="production-auth-notice">This workspace is waiting for its owner email to be verified. Use the verification email sent during signup before signing in.</div>
          ) : null}

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
          {passwordStep ? <button className="production-auth-secondary-action" type="button" onClick={() => { setPasswordStep(false); setForm((current) => ({ ...current, password: '' })); setError('') }}>Use a different email</button> : null}
          {microsoftAvailable ? <>
            <div className="production-auth-divider"><span>or</span></div>
            <button className="production-auth-microsoft" type="button" onClick={() => { const params = new URLSearchParams({ tenantSlug: tenant.slug, returnTo: window.location.pathname || '/' }); window.location.href = `${API_BASE}/api/v1/auth/microsoft/start?${params.toString()}` }}><Cloud size={17} /> Sign in with Microsoft</button>
          </> : null}
          <a href="https://hi5central.com">Back to hi5central.com</a>
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
  const [serverSession, setServerSession] = useState(null)
  const [tenantState, setTenantState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState('')
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
        saveProductionSession(toWorkspaceSession(payload))
        void hydrateWorkspaceData()
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
      setLoading(true)
      setBootstrapError('')
      setBootstrapDelayed(false)

      try {
        const handoff = takeProductionAuthHandoff()
        if (handoff && acceptBootstrapPayload(handoff)) return

        const sessionEndpoint = onboardingRoute
          ? `${API_BASE}/api/v1/onboarding/session`
          : `${API_BASE}/api/v1/auth/session`
        const { response, payload } = await fetchJsonWithTimeout(sessionEndpoint, {
          credentials: 'include',
          cache: 'no-store',
        })

        if (response.ok && acceptBootstrapPayload(payload)) return

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
        clearProductionSession()

        if (active) {
          setBootstrapError(
            error?.message === 'REQUEST_TIMEOUT'
              ? 'Hi5Central could not restore the session within 8 seconds.'
              : 'Hi5Central could not restore this session.',
          )
          setTenantState({
            managed: true,
            slug: surface.tenantSlug,
            companyName: surface.tenantName,
            status: 'active',
            unavailable: true,
          })
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
  }, [bootstrapAttempt, onboardingRoute, surface.tenantName, surface.tenantSlug])

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
    applyTenantPreferences(nextSession)
    if (nextSession.onboarding?.completedAt) {
      saveProductionSession(toWorkspaceSession(nextSession))
      void hydrateWorkspaceData()
    }
    setServerSession(nextSession)
    setTenantState({
      managed: true,
      slug: nextSession.tenant.slug,
      companyName: nextSession.tenant.companyName,
      status: 'active',
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
      appearanceKey.accentMode === 'personal' ? (appearanceKey.accent || 'amber') : (themeKey.accent || 'amber'),
      appearanceKey.density || 'comfortable',
      navigationKey.sidebarMode || 'expanded',
      themeKey.brandName || serverSession?.tenant?.companyName || '',
      themeKey.portalTitle || 'IT Help Centre',
    ].join(':')

    return (
      <>
        <WorkspaceRuntime key={workspaceKey} />
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
            <button type="button" onClick={() => window.location.replace('/login')}>Sign in again</button>
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