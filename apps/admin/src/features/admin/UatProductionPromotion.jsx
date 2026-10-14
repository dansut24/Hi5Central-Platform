import {useCallback,useEffect,useState} from 'react'
import {ArrowRight,CheckCircle2,Clock3,ExternalLink,RefreshCw,ShieldCheck,TriangleAlert} from 'lucide-react'
import './UatProductionPromotion.css'

const short=value=>String(value||'').slice(0,10)||'unknown'
const when=value=>{
  if(!value)return 'Not yet'
  const d=new Date(value)
  return Number.isNaN(d.getTime())?'Not recorded':d.toLocaleString('en-GB')
}
const stateLabel=value=>String(value||'pending').replaceAll('_',' ')

function promotionReadiness(item,uat,live,executor){
  if(!executor?.ready)return {ready:false,reason:executor?.reason||'A trusted application deployment executor is not connected.'}
  if(item.status!=='pending')return {ready:false,reason:'This request has already been reviewed.'}
  if(!item.version_label)return {ready:false,reason:'Publish release notes for this exact build first.'}
  if(String(item.evidence||'').trim().length<20)return {ready:false,reason:'UAT acceptance evidence is incomplete.'}
  if(!uat?.verified||uat.apiSha!==item.build_sha||uat.itsmSha!==item.build_sha)
    return {ready:false,reason:'Host verification of this precise UAT API and ITSM build is missing or has expired.'}
  if(live?.verified&&live.apiSha===item.build_sha&&live.itsmSha===item.build_sha)
    return {ready:false,reason:'Production already runs this revision.'}
  return {ready:true,reason:'Verified UAT build with recorded customer testing and published release notes.'}
}

/**
 * Platform Admin exclusively: approval enqueues a host-verified shared
 * Production deployment job. Browser JavaScript never invokes Docker,
 * selects arbitrary images or reports a build as installed.
 */
