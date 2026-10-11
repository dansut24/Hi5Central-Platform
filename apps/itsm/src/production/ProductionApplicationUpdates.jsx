import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, CheckCircle2, ChevronDown, CircleAlert, ClipboardCheck, Clock3, GitBranch, History, RefreshCw, Rocket, X } from 'lucide-react'
import { deploymentConfig } from '../lib/deploymentConfig.js'
import './ProductionApplicationUpdates.css'

const API_BASE=window.__HI5_API_BASE__ || ''
const KIND_LABEL={feature:'New feature',fix:'Fix',improvement:'Improvement',database:'Database migration',maintenance:'Maintenance'}

async function request(path,options={}) {
  const r=await fetch(API_BASE+path,{credentials:'include',cache:'no-store',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}})
  const body=await r.json().catch(()=>({}))
  if(!r.ok)throw Object.assign(new Error(body.error||'Could not load release information.'),{status:r.status})
  return body
}

function groupChanges(data,baseline) {
  if(!data?.changes?.length)return []
  const all=data.changes
  if(!baseline?.sha)return all
  if(baseline.sha===data.sha)return []
  const index=all.findIndex(item=>item.sha===baseline.sha)
  return index<0?all:all.slice(0,index)
}

function short(sha){return String(sha||'').slice(0,8)||'Unknown'}
function fmtDate(value){try{return value?new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):''}catch{return ''}}
function Label({children}){return <span className="hi5-updates-kicker">{children}</span>}

