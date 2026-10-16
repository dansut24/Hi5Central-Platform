import {useCallback,useEffect,useMemo,useState} from 'react'
import {Activity,ArrowLeft,ArrowRight,ChevronDown,ChevronUp,Clock3,RefreshCw,RotateCcw,ServerCog,ShieldCheck} from 'lucide-react'
import './WorkerActivity.css'

const stamps=v=>{
  if(!v)return '—'
  const d=new Date(v)
  return Number.isNaN(d.getTime())?'—':
    new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium'}).format(d)
}
const elapsed=ms=>{
  if(ms==null)return 'Not started'
  const n=Math.max(0,Number(ms)||0)
  if(n<1000)return n+' ms'
  if(n<60000)return (n/1000).toFixed(1)+' s'
  return Math.floor(n/60000)+'m '+Math.floor(n%60000/1000)+'s'
}
const states={
  succeeded:'healthy',running:'running',failed:'critical',rolled_back:'warning',
  scheduled:'neutral',pending:'neutral',deferred:'warning',cancelled:'neutral',
}
function ReleaseState({value}){
  return <span className={'rmm-status-pill '+(states[value]||'neutral')}>{String(value||'unknown').replaceAll('_',' ')}</span>
}
const revision=value=>value?String(value).slice(0,12):'—'
function Events({events,loading}){
  if(loading)return <p className="h5-worker-muted">Retrieving the durable event timeline…</p>
  if(!events.length)return <p className="h5-worker-muted">No worker events have been recorded for this deployment.</p>
  return <ol className="h5-worker-timeline">{events.map(event=>
    <li key={event.id}>
      <span className="h5-worker-event-bullet"/>
      <div>
        <strong>{event.event_type.replaceAll('_',' ')}</strong>
        <small>{stamps(event.occurred_at)} · Attempt fence {event.fence}</small>
        {Object.keys(event.details||{}).length?
          <pre>{JSON.stringify(event.details,null,2)}</pre>:null}
      </div>
    </li>
  )}</ol>
}
export function WorkerActivity({api}){
  const [filter,setFilter]=useState({tenant:'',environment:'',status:''})
  const [offset,setOffset]=useState(0)
  const [data,setData]=useState({items:[],total:0,control:{paused:true}})
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [selected,setSelected]=useState(null)
  const [events,setEvents]=useState([])
  const [eventLoading,setEventLoading]=useState(false)
  const refresh=useCallback(async()=>{
    setLoading(true)
    try{
      const q=new URLSearchParams({limit:'50',offset:String(offset)})
      if(filter.tenant)q.set('tenant',filter.tenant)
      if(filter.environment)q.set('environment',filter.environment)
      if(filter.status)q.set('status',filter.status)
      const result=await api('/releases/worker-activity?'+q)
      setData(result)
      setError('')
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  },[api,filter,offset])
  useEffect(()=>{
    refresh()
    const interval=setInterval(()=>{
      if(document.visibilityState==='visible')refresh()
    },30000)
    return()=>clearInterval(interval)
  },[refresh])
  useEffect(()=>{
    let valid=true
    if(!selected){setEvents([]);return()=>{valid=false}}
    setEventLoading(true)
    api('/releases/worker-activity/'+encodeURIComponent(selected)+'/events')
      .then(result=>{if(valid)setEvents(result.events||[])})
      .catch(e=>{if(valid){setEvents([]);setError(e.message)}})
      .finally(()=>{if(valid)setEventLoading(false)})
    return()=>{valid=false}
  },[selected,api])
  const count=useMemo(()=>{
    const result={success:0,running:0,failures:0}
    for(const item of data.items){
      if(item.status==='succeeded')result.success++
      if(item.status==='running')result.running++
      if(['failed','rolled_back'].includes(item.status))result.failures++
    }
    return result
  },[data])
  const update=(key,value)=>{
    setFilter(prev=>({...prev,[key]:value}))
    setOffset(0);setSelected(null)
  }
  return <div className="h5-worker-view">
    <header className="h5-worker-heading">
      <div><span className="rmm-eyebrow">DEPLOYMENT OPERATIONS</span>
        <h1>Release worker activity</h1>
        <p>Actual deployments, scheduling, duration, retries and per-tenant audit evidence from PostgreSQL.</p>
      </div>
      <button className="rmm-secondary compact" type="button" disabled={loading} onClick={refresh}>
        <RefreshCw size={15} className={loading?'h5-worker-spin':''}/>Refresh
      </button>
    </header>
    <div className="h5-worker-stats">
      <article className="rmm-card"><ShieldCheck size={19}/><div><small>Rollout controller</small>
        <strong>{data.control?.paused?'Paused':'Enabled'}</strong>
        <span title={data.control?.reason}>{data.control?.reason||'Status last read from PostgreSQL'}</span></div></article>
      <article className="rmm-card"><Activity size={19}/><div><small>Jobs in selected page</small>
        <strong>{data.items.length} <small>of {data.total}</small></strong>
        <span>{count.running} running · {count.success} successful</span></div></article>
      <article className="rmm-card"><RotateCcw size={19}/><div><small>Failures and rollback</small>
        <strong>{count.failures}</strong><span>Includes jobs safely rolled back</span></div></article>
      <article className="rmm-card"><ServerCog size={19}/><div><small>Workers reporting</small>
        <strong>{(data.workers||[]).filter(w=>w.online).length} <small>of {(data.workers||[]).length}</small></strong>
        <span title={(data.workers||[]).map(w=>w.worker_id+': '+w.state).join(' · ')}>
          {(data.workers||[]).length?'Heartbeat within 2 minutes = online':'No heartbeats recorded yet'}
        </span></div></article>
    </div>
    <section className="rmm-card h5-worker-panel">
      <div className="h5-worker-toolbar">
        <label>Tenant
          <input aria-label="Filter worker activity by tenant slug" placeholder="All tenants" value={filter.tenant}
            onChange={e=>update('tenant',e.target.value.toLowerCase())}/>
        </label>
        <label>Environment
          <select value={filter.environment} onChange={e=>update('environment',e.target.value)}>
            <option value="">All environments</option><option value="test">Test</option>
            <option value="uat">UAT</option><option value="live">Production</option>
          </select>
        </label>
        <label>Result
          <select value={filter.status} onChange={e=>update('status',e.target.value)}>
            <option value="">All results</option>
            {['pending','scheduled','deferred','running','succeeded','failed','rolled_back','cancelled'].map(k=>
              <option value={k} key={k}>{k.replaceAll('_',' ')}</option>)}
          </select>
        </label>
      </div>
      {error?<p role="alert" className="h5-worker-error">{error}</p>:null}
      <div className="h5-worker-scroll"><table className="h5-worker-table"><thead><tr>
        <th>Tenant / environment</th><th>Version deployed</th><th>Result</th>
        <th>Scheduled / started</th><th>Duration</th><th>Attempts</th><th>History</th>
      </tr></thead><tbody>{data.items.map(job=>
        <tr key={job.id}>
          <td><strong>{job.company_name||job.tenant_slug}</strong><small>{job.tenant_slug} · {job.environment==='live'?'Production':job.environment.toUpperCase()}</small></td>
          <td><strong title={job.build_sha}>{job.version_label||revision(job.build_sha)}</strong><small title={job.previous_build_sha}>From {revision(job.previous_build_sha)} → {revision(job.build_sha)}</small></td>
          <td><ReleaseState value={job.status}/>{job.last_error?<small title={job.last_error}>Previous error recorded</small>:null}</td>
          <td><strong>{stamps(job.scheduled_at)}</strong><small>Started {stamps(job.started_at)}</small></td>
          <td><strong>{elapsed(job.duration_ms)}</strong><small>Queue delay {elapsed(job.queue_delay_ms)}</small></td>
          <td>{job.attempt_count} / {job.max_attempts}</td>
          <td><button className="rmm-secondary compact" aria-expanded={selected===job.id}
            type="button" onClick={()=>setSelected(v=>v===job.id?null:job.id)}>
            {selected===job.id?<ChevronUp size={14}/>:<ChevronDown size={14}/>}Details
          </button></td>
        </tr>
      )}</tbody></table>
      {!data.items.length&&!loading?<p className="h5-worker-empty">No rollout jobs match these filters yet.</p>:null}
      {loading&&!data.items.length?<p className="h5-worker-empty">Loading worker activity…</p>:null}
      </div>
      {selected?<div className="h5-worker-detail"><h3>Deployment event history</h3>
        <p>Chronological queue decisions, claims, verified deploys, failures and rollback records.</p>
        <Events events={events} loading={eventLoading}/>
      </div>:null}
      <footer className="h5-worker-pagination"><small>Showing {data.items.length?offset+1:0}–{offset+data.items.length} of {data.total||0}. Auto-refreshes every 30 seconds.</small>
        <div><button className="rmm-secondary compact" type="button" disabled={offset===0} onClick={()=>setOffset(o=>Math.max(0,o-50))}><ArrowLeft size={14}/>Previous</button>
        <button className="rmm-secondary compact" type="button" disabled={offset+50>=data.total} onClick={()=>setOffset(o=>o+50)}>Next<ArrowRight size={14}/></button></div>
      </footer>
    </section>
  </div>
}
