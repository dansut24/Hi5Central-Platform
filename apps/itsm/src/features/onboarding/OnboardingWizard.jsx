import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  LockKeyhole,
  Mail,
  MonitorCog,
  Palette,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'
import { OnboardingMfaEnhancer } from '../security/OnboardingMfaEnhancer.jsx'
import './OnboardingWizard.css'

const API_BASE = window.__HI5_API_BASE__
const DEPLOYMENT = deploymentConfig()
const SELF_HOSTED = DEPLOYMENT.deploymentMode === 'self_hosted'

const accentColours = {
  amber: '#f59e0b',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  emerald: '#10b981',
  violet: '#8b5cf6',
  rose: '#f43f5e',
}

const defaultPrefixes = {
  incident: 'INC-',
  serviceRequest: 'REQ-',
  problem: 'PRB-',
  change: 'CHG-',
}

const stepMeta = {
  company: { label: 'Company', icon: Building2, description: 'Organisation identity and regional defaults.' },
  theme: { label: 'Branding', icon: Palette, description: 'Set the default look and feel for your tenant.' },
  groups: { label: 'Teams & groups', icon: Users, description: 'Create the first organisational and assignment structure.' },
  permissions: { label: 'Permissions', icon: LockKeyhole, description: 'Choose a safe starting RBAC model.' },
  security: { label: 'Security', icon: ShieldCheck, description: 'Set tenant-wide authentication and session defaults.' },
  itsm: { label: 'ITSM setup', icon: Wrench, description: 'Configure records, service desk defaults, portal and notifications.' },
  rmm: { label: 'RMM setup', icon: MonitorCog, description: 'Set the first device-management defaults.' },
  finish: { label: 'Review', icon: Sparkles, description: 'Review the tenant before opening Hi5Central.' },
}

function sequenceFor(modules = {}) {
  return [
    'company',
    'theme',
    'groups',
    'permissions',
    'security',
    modules.itsm ? 'itsm' : null,
    modules.rmm ? 'rmm' : null,
    'finish',
  ].filter(Boolean)
}

function defaultData(step, session) {
  const saved = session?.onboarding?.data?.[step]
  if (saved && typeof saved === 'object') return saved

  const defaults = {
    company: {
      displayName: session?.tenant?.companyName || '',
      legalName: session?.tenant?.companyName || '',
      timezone: 'Europe/London',
      locale: 'en-GB',
      country: 'United Kingdom',
      industry: 'Technology',
      employeeBand: '51-250',
    },
    theme: {
      accent: 'amber',
      mode: 'system',
      brandName: session?.tenant?.companyName || '',
      portalTitle: 'IT Help Centre',
    },
    groups: {
      serviceDeskTeam: session?.tenant?.modules?.itsm ? 'Service Desk' : 'Endpoint Operations',
      firstDepartment: 'IT',
      firstSite: 'Head Office',
      assignmentModel: 'team-first',
    },
    permissions: {
      preset: 'balanced',
      requesterAccess: 'portal',
      changeApprovalRole: 'admin-change',
    },
    security: {
      requireMfa: true,
      sessionHours: '12',
      passwordPolicy: 'strong',
      auditRetention: '365',
    },
    itsm: {
      numberingMode: 'default',
      recordPrefixes: { ...defaultPrefixes },
      recordDigits: '5',
      supportEmail: 'support',
      defaultTeam: 'Service Desk',
      businessHours: 'uk-business',
      defaultPriority: 'Medium',
      p1ResponseMinutes: '15',
      p1ResolutionMinutes: '240',
      managerApprovalThreshold: '500',
      portalName: 'IT Help Centre',
      portalKnowledge: true,
      requesterComments: true,
      liveChat: true,
      aiAssistant: false,
      cabName: 'Change Advisory Board',
      standardChangeAutoApprove: true,
      requesterNotifications: true,
      slaWarnings: true,
      knowledgeFeedback: true,
    },
    rmm: {
      defaultSite: 'Main site',
      agentChannel: 'stable',
      monitoringPolicy: 'Standard endpoint monitoring',
      patchRing: 'Standard Windows endpoints',
      maintenanceWindow: 'Wednesday 22:00-02:00',
      unattendedAccess: true,
      requireRemoteApproval: false,
    },
    finish: {},
  }

  return defaults[step] || {}
}

