import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, GitBranch, Plus, RefreshCw, Rocket, Save, Send, Trash2, X } from 'lucide-react'
import { deploymentConfig } from '../lib/deploymentConfig.js'
import { updatePublicationStatus } from './updatePublicationStatus.js'
import './ProductionApplicationUpdates.css'

const API_BASE=window.__HI5_API_BASE__||''
const ENV=deploymentConfig().runtimeEnvironment
const CATEGORIES=[{value:'feature',label:'New feature'},{value:'improvement',label:'Improvement'},
  {value:'fix',label:'Fix'},{value:'security',label:'Security update'},{value:'other',label:'Other'}]
const EMPTY_ENTRY=()=>({category:'feature',title:'',description:''})
function dateLabel(value){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function short(sha){return String(sha||'').slice(0,8)||'Unknown'}
async function api(path,options={}){
  const response=await fetch(API_BASE+path,{credentials:'include',cache:'no-store',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}})
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw Object.assign(new Error(body.error||'Could not load release information.'),{status:response.status})
  return body
}
function noteEntry(item,index){
  return <div className="hi5-updates-note-entry" key={index}>
    <span className="hi5-updates-note-icon"><CheckCircle2 size={15}/></span>
    <div><strong>{item.title}</strong>
      <small>{CATEGORIES.find(c=>c.value===item.category)?.label||'Update'}</small>
      {item.description?<p>{item.description}</p>:null}
    </div>
  </div>
}
function DevReleaseEditor({installed,onPublished}){
  const [notes,setNotes]=useState(null)
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [success,setSuccess]=useState('')
  useEffect(()=>{
    let active=true
    api('/api/v1/updates/dev-notes').then(data=>{
      if(!active)return
      setNotes(data.notes||{buildSha:data.buildSha,versionLabel:data.defaultVersion||'',
        title:'',summary:'',entries:[EMPTY_ENTRY()],status:'draft'})
    }).catch(e=>{if(active&&e.status!==403)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[installed])
  const editable=notes?.status==='draft'
  function field(key,value){setNotes(current=>({...current,[key]:value}))}
  function entry(index,key,value){
    field('entries',notes.entries.map((item,i)=>i===index?{...item,[key]:value}:item))
  }
  async function save(publish=false){
    if(!notes||busy)return
    if(publish&&!window.confirm('Release this version and its notes to customers? Unreleased notes are private; publication cannot be undone for this build. This does not deploy application code.'))return
    setBusy(true);setError('');setSuccess('')
    try{
      await api('/api/v1/updates/dev-notes',{method:'PUT',body:JSON.stringify(notes)})
      if(publish){
        await api('/api/v1/updates/dev-notes/publish',{method:'POST',body:'{}'})
        field('status','publication_requested')
        setSuccess('Publication requested. The trusted release operator will make these notes customer-visible once the central release authority accepts them.')
      }else setSuccess('Release-note draft saved. Customers cannot see it yet.')
      onPublished?.()
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(loading)return <p className="hi5-updates-placeholder">Loading Dev release editor…</p>
  if(!notes)return error?<p role="alert" className="hi5-updates-error">{error}</p>:null
  return <section className="hi5-updates-editor" aria-label="Hi5Central Dev release-note editor">
    <div className="hi5-updates-change-header">
      <div><h3>Dev team · Prepare release notes</h3>
        <p>Write what customers should see. Notes remain private until you publish this version from Dev.</p>
      </div>
      <span className="hi5-updates-status">{notes.status==='draft'?'Unpublished draft':notes.status==='publication_requested'?'Publishing requested':'Published'}</span>
    </div>
    {error?<p role="alert" className="hi5-updates-error"><CircleAlert size={16}/>{error}</p>:null}
    {success?<p role="status" className="hi5-updates-success">{success}</p>:null}
    <div className="hi5-updates-editor-fields">
      <label>Customer version number<input maxLength={64} disabled={!editable} value={notes.versionLabel||''}
        onChange={e=>field('versionLabel',e.target.value)} placeholder="e.g. 2026.10.2"/></label>
      <label>Release title<input maxLength={180} disabled={!editable} value={notes.title||''}
        onChange={e=>field('title',e.target.value)} placeholder="e.g. October platform improvements"/></label>
      <label>Release summary<textarea rows={2} maxLength={1200} disabled={!editable} value={notes.summary||''}
        onChange={e=>field('summary',e.target.value)} placeholder="A short overview of this release…"/></label>
    </div>
    <div className="hi5-updates-change-header"><h3>Changes in this version</h3>
      {editable?<button type="button" className="hi5-updates-add-note" disabled={notes.entries.length>=35}
        onClick={()=>field('entries',[...notes.entries,EMPTY_ENTRY()])}><Plus size={15}/> Add change</button>:null}
    </div>
    <div className="hi5-updates-editor-entries">
      {(notes.entries||[]).map((item,i)=><div className="hi5-updates-edit-row" key={i}>
        <div className="hi5-updates-edit-head"><strong>Change {i+1}</strong>
          {editable&&notes.entries.length>1?<button type="button" aria-label={'Remove change '+(i+1)}
            onClick={()=>field('entries',notes.entries.filter((_,j)=>i!==j))}><Trash2 size={15}/></button>:null}</div>
        <select disabled={!editable} value={item.category} onChange={e=>entry(i,'category',e.target.value)}>
          {CATEGORIES.map(category=><option key={category.value} value={category.value}>{category.label}</option>)}</select>
        <input disabled={!editable} maxLength={160} aria-label={'Change '+(i+1)+' title'}
          placeholder="What changed?" value={item.title} onChange={e=>entry(i,'title',e.target.value)}/>
        <textarea disabled={!editable} rows={2} maxLength={950} aria-label={'Change '+(i+1)+' description'}
          placeholder="What does this improve for customers?" value={item.description||''}
          onChange={e=>entry(i,'description',e.target.value)}/>
      </div>)}
    </div>
    {editable?<div className="hi5-updates-approval-actions">
      <button type="button" disabled={busy} onClick={()=>save(false)}><Save size={15}/> Save draft</button>
      <button type="button" className="is-primary" disabled={busy||!notes.versionLabel?.trim()||!notes.title?.trim()||
        !(notes.entries||[]).length||notes.entries.some(item=>item.title.trim().length<3)}
        onClick={()=>save(true)}><Send size={15}/> Release to customers</button>
    </div>:<small>Notes for this build are locked after publication is requested. Publish a newer build for revised release notes.</small>}
  </section>
}
export function Hi5CentralUpdatesPanel({compact=false,visible=true,onClose=null}){
  const [data,setData]=useState(null)
  const [review,setReview]=useState(null)
  const [canReview,setCanReview]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [evidence,setEvidence]=useState('')
  const [busy,setBusy]=useState(false)
  const [expanded,setExpanded]=useState(null)
  async function refresh(){
    setError('')
    try{
      const response=await api('/api/v1/updates')
      setData(response)
      if(ENV==='uat'){
        try{
          const {review:next}=await api('/api/v1/updates/uat-review')
          setReview(next);setEvidence(next?.evidence||'');setCanReview(true)
        }catch(e){if(e.status===403)setCanReview(false);else throw e}
      }
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{refresh()},[])
  async function requestLive(){
    if(!data||busy||!window.confirm('Submit this tested UAT version for a Platform Admin to approve for Live? This will not deploy code automatically.'))return
    setBusy(true);setError('')
    try{
      const response=await fetch('https://api.hi5central.com/api/v1/updates/version',{cache:'no-store'})
      const live= response.ok?await response.json():{}
      await api('/api/v1/updates/uat-review',{method:'POST',body:JSON.stringify({
        acceptWholeBuild:true,baselineSha:live.sha||'',evidence,requestLive:true})})
      setReview({status:'requested',buildSha:data.sha,evidence})
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(!visible)return null
  const releases=data?.releases||[]
  const installed=releases.find(release=>release.buildSha===data?.sha)
  const latest=releases[0]
  const candidate=releases.find(release=>release.buildSha===data?.sha)
  const updateStatus=updatePublicationStatus({installedSha:data?.sha,releases})
  return <section className={'hi5-updates-surface'+(compact?' is-compact':'')} aria-label="Hi5Central versions and updates">
    <div className="hi5-updates-intro">
      <div><span className="hi5-updates-kicker">Hi5Central</span><h2>Versions & updates</h2>
        <p>Published releases, customer-facing improvements and your currently installed version.</p></div>
      <div className="hi5-updates-intro-actions">
        <button type="button" onClick={refresh} title="Refresh versions"><RefreshCw size={16}/></button>
        {onClose?<button type="button" onClick={onClose} aria-label="Close versions"><X size={18}/></button>:null}
      </div>
    </div>
    {error?<p role="alert" className="hi5-updates-error"><CircleAlert size={16}/>{error}</p>:null}
    {loading?<div className="hi5-updates-placeholder">Checking Hi5Central versions…</div>:null}
    {data?<div className="hi5-updates-content">
      <div className="hi5-updates-versions">
        <article><span className="hi5-updates-kicker">Installed version</span>
          <strong>{installed?.versionLabel||data.releaseName?.split('+')[0]||short(data.sha)}</strong>
          <small>Build {short(data.sha)} · {ENV.toUpperCase()}</small></article>
        <article><span className="hi5-updates-kicker">Latest published</span>
          <strong>{latest?.versionLabel||'No releases yet'}</strong>
          <small>{latest?dateLabel(latest.publishedAt):'Updates will appear when Hi5Central publishes a version'}</small></article>
        <article><span className="hi5-updates-kicker">Update status</span>
          <strong>{updateStatus.label}</strong>
          <small>{updateStatus.description}</small></article>
      </div>
      {ENV==='dev'?<DevReleaseEditor key={data.sha} installed={data.sha} onPublished={refresh}/>:null}
      {ENV==='uat'&&canReview?<div className="hi5-updates-approval">
        <div><strong><GitBranch size={17}/> UAT release review</strong>
          <small>{review?.status==='requested'?'Promotion requested':candidate?'Published candidate':'Awaiting Dev release'}</small></div>
        <p>{candidate?'Review the Dev-authored release notes above and record testing before requesting Live deployment.':
          'The Dev team must release the customer-facing notes for this version before UAT can request promotion.'}</p>
        <textarea rows={2} placeholder="What was tested in UAT, and what passed?" aria-label="UAT test evidence"
          value={evidence} onChange={e=>setEvidence(e.target.value)} />
        <div className="hi5-updates-approval-actions">
          <button type="button" className="is-primary" disabled={busy||!candidate||review?.status==='requested'||evidence.trim().length<12}
            onClick={requestLive}><Rocket size={15}/> Request Live promotion</button>
        </div>
      </div>:null}
      <div className="hi5-updates-change-header"><div><h3>Release history</h3>
        <p>Only notes officially published by Hi5Central are shown here.</p></div></div>
      <div className="hi5-updates-published-list">
        {releases.length?releases.map(release=><article className="hi5-updates-published-release" key={release.buildSha}>
          <button className="hi5-updates-release-heading" type="button"
            aria-expanded={expanded===release.buildSha||(!expanded&&release===latest)}
            onClick={()=>setExpanded(v=>v===release.buildSha?'closed':release.buildSha)}>
            <span><strong>{release.versionLabel} · {release.title}</strong>
              <small>{dateLabel(release.publishedAt)} · {release.entries?.length||0} changes
                {release.buildSha===data.sha?' · Installed':''}</small></span>
            <span>{expanded===release.buildSha||(!expanded&&release===latest)?'−':'+'}</span>
          </button>
          {expanded===release.buildSha||(!expanded&&release===latest)?<div className="hi5-updates-release-details">
            {release.summary?<p>{release.summary}</p>:null}
            {(release.entries||[]).map(noteEntry)}
          </div>:null}
        </article>):<div className="hi5-updates-empty">
          <CheckCircle2 size={20}/><strong>No published releases yet</strong>
          <span>The Dev team can prepare private release notes. Customers see a version only after Hi5Central publishes it.</span>
        </div>}
      </div>
    </div>:null}
  </section>
}
export function ProductionUatChangeTracking(){
  const [target,setTarget]=useState(null)
  const [open,setOpen]=useState(false)
  useEffect(()=>{
    if(ENV!=='uat')return
    let active=true
    function scan(){
      const host=document.querySelector('.itsm-topbar-actions')
      if(!(host instanceof HTMLElement))return
      let node=host.querySelector('[data-hi5-uat-changes-anchor]')
      if(!node){node=document.createElement('span');node.dataset.hi5UatChangesAnchor='true';host.insertBefore(node,host.firstChild)}
      if(active)setTarget(old=>old===node?old:node)
    }
    scan()
    const timer=window.setInterval(scan,1250)
    return()=>{active=false;clearInterval(timer)}
  },[])
  useEffect(()=>{
    if(!open)return
    const escape=e=>{if(e.key==='Escape')setOpen(false)}
    document.addEventListener('keydown',escape)
    return()=>document.removeEventListener('keydown',escape)
  },[open])
  if(ENV!=='uat'||!target)return null
  return <>
    {createPortal(<button type="button" className="hi5-uat-changes-trigger" title="UAT version changes"
      aria-label="UAT version changes" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><GitBranch size={17}/></button>,target)}
    {open?createPortal(<div className="hi5-updates-overlay">
      <button className="hi5-updates-backdrop" type="button" aria-label="Close update panel"
        onClick={()=>setOpen(false)}/>
      <aside className="hi5-updates-drawer"><Hi5CentralUpdatesPanel compact onClose={()=>setOpen(false)}/></aside>
    </div>,document.body):null}
  </>
}
