import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'

const stateLabels = {
  not_enabled: 'Not enabled',
  waiting_for_device: 'Waiting for device',
  queued: 'Queued',
  installing: 'Installing',
  installed: 'Installed',
  failed: 'Installation failed',
  stalled: 'Installation not responding',
  removal_queued: 'Removal queued',
  removing: 'Removing Self Service',
  removal_failed: 'Removal failed',
  removed: 'Removed from device',
}
export function RmmDeviceSelfService({ device }) {
  const [policy, setPolicy] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [software, setSoftware] = useState(null)
  const [softwareError, setSoftwareError] = useState('')
  const [softwareBusy, setSoftwareBusy] = useState(false)
  const [softwareTab, setSoftwareTab] = useState('available')
  const [softwareSearch, setSoftwareSearch] = useState('')

  const agentId = device?.agentDeviceId
  const apiBase = window.__HI5_API_BASE__ || deploymentConfig().apiUrl
  const url = agentId ? apiBase.replace(/\/$/, '') + '/api/v1/rmm/app-portal/devices/'
    + encodeURIComponent(agentId) + '/self-service' : ''
  const softwareUrl = url ? url.replace(/\/self-service$/, '/software') : ''
  const refreshSoftware = useCallback(async (silent = false) => {
    if (!softwareUrl) return
    if (!silent) setSoftwareBusy(true)
    try {
      const response = await fetch(softwareUrl, { credentials:'include', cache:'no-store' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Unable to load device software.')
      setSoftware(result)
      setSoftwareError('')
    } catch (err) {
      // Retain the last known inventory while API connection is temporarily lost.
      setSoftwareError(err.message)
    } finally {
      if (!silent) setSoftwareBusy(false)
    }
  }, [softwareUrl])
  useEffect(() => {
    if (!softwareUrl) return undefined
    refreshSoftware()
    const interval = setInterval(() => refreshSoftware(true), 60000)
    return () => clearInterval(interval)
  }, [refreshSoftware, softwareUrl])
  const installedList = software?.installedSoftware || []
  const availableList = software?.availableApps || []
  const normalizedSearch = softwareSearch.trim().toLowerCase()
  const matching = (softwareTab === 'installed' ? installedList : availableList)
    .filter(item => !normalizedSearch || [item.name,item.publisher,item.version]
      .some(value => String(value || '').toLowerCase().includes(normalizedSearch)))
  const visibleSoftware = matching.slice(0, 150)

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
      <button type="button" onClick={() => { refresh(); refreshSoftware() }} disabled={loading || busy}>
        <RefreshCw size={15} /> Refresh
      </button>
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
      {['installed', 'removed'].includes(policy?.status) ? <CheckCircle2 color="#208456" size={19}/> :
        ['failed', 'removal_failed', 'stalled'].includes(policy?.status) ? <AlertTriangle color="#dc8a28" size={19}/> :
        <Download size={19}/>}
      <strong>{loading ? 'Checking deployment…' : stateLabels[policy?.status] || 'Status unknown'}</strong>
      {policy?.status === 'stalled' && <small>Previous Agent job has not reported completion. Check device diagnostics before retrying.</small>}
      <small>{policy?.version ? 'App ' + policy.version : ''}</small>
      {policy && <small>{policy.online ? 'Device connected' : 'Agent connection unavailable — operation queued or awaiting result'}</small>}
      {busy && <small>Submitting device policy…</small>}
    </div>
    {policy?.lastError && <p role="alert">{policy.lastError}</p>}
    {error && <p role="alert" style={{ color:'#c45a47' }}>{error}</p>}
    {policy?.enabled && <button type="button" onClick={() => changeEnabled(true, true)} disabled={busy}>
      <RefreshCw size={14} /> Retry / reconcile installation
    </button>}
    <section style={{ borderTop:'1px solid var(--rmm-border,#dfe7f1)',marginTop:20,paddingTop:18 }}
      aria-label="Self Service available and installed applications">
      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12 }}>
        <div>
          <h3 style={{margin:0}}>Applications for this device</h3>
          <small>Available apps use this device and its last known signed-in user assignments.
            Installed apps use the last Agent software inventory.</small>
        </div>
        <button type="button" onClick={() => refreshSoftware()} disabled={softwareBusy}>
          <RefreshCw size={14} /> {softwareBusy ? 'Refreshing…' : 'Refresh lists'}
        </button>
      </div>
      <div role="tablist" aria-label="Device software lists"
        style={{ display:'flex',gap:8,flexWrap:'wrap',marginBottom:12 }}>
        <button role="tab" type="button" aria-selected={softwareTab === 'available'}
          onClick={() => setSoftwareTab('available')}
          style={{ fontWeight: softwareTab === 'available' ? 700 : 400 }}>
          Available to user / device ({availableList.length})
        </button>
        <button role="tab" type="button" aria-selected={softwareTab === 'installed'}
          onClick={() => setSoftwareTab('installed')}
          style={{ fontWeight: softwareTab === 'installed' ? 700 : 400 }}>
          Installed on device ({installedList.length})
        </button>
      </div>
      <input aria-label="Search device software" placeholder="Search application, publisher or version"
        value={softwareSearch} onChange={(event) => setSoftwareSearch(event.target.value)}
        style={{ width:'100%',maxWidth:420,boxSizing:'border-box',padding:'9px 11px',
          border:'1px solid #cbd5e1',borderRadius:8,marginBottom:12 }}/>
      <p style={{fontSize:12,margin:'0 0 12px'}}>
        {softwareTab === 'installed'
          ? software?.lastInventoryAt
            ? 'Last installed-software inventory: ' + new Date(software.lastInventoryAt).toLocaleString()
            : 'No installed-software inventory has been reported.'
          : software?.user?.displayName
            ? 'Assignments evaluated for ' + software.user.displayName + ' and this device.'
            : 'Assignments evaluated for this device; user-specific access will appear after the user opens Self Service.'}
        {software?.inventoryIsSnapshot && <span> · Snapshot, not live Windows state</span>}
      </p>
      {softwareError && <p role="alert" style={{fontSize:12,color:'#b45309'}}>
        Showing the last loaded inventory. {softwareError}</p>}
      {!software && !softwareError && <p>Loading device applications…</p>}
      {software && matching.length === 0 && <p style={{fontSize:13}}>
        {softwareTab === 'installed'
          ? 'No installed applications match this search or this device has not reported inventory yet.'
          : 'No published applications are currently assigned to this device or its last known user.'}
      </p>}
      {visibleSoftware.length > 0 && <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr>
            <th style={{textAlign:'left',padding:'9px 8px'}}>Application</th>
            <th style={{textAlign:'left',padding:'9px 8px'}}>Version</th>
            <th style={{textAlign:'left',padding:'9px 8px'}}>
              {softwareTab === 'installed' ? 'Publisher' : 'Assignment'}
            </th>
          </tr></thead>
          <tbody>
            {visibleSoftware.map((item,i) => <tr key={(item.id || item.name) + ':' + i}
              style={{borderTop:'1px solid #e2e8f0'}}>
              <td style={{padding:'11px 8px'}}>
                <strong>{item.name}</strong>
                {softwareTab === 'available' && <div style={{fontSize:11,opacity:0.7}}>
                  {item.publisher || 'Company software'}</div>}
              </td>
              <td style={{padding:'11px 8px'}}>{item.version || 'Not reported'}</td>
              <td style={{padding:'11px 8px'}}>
                {softwareTab === 'installed'
                  ? item.publisher || 'Not reported'
                  : (item.scope?.name || item.scope?.type || 'Device') + ' · ' +
                    (item.intent === 'approval_required' ? 'Approval required' : 'Available')}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      {matching.length > visibleSoftware.length && <small>
        Showing {visibleSoftware.length} of {matching.length} results. Refine the search to narrow the list.
      </small>}
    </section>
    <p style={{ fontSize:12,marginTop:14 }}>When enabled, the installed Agent and a local reconciliation task
      maintain Self Service without duplicate installations. When disabled, Hi5Central removes the
      Self Service executable, Start Menu shortcut and reconciliation tasks. The Agent and PatchHost stay installed.</p>
    <p style={{ fontSize:12 }}><ShieldCheck size={13} style={{verticalAlign:'middle'}}/> Uploaded installers
      are hash-pinned. Unsigned custom applications still require explicit tenant-owner approval and
      device-specific assignment.</p>
  </section>
}
