import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleOff, FilePlus2, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { endpointApi } from '../../lib/rmmEndpointApi.js'
import { RmmWindowsSettingsLibrary } from './RmmWindowsSettingsLibrary.jsx'
import './RmmEndpointManagement.css'

const defaults = {
  baseline: [['windows.smb1.enabled', false], ['windows.firewall.domain.enabled', true], ['windows.firewall.private.enabled', true], ['windows.firewall.public.enabled', true]],
  configuration: [['windows.filesystem.long_paths_enabled', true]],
  laps: [['windows.laps.backup_directory', 'entra'], ['windows.laps.password_age_days', 30], ['windows.laps.password_length', 20], ['windows.laps.password_complexity', '4'], ['windows.laps.post_auth_reset_hours', 24], ['windows.laps.post_auth_actions', '3']],
}
const labels = { baseline: 'Security baseline', configuration: 'Configuration profile', laps: 'Windows LAPS' }
const human = (value) => value === true ? 'Enabled' : value === false ? 'Disabled' : String(value ?? '')
const blankException = { settingKey: '', scopeType: 'device', scopeId: '', mode: 'exclude', value: false, reason: '', expiresAt: '', riskAccepted: false }

function ValueEditor({ setting, value, onChange }) {
  if (setting.type === 'boolean') return <select aria-label={setting.label} value={String(value)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select>
  if (setting.type === 'enum') return <select aria-label={setting.label} value={value} onChange={(e) => onChange(e.target.value)}>{setting.values.map((option) => <option key={option} value={option}>{setting.options?.[option] || (option === 'entra' ? 'Microsoft Entra ID' : option === 'ad' ? 'Active Directory' : option)}</option>)}</select>
  if (setting.type === 'integer') return <input aria-label={setting.label} type="number" min={setting.min} max={setting.max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  return <input aria-label={setting.label} maxLength={setting.maxLength} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Built-in administrator (default)" />
}

function scopeChoices(data, type) {
  if (type === 'group') return (data?.groups || []).map((item) => ({ id: item.id, label: item.name + ' (' + item.devices + ' devices)' }))
  if (type === 'device') return (data?.devices || []).map((item) => ({ id: item.id, label: item.name }))
  if (type === 'user') return (data?.users || []).map((item) => ({ id: item.email, label: item.name + ' · ' + item.email }))
  return []
}
function scopeLabel(data, type, id) {
  if (type === 'estate') return 'All devices'
  return scopeChoices(data, type).find((item) => item.id === id)?.label || id
}

export function RmmEndpointManagement() {
  const [screen, setScreen] = useState('library')
  const [data, setData] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState(null)
  const [exception, setException] = useState(blankException)
  const [editingException, setEditingException] = useState(false)
  const [previewDevice, setPreviewDevice] = useState('')
  const [preview, setPreview] = useState(null)
  const [runId, setRunId] = useState('')
  const [runReport, setRunReport] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)

  const reload = useCallback(async () => {
    const next = await endpointApi.list()
    setData(next)
    setSelectedId((current) => current || next.profiles[0]?.id || '')
    setPreviewDevice((current) => current || next.devices[0]?.id || '')
    setRevision((current) => current + 1)
    return next
  }, [])
  useEffect(() => { reload().catch((e) => setError(e.message)) }, [reload])
  const selected = useMemo(() => (data?.profiles || []).find((profile) => profile.id === selectedId), [data, selectedId])
  useEffect(() => {
    if (selected && !draft) setDraft({ id: selected.id, revision: selected.revision, name: selected.name, description: selected.description, kind: selected.kind, status: selected.status, scopeType: selected.scope_type, scopeId: selected.scope_id, settings: selected.settings })
  }, [selected, draft])
  useEffect(() => {
    if (!selectedId || !previewDevice) { setPreview(null); return }
    let active = true
    endpointApi.preview(selectedId, previewDevice).then((item) => { if (active) setPreview(item) }).catch(() => { if (active) setPreview(null) })
    return () => { active = false }
  }, [selectedId, previewDevice, revision])
  useEffect(() => {
    if (!runId) return
    let active = true
    let timer = null
    const poll = async () => {
      try {
        const result = await endpointApi.runStatus(runId)
        if (!active) return
        setRunReport(result)
        if (result.status === 'queued' || result.status === 'claimed') timer = window.setTimeout(poll, 2000)
      } catch (error) { if (active) setError(error.message) }
    }
    poll()
    return () => { active = false; if (timer) window.clearTimeout(timer) }
  }, [runId])
  const settings = data?.catalogue || []
  const exceptions = (data?.exceptions || []).filter((item) => item.profile_id === selectedId)
  const setField = (name, value) => setDraft((current) => ({ ...current, [name]: value }))
  const setExceptionField = (name, value) => setException((current) => ({ ...current, [name]: value }))

  function selectProfile(item) {
    setSelectedId(item.id)
    setDraft({ id: item.id, revision: item.revision, name: item.name, description: item.description, kind: item.kind, status: item.status, scopeType: item.scope_type, scopeId: item.scope_id, settings: item.settings })
    setEditingException(false); setError(''); setNotice(''); setRunId(''); setRunReport(null)
  }
  function createProfile(kind) {
    setSelectedId(''); setEditingException(false); setError(''); setNotice(''); setRunId(''); setRunReport(null)
    setDraft({ name: kind === 'laps' ? 'Windows LAPS management' : kind === 'baseline' ? 'Windows 11 baseline' : 'Windows configuration', description: '', kind, status: 'draft', scopeType: 'estate', scopeId: '', settings: defaults[kind].map(([key, value]) => ({ key, value })) })
  }
  async function saveProfile() {
    if (!draft) return
    setPending(true); setError(''); setNotice('')
    try {
      const result = draft.id ? await endpointApi.update(draft) : await endpointApi.create(draft)
      const next = await reload()
      const saved = next.profiles.find((item) => item.id === result.profile.id)
      if (saved) selectProfile(saved)
      setNotice('Profile saved. Agent evaluation is available manually for supported Windows settings.')
    } catch (e) { setError(e.message) } finally { setPending(false) }
  }
  async function addException(event) {
    event.preventDefault()
    if (!selected) return
    setPending(true); setError(''); setNotice('')
    try {
      await endpointApi.setException(selected.id, {
        ...exception,
        expiresAt: exception.expiresAt ? new Date(exception.expiresAt + 'T23:59:59Z').toISOString() : null,
      })
      await reload()
      setEditingException(false); setException(blankException)
      setNotice('Setting-specific exception saved. Its effective configuration is now visible in device previews.')
    } catch (e) { setError(e.message) } finally { setPending(false) }
  }
  async function removeException(item) {
    if (!window.confirm('Remove this exception? The base setting will become effective again on the next configuration evaluation.')) return
    setPending(true); setError(''); setNotice('')
    try {
      await endpointApi.removeException(selected.id, item.id)
      await reload()
      setNotice('Exception revoked. Re-run evaluation or apply on the selected device to enact the updated desired state.')
    } catch (e) { setError(e.message) } finally { setPending(false) }
  }
  async function runWindowsPolicy(action, settingKey = '') {
    if (!selectedId || !previewDevice || pending) return
    const safeWrite = settingKey === 'windows.filesystem.long_paths_enabled'
    if (action !== 'audit' && !safeWrite) { setError('This setting has no supported write adapter yet.'); return }
    if (action !== 'audit' && !window.confirm(action === 'apply'
      ? 'Apply this supported Windows setting to the selected device now? The previous value will be saved for restoration.'
      : 'Restore the previously saved Windows setting value for the selected device?')) return
    setPending(true); setError(''); setNotice(''); setRunId(''); setRunReport(null)
    try {
      const result = await endpointApi.run(selectedId, previewDevice, action, settingKey)
      setRunId(result.jobId)
      setNotice('Windows ' + action + ' job queued. Waiting for device verification.')
    } catch (error) { setError(error.message) } finally { setPending(false) }
  }
  function beginException(setting) {
    const first = data?.devices?.[0]
    const defaultExpiry = new Date(Date.now() + 30*86400000).toISOString().slice(0, 10)
    setException({ ...blankException, settingKey: setting.key, value: setting.value, scopeId: first?.id || '', expiresAt: defaultExpiry })
    setEditingException(true); setError(''); setNotice('')
  }
  const choices = scopeChoices(data, exception.scopeType)
  const currentExceptionSetting = settings.find((setting) => setting.key === exception.settingKey)
  const riskOverride = exception.mode === 'override' && (
    (exception.settingKey === 'windows.smb1.enabled' && exception.value === true) ||
    (exception.settingKey.startsWith('windows.firewall.') && exception.value === false) ||
    (exception.settingKey === 'windows.usb.storage.enabled' && exception.value === true)
  )

  return (
    <div className="rmm-endpoint">
      <div className="rmm-page-heading">
        <div><span className="rmm-eyebrow">Windows endpoint management</span><h1>Configuration & security</h1><p>Build Windows policies with exceptions to individual settings for devices, device groups and assigned users.</p></div>
      </div>
      <div className="rmm-endpoint-warning"><AlertTriangle size={19}/><span><strong>Manual agent evaluation is available.</strong> Windows firewall, SMBv1 and LAPS are currently audit-only. Win32 long-path support can be applied and restored with verification. Automatic enforcement, wider security controls and native LAPS password management are not enabled.</span></div>
      <nav className="rmm-endpoint-tabbar" aria-label="Endpoint management sections">
        <button type="button" className={screen === 'library' ? 'selected' : ''} onClick={()=>setScreen('library')}>All Windows settings</button>
        <button type="button" className={screen === 'profiles' ? 'selected' : ''} onClick={()=>setScreen('profiles')}>Profiles & setting exceptions</button>
      </nav>
      {screen === 'library' ? <RmmWindowsSettingsLibrary nativeSettings={data?.catalogue || []} /> : <>
      {error && <div className="rmm-endpoint-message error" role="alert"><XCircle size={17}/>{error}</div>}
      {notice && <div className="rmm-endpoint-message success" role="status"><CheckCircle2 size={17}/>{notice}</div>}
      <div className="rmm-endpoint-actions">
        <button type="button" onClick={() => createProfile('baseline')}><FilePlus2 size={15}/> Security baseline</button>
        <button type="button" onClick={() => createProfile('configuration')}><FilePlus2 size={15}/> Configuration profile</button>
        <button type="button" onClick={() => createProfile('laps')}><ShieldCheck size={15}/> Windows LAPS</button>
      </div>
      <div className="rmm-endpoint-layout">
        <aside className="rmm-endpoint-list">
          <h2>Configuration profiles <span>{data?.profiles?.length || 0}</span></h2>
          {(data?.profiles || []).map((item) => (
            <button key={item.id} type="button" className={selectedId === item.id ? 'selected' : ''} onClick={() => selectProfile(item)}>
              <strong>{item.name}</strong><small>{labels[item.kind]} · {item.status}</small>
            </button>
          ))}
          {!data && <p>Loading endpoint policies…</p>}
          {data && !data.profiles.length && <p>Create your first Windows configuration profile.</p>}
        </aside>
        <section className="rmm-endpoint-editor">
          {!draft ? <div className="rmm-endpoint-empty"><ShieldCheck size={30}/><h2>Select or create a profile</h2><p>Start with a safe baseline or configure Windows LAPS policy settings.</p></div> : <>
            <div className="rmm-endpoint-editor-title"><div><span className="rmm-eyebrow">{draft.id ? labels[draft.kind] : 'New ' + labels[draft.kind]}</span><h2>Profile configuration</h2></div><span className="rmm-endpoint-tag">{draft.status}</span></div>
            <div className="rmm-endpoint-fields">
              <label>Profile name<input value={draft.name} maxLength={120} onChange={(e) => setField('name', e.target.value)} /></label>
              <label>Description<input value={draft.description} maxLength={1000} onChange={(e) => setField('description', e.target.value)} /></label>
              <label>Policy stage<select value={draft.status} onChange={(e) => setField('status', e.target.value)}><option value="draft">Draft</option><option value="ready">Ready for manual agent evaluation</option><option value="disabled">Disabled</option></select></label>
              <label>Assignment<select value={draft.scopeType} onChange={(e) => setDraft((old) => ({ ...old, scopeType: e.target.value, scopeId: scopeChoices(data, e.target.value)[0]?.id || '' }))}>
                <option value="estate">All devices</option><option value="group">Device group</option><option value="device">Single device</option><option value="user">Assigned user</option>
              </select></label>
              {draft.scopeType !== 'estate' && <label>Target<select value={draft.scopeId} onChange={(e) => setField('scopeId', e.target.value)}><option value="">Select target</option>{scopeChoices(data, draft.scopeType).map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>}
            </div>
            {draft.kind === 'laps' && <p className="rmm-endpoint-hint">Hi5Central stores the Windows LAPS configuration here, not the administrator password. Native password escrow goes to Microsoft Entra ID or Active Directory. Advanced options require compatible Windows versions and policy sources; they are not delivered by this preview.</p>}
            {draft.scopeType === 'user' && <p className="rmm-endpoint-hint">User targeting currently uses the device's assigned user identity, not the user currently signed in. Device-level LAPS settings should normally target devices or device groups.</p>}
            <div className="rmm-endpoint-subheading"><h3>Individual Windows settings</h3><span>{draft.settings.length} selected</span></div>
            <div className="rmm-endpoint-settings">
              {draft.settings.map((item) => {
                const meta = settings.find((setting) => setting.key === item.key)
                if (!meta) return null
                return <div className="rmm-endpoint-setting" key={item.key}>
                  <div><strong>{meta.label}</strong><small>{meta.category} · {item.key}</small>{meta.description && <small>{meta.description}</small>}</div>
                  <ValueEditor setting={meta} value={item.value} onChange={(value) => setField('settings', draft.settings.map((entry) => entry.key === item.key ? { ...entry, value } : entry))}/>
                  <button type="button" title="Remove setting from profile" aria-label={'Remove ' + meta.label} onClick={() => setField('settings', draft.settings.filter((entry) => entry.key !== item.key))}><CircleOff size={17}/></button>
                  {draft.id && <button type="button" title={'Add per-setting exception for ' + meta.label} onClick={() => beginException(item)}>Exception</button>}
                </div>
              })}
            </div>
            <label className="rmm-endpoint-add-setting">Add another setting<select value="" onChange={(e) => {
              const setting = settings.find((item) => item.key === e.target.value)
              if (setting && !draft.settings.some((item) => item.key === setting.key)) setField('settings', [...draft.settings, { key: setting.key, value: setting.defaultValue }])
            }}><option value="">Select a setting…</option>{settings.filter((setting) => (draft.kind === 'laps' ? setting.category === 'Windows LAPS' : draft.kind === 'baseline' ? setting.category === 'Security baseline' : setting.category !== 'Windows LAPS') && !draft.settings.some((item) => item.key === setting.key)).map((setting) => <option key={setting.key} value={setting.key}>{setting.label}</option>)}</select></label>
            <div className="rmm-endpoint-save"><button type="button" disabled={pending || !draft.settings.length} onClick={saveProfile}>{pending ? 'Saving…' : 'Save profile'}</button><span>Saving does not automatically deploy to devices.</span></div>
          </>}
        </section>
      </div>
      {selected && <div className="rmm-endpoint-lower">
        <section className="rmm-endpoint-panel"><div className="rmm-endpoint-subheading"><h3>Setting-specific exceptions</h3><span>{exceptions.length} unrevoked records</span></div>
          {exceptions.map((item) => <div className="rmm-endpoint-exception" key={item.id}>
            <div><strong>{settings.find((setting) => setting.key === item.setting_key)?.label || item.setting_key}</strong><small>{item.mode === 'exclude' ? 'Excluded from enforcement' : 'Override to ' + human(item.value)} · {item.scope_type}: {scopeLabel(data, item.scope_type, item.scope_id)}</small><small>{item.reason}{item.expires_at ? ' · Expires ' + new Date(item.expires_at).toLocaleDateString() : ''}</small></div>
            <button type="button" disabled={pending} onClick={() => removeException(item)} title="Revoke this exception" aria-label="Revoke exception"><Trash2 size={17}/></button>
          </div>)}
          {!exceptions.length && <p className="rmm-endpoint-hint">No exceptions. Select Exception on an individual setting above to create one.</p>}
        </section>
        <section className="rmm-endpoint-panel">
          <div className="rmm-endpoint-subheading"><h3>Effective configuration & agent checks</h3></div>
          <label>Device<select value={previewDevice} onChange={(e) => { setPreviewDevice(e.target.value);setRunId('');setRunReport(null) }}>{(data?.devices || []).map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
          {preview?.resolution?.applicable && <div className="rmm-endpoint-run-actions"><button disabled={pending} type="button" onClick={() => runWindowsPolicy('audit')}>Audit supported settings</button><small>Manual, read-only Windows assessment</small></div>}
          {preview?.resolution && (preview.resolution.applicable ? preview.resolution.settings.map((item) => <div key={item.key} className="rmm-endpoint-resolution">
            <div><strong>{settings.find((setting) => setting.key === item.key)?.label || item.key}</strong><small>{item.state === 'excluded' ? 'Excluded' : item.state === 'conflict' ? 'Conflict — no winning override' : human(item.value) + (item.state === 'overridden' ? ' · Override' : ' · Baseline')}</small></div>
            {item.key === 'windows.filesystem.long_paths_enabled' && <div className="rmm-endpoint-row-actions">
              <button type="button" disabled={pending || selected.status !== 'ready' || !['configured','overridden'].includes(item.state)} onClick={() => runWindowsPolicy('apply',item.key)}>Apply</button>
              <button type="button" disabled={pending} onClick={() => runWindowsPolicy('restore',item.key)}>Restore original</button>
            </div>}
          </div>) : <p className="rmm-endpoint-hint">This profile does not target the selected device.</p>)}
          {!preview && <p className="rmm-endpoint-hint">Choose a device to see which settings and exceptions apply.</p>}
          {runReport && <section className="rmm-endpoint-run-report" aria-live="polite">
            <div><strong>Agent {runReport.action} · {runReport.status}</strong><small>{runReport.verified ? 'Verified from actual device results' : runReport.error || 'Awaiting verified result'}</small></div>
            {runReport.compliance?.map((item) => <div key={item.key}><strong>{settings.find((setting) => setting.key === item.key)?.label || item.key}</strong><span>{item.status} · observed {human(item.observed)}</span></div>)}
            {runReport.report?.results?.filter((item)=>item.action !== 'audit').map((item) => <div key={item.key}><strong>{item.key}</strong><span>{item.status} · {human(item.before)} → {human(item.observed)}</span></div>)}
          </section>}
        </section>
      </div>}
      {editingException && selected && <div className="rmm-endpoint-dialog-backdrop"><form className="rmm-endpoint-dialog" onSubmit={addException}>
        <div className="rmm-endpoint-editor-title"><div><span className="rmm-eyebrow">Policy exception</span><h2>{currentExceptionSetting?.label}</h2></div><button type="button" aria-label="Close" onClick={() => setEditingException(false)}><XCircle size={20}/></button></div>
        <p>Only this individual setting is affected. Other settings remain part of the baseline.</p>
        <label>Action<select value={exception.mode} onChange={(e) => setExceptionField('mode', e.target.value)}><option value="exclude">Exclude / stop managing setting</option><option value="override">Override with a different value</option></select></label>
        {exception.mode === 'override' && currentExceptionSetting && <label>Override value<ValueEditor setting={currentExceptionSetting} value={exception.value} onChange={(value) => setExceptionField('value', value)}/></label>}
        <label>Target type<select value={exception.scopeType} onChange={(e) => setException((old) => ({ ...old, scopeType: e.target.value, scopeId: scopeChoices(data, e.target.value)[0]?.id || '' }))}><option value="device">Single device</option><option value="group">Device group</option><option value="user">Assigned user</option></select></label>
        <label>Target<select value={exception.scopeId} onChange={(e) => setExceptionField('scopeId', e.target.value)} required><option value="">Choose a target</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Reason / risk justification<textarea value={exception.reason} onChange={(e) => setExceptionField('reason', e.target.value)} rows={3} placeholder="Business reason and risk owner" required minLength={8}/></label>
        <label>Review / expiry date<input type="date" value={exception.expiresAt} onChange={(e) => setExceptionField('expiresAt', e.target.value)} /></label>
        {riskOverride && <label className="rmm-endpoint-risk"><input type="checkbox" checked={exception.riskAccepted} onChange={(e) => setExceptionField('riskAccepted', e.target.checked)}/> I acknowledge the security risk of weakening this control and accept a time-limited exception.</label>}
        {riskOverride && <p className="rmm-endpoint-hint">High-risk overrides require risk acceptance and an expiry date. This is recorded for audit.</p>}
        <div className="rmm-endpoint-save"><button type="submit" disabled={pending || !exception.scopeId || (riskOverride && !exception.riskAccepted)}>{pending ? 'Saving…' : 'Save exception'}</button><button type="button" className="secondary" onClick={() => setEditingException(false)}>Cancel</button></div>
      </form></div>}
      </>}
    </div>
  )
}
