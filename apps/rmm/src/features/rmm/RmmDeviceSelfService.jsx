import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'

const stateLabels = {
  not_enabled: 'Not enabled',
  waiting_for_device: 'Waiting for device',
  queued: 'Queued',
  installing: 'Installing',
  installed: 'Installed',
  failed: 'Failed',
}
export function RmmDeviceSelfService({ device }) {
  const [policy, setPolicy] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const agentId = device?.agentDeviceId
  const apiBase = window.__HI5_API_BASE__ || deploymentConfig().apiUrl
  const url = agentId ? apiBase.replace(/\/$/, '') + '/api/v1/rmm/app-portal/devices/'
    + encodeURIComponent(agentId) + '/self-service' : ''
  const refresh = useCallback(async (silent = false) => {
    if (!url) return
    if (!silent) setLoading(true)
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Could not read Self Service device state.')
      setPolicy(payload.policy)
      if (!silent) setError('')
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [url])
  useEffect(() => {
    if (!url) return undefined
    refresh()
    const interval = setInterval(() => refresh(true), 15000)
    return () => clearInterval(interval)
  }, [refresh, url])
  const changeEnabled = async (enabled, retry = false) => {
    if (busy || !url) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, retry }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Could not update Self Service.')
      setPolicy(payload.policy)
      await refresh(true)
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }
  if (!agentId) return <section className="rmm-card"><h3>Software Self Service</h3><p>Install the Hi5Central Agent to manage the Company Portal app.</p></section>
  return <section className="rmm-card" aria-label="Software Self Service deployment">
    <div className="rmm-card-heading">
      <div><span className="rmm-eyebrow">Device-managed applications</span><h2>Software Self Service</h2></div>
      <button type="button" onClick={() => refresh()} disabled={loading || busy}><RefreshCw size={15} /> Refresh</button>
    </div>
    <p>Enable the Hi5Central Company Portal-style application on this Windows device.
      Hi5Central installs it automatically through the enrolled Agent, checks immutable SHA-256 hashes,
      and adds an all-users Start Menu shortcut.</p>
    <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,
      padding:'16px 0',flexWrap:'wrap' }}>
      <div><strong>Enable Self Service</strong>
        <div><small>Only this device. No Agent reinstall or remote viewer changes.</small></div>
      </div>
      <label style={{ display:'flex',alignItems:'center',gap:12,cursor:'pointer' }}>
        <input type="checkbox" checked={policy?.enabled === true}
          disabled={!policy || loading || busy}
          onChange={(event) => changeEnabled(event.target.checked)} />
        <strong>{policy?.enabled ? 'On' : 'Off'}</strong>
      </label>
    </div>
    <div style={{ display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'8px 0' }}>
      {policy?.status === 'installed' ? <CheckCircle2 color="#208456" size={19}/> :
        policy?.status === 'failed' ? <AlertTriangle color="#dc8a28" size={19}/> :
        <Download size={19}/>}
      <strong>{loading ? 'Checking deployment…' : stateLabels[policy?.status] || 'Status unknown'}</strong>
      <small>{policy?.version ? 'App ' + policy.version : ''}</small>
      {policy && <small>{policy.online ? 'Device connected' : 'Device offline — deployment queued for reconnect'}</small>}
      {busy && <small>Submitting device policy…</small>}
    </div>
    {policy?.lastError && <p role="alert">{policy.lastError}</p>}
    {error && <p role="alert" style={{ color:'#c45a47' }}>{error}</p>}
    {policy?.enabled && <button type="button" onClick={() => changeEnabled(true, true)} disabled={busy}>
      <RefreshCw size={14} /> Retry / reconcile installation
    </button>}
    <p style={{ fontSize:12,marginTop:14 }}>On restart, the installed Agent and the local reconciliation task
      restore the required application without duplicate installs. Disabling removes automatic deployment
      but retains the existing app and shortcut.</p>
    <p style={{ fontSize:12 }}><ShieldCheck size={13} style={{verticalAlign:'middle'}}/> Uploaded installers
      are hash-pinned. Unsigned custom applications still require explicit tenant-owner approval and
      device-specific assignment.</p>
  </section>
}
