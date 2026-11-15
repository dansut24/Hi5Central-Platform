import { useEffect, useRef, useState } from 'react'
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
  const [uacReviews,setUacReviews] = useState([])
  const [review,setReview] = useState(null)
  const [reviewNote,setReviewNote] = useState('')
  const [reviewBusy,setReviewBusy] = useState(false)
  const refreshPending=useRef(false)

  async function refresh({silent=false}={}) {
    if (refreshPending.current) return
    refreshPending.current=true
    if (!silent) setError('')
    try {
      const [data,uac]=await Promise.all([
        request('/api/v1/rmm/epm/file-requests'),
        request('/api/v1/rmm/epm/uac-reviews'),
      ])
      setRows(data.requests || [])
      setUacReviews(uac.requests || [])
    } catch (e) { if (!silent) setError(e.message) }
    finally { refreshPending.current=false }
  }
  useEffect(() => {
    refresh()
    // Native UAC reviews expire after five minutes. Keep the technician
    // queue current without manual refreshes or overlapping fetches.
    const timer=window.setInterval(() => {
      if (document.visibilityState==='visible') refresh({silent:true})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])
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
  async function decideReview() {
    if(!review || reviewNote.trim().length<10)return
    setReviewBusy(true);setError('');setMessage('')
    try {
      await request('/api/v1/rmm/epm/uac-reviews/'+encodeURIComponent(review.id)+'/decision','POST',{
        decision:review.decision,note:reviewNote.trim(),
      })
      setMessage(review.decision==='reviewed'
        ? 'UAC request reviewed. No administrator credential or elevation has been released.'
        : 'UAC review rejected. No elevation occurred.')
      setReview(null);setReviewNote('');await refresh()
    }catch(e){setError(e.message)}
    finally{setReviewBusy(false)}
  }
  return <div className="app-portal-admin">
    <header className="app-portal-hero">
      <div><span className="rmm-eyebrow">Endpoint security / privilege management</span>
        <h2>File elevation requests</h2>
        <p>Approve a specific signed executable for one user and device. This does not deploy an App Portal package or grant general administrator membership.</p></div>
      <button className="rmm-secondary" type="button" disabled={busy} onClick={() => refresh()}><RefreshCw size={15}/> Refresh</button>
    </header>
    {error && <p role="alert" className="app-portal-notice error">{error}</p>}
    {message && <p role="status" className="app-portal-notice success">{message}</p>}
    <section className="app-portal-stats">
      <article><strong>{rows.filter(r=>r.status==='pending').length}</strong><span>Awaiting review</span></article>
      <article><strong>{rows.filter(r=>r.status==='approved').length}</strong><span>Approved</span></article>
      <article><strong>{rows.filter(r=>r.status==='redeemed').length}</strong><span>Redeemed once</span></article>
    </section>
    <section className="app-portal-card app-portal-wide">
      <div className="app-portal-card-title"><div>
        <h3><ShieldCheck size={17}/> Native Windows UAC requests — security review</h3>
        <small>Automatically updates every 5 seconds while this page is open.</small>
        <p>These requests come from the Windows credential prompt, but Windows does not disclose a verified underlying application or operation to this provider. A technician can record a review decision; this build cannot release administrator credentials, resume UAC or elevate an unknown operation.</p>
      </div></div>
      {!uacReviews.length && <p>No native UAC review requests have been received.</p>}
      {uacReviews.map(r=><article className="app-portal-approval-item" key={'uac-'+r.id}>
        <div className="app-portal-approval-summary" style={{overflowWrap:'anywhere'}}>
          <strong>Unidentified Windows UAC operation</strong>
          <small>{r.requester_name || r.requester_sid} · {new Date(r.created_at).toLocaleString()}</small>
          <small><b>Device:</b> {r.agent_device_id} · <b>Session:</b> {r.requester_session_id}</small>
          <small><b>UAC process:</b> {r.consent_process_id} · <b>Started:</b> {new Date(r.consent_process_started_at).toLocaleString()}</small>
          <small><b>Expires:</b> {new Date(r.expires_at).toLocaleTimeString()}</small>
          <p><b>Business justification:</b> {r.business_reason}</p>
          {r.decision_note && <p><b>Technician review:</b> {r.decision_note}</p>}
          <p><b>Security boundary:</b> No verified target, no credential release and no elevation. This is not an elevation approval.</p>
        </div>
        <span className="app-portal-state">{r.status}</span>
        {r.status==='pending' && <span className="app-portal-request-actions">
          <button type="button" disabled={reviewBusy||busy} className="app-portal-text-action"
            onClick={()=>{setReview({id:r.id,decision:'reviewed'});setReviewNote('')}}>Record review</button>
          <button type="button" disabled={reviewBusy||busy} className="app-portal-text-action"
            onClick={()=>{setReview({id:r.id,decision:'rejected'});setReviewNote('')}}>Reject</button>
        </span>}
      </article>)}
      {review && <section className="app-portal-card">
        <h3>{review.decision==='reviewed'?'Record UAC security review':'Reject UAC request'}</h3>
        <p>No administrator credential will be released and Windows UAC will not resume from this decision. The underlying operation remains unidentified.</p>
        <label>Review explanation<textarea value={reviewNote} rows="3"
          onChange={e=>setReviewNote(e.target.value)}
          placeholder="Explanation (minimum 10 characters)" /></label>
        <div className="app-portal-request-actions">
          <button type="button" className="rmm-primary" disabled={reviewBusy||reviewNote.trim().length<10}
            onClick={decideReview}>Save review</button>
          <button type="button" disabled={reviewBusy} onClick={()=>setReview(null)}>Cancel</button>
        </div>
      </section>}
    </section>
    <section className="app-portal-card app-portal-wide">
      <div className="app-portal-card-title"><div><h3><ShieldCheck size={17}/> Executable approval queue</h3>
        <p>Trust status and SHA-256 are independently rechecked by the Windows broker before execution. A UAC tile request targets the EXE manually selected by the employee; it does not automatically resume the original UAC action.</p></div></div>
      {!rows.length && <p>No file elevation requests. The Newtest Lenovo pilot only accepts signed, locally verified EXE files.</p>}
      {rows.map(r=><article className="app-portal-approval-item" key={r.id}>
        <div className="app-portal-approval-summary" style={{overflowWrap:'anywhere'}}>
          <strong>{r.file_name}</strong>
          <small>{r.requester_name || r.requester_sid} · {new Date(r.created_at).toLocaleString()}</small>
          <small><b>Origin:</b> {r.request_source==='native-uac'
            ? 'Windows UAC — user explicitly selected and verified EXE'
            : 'Explorer / browser — selected EXE'}</small>
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
