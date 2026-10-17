import {useEffect,useMemo,useState} from 'react'
import {CheckCircle2,Clock3,RefreshCw,ShieldCheck,ShieldAlert} from 'lucide-react'

const short=sha=>sha?String(sha).slice(0,12):'—'
const when=value=>value?new Date(value).toLocaleString('en-GB'):'—'

/** Staff-only surface. Nothing is routed by pressing Approve: the backend
 * verifies GitHub Actions, Dev health, role and the exact published notes
 * before atomically authorising customer delivery paths and queuing jobs.
 */
export function CertifiedReleaseControls({api,canApprove=false}){
  const [data,setData]=useState({published:[],certifications:[],fanout:[]})
  const [selected,setSelected]=useState('')
  const [runUrl,setRunUrl]=useState('')
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  async function refresh(){
    try{
      const next=await api('/releases/certifications')
      setData(next)
      setError('')
    }catch(e){setError(e.message||'Release certifications unavailable.')}
  }
  useEffect(()=>{
    let active=true
    api('/releases/certifications').then(x=>{
      if(active)setData(x)
    }).catch(e=>{if(active)setError(e.message)})
    const timer=setInterval(()=>{if(active)refresh().catch(()=>{})},30000)
    return()=>{active=false;clearInterval(timer)}
  },[api])
  const rows=useMemo(()=>new Map((data.certifications||[]).map(c=>[c.build_sha,c])),[data])
  const scan=new Map((data.fanout||[]).map(c=>[c.build_sha,c]))
  async function approve(){
    if(!selected||!runUrl){setError('Choose a published release and its exact official GitHub Actions run.');return}
    if(!window.confirm('Release '+short(selected)+' to customers? Managed will queue for its Production maintenance window; Custom will receive UAT and choose when to promote to Production.'))return
    setBusy('approve');setError('');setMessage('')
    try{
      const result=await api('/releases/certifications/approve',{
        method:'POST',body:JSON.stringify({buildSha:selected,ciRunUrl:runUrl.trim(),releaseToCustomers:true}),
      })
      setMessage(result.queued>0
        ?'Release authorised: '+result.queued+' tenant upgrades queued. Managed Production and Custom UAT follow customer maintenance windows.'
        :'Release authorised, but no new jobs were scheduled. Check eligible tenants, rollout scope and already queued releases.')
      await refresh()
    }catch(e){setError(e.message||'Release certification failed.')}
    finally{setBusy('')}
  }
  async function revoke(sha){
    if(!window.confirm('Revoke future release planning for '+short(sha)+'? Already running jobs require the global pause/rollback controls.'))return
    setBusy(sha);setError('')
    try{
      await api('/releases/certifications/'+sha+'/revoke',{method:'POST',body:'{}'})
      setMessage('Release certification revoked. Review Worker activity and pause any running wave separately.')
      await refresh()
    }catch(e){setError(e.message)}
    finally{setBusy('')}
  }
  return <section className="rmm-card" style={{padding:20,marginBottom:18}}>
    <div className="rmm-card-heading" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
      <div>
        <span className="rmm-eyebrow">GITHUB → DEV → CUSTOMER RELEASE</span>
        <h2>Release to customers</h2>
        <p>Select the exact tested GitHub commit and its prepared features and notes. This one action verifies the build and queues eligible customer upgrades.</p>
      </div>
      <button className="rmm-secondary compact" type="button" onClick={refresh} title="Refresh release fanout"><RefreshCw size={15}/> Refresh</button>
    </div>
    {canApprove&&<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(230px,1fr))',gap:12,margin:'16px 0'}}>
      <label>Published release
        <select value={selected} onChange={e=>setSelected(e.target.value)}>
          <option value="">Select commit and release notes</option>
          {(data.published||[]).map(r=><option key={r.build_sha} value={r.build_sha}>
            {r.version_label||short(r.build_sha)} · {r.title} ({short(r.build_sha)})
          </option>)}
        </select>
      </label>
      <label>Official successful GitHub Actions run URL
        <input type="url" value={runUrl} onChange={e=>setRunUrl(e.target.value)}
          placeholder="https://github.com/dansut24/Hi5Central-Platform/actions/runs/…" autoComplete="off"/>
      </label>
      <div style={{alignSelf:'end'}}>
        <button className="rmm-primary" disabled={Boolean(busy)||!selected||!runUrl}
          onClick={approve}><ShieldCheck size={16}/> Release to customers</button>
      </div>
    </div>}
    {error&&<p role="alert" style={{color:'var(--rmm-danger,#c75050)'}}><ShieldAlert size={16}/> {error}</p>}
    {message&&<p role="status" style={{color:'var(--rmm-accent)'}}><CheckCircle2 size={16}/> {message}</p>}
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',fontSize:13,textAlign:'left'}}>
        <thead><tr><th>Release</th><th>Certification</th><th>Last queue scan</th><th>Queued</th><th>Blocked</th><th>Actions</th></tr></thead>
        <tbody>
          {(data.published||[]).map(r=>{
            const cert=rows.get(r.build_sha),status=cert?.status||'awaiting approval',item=scan.get(r.build_sha)
            return <tr key={r.build_sha}>
              <td><strong>{r.version_label}</strong><div><small>{short(r.build_sha)} · {r.title}</small></div></td>
              <td>{status==='approved'?<><CheckCircle2 size={14}/> Approved</>:<><Clock3 size={14}/> {status}</>}</td>
              <td>{when(item?.last_scan_at)}</td>
              <td>{item?.last_queued_count??'—'}</td>
              <td>{item?.last_blocked_count??'—'}</td>
              <td>{canApprove&&status==='approved'
                ?<button className="rmm-secondary compact" disabled={Boolean(busy)} onClick={()=>revoke(r.build_sha)}>Revoke</button>
                :'—'}</td>
            </tr>
          })}
          {!data.published?.length&&<tr><td colSpan={6}>No release has been published yet. Prepare release notes in Dev first.</td></tr>}
        </tbody>
      </table>
    </div>
    <p style={{marginTop:10,fontSize:12,opacity:.75}}>
      The release action records authorisation and schedules durable jobs. Actual upgrades require the permitted maintenance window and host safety checks. Custom Production always requires customer-approved UAT promotion.
    </p>
  </section>
}
