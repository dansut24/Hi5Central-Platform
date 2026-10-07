import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, ChevronRight, Monitor, Moon, Palette, PanelLeft, PanelRight, Sparkles, Sun, WandSparkles } from 'lucide-react'
import './ProductionUserExperience.css'

const API_BASE = window.__HI5_API_BASE__

const ACCENTS = [
  ['Hi5Central blue', '#3d73e8'],
  ['Cyan', '#089fc5'],
  ['Amber', '#d98a0a'],
  ['Emerald', '#188c61'],
  ['Violet', '#7858df'],
  ['Rose', '#d84e73'],
]

function accentHex(value) {
  const presets = {
    blue: '#3d73e8',
    cyan: '#089fc5',
    amber: '#d98a0a',
    emerald: '#188c61',
    violet: '#7858df',
    rose: '#d84e73',
  }
  const raw = String(value || '').trim().toLowerCase()
  if (presets[raw]) return presets[raw]
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  return '#3d73e8'
}

function accentVars(value) {
  const hex = accentHex(value)
  const clean = hex.slice(1)
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return {
    '--personal-accent': hex,
    '--personal-accent-soft': `rgba(${r}, ${g}, ${b}, .12)`,
  }
}

const TOUR = [
  { id: 'navigation', title: 'RMM navigation', copy: 'Devices, patching, automation, reports and administration stay together in the RMM navigation.', selector: '.rmm-sidebar' },
  { id: 'search', title: 'Search the estate', copy: 'Use global search to find devices, users, sites, groups and alerts quickly.', selector: '.rmm-global-search' },
  { id: 'health', title: 'Estate health at a glance', copy: 'The dashboard surfaces managed devices, critical alerts, patch compliance and active jobs.', selector: '.rmm-metric-grid' },
  { id: 'switch', title: 'Move between Hi5Central products', copy: 'Use the product links to move between RMM, ITSM and Admin without changing your personal workspace settings.', selector: '.rmm-product-switches' },
]

function defaults() {
  return {
    appearance: { theme: 'light', accentMode: 'tenant', accent: '#3d73e8', density: 'comfortable' },
    navigation: { desktopSide: 'left', mobileSide: 'left', sidebarStyle: 'floating', sidebarMode: 'expanded' },
    guidance: { coachMarks: true },
  }
}

function merge(value) {
  const base = defaults()
  return {
    appearance: { ...base.appearance, ...(value?.appearance || {}) },
    navigation: { ...base.navigation, ...(value?.navigation || {}) },
    guidance: { ...base.guidance, ...(value?.guidance || {}) },
  }
}

