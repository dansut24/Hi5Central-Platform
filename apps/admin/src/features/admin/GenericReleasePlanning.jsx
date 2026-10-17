import {useEffect,useMemo,useState} from 'react'
import {CheckCircle2,Clock3,LockKeyhole,RefreshCw,ShieldCheck,ShieldOff,AlertTriangle} from 'lucide-react'

const stageNames={test:'Test',uat:'UAT',live:'Production'}
const fmtTime=value=>value?new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'}):'—'
const abbrev=value=>value?String(value).slice(0,12):'—'
const statusLabel=v=>v==='eligible'?'Ready to schedule':v==='approval_required'?'Planning approval needed':v==='blocked'?'Policy blocked':v

/**
 * Platform-Admin generic release preview: human review and planning only.
 * Backend does not expose an execution grant, global unpause or route writer.
 */
export function GenericReleasePlanning({api,canApprove=false}){
 const [certifications,setCertifications]=useState([])
 const eligible=useMemo(()=>certifications.filter(x=>x.status==='approved'),[certifications])
 useEffect(()=>{
  let active=true
  api('/releases/certifications').then(r=>{
    if(active)setCertifications(r.certifications||[])
  }).catch(()=>{})
  return()=>{active=false}
 },[api])
 const [selected,setSelected]=useState('')
 const [preview,setPreview]=useState(null)
 const [details,setDetails]=useState(null)
 const [filter,setFilter]=useState('all')
 const [stage,setStage]=useState('test')
 const [expiresInHours,setExpiresInHours]=useState(24)
 const [reviewedChange,setReviewedChange]=useState('')
 const [reason,setReason]=useState('')
 const [confirmation,setConfirmation]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [message,setMessage]=useState('')
 const [expanded,setExpanded]=useState(false)
 const [executionExpanded,setExecutionExpanded]=useState(false)
 const [executionConfirmation,setExecutionConfirmation]=useState('')
 const [executionHours,setExecutionHours]=useState(2)
 const [executionReason,setExecutionReason]=useState('')
 const [executionReviewedChange,setExecutionReviewedChange]=useState('')

 useEffect(()=>{
  if(selected&&!eligible.some(x=>x.build_sha===selected)){
   setSelected('');setPreview(null);setDetails(null)
  }
 },[eligible,selected])

 async function load(sha=selected){
  if(!sha)return
  setBusy(true);setError('');setMessage('')
  try{
   const [p,a]=await Promise.all([
    api('/releases/generic-preview/'+encodeURIComponent(sha)),
    api('/releases/generic-stage-approvals/'+encodeURIComponent(sha)),
   ])
   setPreview(p);setDetails(a)
  }catch(e){
   setPreview(null);setDetails(null)
   setError(e.message||'Could not load read-only generic release preview.')
  }finally{setBusy(false)}
 }
 async function approve(){
  if(!selected||!canApprove||!preview||!details)return
  if(confirmation!=='AUTHORISE_PLANNING_ONLY'){
   setError('Type AUTHORISE_PLANNING_ONLY before recording this staff approval.');return
  }
  if(!window.confirm('Approve planning ONLY for '+stageNames[stage]+' on '+abbrev(selected)+'? This does not permit deployment or unpause workers.'))return
  setBusy(true);setError('');setMessage('')
  try{
   await api('/releases/generic-stage-approvals/'+selected+'/planning',{
    method:'POST',body:JSON.stringify({
      environment:stage,expiresInHours:Number(expiresInHours),reviewedChange,
      reason,confirmation,
    }),
   })
   setConfirmation('')
   setMessage(stageNames[stage]+' planning approval recorded. Execution remains disabled.')
   await Promise.all([
    api('/releases/generic-preview/'+selected).then(setPreview),
    api('/releases/generic-stage-approvals/'+selected).then(setDetails),
   ])
  }catch(e){setError(e.message||'Planning approval was not recorded.')}
  finally{setBusy(false)}
 }
 async function approveExecution(){
  if(!selected||!canApprove||!details?.approvals?.[stage]?.planning_enabled)return
  if(executionConfirmation!=='AUTHORISE_STAGE_EXECUTION'){
   setError('Type AUTHORISE_STAGE_EXECUTION to approve this release and environment.');return
  }
  if(!window.confirm('Grant execution authority for '+stageNames[stage]+' / '+abbrev(selected)+' for up to '+executionHours+' hours? This DOES NOT unpause workers or immediately deploy. Customer windows, UAT and gateway checks remain enforced.'))return
  setBusy(true);setError('');setMessage('')
  try{
   await api('/releases/generic-stage-approvals/'+selected+'/execution',{
    method:'POST',body:JSON.stringify({
     environment:stage,expiresInHours:Number(executionHours),reason:executionReason,
     reviewedChange:executionReviewedChange,confirmation:executionConfirmation,
    }),
   })
   setExecutionConfirmation('')
   setMessage('Execution stage approved. Workers remain globally paused until separately reviewed activation.')
   await Promise.all([
    api('/releases/generic-preview/'+selected).then(setPreview),
    api('/releases/generic-stage-approvals/'+selected).then(setDetails),
   ])
  }catch(e){setError(e.message||'Execution authorisation was not recorded.')}
  finally{setBusy(false)}
 }
 async function revoke(target){
  if(!selected||!canApprove||!window.confirm('Revoke '+stageNames[target]+' release planning permission for '+abbrev(selected)+'?'))return
  setBusy(true);setError('');setMessage('')
  try{
   await api('/releases/generic-stage-approvals/'+selected+'/revoke',{
    method:'POST',body:JSON.stringify({environment:target}),
   })
   setMessage(stageNames[target]+' stage authorisation revoked. No worker or rollout controls changed.')
   await Promise.all([
    api('/releases/generic-preview/'+selected).then(setPreview),
    api('/releases/generic-stage-approvals/'+selected).then(setDetails),
   ])
  }catch(e){setError(e.message||'Could not revoke the stage.')}
  finally{setBusy(false)}
 }
 const tenants=(preview?.tenants||[]).filter(t=>filter==='all'||t.status===filter)
 const decisions=preview?.stageApprovals||{}
 return <section className="rmm-card" style={{padding:20,marginBottom:18}}>
  <div className="rmm-card-heading" style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
   <div>
    <span className="rmm-eyebrow">GENERIC RELEASE SCHEDULING</span>
    <h2>Customer rollout planner</h2>
    <p>Review each tenant's next Test, UAT or Production maintenance window. Approval here permits planning only. Deployment remains separately secured.</p>
   </div>
   <span className="rmm-status-pill warning"><LockKeyhole size={14}/> Execution disabled</span>
  </div>
  <div style={{display:'flex',gap:12,alignItems:'end',flexWrap:'wrap',marginTop:12}}>
   <label style={{minWidth:230,flex:'1 1 280px'}}>Certified release
    <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setPreview(null);setDetails(null);setError('');setMessage('')}}>
     <option value="">Choose a certified Dev release</option>
     {eligible.map(c=><option key={c.build_sha} value={c.build_sha}>{c.version_label||abbrev(c.build_sha)} · {abbrev(c.build_sha)}</option>)}
    </select>
   </label>
   <button type="button" className="rmm-secondary compact" disabled={!selected||busy} onClick={()=>load()}>
    <RefreshCw size={15}/> {busy?'Checking…':'Preview release'}
   </button>
  </div>
  {error?<p role="alert" style={{color:'var(--rmm-danger,#c75050)',marginTop:10}}><AlertTriangle size={15}/> {error}</p>:null}
  {message?<p role="status" style={{color:'var(--rmm-accent)',marginTop:10}}><CheckCircle2 size={15}/> {message}</p>:null}
  {preview&&<div style={{marginTop:16}}>
   <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
    <span className="rmm-status-pill">{preview.scanned} tenants checked</span>
    <span className="rmm-status-pill healthy">{preview.eligible} approved to plan</span>
    <span className="rmm-status-pill warning">{preview.approvalBlocked} awaiting approval</span>
    <span className="rmm-status-pill">{preview.policyBlocked} policy-blocked</span>
    <span className="rmm-status-pill">{preview.globallyPaused?'Global worker paused':'Check worker state'}</span>
   </div>
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:10,marginTop:14}}>
    {['test','uat','live'].map(key=>{
     const approval=details?.approvals?.[key]
     const allowed=decisions[key]?.allowed===true
     return <div key={key} style={{border:'1px solid var(--rmm-border,#d7dce2)',borderRadius:12,padding:12}}>
      <strong>{stageNames[key]}</strong>
      <p style={{fontSize:12,margin:'7px 0'}}>{allowed?<><CheckCircle2 size={14}/> Planning approved</>:<><LockKeyhole size={14}/> Planning locked</>}</p>
      <small>{approval?.expires_at?'Expires '+fmtTime(approval.expires_at):'No active reviewed grant'}</small>
      <div style={{marginTop:8}}><small>Execution: <strong>{approval?.execution_enabled?'Separately authorised':'Disabled'}</strong></small></div>
      {canApprove&&approval?.planning_enabled&&<button type="button" className="rmm-secondary compact" style={{marginTop:9}} disabled={busy} onClick={()=>revoke(key)}>
       <ShieldOff size={14}/> Revoke
      </button>}
     </div>
    })}
   </div>
   <div style={{display:'flex',alignItems:'end',gap:12,margin:'17px 0 9px',flexWrap:'wrap'}}>
    <h3 style={{margin:0,flex:1}}>Tenant decisions</h3>
    <label>Filter
     <select value={filter} onChange={e=>setFilter(e.target.value)}>
      <option value="all">All tenants</option>
      <option value="eligible">Ready to schedule</option>
      <option value="approval_required">Awaiting approval</option>
      <option value="blocked">Policy blocked</option>
     </select>
    </label>
   </div>
   <div style={{overflowX:'auto'}}>
    <table style={{width:'100%',minWidth:620,fontSize:13,textAlign:'left'}}>
     <thead><tr><th>Tenant</th><th>Policy</th><th>Next environment</th><th>Next maintenance slot</th><th>Decision</th></tr></thead>
     <tbody>
      {tenants.map(t=><tr key={t.tenantId}>
       <td><strong>{t.slug}</strong></td>
       <td>{t.mode==='hi5_managed'?'Managed':'Custom'}</td>
       <td>{stageNames[t.proposedStage]||'—'}</td>
       <td>{fmtTime(t.proposedAt)}</td>
       <td title={t.reason||''}>{statusLabel(t.status)}<div><small>{t.reason||''}</small></div></td>
      </tr>)}
      {!tenants.length&&<tr><td colSpan={5}>No tenants match this filter.</td></tr>}
     </tbody>
    </table>
   </div>
   {canApprove&&<div style={{marginTop:18,padding:14,border:'1px solid var(--rmm-border,#d7dce2)',borderRadius:12}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
     <div><strong>Platform owner/admin: time-limited planning approval</strong>
      <p style={{fontSize:12,margin:'5px 0'}}>This does not grant execution, bypass UAT acceptance, or turn off the global pause.</p>
     </div>
     <button className="rmm-secondary compact" type="button" onClick={()=>setExpanded(v=>!v)}>{expanded?'Hide':'Review'}</button>
    </div>
    {expanded&&<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12,marginTop:12}}>
     <label>Environment
      <select value={stage} onChange={e=>setStage(e.target.value)}>
       <option value="test">Test</option><option value="uat">UAT</option><option value="live">Production planning ONLY</option>
      </select>
     </label>
     <label>Expiry (1–72 hours)
      <input type="number" min="1" max="72" value={expiresInHours} onChange={e=>setExpiresInHours(e.target.value)}/>
     </label>
     <label>Reviewed change/PR reference
      <input value={reviewedChange} onChange={e=>setReviewedChange(e.target.value)} placeholder="PR #79 / security review"/>
     </label>
     <label style={{gridColumn:'1 / -1'}}>Reason for authorisation (minimum 20 characters)
      <textarea rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Explain approved scope, tenants and maintenance window"/>
     </label>
     <label style={{gridColumn:'1 / -1'}}>Type AUTHORISE_PLANNING_ONLY
      <input value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="off"/>
     </label>
     <div><button type="button" className="rmm-primary" disabled={busy||confirmation!=='AUTHORISE_PLANNING_ONLY'||reason.trim().length<20||reviewedChange.trim().length<8} onClick={approve}>
      <ShieldCheck size={15}/> Authorise planning only
     </button></div>
    </div>}
   </div>}
   {details?.approvals?.[stage]?.planning_enabled&&canApprove?
    <div style={{marginTop:14,padding:14,border:'1px solid var(--rmm-border,#d7dce2)',borderRadius:12}}>
     <div style={{display:'flex',gap:10,alignItems:'center',justifyContent:'space-between'}}>
      <div><strong>Separate execution authorisation · {stageNames[stage]}</strong>
       <p style={{fontSize:12,margin:'5px 0'}}>Requires a current planning approval. This is not a deployment button or a global unpause.</p>
      </div>
      <button type="button" className="rmm-secondary compact" onClick={()=>setExecutionExpanded(v=>!v)}>
       {executionExpanded?'Hide':'Review execution'}
      </button>
     </div>
     {executionExpanded?<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12,marginTop:12}}>
      <label>Expiry (1–12 hours)
       <input type="number" min="1" max="12" value={executionHours} onChange={e=>setExecutionHours(e.target.value)}/>
      </label>
      <label>Reviewed change / certification
       <input value={executionReviewedChange} onChange={e=>setExecutionReviewedChange(e.target.value)} placeholder="PR #79, gateway and Test evidence"/>
      </label>
      <label style={{gridColumn:'1 / -1'}}>Why this exact stage is ready (minimum 20 characters)
       <textarea rows={2} value={executionReason} onChange={e=>setExecutionReason(e.target.value)}/>
      </label>
      <label style={{gridColumn:'1 / -1'}}>Type AUTHORISE_STAGE_EXECUTION
       <input value={executionConfirmation} onChange={e=>setExecutionConfirmation(e.target.value)} autoComplete="off"/>
      </label>
      <div><button type="button" className="rmm-secondary compact" disabled={busy||
       executionConfirmation!=='AUTHORISE_STAGE_EXECUTION'||executionReason.trim().length<20||
       executionReviewedChange.trim().length<8||!(Number(executionHours)>=1&&Number(executionHours)<=12)}
       onClick={approveExecution}><ShieldCheck size={15}/> Approve stage execution</button></div>
     </div>:null}
    </div>:null}
   <div style={{marginTop:12,display:'flex',gap:8,alignItems:'center'}}>
    <Clock3 size={14}/><small>Preview is read-only. Live customer upgrades require a separate execution approval, maintenance gate and host verification.</small>
   </div>
  </div>}
 </section>
}