function Field({ label, children, hint, full = false }) {
  return (
    <label className={`onboarding-field ${full ? 'onboarding-field-full' : ''}`}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}

function Section({ title, description, children }) {
  return (
    <section className="onboarding-section">
      <div className="onboarding-section-heading">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Toggle({ checked, onChange, title, description }) {
  return (
    <button
      className={`onboarding-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span className="onboarding-toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="onboarding-toggle-switch" aria-hidden="true"><span /></span>
    </button>
  )
}

function normalisePrefix(value, fallback) {
  const cleaned = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 9)
  if (!cleaned) return fallback
  return cleaned.endsWith('-') ? cleaned : `${cleaned}-`
}

async function fetchWithDeadline(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Hi5Central did not finish saving this step within 12 seconds. Your previous progress is safe; retry this step.')
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export function OnboardingWizard({ session, onSessionChange }) {
  const modules = session?.tenant?.modules || {}
  const sequence = useMemo(() => sequenceFor(modules), [modules])
  const canonicalStep = sequence.includes(session?.onboarding?.step) ? session.onboarding.step : sequence[0]
  const canonicalIndex = Math.max(0, sequence.indexOf(canonicalStep))
  const [viewStep, setViewStep] = useState(canonicalStep)
  const [data, setData] = useState(() => defaultData(canonicalStep, session))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setViewStep(canonicalStep)
    setData(defaultData(canonicalStep, session))
    setError('')
  }, [canonicalStep])

  const viewIndex = Math.max(0, sequence.indexOf(viewStep))
  const savedAccent = session?.onboarding?.data?.theme?.accent
  const activeAccent = viewStep === 'theme' ? data.accent : savedAccent || 'amber'
  const shellStyle = { '--onboarding-accent': accentColours[activeAccent] || accentColours.amber }
  const meta = stepMeta[viewStep]
  const Icon = meta?.icon || Sparkles
  const progress = Math.round(((canonicalIndex + 1) / sequence.length) * 100)

  function update(field, value) {
    setData((current) => ({ ...current, [field]: value }))
    setError('')
  }

  function updateNested(parent, field, value) {
    setData((current) => ({
      ...current,
      [parent]: {
        ...(current[parent] || {}),
        [field]: value,
      },
    }))
    setError('')
  }

  function normalisedStepData(stepName, stepData) {
    if (stepName !== 'itsm') return stepData
    const configured = stepData.numberingMode === 'custom'
      ? Object.fromEntries(Object.entries(defaultPrefixes).map(([key, fallback]) => [
          key,
          normalisePrefix(stepData.recordPrefixes?.[key], fallback),
        ]))
      : { ...defaultPrefixes }
    return { ...stepData, recordPrefixes: configured }
  }

  async function persistStep(stepName, stepData, { advance = false } = {}) {
    const payloadData = normalisedStepData(stepName, stepData)
    const response = await fetchWithDeadline(`${API_BASE}/api/v1/onboarding/${advance ? 'step' : 'save'}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepName, data: payloadData }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'We could not save this onboarding step.')
    return { payload, payloadData }
  }

  async function continueStep() {
    setSaving(true)
    setError('')
    try {
      if (viewStep === canonicalStep) {
        const { payload, payloadData } = await persistStep(viewStep, data, { advance: true })
        setData(payloadData)
        onSessionChange(payload)
        return
      }

      const { payload } = await persistStep(viewStep, data)
      onSessionChange(payload)
      const nextView = sequence[Math.min(viewIndex + 1, canonicalIndex)]
      setViewStep(nextView)
      setData(defaultData(nextView, payload))
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  async function goPrevious() {
    if (viewIndex <= 0) return
    setSaving(true)
    setError('')
    try {
      const { payload } = await persistStep(viewStep, data)
      onSessionChange(payload)
      const previousView = sequence[viewIndex - 1]
      setViewStep(previousView)
      setData(defaultData(previousView, payload))
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  async function complete() {
    setSaving(true)
    setError('')
    try {
      const response = await fetchWithDeadline(`${API_BASE}/api/v1/onboarding/complete`, {
        method: 'POST',
        credentials: 'include',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'We could not complete onboarding.')
      onSessionChange(payload)
    } catch (completeError) {
      setError(completeError.message)
    } finally {
      setSaving(false)
    }
  }

  const savedItsm = session?.onboarding?.data?.itsm || {}

  return (
    <div className="onboarding-shell" style={shellStyle}>
      <aside className="onboarding-sidebar">
        <div className="onboarding-brand">
          <img src="/hi5central-logo.png" alt="" />
          <div><strong>Hi5Central</strong><span>{session.tenant.companyName}</span></div>
        </div>
        <div className="onboarding-progress-copy"><span>Workspace setup</span><strong>{progress}%</strong></div>
        <div className="onboarding-progress"><span style={{ width: `${progress}%` }} /></div>
        <nav className="onboarding-steps" aria-label="Onboarding progress">
          {sequence.map((item, itemIndex) => {
            const ItemIcon = stepMeta[item]?.icon || Check
            const complete = itemIndex < canonicalIndex
            const current = item === viewStep
            return (
              <div className={`onboarding-step ${complete ? 'is-complete' : ''} ${current ? 'is-current' : ''}`} key={item}>
                <span className="onboarding-step-icon">{complete ? <Check size={15} /> : <ItemIcon size={15} />}</span>
                <span>{stepMeta[item]?.label}</span>
              </div>
            )
          })}
        </nav>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-card">
          <div className="onboarding-heading">
            <span className="onboarding-heading-icon"><Icon size={21} /></span>
            <div>
              <span>Step {viewIndex + 1} of {sequence.length}</span>
              <h1>{meta?.label}</h1>
              <p>{meta?.description}</p>
            </div>
          </div>

          {viewStep === 'company' ? (
            <>
              <Section title="Organisation" description="These values become the tenant defaults and can be changed later in Settings.">
                <div className="onboarding-form-grid">
                  <Field label="Display name"><input value={data.displayName || ''} onChange={(event) => update('displayName', event.target.value)} /></Field>
                  <Field label="Legal / registered name"><input value={data.legalName || ''} onChange={(event) => update('legalName', event.target.value)} /></Field>
                  <Field label="Country"><input value={data.country || ''} onChange={(event) => update('country', event.target.value)} /></Field>
                  <Field label="Industry"><select value={data.industry || 'Technology'} onChange={(event) => update('industry', event.target.value)}><option>Technology</option><option>Professional services</option><option>Education</option><option>Healthcare</option><option>Retail</option><option>Manufacturing</option><option>Other</option></select></Field>
                  <Field label="Organisation size"><select value={data.employeeBand || '51-250'} onChange={(event) => update('employeeBand', event.target.value)}><option value="1-50">1-50 people</option><option value="51-250">51-250 people</option><option value="251-1000">251-1,000 people</option><option value="1001+">1,001+ people</option></select></Field>
                  <Field label="Time zone"><select value={data.timezone || 'Europe/London'} onChange={(event) => update('timezone', event.target.value)}><option>Europe/London</option><option>Europe/Dublin</option><option>UTC</option><option>America/New_York</option><option>America/Chicago</option><option>America/Los_Angeles</option></select></Field>
                  <Field label="Locale"><select value={data.locale || 'en-GB'} onChange={(event) => update('locale', event.target.value)}><option value="en-GB">English (UK)</option><option value="en-US">English (US)</option></select></Field>
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'theme' ? (
            <>
              <Section title="Default appearance" description="This becomes the starting experience for the tenant. Individual users can later have personal preferences.">
                <div className="onboarding-form-grid">
                  <Field label="Appearance"><select value={data.mode || 'system'} onChange={(event) => update('mode', event.target.value)}><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
                  <Field label="Accent colour"><select value={data.accent || 'amber'} onChange={(event) => update('accent', event.target.value)}><option value="amber">Amber</option><option value="blue">Blue</option><option value="cyan">Cyan</option><option value="emerald">Emerald</option><option value="violet">Violet</option><option value="rose">Rose</option></select></Field>
                  <Field label="Workspace brand name"><input value={data.brandName || ''} onChange={(event) => update('brandName', event.target.value)} /></Field>
                  {modules.itsm ? <Field label="Portal title"><input value={data.portalTitle || ''} onChange={(event) => update('portalTitle', event.target.value)} /></Field> : null}
                </div>
                <div className="onboarding-theme-preview">
                  <span className="onboarding-theme-preview-accent" />
                  <div>
                    <strong>{data.brandName || session.tenant.companyName}</strong>
                    <span>{modules.itsm ? `${data.portalTitle || 'IT Help Centre'} · ` : ''}{data.mode === 'system' ? 'Follows device appearance' : `${data.mode} mode`}</span>
                  </div>
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'groups' ? (
            <>
              <Section title="Initial structure" description="Create sensible defaults before importing or manually adding the full organisation.">
                <div className="onboarding-form-grid">
                  <Field label={modules.itsm ? 'Primary support team' : 'Primary operations team'}><input value={data.serviceDeskTeam || ''} onChange={(event) => update('serviceDeskTeam', event.target.value)} /></Field>
                  <Field label="First department"><input value={data.firstDepartment || ''} onChange={(event) => update('firstDepartment', event.target.value)} /></Field>
                  <Field label="First site / location"><input value={data.firstSite || ''} onChange={(event) => update('firstSite', event.target.value)} /></Field>
                  <Field label="Assignment model"><select value={data.assignmentModel || 'team-first'} onChange={(event) => update('assignmentModel', event.target.value)}><option value="team-first">Assign to team, then technician</option><option value="technician-first">Assign directly to technician</option><option value="queue">Shared queue ownership</option></select></Field>
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'permissions' ? (
            <>
              <Section title="Role model" description="Start with a template; granular RBAC remains editable later in Settings.">
                <div className="onboarding-choice-grid">
                  {[
                    ['balanced', 'Balanced', 'Owners and admins configure the platform; analysts work operational records.'],
                    ['restricted', 'Restricted', 'Start with tighter analyst permissions and open access deliberately.'],
                    ['open', 'Collaborative', 'Broader analyst access for smaller IT teams.'],
                  ].map(([value, title, copy]) => <button type="button" onClick={() => update('preset', value)} className={data.preset === value ? 'is-selected' : ''} key={value}><strong>{title}</strong><span>{copy}</span></button>)}
                </div>
                {modules.itsm ? (
                  <div className="onboarding-form-grid onboarding-form-grid-spaced">
                    <Field label="Requester access"><select value={data.requesterAccess || 'portal'} onChange={(event) => update('requesterAccess', event.target.value)}><option value="portal">Portal only</option><option value="portal-approvals">Portal + assigned approvals</option></select></Field>
                    <Field label="Change approvals"><select value={data.changeApprovalRole || 'admin-change'} onChange={(event) => update('changeApprovalRole', event.target.value)}><option value="admin-change">Admins + Change Managers</option><option value="change-only">Change Managers only</option></select></Field>
                  </div>
                ) : null}
              </Section>
            </>
          ) : null}

          {viewStep === 'security' ? (
            <>
              <Section title="Authentication & sessions" description="These are tenant defaults and are enforced by the tenant security service where supported.">
                <div className="onboarding-form-grid">
                  <Field label="Administrator MFA"><select value={data.requireMfa ? 'required' : 'optional'} onChange={(event) => update('requireMfa', event.target.value === 'required')}><option value="required">Require MFA</option><option value="optional">Optional initially</option></select></Field>
                  <Field label="Maximum session length"><select value={data.sessionHours || '12'} onChange={(event) => update('sessionHours', event.target.value)}><option value="8">8 hours</option><option value="12">12 hours</option><option value="24">24 hours</option></select></Field>
                  <Field label="Password policy"><select value={data.passwordPolicy || 'strong'} onChange={(event) => update('passwordPolicy', event.target.value)}><option value="strong">Strong</option><option value="standard">Standard</option></select></Field>
                  <Field label="Audit retention"><select value={data.auditRetention || '365'} onChange={(event) => update('auditRetention', event.target.value)}><option value="90">90 days</option><option value="365">1 year</option><option value="730">2 years</option></select></Field>
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'itsm' ? (
            <>
              <Section title="Record numbering" description="Use Hi5Central defaults or choose your own prefixes for records created in this tenant.">
                <div className="onboarding-segmented">
                  <button className={data.numberingMode !== 'custom' ? 'is-selected' : ''} onClick={() => update('numberingMode', 'default')} type="button">Use defaults</button>
                  <button className={data.numberingMode === 'custom' ? 'is-selected' : ''} onClick={() => update('numberingMode', 'custom')} type="button">Custom prefixes</button>
                </div>
                <div className="onboarding-prefix-grid">
                  {[
                    ['incident', 'Incident', 'INC-'],
                    ['serviceRequest', 'Service Request', 'REQ-'],
                    ['problem', 'Problem', 'PRB-'],
                    ['change', 'Change', 'CHG-'],
                  ].map(([key, label, fallback]) => {
                    const value = data.numberingMode === 'custom' ? data.recordPrefixes?.[key] || fallback : fallback
                    return (
                      <Field key={key} label={label} hint={`Preview: ${normalisePrefix(value, fallback)}10425`}>
                        <input
                          disabled={data.numberingMode !== 'custom'}
                          value={value}
                          onChange={(event) => updateNested('recordPrefixes', key, event.target.value.toUpperCase())}
                          onBlur={(event) => updateNested('recordPrefixes', key, normalisePrefix(event.target.value, fallback))}
                          maxLength={9}
                        />
                      </Field>
                    )
                  })}
                </div>
                <Field label="Number length" hint="This controls how many numeric digits are displayed in generated record IDs."><select value={data.recordDigits || '5'} onChange={(event) => update('recordDigits', event.target.value)}><option value="4">4 digits</option><option value="5">5 digits</option><option value="6">6 digits</option><option value="7">7 digits</option><option value="8">8 digits</option></select></Field>
              </Section>

              <Section title="Service desk defaults" description="Starting values for new incidents, requests and service routing.">
                <div className="onboarding-form-grid">
                  <Field label="Support address" hint="Inbound mail routing is a later backend step."><div className="onboarding-prefix-input"><input value={data.supportEmail || 'support'} onChange={(event) => update('supportEmail', event.target.value)} /><span>@{SELF_HOSTED ? DEPLOYMENT.rootDomain : `${session.tenant.slug}.${DEPLOYMENT.rootDomain}`}</span></div></Field>
                  <Field label="Default assignment team"><input value={data.defaultTeam || 'Service Desk'} onChange={(event) => update('defaultTeam', event.target.value)} /></Field>
                  <Field label="Business hours"><select value={data.businessHours || 'uk-business'} onChange={(event) => update('businessHours', event.target.value)}><option value="uk-business">Mon-Fri 09:00-17:30 UK</option><option value="extended">Mon-Fri 08:00-20:00</option><option value="24x7">24 × 7</option></select></Field>
                  <Field label="Default priority"><select value={data.defaultPriority || 'Medium'} onChange={(event) => update('defaultPriority', event.target.value)}><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select></Field>
                </div>
              </Section>

              <Section title="SLAs & approvals" description="Set simple first-day defaults; full SLA policies and workflow rules remain configurable later.">
                <div className="onboarding-form-grid">
                  <Field label="P1 response (minutes)"><input type="number" min="1" value={data.p1ResponseMinutes || '15'} onChange={(event) => update('p1ResponseMinutes', event.target.value)} /></Field>
                  <Field label="P1 resolution target (minutes)"><input type="number" min="1" value={data.p1ResolutionMinutes || '240'} onChange={(event) => update('p1ResolutionMinutes', event.target.value)} /></Field>
                  <Field label="Manager approval threshold (£)" hint="Used as the default threshold for catalogue cost approvals."><input type="number" min="0" value={data.managerApprovalThreshold || '500'} onChange={(event) => update('managerApprovalThreshold', event.target.value)} /></Field>
                  <Field label="CAB name"><input value={data.cabName || ''} onChange={(event) => update('cabName', event.target.value)} /></Field>
                </div>
                <div className="onboarding-toggle-grid onboarding-toggle-grid-spaced">
                  <Toggle checked={Boolean(data.standardChangeAutoApprove)} onChange={(value) => update('standardChangeAutoApprove', value)} title="Auto-approve standard changes" description="Allow pre-authorised standard change templates to bypass CAB." />
                  <Toggle checked={Boolean(data.slaWarnings)} onChange={(value) => update('slaWarnings', value)} title="SLA warning notifications" description="Warn technicians before response or resolution targets breach." />
                </div>
              </Section>

              <Section title="Portal, knowledge & engagement" description="Choose which self-service capabilities are enabled from day one.">
                <div className="onboarding-form-grid">
                  <Field label="Portal name"><input value={data.portalName || ''} onChange={(event) => update('portalName', event.target.value)} /></Field>
                </div>
                <div className="onboarding-toggle-grid onboarding-toggle-grid-spaced">
                  <Toggle checked={Boolean(data.portalKnowledge)} onChange={(value) => update('portalKnowledge', value)} title="Knowledge in Portal" description="Show published knowledge articles to requesters." />
                  <Toggle checked={Boolean(data.knowledgeFeedback)} onChange={(value) => update('knowledgeFeedback', value)} title="Knowledge feedback" description="Allow users to mark articles helpful or unhelpful." />
                  <Toggle checked={Boolean(data.requesterComments)} onChange={(value) => update('requesterComments', value)} title="Requester comments" description="Allow two-way updates on portal requests." />
                  <Toggle checked={Boolean(data.liveChat)} onChange={(value) => update('liveChat', value)} title="Live chat" description="Enable the existing Hi5Central live-chat experience." />
                  <Toggle checked={Boolean(data.requesterNotifications)} onChange={(value) => update('requesterNotifications', value)} title="Requester notifications" description="Send lifecycle updates when outbound notifications are connected." />
                  <Toggle checked={Boolean(data.aiAssistant)} onChange={(value) => update('aiAssistant', value)} title="AI assistant" description="Enable the tenant AI preference. AI features remain unavailable until the production AI service is configured." />
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'rmm' ? (
            <>
              <Section title="Managed estate defaults" description="These values seed the first RMM site, policy and operational defaults.">
                <div className="onboarding-form-grid">
                  <Field label="Default site"><input value={data.defaultSite || 'Main site'} onChange={(event) => update('defaultSite', event.target.value)} /></Field>
                  <Field label="Agent update channel"><select value={data.agentChannel || 'stable'} onChange={(event) => update('agentChannel', event.target.value)}><option value="stable">Stable</option><option value="early">Early access</option></select></Field>
                  <Field label="Monitoring policy"><input value={data.monitoringPolicy || ''} onChange={(event) => update('monitoringPolicy', event.target.value)} /></Field>
                  <Field label="Patch ring"><input value={data.patchRing || ''} onChange={(event) => update('patchRing', event.target.value)} /></Field>
                  <Field label="Maintenance window"><input value={data.maintenanceWindow || ''} onChange={(event) => update('maintenanceWindow', event.target.value)} /></Field>
                </div>
                <div className="onboarding-toggle-grid onboarding-toggle-grid-spaced">
                  <Toggle checked={Boolean(data.unattendedAccess)} onChange={(value) => update('unattendedAccess', value)} title="Unattended remote access" description="Allow authorised technicians to start unattended sessions." />
                  <Toggle checked={Boolean(data.requireRemoteApproval)} onChange={(value) => update('requireRemoteApproval', value)} title="Require user approval by default" description="Use attended approval for endpoints unless policy overrides it." />
                </div>
              </Section>
            </>
          ) : null}

          {viewStep === 'finish' ? (
            <div className="onboarding-finish">
              <span><Sparkles size={24} /></span>
              <h2>Your workspace is ready.</h2>
              <p>Open Hi5Central with the owner account and the tenant defaults you configured during onboarding.</p>
              <div className="onboarding-summary onboarding-summary-expanded">
                <div><span>Tenant</span><strong>{SELF_HOSTED ? DEPLOYMENT.appUrl : `${session.tenant.slug}.${DEPLOYMENT.rootDomain}`}</strong></div>
                <div><span>Owner</span><strong>{session.user.email}</strong></div>
                <div><span>Products</span><strong>{[modules.itsm ? 'ITSM' : null, modules.rmm ? 'RMM' : null].filter(Boolean).join(' + ')}</strong></div>
                {modules.itsm ? <div><span>Record IDs</span><strong>{Object.values(savedItsm.recordPrefixes || defaultPrefixes).join(' · ')}</strong></div> : null}
                {modules.itsm ? <div><span>Portal</span><strong>{savedItsm.portalName || 'IT Help Centre'}</strong></div> : null}
              </div>
              <div className="onboarding-integration-note onboarding-finish-note"><Mail size={16} /><span>{SELF_HOSTED ? 'Your core workspace settings are saved locally. External integrations, inbound email and AI can be configured later from Settings.' : 'Your core workspace settings are saved to this tenant. Integrations, inbound email, AI and billing can be configured later from Settings.'}</span></div>
            </div>
          ) : null}

          {error ? <div className="onboarding-error">{error}</div> : null}

          <div className="onboarding-actions">
            <span className="onboarding-saved">Changes are saved as you move between steps.</span>
            <div className="onboarding-action-buttons">
              {viewIndex > 0 ? (
                <button className="onboarding-secondary" disabled={saving} onClick={goPrevious} type="button">
                  <ArrowLeft size={16} /> Previous
                </button>
              ) : null}
              <button
                className="onboarding-primary"
                disabled={saving}
                onClick={viewStep === 'finish' && viewStep === canonicalStep ? complete : continueStep}
                type="button"
              >
                {saving ? 'Saving…' : viewStep === 'finish' && viewStep === canonicalStep ? 'Open Hi5Central' : 'Continue'}
                {!saving ? <ArrowRight size={17} /> : null}
              </button>
            </div>
          </div>
        </div>
      </main>
      <OnboardingMfaEnhancer />
    </div>
  )
}
