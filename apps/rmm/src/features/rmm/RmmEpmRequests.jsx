import { useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'

const base = window.__HI5_API_BASE__
async function request(url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method, credentials: 'include', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? {body: JSON.stringify(body)} : {}),
  })
  const data = await response.json().catch(()=>({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

export function RmmEpmRequests() {
  const [rows,setRows] = useState([])
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [message,setMessage] = useState('')
  const [active,setActive] = useState(null)
  const [note,setNote] = useState('')

  async function refresh() {
    setError('')
    try {
      const data=await request('/api/v1/rmm/epm/file-requests')
      setRows(data.requests || [])
    } catch (e) { setError(e.message) }
  }
  useEffect(() => { refresh() }, [])
  async function decide() {
    if (!active || note.trim().length<10) return
    setBusy(true); setError(''); setMessage('')
    try {
      await request('/api/v1/rmm/epm/file-requests/'+encodeURIComponent(active.id)+'/decision','POST',{
        decision:active.decision,note:note.trim(),
      })
      setMessage(active.decision==='approved'
        ? 'Approved once for 15 minutes. The user must retry the exact file.'
        : 'Request rejected. No executable has been elevated.')
      setActive(null);setNote('')
      await refresh()
    } catch (e) {setError(e.message)}
    finally {setBusy(false)}
  }
  return <div className="app-portal-admin">
    <header className="app-portal-hero">
      <div><span className="rmm-eyebrow">Endpoint security / privilege management</span>
        <h2>File elevation requests</h2>
        <p>Approve a specific signed executable for one user and device. This does not deploy an App Portal package or grant general administrator membership.</p></div>
      <button className="rmm-secondary" type="button" disabled={busy} onClick={refresh}><RefreshCw size={15}/> Refresh</button>
    </header>
    {error && <p role="alert" className="app-portal-notice error">{error}</p>}
    {message && <p role="status" className="app-portal-notice success">{message}</p>}
    <section className="app-portal-stats">
      <article><strong>{rows.filter(r=>r.status==='pending').length}</strong><span>Awaiting review</span></article>
      <article><strong>{rows.filter(r=>r.status==='approved').length}</strong><span>Approved</span></article>
      <article><strong>{rows.filter(r=>r.status==='redeemed').length}</strong><span>Redeemed once</span></article>
    </section>
    <section className="app-portal-card app-portal-wide">
      <div className="app-portal-card-title"><div><h3><ShieldCheck size={17}/> Executable approval queue</h3>
        <p>Trust status and SHA-256 are independently rechecked by the Windows broker before execution.</p></div></div>
      {!rows.length && <p>No file elevation requests. The Newtest Lenovo pilot only accepts signed, locally verified EXE files.</p>}
      {rows.map(r=><article className="app-portal-approval-item" key={r.id}>
        <div className="app-portal-approval-summary" style={{overflowWrap:'anywhere'}}>
          <strong>{r.file_name}</strong>
          <small>{r.requester_name || r.requester_sid} · {new Date(r.created_at).toLocaleString()}</small>
          <small><b>Publisher:</b> {r.publisher}</small>
          <small><b>File:</b> {r.file_path}</small>
          <small><b>SHA-256:</b> {r.file_sha256}</small>
          <small><b>Signing thumbprint:</b> {r.signer_thumbprint}</small>
          <small><b>User SID:</b> {r.requester_sid} · <b>Device:</b> {r.agent_device_id}</small>
          <p><b>Business reason:</b> {r.business_reason}</p>
          {r.decision_note && <p><b>Technician decision:</b> {r.decision_note}</p>}
          {r.launch_pid && <p>
            <b>Windows launch:</b> Process ID {r.launch_pid}.
            {r.launch_ended_at
              ? ' Process job ended after '+((r.launch_elapsed_ms||0)/1000).toFixed(1)+' seconds'+
                (r.launch_exit_code!==null ? ', initial EXE exit code '+r.launch_exit_code : ', initial EXE exit code unknown')+
                '. Reason: '+(r.launch_end_reason||'not recorded')+'.'
              : ' Process completion not yet reported.'}
            {' '}This does not confirm installation success.
          </p>}
          {r.status==='launch_failed' && <p role="alert"><b>Windows launch:</b> Failed
            {r.launch_failure_stage
              ? ' · Stage: '+r.launch_failure_stage+' · Win32 code: '+r.launch_failure_code
              : ' · Previous pilot did not record a Windows error code'}
          </p>}
        </div>
        <span className="app-portal-state">{r.status}{r.status==='approved' && r.approval_expires_at
          ? ' · until '+new Date(r.approval_expires_at).toLocaleTimeString() : ''}</span>
        {r.status==='pending' && <span className="app-portal-request-actions">
          <button disabled={busy} className="app-portal-text-action approve" onClick={()=>{setActive({id:r.id,decision:'approved'});setNote('')}} type="button">Approve once</button>
          <button disabled={busy} className="app-portal-text-action" onClick={()=>{setActive({id:r.id,decision:'rejected'});setNote('')}} type="button">Reject</button>
        </span>}
      </article>)}
    </section>
    {active && <section className="app-portal-card">
      <h3>{active.decision==='approved'?'Approve one-time elevation':'Reject elevation'}</h3>
      <p>{active.decision==='approved'?'Approval expires after 15 minutes and is consumed on its first attempted launch.':'No elevation will be permitted.'}</p>
      <label>Decision explanation<textarea value={note} rows="3" onChange={e=>setNote(e.target.value)}
        placeholder="Explain this decision (minimum 10 characters)" /></label>
      <div className="app-portal-request-actions">
        <button disabled={busy||note.trim().length<10} className="rmm-primary" onClick={decide} type="button">Confirm decision</button>
        <button disabled={busy} onClick={()=>setActive(null)} type="button">Cancel</button>
      </div>
    </section>}
  </div>
}
