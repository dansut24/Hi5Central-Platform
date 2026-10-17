import {useEffect,useMemo,useState} from 'react'
import {CheckCircle2,Clock3,RefreshCw,ShieldCheck,ShieldAlert,Plus,Trash2,Save} from 'lucide-react'

const short=sha=>sha?String(sha).slice(0,12):'—'
const when=value=>value?new Date(value).toLocaleString('en-GB'):'—'
const emptyNotes=()=>({versionLabel:'',title:'',summary:'',
  entries:[{category:'feature',title:'',description:''}]})
const categories=['feature','improvement','fix','security','other']

/** One customer release action. Drafts are editable before publication;
 * the server verifies exact GitHub CI+Dev and schedules both tenant tracks.
 */
export function CertifiedReleaseControls({api,canApprove=false}){
 const [data,setData]=useState({published:[],certifications:[],fanout:[]})
 const [candidates,setCandidates]=useState([])
 const [selected,setSelected]=useState('')
 const [notes,setNotes]=useState(emptyNotes)
 const [isPublished,setIsPublished]=useState(false)
 const [busy,setBusy]=useState('')
 const [error,setError]=useState('')
 const [message,setMessage]=useState('')
 const [pickerError,setPickerError]=useState('')
 const [loadingNotes,setLoadingNotes]=useState(false)
 const rows=useMemo(()=>new Map((data.certifications||[]).map(c=>[c.build_sha,c])),[data])
 const scan=new Map((data.fanout||[]).map(c=>[c.build_sha,c]))
 const candidate=candidates.find(item=>item.buildSha===selected)
 async function refresh(){
  const [releases,candidateList]=await Promise.allSettled([
   api('/releases/certifications'),api('/releases/candidates'),
  ])
  if(releases.status==='fulfilled')setData(releases.value)
  else setError(releases.reason?.message||'Release history unavailable.')
  if(candidateList.status==='fulfilled'){
   setCandidates(candidateList.value.candidates||[])
   setPickerError('')
  }else setPickerError(candidateList.reason?.message||'GitHub candidates unavailable.')
 }
 useEffect(()=>{
  let active=true
  Promise.allSettled([api('/releases/certifications'),api('/releases/candidates')])
   .then(([r,g])=>{
    if(!active)return
    if(r.status==='fulfilled')setData(r.value)
    if(g.status==='fulfilled')setCandidates(g.value.candidates||[])
    else setPickerError(g.reason?.message||'GitHub release list unavailable.')
   }).catch(()=>{})
  const timer=setInterval(()=>{if(active)refresh().catch(()=>{})},30000)
  return()=>{active=false;clearInterval(timer)}
 },[api])
 useEffect(()=>{
  let active=true
  setIsPublished(false);setNotes(emptyNotes());setError('');setMessage('')
  if(!selected)return()=>{active=false}
  setLoadingNotes(true)
  api('/releases/preparations/'+selected).then(result=>{
   if(!active)return
   const next=result.published||result.draft
   if(next)setNotes({...emptyNotes(),...next,
    entries:Array.isArray(next.entries)&&next.entries.length?next.entries:emptyNotes().entries})
   setIsPublished(Boolean(result.published))
  }).catch(error=>{if(active)setError(error.message||'Cannot load release notes.')})
   .finally(()=>{if(active)setLoadingNotes(false)})
  return()=>{active=false}
 },[api,selected])
 const update=(name,value)=>setNotes(current=>({...current,[name]:value}))
 const updateEntry=(index,name,value)=>setNotes(current=>({
  ...current,entries:current.entries.map((entry,i)=>i===index?{...entry,[name]:value}:entry),
 }))
 function addEntry(){
  setNotes(current=>({...current,entries:[...current.entries,
   {category:'feature',title:'',description:''}]}))
 }
 async function saveDraft(){
  if(!selected||busy||isPublished)return
  setBusy('draft');setError('');setMessage('')
  try{
   await api('/releases/preparations/'+selected,{
    method:'PUT',body:JSON.stringify({notes}),
   })
   setMessage('Release notes saved for commit '+short(selected)+'. No release has been sent.')
  }catch(e){setError(e.message||'Could not save the draft.')}
  finally{setBusy('')}
 }
 async function release(){
  if(!selected||!candidate||busy||loadingNotes){
   setError('Select a GitHub release candidate that has completed successfully.');return
  }
  if(!notes.versionLabel.trim()||!notes.title.trim()||notes.entries.length===0
     ||notes.entries.some(entry=>entry.title.trim().length<3)){
   setError('Add a version, title and at least one feature, improvement or fix.');return
  }
  if(!window.confirm('Release '+short(selected)+' to customers? Managed will enter its Production maintenance queue; Custom will receive UAT and must approve Production itself.'))return
  setBusy('release');setError('');setMessage('')
  try{
   const result=await api('/releases/certifications/approve',{
    method:'POST',body:JSON.stringify({buildSha:selected,ciRunUrl:candidate.ciRunUrl,
     releaseNotes:notes,releaseToCustomers:true}),
   })
   setIsPublished(true)
   setMessage(result.globallyPaused
    ?'Release published and '+result.queued+' jobs queued. Actual upgrades remain held by the platform safety pause.'
    :result.queued
     ?'Release published: '+result.queued+' new Managed Production / Custom UAT jobs queued within customer windows.'
     :'Release published; no new eligible tenant jobs. Check rollout admission and existing jobs.')
   await refresh()
  }catch(e){setError(e.message||'Release was not published. Nothing was deployed.')}
  finally{setBusy('')}
 }
 async function revoke(sha){
  if(!window.confirm('Revoke future release planning for '+short(sha)+'?'))return
  setBusy(sha);setError('')
  try{
   await api('/releases/certifications/'+sha+'/revoke',{method:'POST',body:'{}'})
   setMessage('Release certification revoked. Inspect Worker activity for existing jobs.')
   await refresh()
  }catch(e){setError(e.message||'Could not revoke release.')}
  finally{setBusy('')}
 }
 return <section className="rmm-card" style={{padding:20,marginBottom:18}}>
  <div className="rmm-card-heading" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
   <div>
    <span className="rmm-eyebrow">GITHUB → DEV → RELEASE TO CUSTOMERS</span>
    <h2>Application releases</h2>
    <p>Select a successful commit, prepare the features and notes, then release once. The scheduler handles every eligible customer's maintenance window.</p>
   </div>
   <button className="rmm-secondary compact" type="button" onClick={()=>refresh().catch(()=>{})} title="Refresh releases"><RefreshCw size={15}/> Refresh</button>
  </div>
  {canApprove&&<div style={{margin:'16px 0'}}>
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:12}}>
    <label>Verified GitHub candidate
     <select value={selected} disabled={Boolean(busy)} onChange={e=>setSelected(e.target.value)}>
      <option value="">Choose GitHub commit</option>
      {candidates.map(run=><option key={run.ciRunUrl} value={run.buildSha}>
       {short(run.buildSha)} · {run.branch||'release'} · {when(run.createdAt)}
      </option>)}
     </select>
    </label>
    <div style={{alignSelf:'end',fontSize:12}}>
     {candidate?<a href={candidate.ciRunUrl} target="_blank" rel="noreferrer">View successful GitHub Actions build ↗</a>
      :<span>Only successfully built release candidates are selectable.</span>}
     {pickerError&&<p role="alert" style={{color:'var(--rmm-danger,#c75050)'}}>{pickerError}</p>}
    </div>
   </div>
   {selected&&<div style={{marginTop:16}}>
    <p style={{fontSize:12,opacity:.8,marginBottom:10}}>
     {loadingNotes?'Loading prepared notes…':isPublished?'Published notes are immutable.':
      'Draft notes may be saved and edited while Development testing continues.'}
    </p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>
     <label>Customer version
      <input disabled={isPublished||Boolean(busy)||loadingNotes} value={notes.versionLabel}
       onChange={e=>update('versionLabel',e.target.value)} placeholder="1.2.0"/>
     </label>
     <label>Release title
      <input disabled={isPublished||Boolean(busy)||loadingNotes} value={notes.title}
       onChange={e=>update('title',e.target.value)} placeholder="October improvements"/>
     </label>
    </div>
    <label style={{display:'block',marginTop:12}}>Release summary
     <textarea rows={2} disabled={isPublished||Boolean(busy)||loadingNotes}
      value={notes.summary} onChange={e=>update('summary',e.target.value)}
      placeholder="What should customers know about this release?"/>
    </label>
    <h3 style={{fontSize:14,margin:'16px 0 8px'}}>Features and release notes</h3>
    {notes.entries.map((entry,i)=><div key={i} style={{border:'1px solid var(--rmm-border,#d7dce2)',
     borderRadius:10,padding:12,marginBottom:10}}>
     <div style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'end'}}>
      <label style={{width:145}}>Type
       <select disabled={isPublished||Boolean(busy)||loadingNotes} value={entry.category||'feature'}
        onChange={e=>updateEntry(i,'category',e.target.value)}>
        {categories.map(category=><option key={category} value={category}>{category}</option>)}
       </select>
      </label>
      <label style={{flex:'1 1 220px'}}>Feature or change
       <input disabled={isPublished||Boolean(busy)||loadingNotes} value={entry.title||''}
        onChange={e=>updateEntry(i,'title',e.target.value)} placeholder="Improved incident assignment"/>
      </label>
      {!isPublished&&notes.entries.length>1&&<button className="rmm-secondary compact" type="button"
       disabled={Boolean(busy)} onClick={()=>setNotes(current=>({...current,
        entries:current.entries.filter((_,index)=>index!==i)}))} title="Remove release note">
       <Trash2 size={14}/>
      </button>}
     </div>
     <label style={{display:'block',marginTop:9}}>Description
      <textarea rows={2} disabled={isPublished||Boolean(busy)||loadingNotes}
       value={entry.description||''} onChange={e=>updateEntry(i,'description',e.target.value)}
       placeholder="Describe the customer-facing improvement"/>
     </label>
    </div>)}
    {!isPublished&&<button type="button" className="rmm-secondary compact"
     disabled={Boolean(busy)||notes.entries.length>=35} onClick={addEntry}>
     <Plus size={14}/> Add feature or note
    </button>}
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',marginTop:16}}>
     {!isPublished&&<button className="rmm-secondary" type="button" disabled={Boolean(busy)||loadingNotes}
      onClick={saveDraft}><Save size={15}/> Save draft</button>}
     <button className="rmm-primary" type="button" disabled={Boolean(busy)||loadingNotes||!candidate}
      onClick={release}><ShieldCheck size={16}/> {busy==='release'?'Releasing…':'Release to customers'}</button>
    </div>
   </div>}
  </div>}
  {error&&<p role="alert" style={{color:'var(--rmm-danger,#c75050)'}}><ShieldAlert size={16}/> {error}</p>}
  {message&&<p role="status" style={{color:'var(--rmm-accent)'}}><CheckCircle2 size={14}/> {message}</p>}
  <div style={{overflowX:'auto',marginTop:14}}>
   <table style={{width:'100%',fontSize:13,textAlign:'left'}}>
    <thead><tr><th>Release</th><th>Certification</th><th>Last queue scan</th><th>Queued</th><th>Blocked</th><th>Actions</th></tr></thead>
    <tbody>
     {(data.published||[]).map(r=>{
      const cert=rows.get(r.build_sha),status=cert?.status||'not certified',item=scan.get(r.build_sha)
      return <tr key={r.build_sha}>
       <td><strong>{r.version_label}</strong><div><small>{short(r.build_sha)} · {r.title}</small></div></td>
       <td>{status==='approved'?<><CheckCircle2 size={14}/> Approved</>:<><Clock3 size={14}/> {status}</>}</td>
       <td>{when(item?.last_scan_at)}</td>
       <td>{item?.last_queued_count??'—'}</td>
       <td>{item?.last_blocked_count??'—'}</td>
       <td>{canApprove&&status==='approved'
        ?<button className="rmm-secondary compact" disabled={Boolean(busy)}
          onClick={()=>revoke(r.build_sha)}>Revoke</button>:'—'}</td>
      </tr>
     })}
     {!data.published?.length&&<tr><td colSpan={6}>No customer releases published yet.</td></tr>}
    </tbody>
   </table>
  </div>
  <p style={{fontSize:12,opacity:.78,marginTop:10}}>
   Managed updates queue directly for Production. Custom updates deploy to UAT and require customer approval for Production.
   Global safety pause, maintenance windows, tenant isolation, gateway locks and rollback protection remain mandatory.
  </p>
 </section>
}
