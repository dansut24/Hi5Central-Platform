import {useEffect,useMemo,useState} from 'react'
import {ShieldCheck,LockKeyhole,RefreshCw} from 'lucide-react'

/** Human-approved REAL ten-tenant pilot. Never provisions tenants, deploys,
 * unpauses workers, or grants stage execution. Collapsed by default. */
export function GenericReleasePilotScope({api,canApprove=false}){
 const [data,setData]=useState(null)
 const [chosen,setChosen]=useState([])
 const [reason,setReason]=useState('')
 const [reviewedChange,setReviewedChange]=useState('')
 const [confirmation,setConfirmation]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [message,setMessage]=useState('')
 const [expanded,setExpanded]=useState(false)
 async function reload(){
  setBusy(true);setError('')
  try{
   const result=await api('/releases/generic-tenant-scope')
   setData(result)
  }catch(e){setError(e.message||'Scope review unavailable. Migration 169 may be pending.')}
  finally{setBusy(false)}
 }
 useEffect(()=>{
  let active=true
  api('/releases/generic-tenant-scope')
    .then(result=>{if(active)setData(result)})
    .catch(()=>{}) // Migration 169 may not be installed in Production yet.
  return()=>{active=false}
 },[api])
 const candidates=data?.candidates||[]
 const selected=useMemo(()=>candidates.filter(t=>chosen.includes(t.id)),[chosen,candidates])
 const managed=selected.filter(t=>t.update_mode==='hi5_managed').length
 const custom=selected.filter(t=>t.update_mode==='admin_controlled').length
 const rmm=selected.filter(t=>t.rmm===true).length
 const existing=(data?.pilot||[]).filter(x=>x.enabled)
 const valid=chosen.length===10&&managed===5&&custom===5&&rmm===2
  &&reason.trim().length>=25&&reviewedChange.trim().length>=8
  &&confirmation==='AUTHORISE_TEN_TENANT_PILOT'
 async function enrol(){
  if(!canApprove||!valid||busy||existing.length||data?.scope?.mode!=='pilot')return
  if(!window.confirm('Enrol exactly 10 named, fully onboarded tenants for reviewed pilot planning? This DOES NOT enable releases or unpause workers.'))return
  setBusy(true);setError('');setMessage('')
  try{
   await api('/releases/generic-tenant-scope/pilot',{
    method:'POST',body:JSON.stringify({tenantIds:chosen,reason,reviewedChange,confirmation})
   })
   setChosen([]);setConfirmation('')
   setMessage('Pilot admission recorded. Planning and execution still require independent release/stage approvals.')
   const next=await api('/releases/generic-tenant-scope')
   setData(next)
  }catch(e){setError(e.message||'Pilot authorisation was not saved.')}
  finally{setBusy(false)}
 }
 return <div className="rmm-card" style={{padding:16,marginBottom:18}}>
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap'}}>
   <div>
    <strong>Generic release tenant admission</strong>
    <p style={{fontSize:12,margin:'6px 0 0'}}>Start with 10 reviewed real tenants. Global new-customer automation remains locked until the observed trial and independent security review pass.</p>
   </div>
   <button type="button" className="rmm-secondary compact" onClick={()=>{setExpanded(v=>!v);if(!data)reload()}}>
    <LockKeyhole size={14}/>{expanded?'Hide pilot controls':'Pilot review'}
   </button>
  </div>
  {expanded&&<div style={{marginTop:14}}>
   <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
    <span className="rmm-status-pill">{data?.scope?.mode==='all_onboarded'?'General rollout scope approved':data?.scope?.mode==='pilot'?'Pilot admission only':'Scope not installed'}</span>
    <span className="rmm-status-pill">{existing.length} pilot tenants enrolled</span>
    <button className="rmm-secondary compact" type="button" disabled={busy} onClick={reload}><RefreshCw size={14}/> Refresh</button>
   </div>
   {error&&<p role="alert" style={{color:'var(--rmm-danger,#c75050)'}}>{error}</p>}
   {message&&<p role="status" style={{color:'var(--rmm-accent)'}}>{message}</p>}
   {existing.length>0?<p style={{fontSize:12}}>Approved pilot: {existing.map(x=>x.slug).join(', ')}. Scope changes require a separate audited review; existing enrolment cannot be silently replaced.</p>:null}
   {data?.scope?.mode==='pilot'&&existing.length===0&&
    <div>
     <p style={{fontSize:12}}>Select exactly 5 Managed, 5 Custom, including 2 ITSM+RMM tenants. Every selection must have completed the normal signup and onboarding wizard.</p>
     <p style={{fontSize:12}}><strong>Selected:</strong> {chosen.length}/10 · Managed {managed}/5 · Custom {custom}/5 · RMM-enabled {rmm}/2</p>
     <div style={{maxHeight:240,overflowY:'auto',border:'1px solid var(--rmm-border,#d7dce2)',borderRadius:10,padding:8}}>
      {candidates.map(t=><label key={t.id} style={{display:'flex',gap:9,padding:'5px 8px',alignItems:'center'}}>
       <input type="checkbox" checked={chosen.includes(t.id)} disabled={!canApprove||busy||(!chosen.includes(t.id)&&chosen.length>=10)}
        onChange={e=>setChosen(previous=>e.target.checked?[...previous,t.id]:previous.filter(id=>id!==t.id))}/>
       <span style={{flex:1}}>{t.slug}</span>
       <small>{t.update_mode==='hi5_managed'?'Managed':'Custom'}{t.rmm?' · RMM':''}</small>
      </label>)}
      {!candidates.length&&<p style={{fontSize:12}}>No onboarded ITSM tenants are available yet.</p>}
     </div>
     {canApprove&&<div style={{display:'grid',gap:10,marginTop:12}}>
      <label>Reviewed change / security reference
       <input value={reviewedChange} onChange={e=>setReviewedChange(e.target.value)} placeholder="PR #79 + independent approval"/>
      </label>
      <label>Reason and cohort review evidence (minimum 25 characters)
       <textarea rows={2} value={reason} onChange={e=>setReason(e.target.value)}/>
      </label>
      <label>Type AUTHORISE_TEN_TENANT_PILOT
       <input value={confirmation} autoComplete="off" onChange={e=>setConfirmation(e.target.value)}/>
      </label>
      <div><button type="button" className="rmm-primary" disabled={!valid||busy} onClick={enrol}>
       <ShieldCheck size={15}/> Enrol reviewed pilot only
      </button></div>
     </div>}
    </div>}
  </div>}
 </div>
}
