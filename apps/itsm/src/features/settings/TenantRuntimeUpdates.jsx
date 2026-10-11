import {useEffect,useState} from 'react'
import {CheckCircle2,Clock3,ExternalLink,RefreshCw,ShieldCheck} from 'lucide-react'
import './TenantRuntimeUpdates.css'

const BASE=window.__HI5_API_BASE__||''
const ITEMS=[
  {key:'login',title:'Login, MFA and tenant access'},
  {key:'navigation',title:'Updated features and navigation'},
  {key:'records',title:'Incidents, requests and tasks regression'},
  {key:'mobile',title:'Mobile layout, permissions and accessibility'},
]
async function request(path,options={}){
 const r=await fetch(BASE+'/api/v1/release-management/runtime-updates'+path,{
  credentials:'include',cache:'no-store',...options,
  headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},
 })
 const data=await r.json().catch(()=>({}))
 if(!r.ok)throw Object.assign(Error(data.error||'Could not load customer updates.'),{status:r.status})
 return data
}
const when=v=>v?new Date(v).toLocaleString('en-GB'):'Not scheduled'
const displayState=v=>String(v||'pending').replaceAll('_',' ')
const short=v=>String(v||'').slice(0,8)
export function TenantRuntimeUpdates({updateMode}){
 const [data,setData]=useState(null)
 const [loading,setLoading]=useState(true)
 const [unsupported,setUnsupported]=useState(false)
 const [busy,setBusy]=useState('')
 const [error,setError]=useState('')
 const [message,setMessage]=useState('')
 const [checks,setChecks]=useState([])
 const [evidence,setEvidence]=useState('')
 const [date,setDate]=useState('')
 async function load(){
  try{
   const r=await request('')
   setData(r);setUnsupported(false);setError('')
  }catch(e){if(e.status===403||e.status===404){setUnsupported(true)}
   else setError(e.message)}
  finally{setLoading(false)}
 }
 useEffect(()=>{load()},[])
 async function accept(offer){
  if(checks.length!==ITEMS.length||evidence.trim().length<20){
   setError('Complete all four checks and provide at least 20 characters of UAT evidence.');return
  }
  if(!window.confirm('Confirm this precise UAT build was tested and accepted by your organisation?'))return
  setBusy(offer.id);setError('');setMessage('')
  try{
   await request('/'+offer.id+'/accept-uat',{method:'POST',
    body:JSON.stringify({checks,notes:evidence})})
   setMessage('UAT accepted. This version may now be scheduled for Production.')
   setChecks([]);setEvidence('');await load()
  }catch(e){setError(e.message)}finally{setBusy('')}
 }
 async function schedule(offer){
  if(!window.confirm('Schedule this exact UAT-approved version for your Production workspace? This only queues the update; it does not deploy it immediately.'))return
  setBusy(offer.id);setError('');setMessage('')
  try{
   const res=await request('/'+offer.id+'/schedule',{method:'POST',
    body:JSON.stringify({confirm:true,requestedAt:date?new Date(date).toISOString():null})})
   setMessage(res.message||'Production update scheduled for host verification.')
   await load()
  }catch(e){setError(e.message)}finally{setBusy('')}
 }
 if(unsupported)return null
 if(loading)return <section className="production-settings-panel"><div className="hi5-release-loading">
  <RefreshCw size={17}/> Checking customer version updates…</div></section>
 if(!data)return null
 const offers=data.updateOffers||[]
 const uat=offers.filter(x=>x.environment==='uat')
 const live=offers.filter(x=>x.environment==='live')
 return <section className="production-settings-panel" data-hi5-customer-runtime-updates>
  <header><div><h2>Application versions & customer updates</h2>
   <p>Your version assignments are independent of other customers. UAT acceptance and Production release approvals are recorded separately.</p>
   </div><button type="button" className="hi5-release-refresh" onClick={load}><RefreshCw size={15}/> Refresh</button>
  </header>
  <div className="production-settings-panel-body hi5-runtime-updates">
   {error?<p className="hi5-release-message is-error" role="alert">{error}</p>:null}
   {message?<p className="hi5-release-message is-success" role="status">{message}</p>:null}
   <div className="hi5-runtime-updates-meta">
    <span><ShieldCheck size={16}/> {data.mode==='hi5_managed'?'Hi5Central managed':'Customer controlled'}</span>
    <small>Production routing only changes after host verification. An available update is not yet installed.</small>
   </div>
   {!offers.length?<div className="hi5-release-sandbox-guidance">
    <strong>No customer-specific application update is pending</strong>
    <p>New versions appear here after Hi5Central publishes them and prepares a verified UAT runtime for your organisation.</p>
   </div>:null}
   {uat.map(offer=><article className="hi5-runtime-update" key={offer.id}>
    <div className="hi5-runtime-update-header">
     <div><span>UAT · {displayState(offer.state)}</span>
      <strong>{offer.versionLabel||'Application release'} · {offer.title||'Hi5Central update'}</strong>
      <small>Build {short(offer.buildSha)} · {displayState(offer.state)}</small></div>
     <a href={'https://'+window.location.hostname.split('.')[0]+'-uat.'+window.location.hostname.split('.').slice(1).join('.')}
      target="_blank" rel="noreferrer"><ExternalLink size={14}/> Open UAT</a>
    </div>
    {offer.state==='uat_testing'?<div className="hi5-runtime-uat-accept">
      <p>Review the actual UAT version. All checks and recorded results are required before Production scheduling.</p>
      {ITEMS.map(item=><label key={item.key}>
       <input type="checkbox" checked={checks.includes(item.key)}
        onChange={e=>setChecks(list=>e.target.checked?[...list,item.key]:list.filter(x=>x!==item.key))}/>
       {item.title}
      </label>)}
      <textarea rows={3} maxLength={3000} value={evidence}
       onChange={e=>setEvidence(e.target.value)}
       placeholder="Describe what passed in UAT and any issues investigated."/>
      <button type="button" disabled={busy!==''||checks.length!==ITEMS.length||evidence.trim().length<20}
       onClick={()=>accept(offer)}><CheckCircle2 size={15}/> Accept tested UAT version</button>
    </div>:null}
    {offer.state==='offered'?<p className="hi5-runtime-update-pending">
     Awaiting a trusted host check that this exact build is serving your UAT URL.</p>:null}
    {offer.uatAcceptedAt?<small>Accepted on {when(offer.uatAcceptedAt)}</small>:null}
   </article>)}
   {live.map(offer=><article className="hi5-runtime-update" key={offer.id}>
     <div className="hi5-runtime-update-header">
      <div><span>Production · {displayState(offer.state)}</span>
       <strong>{offer.versionLabel||'Application release'} · {offer.title||'Hi5Central update'}</strong>
       <small>Build {short(offer.buildSha)}</small>
      </div><Clock3 size={17}/>
     </div>
     {offer.state==='offered'&&data.mode==='admin_controlled'?<div className="hi5-runtime-update-actions">
      <p>After UAT sign-off, schedule the approved version at a time that suits your organisation.</p>
      <label>Optional release time <input type="datetime-local" value={date} onChange={e=>setDate(e.target.value)}/></label>
      <button type="button" disabled={Boolean(busy)} onClick={()=>schedule(offer)}>
       <ShieldCheck size={15}/> Approve Production update</button>
     </div>:null}
     {data.mode==='hi5_managed'&&offer.state==='offered'?<p>
      Hi5Central will schedule this update after UAT approval, the configured delay and maintenance checks.</p>:null}
     {offer.state==='scheduled'?<p>Pending verified host activation from {when(offer.maintenanceNotBefore)}. Existing Production stays live until the switch succeeds.</p>:null}
   </article>)}
  </div>
 </section>
}
