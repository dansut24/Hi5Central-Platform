import { useEffect, useMemo, useState } from 'react'
import {
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  Check,
  Mail,
  MapPin,
  Palette,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
} from 'lucide-react'
import { ProductionProfileSecurity } from './ProductionProfileSecurity.jsx'
import './ProductionProfileWorkspace.css'

const API_BASE = window.__HI5_API_BASE__
const ACCENTS = ['amber', 'cyan', 'blue', 'violet', 'emerald', 'rose']
const ACCENT_HEX = {
  amber: '#d98a0a',
  cyan: '#089fc5',
  blue: '#3b82f6',
  violet: '#7858df',
  emerald: '#188c61',
  rose: '#d84e73',
}

function accentHex(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  return ACCENT_HEX[raw] || '#3b82f6'
}
const DESKTOP_SIDE_KEY = 'hi5central-primary-nav-side-v1'
const MOBILE_SIDE_KEY = 'hi5central-mobile-nav-side-v1'

function initials(name = '') {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'HC'
}

function roleLabel(role = '') {
  const value = String(role || '').trim()
  if (!value) return 'Workspace user'
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function defaultPreferences(session) {
  const tenantTheme = session?.settings?.theme || session?.onboarding?.data?.theme || {}
  return {
    appearance: {
      theme: ['system', 'light', 'dark'].includes(tenantTheme.mode) ? tenantTheme.mode : 'system',
      accentMode: 'tenant',
      accent: tenantTheme.accent || 'blue',
      density: 'comfortable',
    },
    navigation: {
      desktopSide: 'left',
      mobileSide: 'left',
      sidebarStyle: 'floating',
      sidebarMode: 'expanded',
    },
    guidance: { coachMarks: true },
  }
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="production-profile-detail">
      <span className="production-profile-detail-icon"><Icon size={17} /></span>
      <span><small>{label}</small><strong>{value || 'Not set'}</strong></span>
    </div>
  )
}

function Section({ title, description, children }) {
  return (
    <section className="production-profile-panel">
      <header>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      <div className="production-profile-panel-body">{children}</div>
    </section>
  )
}