async function readExperience() {
  const response = await fetch(`${API_BASE}/api/v1/user-preferences?surface=rmm`, { credentials: 'include', cache: 'no-store' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Could not load your workspace preferences.')
  return payload
}

async function saveExperience(preferences, markers = {}) {
  const response = await fetch(`${API_BASE}/api/v1/user-preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences, platform: 'rmm', ...markers }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Could not save your workspace preferences.')
  return payload
}

function Choice({ active, icon: Icon, title, copy, onClick }) {
  return <button className={`rmm-first-choice ${active ? 'is-active' : ''}`} onClick={onClick} type="button">
    {Icon ? <Icon size={17} /> : null}
    <span><strong>{title}</strong>{copy ? <small>{copy}</small> : null}</span>
    {active ? <Check size={15} /> : null}
  </button>
}

function Personalise({ payload, preferences, setPreferences, onComplete, saving, error }) {
  const [step, setStep] = useState(0)
  const appearance = preferences.appearance
  const navigation = preferences.navigation
  const setAppearance = (patch) => setPreferences({ ...preferences, appearance: { ...appearance, ...patch } })
  const setNavigation = (patch) => setPreferences({ ...preferences, navigation: { ...navigation, ...patch } })

  const previewAccent = appearance.accentMode === 'personal' ? appearance.accent : (payload?.tenant?.accent || '#3d73e8')

  return createPortal(<div className="rmm-first-layer" style={accentVars(previewAccent)}>
    <section className="rmm-first-card">
      <header><img src="/hi5central-logo.png" alt="" /><span>Hi5Central</span><b>{step + 1} / 3</b></header>
      <main>
        {step === 0 ? <div className="rmm-first-welcome">
          <span><Sparkles size={15} /> Your workspace is ready</span>
          <h1>Welcome to Hi5Central{payload.user?.name ? `, ${payload.user.name.split(' ')[0]}` : ''}.</h1>
          <p>Personalise Hi5Central once and these choices will follow you across every product you can access.</p>
        </div> : null}
        {step === 1 ? <div className="rmm-first-settings">
          <section><h2><Palette size={18} /> Appearance</h2>
            <div className="rmm-first-grid three">
              <Choice active={appearance.theme === 'system'} icon={Monitor} title="System" onClick={() => setAppearance({ theme: 'system' })} />
              <Choice active={appearance.theme === 'light'} icon={Sun} title="Light" onClick={() => setAppearance({ theme: 'light' })} />
              <Choice active={appearance.theme === 'dark'} icon={Moon} title="Dark" onClick={() => setAppearance({ theme: 'dark' })} />
            </div>
            <div className="rmm-first-grid two">
              <Choice active={appearance.accentMode === 'tenant'} title="Organisation accent" onClick={() => setAppearance({ accentMode: 'tenant' })} />
              <Choice active={appearance.accentMode === 'personal'} title="Personal accent" onClick={() => setAppearance({ accentMode: 'personal' })} />
            </div>
            {appearance.accentMode === 'personal' ? (
              <div className="rmm-first-colour">
                <div className="rmm-first-colour-picker">
                  <input aria-label="Choose personal accent colour" type="color" value={accentHex(appearance.accent)} onChange={(event) => setAppearance({ accent: event.target.value.toLowerCase() })} />
                  <input aria-label="Personal accent hex colour" maxLength="7" value={accentHex(appearance.accent)} onChange={(event) => {
                    const next = event.target.value.trim()
                    if (/^#[0-9a-fA-F]{0,6}$/.test(next)) setAppearance({ accent: next })
                  }} onBlur={(event) => {
                    if (!/^#[0-9a-fA-F]{6}$/.test(event.target.value)) setAppearance({ accent: '#3d73e8' })
                  }} />
                </div>
                <div className="rmm-first-accents">{ACCENTS.map(([label,colour])=><button aria-label={label} className={accentHex(appearance.accent) === colour ? 'is-active' : ''} key={colour} onClick={() => setAppearance({ accent: colour })} style={{ '--swatch': colour }} type="button"><i /></button>)}</div>
              </div>
            ) : null}
            <div className="rmm-first-grid two">
              <Choice active={appearance.density === 'comfortable'} title="Comfortable" onClick={() => setAppearance({ density: 'comfortable' })} />
              <Choice active={appearance.density === 'compact'} title="Compact" onClick={() => setAppearance({ density: 'compact' })} />
            </div>
          </section>
          <section><h2>Navigation</h2>
            <div className="rmm-first-grid two">
              <Choice active={navigation.desktopSide === 'left'} icon={PanelLeft} title="Sidebar left" onClick={() => setNavigation({ desktopSide: 'left' })} />
              <Choice active={navigation.desktopSide === 'right'} icon={PanelRight} title="Sidebar right" onClick={() => setNavigation({ desktopSide: 'right' })} />
            </div>
          </section>
        </div> : null}
        {step === 2 ? <div className="rmm-first-welcome">
          <span><WandSparkles size={15} /> Ready to go</span>
          <h1>Your preferences will follow you.</h1>
          <p>We’ll show a short walkthrough the first time you open each Hi5Central product. Each product remembers its own walkthrough state.</p>
          <label className="rmm-first-toggle"><input checked={preferences.guidance.coachMarks !== false} onChange={(e)=>setPreferences({ ...preferences, guidance:{ ...preferences.guidance, coachMarks:e.target.checked } })} type="checkbox"/><span>Show guided walkthroughs</span></label>
        </div> : null}
        {error ? <div className="rmm-first-error">{error}</div> : null}
      </main>
      <footer>
        <button className="quiet" disabled={saving} onClick={() => step ? setStep(step - 1) : onComplete(defaults())} type="button">{step ? 'Back' : 'Use defaults'}</button>
        {step < 2 ? <button className="primary" onClick={() => setStep(step + 1)} type="button">{step ? 'Continue' : 'Personalise workspace'}<ArrowRight size={15}/></button> : <button className="primary" disabled={saving} onClick={() => onComplete(preferences)} type="button">{saving ? 'Saving…' : 'Open RMM'}<ArrowRight size={15}/></button>}
      </footer>
    </section>
  </div>, document.body)
}

function Tour({ index, onNext, onSkip }) {
  const step = TOUR[index]
  const [ready, setReady] = useState(false)

  useEffect(() => {
    document.querySelectorAll('[data-hi5-tour-focus]').forEach((node) => node.removeAttribute('data-hi5-tour-focus'))
    if (!step) return undefined
    let target = null
    const find = () => {
      target = document.querySelector(step.selector)
      if (!(target instanceof HTMLElement)) return false
      target.setAttribute('data-hi5-tour-focus', 'true')
      setReady(true)
      return true
    }
    if (!find()) {
      const timer = window.setInterval(() => { if (find()) window.clearInterval(timer) }, 250)
      return () => window.clearInterval(timer)
    }
    return () => target?.removeAttribute('data-hi5-tour-focus')
  }, [step?.id])

  if (!step || !ready) return null
  return createPortal(<aside className="rmm-tour-card">
    <span>{index + 1} of {TOUR.length}</span><strong>{step.title}</strong><p>{step.copy}</p>
    <footer><button onClick={onSkip} type="button">Skip tour</button><button onClick={onNext} type="button">{index === TOUR.length - 1 ? 'Done' : 'Next'}<ChevronRight size={14}/></button></footer>
  </aside>, document.body)
}

export function ProductionUserExperience({ session, onPreferences }) {
  const [payload, setPayload] = useState(null)
  const [preferences, setPreferences] = useState(defaults)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tourIndex, setTourIndex] = useState(-1)

  useEffect(() => {
    if (!session?.onboarding?.completedAt) return
    let active = true
    readExperience().then((next) => {
      if (!active) return
      const merged = merge(next.preferences)
      setPayload(next)
      setPreferences(merged)
      onPreferences?.(merged)
    }).catch((err) => { if (active) setError(err.message) })
    return () => { active = false }
  }, [session?.onboarding?.completedAt])

  useEffect(() => {
    if (!payload?.firstLoginCompletedAt || payload.platformCoachmarksCompletedAt || payload.preferences?.guidance?.coachMarks === false) return
    const timer = window.setTimeout(() => setTourIndex(0), 800)
    return () => window.clearTimeout(timer)
  }, [payload?.firstLoginCompletedAt, payload?.platformCoachmarksCompletedAt, payload?.preferences?.guidance?.coachMarks])

  async function complete(nextPreferences) {
    setSaving(true); setError('')
    try {
      const next = await saveExperience(nextPreferences, { firstLoginComplete: true })
      const merged = merge(next.preferences)
      setPayload(next); setPreferences(merged); onPreferences?.(merged)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  async function finishTour() {
    setTourIndex(-1)
    try { setPayload(await saveExperience(preferences, { coachmarksComplete: true })) } catch { /* non-blocking */ }
  }

  const showPersonalise = Boolean(payload && payload.tenantOnboardingCompletedAt && !payload.firstLoginCompletedAt)

  return <>
    {showPersonalise ? <Personalise payload={payload} preferences={preferences} setPreferences={setPreferences} onComplete={complete} saving={saving} error={error} /> : null}
    {tourIndex >= 0 ? <Tour index={tourIndex} onSkip={finishTour} onNext={() => tourIndex >= TOUR.length - 1 ? finishTour() : setTourIndex((value)=>value+1)} /> : null}
  </>
}