function UseUpdates() {
  const [data,setData]=useState(null)
  const [live,setLive]=useState(null)
  const [review,setReview]=useState(null)
  const [reviewLoaded,setReviewLoaded]=useState(false)
  const [admin,setAdmin]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const refresh=async()=>{
    setError('')
    try{
      const result=await request('/api/v1/updates')
      setData(result)
      if(deploymentConfig().runtimeEnvironment==='uat'){
        const comparison=await fetch('https://api.hi5central.com/api/v1/updates/version',{mode:'cors',cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)
        setLive(comparison)
        try{
          const state=await request('/api/v1/updates/uat-review')
          setReview(state.review)
          setAdmin(true)
          setReviewLoaded(true)
        }catch(e){if(e.status===403){setAdmin(false);setReviewLoaded(true)}else throw e}
      }else{
        setLive(result)
      }
    }catch(e){setError(e.message)}finally{setLoading(false)}
  }
  useEffect(()=>{refresh()},[])
  return {data,live,review,setReview,admin,reviewLoaded,loading,error,setError,refresh}
}

export function Hi5CentralUpdatesPanel({compact=false,visible=true,onClose=null}) {
  const current=UseUpdates()
  const {data,live,review,setReview,admin,reviewLoaded,loading,error,setError,refresh}=current
  const uat=deploymentConfig().runtimeEnvironment==='uat'
  const changes=useMemo(()=>groupChanges(data,live),[data,live])
  const [selected,setSelected]=useState([])
  const [notes,setNotes]=useState('')
  const [busy,setBusy]=useState(false)
  const [filter,setFilter]=useState('changes')
  const reviewReady=review?.buildSha===data?.sha
  const required=changes
  const allApproved=required.every(item=>selected.includes(item.sha))
  const initialized=useRef('')

  useEffect(()=>{
    if(!data||(uat&&!reviewLoaded)||initialized.current===data.sha)return
    initialized.current=data.sha
    setSelected(review?.buildSha===data.sha&&Array.isArray(review.approvedShas)
      ?review.approvedShas:[])
    setNotes(review?.buildSha===data.sha?review.evidence||'':'')
  },[data,review])

  async function save(requestLive=false){
    if(!data||busy)return
    if(requestLive&&!window.confirm('Request promotion of the entire approved UAT application build to Live? Platform Admin must approve the shared deployment.'))return
    setBusy(true);setError('')
    try{
      const res=await request('/api/v1/updates/uat-review',{
        method:'POST',body:JSON.stringify({approvedShas:selected,evidence:notes,requestLive,baselineSha:live?.sha||''})
      })
      setReview({buildSha:data.sha,approvedShas:selected,evidence:notes,status:requestLive?'requested':'approved',reviewedAt:new Date().toISOString()})
      setError('')
      window.dispatchEvent(new CustomEvent('hi5-uat-release-updated'))
      if(requestLive) window.alert(res.message)
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }

  const display=filter==='features'
    ?changes.filter(c=>['feature','improvement'].includes(c.category))
    :filter==='database'?changes.filter(c=>c.migrations?.length):changes
  const hasBaseline=Boolean(live?.sha)
  const same=hasBaseline&&data?.sha===live.sha
  const major=changes.filter(item=>item.category!=='maintenance'||item.migrations?.length)
  const latest=data?.changes?.filter(item=>['feature','fix','improvement','database'].includes(item.category)).slice(0,25)||[]

  if(!visible)return null
  return <section className={'hi5-updates-surface'+(compact?' is-compact':'')} aria-label="Hi5Central versions and updates">
    <div className="hi5-updates-intro">
      <div><Label>Hi5Central updates</Label><h2>{uat?'UAT change tracking':'Versions and changelog'}</h2>
        <p>{uat?'Review what is included in this build, record UAT evidence and request an approved Production deployment.':'See the installed Hi5Central build and the fixes, improvements and features delivered with recent releases.'}</p>
      </div>
      <div className="hi5-updates-intro-actions">
        <button type="button" onClick={refresh} title="Refresh version information"><RefreshCw size={16}/></button>
        {onClose?<button type="button" onClick={onClose} aria-label="Close release tracking"><X size={18}/></button>:null}
      </div>
    </div>
    {error?<p role="alert" className="hi5-updates-error"><CircleAlert size={15}/>{error}</p>:null}
    {loading?<div className="hi5-updates-placeholder">Checking installed application version…</div>:null}
    {data?<div className="hi5-updates-content">
      <div className="hi5-updates-versions">
        <article><Label>Currently installed</Label><strong>{data.releaseName?.split('+')[0]||short(data.sha)}</strong>
          <small>{deploymentConfig().runtimeEnvironment.toUpperCase()} · build {short(data.sha)} · {fmtDate(data.builtAt)}</small></article>
        <article><Label>{uat?'Production comparison':'Release status'}</Label>
          <strong>{uat?(same?'Same as Production':hasBaseline?short(live.sha):'Not available'):'Installed'}</strong>
          <small>{uat?(same?'No newer UAT build changes':hasBaseline?'Review the changes before promoting':'Production needs version reporting to compare builds'):'This is the build currently serving your organisation'}</small>
        </article>
        <article><Label>{uat?'Changes to review':'Recent improvements'}</Label>
          <strong>{uat?(hasBaseline?major.length:'—'):latest.length}</strong>
          <small>{uat?'Application changes are packaged as one build':'Automatically generated release history'}</small></article>
      </div>
      {uat&&admin?<div className="hi5-updates-approval">
        <div><strong><ClipboardCheck size={17}/> UAT acceptance</strong>
          <small>{reviewReady?'Last recorded: '+(review.status||'draft'):'No acceptance recorded for this version'}</small></div>
        <p>Tick the changes you tested. Code and database migrations in the same container release must be promoted together; unticking a code change cannot remove it from the build.</p>
        <textarea rows={2} aria-label="UAT test evidence" placeholder="Record what was tested, affected modules and results…" value={notes} onChange={e=>setNotes(e.target.value)}/>
        <div className="hi5-updates-approval-actions">
          <button type="button" disabled={busy||!selected.length} onClick={()=>save(false)}>Save UAT review</button>
          <button className="is-primary" type="button" disabled={busy||same||!major.length||!allApproved||notes.trim().length<12} onClick={()=>save(true)}>
            <Rocket size={15}/> Request Live promotion
          </button>
        </div>
        {review?.status==='requested'?<small>Promotion requested for this build. Shared API/ITSM deployment still requires approval through Platform Admin.</small>:null}
        {!hasBaseline?<small>Production comparison is unavailable until Live has the version endpoint. You can submit an approval request; Platform Admin must still verify the matching build before deployment.</small>:null}
      </div>:null}
      <div className="hi5-updates-change-header">
        <h3>{uat?'Detected changes since Production':'What’s new in Hi5Central'}</h3>
        {uat&&admin?<button className="hi5-updates-select-all" type="button"
          onClick={()=>setSelected(selected.length===changes.length?[]:changes.map(x=>x.sha))}>
          {selected.length===changes.length?'Uncheck all':'Mark all tested'}
        </button>:null}
        <nav aria-label="Release changelog filters">
          {['changes','features','database'].map((item)=><button type="button" key={item} aria-pressed={filter===item}
            className={filter===item?'active':''} onClick={()=>setFilter(item)}>{item==='changes'?'All':item==='features'?'Features':'Migrations'}</button>)}
        </nav>
      </div>
      <div className="hi5-updates-change-list">
        {(uat?display:(filter==='features'?latest.filter(c=>['feature','improvement'].includes(c.category)):filter==='database'?latest.filter(c=>c.migrations?.length):latest)).map(item=>
          <div className="hi5-updates-change" key={item.sha}>
            {uat&&admin?<input type="checkbox" aria-label={'Tested '+item.title} checked={selected.includes(item.sha)}
              onChange={e=>setSelected(current=>e.target.checked?[...current,item.sha]:current.filter(id=>id!==item.sha))}/>:<span className="hi5-updates-mark"><CheckCircle2 size={15}/></span>}
            <div><strong>{item.title}</strong>
              <small>{KIND_LABEL[item.category]||'Update'} · {(item.components||[]).join(', ')} · {fmtDate(item.date)}</small>
              {item.migrations?.length?<small>Includes {item.migrations.length} schema migration{item.migrations.length===1?'':'s'}</small>:null}
            </div>
          </div>
        )}
        {((uat?display:latest).length===0)?<div className="hi5-updates-empty">
          <CheckCircle2 size={21}/><strong>{same?'UAT and Production are on the same application build.':'No changes in this category'}</strong></div>:null}
      </div>
    </div>:null}
  </section>
}

export function ProductionUatChangeTracking() {
  const environment=deploymentConfig().runtimeEnvironment
  const [target,setTarget]=useState(null)
  const [open,setOpen]=useState(false)
  const [count,setCount]=useState(0)
  useEffect(()=>{
    if(environment!=='uat')return
    let alive=true
    const scan=()=>{
      const host=document.querySelector('.itsm-topbar-actions')
      if(!(host instanceof HTMLElement))return
      let node=host.querySelector('[data-hi5-uat-changes-anchor]')
      if(!node){node=document.createElement('span');node.dataset.hi5UatChangesAnchor='true';host.insertBefore(node,host.firstChild)}
      if(alive)setTarget(t=>t===node?t:node)
    }
    scan()
    const timer=window.setInterval(scan,1250)
    return ()=>{alive=false;window.clearInterval(timer)}
  },[environment])
  useEffect(()=>{
    if(environment!=='uat')return
    Promise.all([
      request('/api/v1/updates'),
      fetch('https://api.hi5central.com/api/v1/updates/version',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
    ]).then(([data,live])=>{
      if(live?.sha&&data?.changes){const index=data.changes.findIndex(c=>c.sha===live.sha);setCount(index>=0?index:0)}
    }).catch(()=>{})
  },[environment])
  useEffect(()=>{
    if(!open)return
    const handle=e=>{if(e.key==='Escape')setOpen(false)}
    document.addEventListener('keydown',handle)
    return ()=>document.removeEventListener('keydown',handle)
  },[open])
  if(environment!=='uat'||!target)return null
  return <>
    {createPortal(<button className="hi5-uat-changes-trigger" type="button" aria-label="Track and approve UAT changes"
      aria-expanded={open} title="UAT changes and Live promotion" onClick={()=>setOpen(v=>!v)}>
      <GitBranch size={17}/>{count>0?<span>{count>99?'99+':count}</span>:null}
    </button>,target)}
    {open?createPortal(<div className="hi5-updates-overlay">
      <button className="hi5-updates-backdrop" type="button" aria-label="Close UAT changes" onClick={()=>setOpen(false)}/>
      <aside className="hi5-updates-drawer"><Hi5CentralUpdatesPanel compact onClose={()=>setOpen(false)}/></aside>
    </div>,document.body):null}
  </>
}
