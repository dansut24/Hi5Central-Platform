import {useEffect,useMemo,useState} from 'react'
import {CheckCircle2,Clock3,RefreshCw,ShieldCheck,ShieldAlert} from 'lucide-react'

const short=sha=>sha?String(sha).slice(0,12):'—'
const when=value=>value?new Date(value).toLocaleString('en-GB'):'—'
const categories={feature:'New feature',improvement:'Improvement',fix:'Fix',
  security:'Security update',other:'Other'}

/**
 * Dev owns release drafts and submissions. Platform Admin may ONLY review,
 * reject or approve an immutable submitted SHA/CI/notes combination.
 * Customer fanout is performed solely by the signed central approval endpoint.
 */
export function CertifiedReleaseControls({api,canApprove=false}){
 const [data,setData]=useState({published:[],certifications:[],fanout:[]})
 const [submissions,setSubmissions]=useState([])
 const [selected,setSelected]=useState('')
 const [rejectReason,setRejectReason]=useState('')
 const [busy,setBusy]=useState('')
 const [error,setError]=useState('')
 const [message,setMessage]=useState('')
 const rows=useMemo(()=>new Map((data.certifications||[]).map(c=>[c.build_sha,c])),[data])
 const scan=new Map((data.fanout||[]).map(c=>[c.build_sha,c]))
 const current=submissions.find(item=>item.build_sha===selected)
 async function refresh(){
  const [releases,proposals]=await Promise.allSettled([
   api('/releases/certifications'),api('/releases/dev-submissions'),
  ])
  if(releases.status==='fulfilled')setData(releases.value)
  else setError(releases.reason?.message||'Release history unavailable.')
  if(proposals.status==='fulfilled'){
   const next=proposals.value.submissions||[]
   setSubmissions(next)
   setSelected(old=>next.some(item=>item.build_sha===old)?old:
     next.find(item=>item.status==='submitted')?.build_sha||'')
  }else setError(proposals.reason?.message||'Dev submissions unavailable.')
 }
 useEffect(()=>{
  let active=true
  refresh().catch(e=>{if(active)setError(e.message)})
  const timer=setInterval(()=>{if(active)refresh().catch(()=>{})},30000)
  return()=>{active=false;clearInterval(timer)}
 },[api])
 async function approve(){
  if(!current||current.status!=='submitted'||busy)return
  if(!window.confirm('Approve Dev submission '+short(current.build_sha)+
      ' and release it to ALL eligible ITSM customers? Managed schedules Production; Custom stages UAT.'))return
  setBusy('approve');setError('');setMessage('')
  try{
   const result=await api('/releases/certifications/approve',{
    method:'POST',body:JSON.stringify({buildSha:current.build_sha,
      ciRunUrl:current.ci_run_url,releaseToCustomers:true}),
   })
   setMessage('Approved Dev submission '+short(current.build_sha)+
     '. Queued '+(result.queued||0)+' customer jobs; '+(result.superseded||0)+' older jobs superseded.')
   await refresh()
  }catch(e){setError(e.message||'Release approval failed; customers were not queued.')}
  finally{setBusy('')}
 }
 async function reject(){
  if(!current||current.status!=='submitted'||busy||rejectReason.trim().length<8)return
  if(!window.confirm('Reject this Dev submission? The Dev author may revise and resubmit it.'))return
  setBusy('reject');setError('');setMessage('')
  try{
   await api('/releases/dev-submissions/'+current.build_sha+'/reject',{
    method:'POST',body:JSON.stringify({reason:rejectReason.trim()}),
   })
   setMessage('Rejected with reason. Dev may revise and resubmit.')
   setRejectReason('')
   await refresh()
  }catch(e){setError(e.message||'Could not reject release submission.')}
  finally{setBusy('')}
 }
 async function revoke(sha){
  if(!window.confirm('Revoke future release planning for '+short(sha)+'?'))return
  setBusy('revoke');setError('')
  try{
   await api('/releases/certifications/'+sha+'/revoke',{method:'POST',body:'{}'})
   setMessage('Certification revoked. Existing recorded jobs remain auditable.')
   await refresh()
  }catch(e){setError(e.message||'Revocation failed.')}
  finally{setBusy('')}
 }
 const pending=submissions.filter(item=>item.status==='submitted').length
 return <section className="rmm-card" style={{padding:20,marginBottom:18}}>
  <div className="rmm-card-heading" style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'flex-start'}}>
   <div><span className="rmm-eyebrow">GITHUB → DEV SUBMISSION → ADMIN APPROVAL</span>
    <h2>Application releases</h2>
    <p>Developers select and test the GitHub commit in Dev, then submit its release notes. Platform Admin reviews that exact submission before any customer rollout.</p>
   </div>
   <button className="rmm-secondary compact" type="button" onClick={()=>refresh().catch(()=>{})}>
    <RefreshCw size={15}/> Refresh</button>
  </div>
  <div style={{padding:'12px 0',fontSize:13}}>
   <strong>{pending} awaiting Platform Admin review</strong>
   <p style={{marginTop:7,opacity:.8}}>Release notes are authored in Dev and locked on submission. Admin cannot change the selected SHA or notes.</p>
  </div>
  {submissions.length?<label style={{display:'block',margin:'12px 0'}}>
   Dev release submission
   <select value={selected} disabled={Boolean(busy)} onChange={e=>{setSelected(e.target.value);setRejectReason('')}}>
    <option value="">Select a submitted release</option>
    {submissions.map(item=><option key={item.build_sha} value={item.build_sha}>
      {short(item.build_sha)} · {item.notes?.versionLabel||'Draft'} · {item.notes?.title||'Untitled'} — {item.status}
    </option>)}
   </select>
  </label>:<p>No Dev releases have been submitted yet. Developers prepare them in dev.hi5central.com.</p>}
  {current?<div style={{padding:14,border:'1px solid var(--rmm-border,#d7dce2)',borderRadius:10}}>
   <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
    <strong>{current.notes?.versionLabel||'Unversioned'} · {current.notes?.title||'Untitled'}</strong>
    <span>{current.status.toUpperCase()}</span>
   </div>
   <p>{current.notes?.summary||''}</p>
   <small>GitHub SHA: {current.build_sha} · Submitted: {when(current.submitted_at)}</small>
   {current.ci_run_url?<p><a href={current.ci_run_url} target="_blank" rel="noreferrer">
    View exact successful GitHub release candidate ↗</a></p>:null}
   <h3 style={{fontSize:14,margin:'14px 0 8px'}}>Dev-submitted features and release notes</h3>
   {(current.notes?.entries||[]).map((entry,i)=><div key={i} style={{
    padding:'9px 0',borderTop:'1px solid var(--rmm-border,#d7dce2)'}}>
    <strong>{entry.title}</strong> <small>· {categories[entry.category]||'Other'}</small>
    <p style={{fontSize:13,marginTop:5}}>{entry.description||'No description'}</p>
   </div>)}
   {current.notes?.internalNotes?<section aria-label="Private developer notes" style={{
    marginTop:14,padding:12,borderRadius:8,border:'1px solid var(--rmm-border,#d7dce2)'}}>
    <strong>Internal Dev notes — Hi5Central staff only</strong>
    <p style={{whiteSpace:'pre-wrap',fontSize:13,marginTop:8}}>{current.notes.internalNotes}</p>
   </section>:null}
   {current.status==='draft'||current.status==='submitted'?<p style={{marginTop:12,fontSize:12,opacity:.7}}>
    Upcoming preview: {current.notes?.upcomingVisible===true?'Visible to customers as Planned':'Private'}
   </p>:null}
   {current.status==='rejected'&&<p role="status">Rejection reason: {current.rejection_reason}</p>}
   {current.status==='submitted'&&canApprove?<div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:16}}>
    <button type="button" className="rmm-primary" disabled={Boolean(busy)} onClick={approve}>
      <ShieldCheck size={16}/> {busy==='approve'?'Releasing…':'Approve & release to customers'}</button>
    <label style={{flex:'1 1 240px'}}>Reason for rejection
      <input value={rejectReason} disabled={Boolean(busy)} maxLength={500}
        onChange={e=>setRejectReason(e.target.value)} placeholder="What must the Dev team fix?"/>
    </label>
    <button type="button" className="rmm-secondary" disabled={Boolean(busy)||rejectReason.trim().length<8}
      onClick={reject}>Reject submission</button>
   </div>:null}
  </div>:null}
  {error?<p role="alert" style={{color:'var(--rmm-danger,#c75050)'}}>
    <ShieldAlert size={16}/> {error}</p>:null}
  {message?<p role="status"><CheckCircle2 size={15}/> {message}</p>:null}
  <div style={{overflowX:'auto',marginTop:20}}>
   <h3 style={{fontSize:15,marginBottom:10}}>Approved customer releases</h3>
   <table style={{width:'100%',fontSize:13,textAlign:'left'}}>
    <thead><tr><th>Release</th><th>Certification</th><th>Last queue scan</th><th>Queued</th><th>Blocked</th><th>Actions</th></tr></thead>
    <tbody>{(data.published||[]).map(r=>{
     const cert=rows.get(r.build_sha),status=cert?.status||'not certified',item=scan.get(r.build_sha)
     return <tr key={r.build_sha}>
      <td><strong>{r.version_label}</strong><div><small>{short(r.build_sha)} · {r.title}</small></div></td>
      <td>{status==='approved'?<><CheckCircle2 size={14}/> Approved</>:<><Clock3 size={14}/> {status}</>}</td>
      <td>{when(item?.last_scan_at)}</td><td>{item?.last_queued_count??'—'}</td>
      <td>{item?.last_blocked_count??'—'}</td>
      <td>{canApprove&&status==='approved'?
       <button className="rmm-secondary compact" type="button" disabled={Boolean(busy)}
         onClick={()=>revoke(r.build_sha)}>Revoke</button>:'—'}</td>
     </tr>
    })}</tbody>
   </table>
  </div>
  <p style={{fontSize:12,opacity:.78,marginTop:12}}>
   Managed releases automatically enter Production maintenance windows. Custom receives UAT first, then the customer approves Production. Both tracks use the same two release workers.
  </p>
 </section>
}