export function UatProductionPromotion({apiBase,canApprove=false}){
  const [state,setState]=useState({environments:{},jobs:[],reviewRequests:[],executor:{ready:false}})
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  const request=useCallback(async(path,options={})=>{
    const result=await fetch(apiBase+'/api/platform/v1/releases/'+path,{
      credentials:'include',cache:'no-store',...options,
      headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},
    })
    const data=await result.json().catch(()=>({}))
    if(!result.ok)throw new Error(data.error||'Release Management is unavailable.')
    return data
  },[apiBase])
  const refresh=useCallback(async(silent=false)=>{
    if(!silent)setLoading(true)
    try{
      const response=await request('application-deployments')
      setState({
        environments:response.environments||{},
        jobs:Array.isArray(response.jobs)?response.jobs:[],
        reviewRequests:Array.isArray(response.reviewRequests)?response.reviewRequests:[],
        executor:response.executor||{ready:false,reason:'The application deployment executor has not reported readiness.'},
      })
      setError('')
    }catch(e){setError(e.message)}
    finally{if(!silent)setLoading(false)}
  },[request])
  useEffect(()=>{refresh()},[refresh])
  useEffect(()=>{
    const hasJobs=state.jobs.some(x=>['requested','running'].includes(x.status))
    if(!hasJobs)return undefined
    const timer=window.setInterval(()=>refresh(true),15000)
    return()=>window.clearInterval(timer)
  },[state.jobs,refresh])
  async function decide(item,decision){
    const approve=decision==='approve'
    if(approve&&!window.confirm(
      'Promote UAT build '+short(item.build_sha)+' to SHARED Production?\n\n'+
      'This queues the exact reviewed API/ITSM images for a host deployment. '+
      'It can affect multiple customer workspaces. RMM is excluded. '+
      'Production traffic will not switch until independent host verification.'
    ))return
    if(!approve&&!window.confirm('Reject this UAT release request?'))return
    setBusy(item.request_key)
    setMessage('')
    setError('')
    try{
      const result=await request('application-release-requests/decision',{
        method:'POST',body:JSON.stringify({requestKey:item.request_key,decision}),
      })
      setMessage(result.status==='queued'
        ?'Production deployment queued. Awaiting host activation and verification; existing Production remains unchanged.'
        :result.status==='already_deployed'
          ?'The verified release is already installed in Production.'
          :'UAT release request rejected. No deployment queued.')
      await refresh(true)
    }catch(e){setError(e.message)}
    finally{setBusy('')}
  }
  const uat=state.environments.uat
  const live=state.environments.live
  const reviews=state.reviewRequests
  const pending=reviews.filter(x=>x.status==='pending')
  return <section className="rmm-card h5a-uat-promotion" data-hi5-uat-to-production>
    <div className="rmm-card-heading">
      <div>
        <span className="rmm-eyebrow">APPLICATION RELEASE APPROVAL</span>
        <h2>One-click UAT → Production</h2>
        <p>Approve an exact, customer-tested UAT build and queue a shared API/ITSM deployment. Version and status come from the trusted host, not browser input.</p>
      </div>
      <button type="button" className="rmm-secondary compact" disabled={loading||Boolean(busy)}
        onClick={()=>refresh()}><RefreshCw size={14}/> Refresh</button>
    </div>
    <div className="h5a-uat-promotion-body">
      <div className="h5a-uat-promotion-versions">
        <div><span>UAT · host observed</span><strong>{uat?.verified?'Verified':'Not verified'}</strong>
          <small>API {short(uat?.apiSha)} · ITSM {short(uat?.itsmSha)}</small></div>
        <ArrowRight size={19} aria-hidden="true"/>
        <div><span>Production · host observed</span><strong>{live?.verified?'Verified':'Not verified'}</strong>
          <small>API {short(live?.apiSha)} · ITSM {short(live?.itsmSha)}</small></div>
      </div>
      {!state.executor?.ready?<p role="status" className="h5a-uat-promotion-warning"><TriangleAlert size={16}/> Release executor offline: {state.executor?.reason||'A compatible API/ITSM deployment worker has not reported a recent heartbeat.'} Approvals will remain disabled.</p>:null}
      <p className="h5a-uat-promotion-warning"><TriangleAlert size={16}/>
        Production images are shared across customer tenants. An approval queues a job only; it never copies UAT database data, modifies RMM or bypasses host health checks.
      </p>
      {error?<p role="alert" className="h5a-uat-promotion-error">{error}</p>:null}
      {message?<p role="status" className="h5a-uat-promotion-success">{message}</p>:null}
      {loading?<p>Loading release reviews…</p>:null}
      {!loading&&!pending.length?<div className="h5a-uat-promotion-empty">
        <ShieldCheck size={18}/><div><strong>No UAT releases awaiting approval</strong>
          <p>Custom customers must test a published build and submit a UAT review before a Production promotion can be approved here.</p></div>
      </div>:null}
      {pending.map(item=>{
        const gate=promotionReadiness(item,uat,live,state.executor)
        const href='https://'+item.source_tenant_slug+'-uat.'+(window.location.hostname.split('.').slice(1).join('.')||'hi5central.com')
        return <article key={item.request_key} className="h5a-uat-promotion-item">
          <div className="h5a-uat-promotion-item-head">
            <div><small>{item.source_tenant_slug} · UAT accepted {when(item.reviewed_at)}</small>
              <strong>{item.version_label||'Unpublished version'} · {item.title||'Application update'}</strong>
              <span>Immutable build {short(item.build_sha)}</span></div>
            <a href={href} target="_blank" rel="noreferrer"><ExternalLink size={13}/> Open UAT</a>
          </div>
          <p className="h5a-uat-promotion-evidence">{item.evidence||'No UAT testing evidence recorded.'}</p>
          <div className="h5a-uat-promotion-actions">
            <small>{gate.reason}</small>
            <button className="rmm-primary compact" type="button" disabled={!canApprove||!gate.ready||Boolean(busy)}
              onClick={()=>decide(item,'approve')}><CheckCircle2 size={14}/>
              {busy===item.request_key?'Queuing…':'Approve & queue Production'}
            </button>
            <button className="rmm-secondary compact" type="button" disabled={!canApprove||Boolean(busy)}
              onClick={()=>decide(item,'reject')}>Reject</button>
          </div>
        </article>
      })}
      <div className="h5a-uat-promotion-jobs">
        <h3>Production deployment status</h3>
        {!state.jobs.filter(x=>x.to_environment==='live').length
          ?<p>No Production image deployment jobs have been recorded.</p>:null}
        {state.jobs.filter(x=>x.to_environment==='live').slice(0,8).map(job=>
          <div key={job.id} className="h5a-uat-promotion-job">
            <div><strong>{stateLabel(job.status)}</strong><small>UAT → Production · {short(job.api_sha)} · {when(job.requested_at)}</small></div>
            {job.status==='succeeded'?<CheckCircle2 size={17}/>:<Clock3 size={17}/>}
            {job.error_message?<p role="alert">{job.error_message}</p>:null}
          </div>)}
      </div>
    </div>
  </section>
}