export function ProductionProfileWorkspace({ session }) {
  const fallbackPreferences = useMemo(() => defaultPreferences(session), [session])
  const [profile, setProfile] = useState(null)
  const [preferences, setPreferences] = useState(fallbackPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [section, setSection] = useState(() => new URLSearchParams(window.location.search).get('section') === 'workspace' ? 'workspace' : 'profile')

  useEffect(() => {
    const syncSection = () => setSection(new URLSearchParams(window.location.search).get('section') === 'workspace' ? 'workspace' : 'profile')
    window.addEventListener('popstate', syncSection)
    return () => window.removeEventListener('popstate', syncSection)
  }, [])

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      try {
        const [profileResponse, preferenceResponse] = await Promise.all([
          fetch(`${API_BASE}/api/v1/profile`, { credentials: 'include' }),
          fetch(`${API_BASE}/api/v1/user-preferences`, { credentials: 'include' }),
        ])
        const profilePayload = await profileResponse.json().catch(() => ({}))
        const preferencePayload = await preferenceResponse.json().catch(() => ({}))
        if (!profileResponse.ok) throw new Error(profilePayload.error || 'Could not load your profile.')
        if (!preferenceResponse.ok) throw new Error(preferencePayload.error || 'Could not load your preferences.')
        if (!active) return
        setProfile(profilePayload)
        setPreferences(preferencePayload.preferences || fallbackPreferences)
      } catch (loadError) {
        if (active) setError(loadError.message)
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => { active = false }
  }, [fallbackPreferences])

  function updatePreference(group, field, value) {
    setPreferences((current) => ({
      ...current,
      [group]: { ...(current[group] || {}), [field]: value },
    }))
    setSaved('')
  }

  async function savePreferences() {
    setSaving(true)
    setError('')
    setSaved('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/user-preferences`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Could not save your preferences.')
      const next = payload.preferences || preferences
      setPreferences(next)

      const tenantAccent = session?.settings?.theme?.accent || session?.onboarding?.data?.theme?.accent || 'amber'
      const selectedAccent = next.appearance?.accentMode === 'personal'
        ? next.appearance?.accent
        : tenantAccent

      window.localStorage.setItem('hi5central-theme-mode', JSON.stringify(next.appearance?.theme || 'system'))
      window.localStorage.setItem('hi5central-accent', JSON.stringify(/^#[0-9a-f]{6}$/i.test(String(selectedAccent || '')) || ACCENTS.includes(selectedAccent) ? selectedAccent : 'blue'))
      window.localStorage.setItem('hi5central-density', JSON.stringify(next.appearance?.density || 'comfortable'))
      window.localStorage.setItem('hi5central-sidebar-mode', JSON.stringify(next.navigation?.sidebarMode || 'expanded'))
      window.localStorage.setItem(DESKTOP_SIDE_KEY, JSON.stringify(next.navigation?.desktopSide || 'left'))
      window.localStorage.setItem(MOBILE_SIDE_KEY, JSON.stringify(next.navigation?.mobileSide || 'left'))
      setSaved('Saved')
      window.setTimeout(() => window.location.reload(), 260)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  const identity = profile?.user || session?.user || {}
  const person = profile?.person || null
  const accessRoles = profile?.access?.roles || session?.access?.roles || []
  const tenant = profile?.tenant || session?.tenant || {}
  const mfaVerified = Boolean(profile?.security?.mfaVerified ?? session?.security?.mfaVerified)

  function selectSection(nextSection) {
    const next = nextSection === 'workspace' ? 'workspace' : 'profile'
    setSection(next)
    const url = new URL(window.location.href)
    if (next === 'workspace') url.searchParams.set('section', 'workspace')
    else url.searchParams.delete('section')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }

  return (
    <div className="production-profile-shell">
      <div className="production-profile-scroll">
        <div className="production-profile-content">
          <header className="production-profile-heading">
            <div>
              <span>Personal account</span>
              <h1>{section === 'workspace' ? 'Workspace' : 'My Profile'}</h1>
              <p>{section === 'workspace'
                ? 'Personal appearance and navigation settings that follow your account across Hi5Central.'
                : 'Your shared Hi5Central identity, organisation details and personal security.'}</p>
            </div>
          </header>

          <nav className="production-profile-section-tabs" aria-label="Profile sections">
            <button className={section === 'profile' ? 'is-active' : ''} onClick={() => selectSection('profile')} type="button">
              <UserRound size={15} /> My Profile
            </button>
            <button className={section === 'workspace' ? 'is-active' : ''} onClick={() => selectSection('workspace')} type="button">
              <SlidersHorizontal size={15} /> Workspace
            </button>
          </nav>

          {loading ? <div className="production-profile-state">Loading your profile…</div> : null}
          {error ? <div className="production-profile-error">{error}</div> : null}

          {!loading && section === 'profile' ? (
            <>
              <section className="production-profile-identity">
                <span className="production-profile-avatar">{initials(identity.name)}</span>
                <div className="production-profile-identity-copy">
                  <span>Signed in as</span>
                  <h2>{identity.name || 'Hi5Central user'}</h2>
                  <p>{identity.email || ''}</p>
                  <div className="production-profile-chips">
                    <span><BadgeCheck size={14} /> {roleLabel(identity.tenantRole)}</span>
                    <span><Building2 size={14} /> {tenant.companyName || tenant.slug || 'Tenant'}</span>
                    {mfaVerified ? <span><ShieldCheck size={14} /> MFA verified</span> : null}
                  </div>
                </div>
              </section>

              <Section title="Account & organisation" description="Identity information comes from your Hi5Central account and organisation directory.">
                <div className="production-profile-detail-grid">
                  <Detail icon={UserRound} label="Name" value={person?.name || identity.name} />
                  <Detail icon={Mail} label="Email" value={person?.email || identity.email} />
                  <Detail icon={BriefcaseBusiness} label="Job title" value={person?.jobTitle} />
                  <Detail icon={Users} label="Primary team" value={person?.primaryTeam} />
                  <Detail icon={Building2} label="Department" value={person?.department} />
                  <Detail icon={MapPin} label="Site / location" value={[person?.site, person?.city].filter(Boolean).join(' · ')} />
                  <Detail icon={UserRound} label="Manager" value={person?.managerName} />
                  <Detail icon={ShieldCheck} label="Access profile" value={roleLabel(person?.accessProfile || identity.tenantRole)} />
                </div>

                <div className="production-profile-role-block">
                  <span>Assigned access roles</span>
                  <div>
                    {accessRoles.length
                      ? accessRoles.map((role) => <span key={role.id || role.key || role.name}>{role.name || roleLabel(role.key)}</span>)
                      : <span>{roleLabel(identity.tenantRole)}</span>}
                  </div>
                </div>
              </Section>

              <ProductionProfileSecurity />
            </>
          ) : null}

          {!loading && section === 'workspace' ? (
            <>
              <Section title="Appearance" description="These preferences follow your account across ITSM, RMM and Platform Admin.">
                <div className="production-profile-form-grid">
                  <label>
                    <span><Palette size={15} /> Theme</span>
                    <select value={preferences.appearance?.theme || 'system'} onChange={(event) => updatePreference('appearance', 'theme', event.target.value)}>
                      <option value="system">Follow device</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>

                  <label>
                    <span><Palette size={15} /> Accent source</span>
                    <select value={preferences.appearance?.accentMode || 'tenant'} onChange={(event) => updatePreference('appearance', 'accentMode', event.target.value)}>
                      <option value="tenant">Use tenant accent</option>
                      <option value="personal">Use my accent</option>
                    </select>
                  </label>

                  <label>
                    <span><Palette size={15} /> Personal accent</span>
                    <input
                      aria-label="Personal accent colour"
                      disabled={preferences.appearance?.accentMode !== 'personal'}
                      type="color"
                      value={accentHex(preferences.appearance?.accent)}
                      onChange={(event) => updatePreference('appearance', 'accent', event.target.value.toLowerCase())}
                    />
                  </label>

                  <label>
                    <span><SlidersHorizontal size={15} /> Density</span>
                    <select value={preferences.appearance?.density || 'comfortable'} onChange={(event) => updatePreference('appearance', 'density', event.target.value)}>
                      <option value="comfortable">Comfortable</option>
                      <option value="compact">Compact</option>
                    </select>
                  </label>
                </div>
              </Section>

              <Section title="Navigation" description="Choose how the shared Hi5Central workspace shell behaves for your account.">
                <div className="production-profile-form-grid">
                  <label>
                    <span><SlidersHorizontal size={15} /> Desktop sidebar position</span>
                    <select value={preferences.navigation?.desktopSide || 'left'} onChange={(event) => updatePreference('navigation', 'desktopSide', event.target.value)}>
                      <option value="left">Left</option>
                      <option value="right">Right</option>
                    </select>
                  </label>

                  <label>
                    <span><SlidersHorizontal size={15} /> Sidebar mode</span>
                    <select value={preferences.navigation?.sidebarMode || 'expanded'} onChange={(event) => updatePreference('navigation', 'sidebarMode', event.target.value)}>
                      <option value="expanded">Expanded</option>
                      <option value="collapsed">Collapsed</option>
                    </select>
                  </label>

                  <label>
                    <span><SlidersHorizontal size={15} /> Guided walkthroughs</span>
                    <select value={preferences.guidance?.coachMarks === false ? 'off' : 'on'} onChange={(event) => updatePreference('guidance', 'coachMarks', event.target.value === 'on')}>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                </div>

                <div className="production-profile-save-row">
                  <span>{saved ? <><Check size={15} /> {saved}</> : null}</span>
                  <button disabled={saving} onClick={savePreferences} type="button">
                    <Save size={16} /> {saving ? 'Saving…' : 'Save workspace preferences'}
                  </button>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
