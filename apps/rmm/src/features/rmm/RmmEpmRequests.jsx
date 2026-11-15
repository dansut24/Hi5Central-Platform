import { useEffect, useRef, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'

// Display the exact pre-registered command that the Windows broker may run.
// These labels are informational; the API and Windows broker enforce the
// source-specific signed-file and arguments-digest binding independently.
const managedCommands={
  notepad: 'C:\\Windows\\System32\\notepad.exe (no arguments)',
  regedit: 'C:\\Windows\\regedit.exe (no arguments)',
  services: 'C:\\Windows\\System32\\mmc.exe services.msc',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NoExit',
  'msiexec-help': 'C:\\Windows\\System32\\msiexec.exe /?'
}
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
    if (!active || note.trim().length<(active.decision==='approved' ? (active.minNoteLength || 10) : 10)) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result=await request('/api/v1/rmm/epm/file-requests/'+encodeURIComponent(active.id)+'/decision','POST',{
        decision:active.decision,note:note.trim(),
      })
      setMessage(active.decision!=='approved'
        ? 'Request rejected. No executable has been elevated.'
        : result.approvalStage==='awaiting_second'
          ? 'First approval recorded. The request remains pending until a different authorised technician provides the second approval.'
          : active.autoLaunch
            ? 'Approved once for '+result.approvalMinutes+' minutes. The employee opted in to start the exact verified executable.'
            : 'Approved once for '+result.approvalMinutes+' minutes. The employee can click the notification to run the verified executable.')
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
        <p>Approve only a verified executable or registered managed Windows action for one user and device. Unidentified native UAC prompts remain review-only.</p>
        <p><b>Security policy:</b> {rows[0]?.epm_risk ? (
          rows.some(r=>r.epm_risk?.requiredApprovers===2)
            ? 'Production hardened: critical actions require separate technicians.'
            : 'Newtest scoped pilot: risk scores are enforced with short approvals; dual control is staged for production.'
          ) : 'No file requests to display.'}
        </p></div>
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
      <div className="app-portal-card-title"><div><h3><ShieldCheck size={17}/> Executable and managed Windows action approvals</h3>
        <p>Trust status and SHA-256 are independently rechecked by the Windows broker before execution. Managed Windows action requests bind one of five approved Windows binaries and its fixed arguments before the UAC prompt. They never resume the original UAC or elevate an unknown operation.</p></div></div>
      {!rows.length && <p>No file elevation requests. The Newtest Lenovo pilot only accepts signed, locally verified EXE files.</p>}
      {rows.map(r=><article className="app-portal-approval-item" key={r.id}>
        <div className="app-portal-approval-summary" style={{overflowWrap:'anywhere'}}>
          <strong>{r.file_name}</strong>
          <small>{r.requester_name || r.requester_sid} · {new Date(r.created_at).toLocaleString()}</small>
          <small><b>Origin:</b> {r.request_source==='managed-uac'
            ? 'Managed Windows UAC — exact operation preselected by employee'
            : r.request_source==='native-uac'
            ? 'Windows UAC — user explicitly selected and verified EXE'
            : 'Explorer / browser — selected EXE'}</small>
          {r.managed_action_code && <small>
            <b>Exact managed command:</b> {managedCommands[r.managed_action_code] || 'Unknown — do not approve'}
            {' '}· <b>Fixed arguments SHA-256:</b> {r.managed_arguments_sha256}
          </small>}
          <small><b>EPM risk:</b> <strong>{(r.epm_risk?.risk||'unclassified').toUpperCase()}</strong>
            {' '}· {r.epm_risk?.description || 'Assess before approving'}
            {' '}· {r.epm_risk?.allowed
              ? r.epm_risk.requiredApprovers+' technician approval(s), '+r.epm_risk.ttlMinutes+' minute authorisation'
              : 'Blocked by current policy'}
          </small>
          {r.first_approved_by_user_id && <small><b>First approval recorded:</b>
            {' '}another authorised technician must complete the decision
            {' '}· {new Date(r.first_approved_at).toLocaleString()}
          </small>}
          {r.epm_risk?.unrestrictedSession && <p><b>Elevated console warning:</b> An approved launch can change
            system state or spawn child processes; argument binding is not a command-level sandbox.
            Use narrowly scoped operations for routine work.</p>}
          <small><b>After approval:</b> {r.auto_launch_on_approval
            ? 'Auto-start the exact verified EXE (explicit employee opt-in)'
            : 'Notify employee to launch the EXE manually'}</small>
          <small><b>Publisher:</b> {r.publisher}</small>
          <small><b>File:</b> {r.file_path}</small>
          <small><b>SHA-256:</b> {r.file_sha256}</small>
          <small><b>Signing thumbprint:</b> {r.signer_thumbprint}</small>
          <small><b>User SID:</b> {r.requester_sid} · <b>Device:</b> {r.agent_device_id}</small>
          <p><b>Business reason:</b> {r.business_reason}</p>
          {r.managed_action_code && <p><b>Execution:</b> RMM approval permits one
            separately launched Windows job for this preselected managed action.
            The original Windows UAC prompt is never authenticated or resumed.</p>}
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
          <button disabled={busy||!r.epm_risk?.allowed} className="app-portal-text-action approve" onClick={()=>{
            setActive({id:r.id,decision:'approved',autoLaunch:r.auto_launch_on_approval===true,
              minNoteLength:r.epm_risk?.minNoteLength||10,
              risk:r.epm_risk?.risk,approvers:r.epm_risk?.requiredApprovers||1,
              alreadyFirst:!!r.first_approved_by_user_id,
              ttlMinutes:r.epm_risk?.ttlMinutes||0});setNote('')
          }} type="button">{r.first_approved_by_user_id?'Second approval':r.epm_risk?.requiredApprovers===2?'First approval':'Approve once'}</button>
          <button disabled={busy} className="app-portal-text-action" onClick={()=>{setActive({id:r.id,decision:'rejected'});setNote('')}} type="button">Reject</button>
        </span>}
      </article>)}
    </section>
    {active && <section className="app-portal-card">
      <h3>{active.decision==='approved'
        ? active.approvers===2?(active.alreadyFirst?'Second independent approval':'First break-glass approval')
          :'Approve one-time elevation'
        :'Reject elevation'}</h3>
      <p><b>Risk:</b> {active.risk||'unclassified'} · <b>Approval window:</b> {active.ttlMinutes||0} minutes.
        {active.approvers===2 && ' A different qualified technician must authorise the second stage before launch.'}
      </p>
      <p>{active.decision==='approved'
        ? 'Approval expires after 15 minutes and is consumed on its first attempted launch. '+
          (active.autoLaunch
            ? 'The user opted to start this exact signed executable automatically after your approval.'
            : 'The user must click the notification or retry the verified file.')
        : 'No elevation will be permitted.'}</p>
      <label>Decision explanation<textarea value={note} rows="3" onChange={e=>setNote(e.target.value)}
        placeholder={'Explain this decision (minimum '+(active.decision==='approved'?active.minNoteLength:10)+' characters)'} /></label>
      <div className="app-portal-request-actions">
        <button disabled={busy||note.trim().length<(active.decision==='approved'?active.minNoteLength:10)} className="rmm-primary" onClick={decide} type="button">Confirm decision</button>
        <button disabled={busy} onClick={()=>setActive(null)} type="button">Cancel</button>
      </div>
    </section>}
  </div>
}
