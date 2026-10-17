import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, ClipboardCheck, Copy, GitBranch, Plus, RefreshCw, Rocket, Save, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import { deploymentConfig } from '../lib/deploymentConfig.js'
import './ProductionApplicationUpdates.css'
import {formatInstalledVersionDetails} from './installedVersionCopy.js'

const API_BASE=window.__HI5_API_BASE__||''
const ENV=deploymentConfig().runtimeEnvironment
const CATEGORIES=[{value:'feature',label:'New feature'},{value:'improvement',label:'Improvement'},
  {value:'fix',label:'Fix'},{value:'security',label:'Security update'},{value:'other',label:'Other'}]
const EMPTY_ENTRY=()=>({category:'feature',title:'',description:''})
function dateLabel(value){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function short(sha){return String(sha||'').slice(0,8)||'Unknown'}
function displayVersion(value){return String(value||'').trim().replace(/\+[a-f0-9]{8,40}$/i,'')}
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
  const [originalVersion,setOriginalVersion]=useState('')
  useEffect(()=>{
    let active=true
    api('/api/v1/updates/dev-notes').then(data=>{
      if(!active)return
      setOriginalVersion(data.notes?.versionLabel||'')
      setNotes(data.notes
        ?{...data.notes,versionLabel:displayVersion(data.notes.versionLabel)}
        :{buildSha:data.buildSha,versionLabel:data.defaultVersion||'',
          title:'',summary:'',entries:[EMPTY_ENTRY()],status:'draft'})
    }).catch(e=>{if(active&&e.status!==403)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[installed])
  // Release publication is asynchronous but normally completed by the
  // persistent trusted relay within one 15-second poll. Refresh server state
  // automatically; never imply success until Dev records central readback.
  useEffect(()=>{
    if(notes?.status!=='publication_requested')return
    let active=true
    const timer=setInterval(async()=>{
      if(!active)return
      try{
        const latest=await api('/api/v1/updates/dev-notes')
        if(!active||latest?.notes?.buildSha!==notes.buildSha)return
        if(latest.notes.status==='published'){
          setNotes(current=>({...current,status:'published',
            versionSyncState:latest.notes.versionSyncState,
            publishedAt:latest.notes.publishedAt}))
          setSuccess('Published centrally. Customer upgrades remain subject to maintenance and approval policies.')
          onPublished?.()
        }
      }catch{/* Visible pending state is retained when network is unavailable. */}
    },7500)
    return()=>{active=false;clearInterval(timer)}
  },[notes?.status,notes?.buildSha])
  const editable=notes?.status==='draft'
  const versionEditable=editable||(notes?.status==='published'&&notes?.versionSyncState!=='pending')
  const pendingVersion=notes?.versionSyncState==='pending'
  const versionChanged=notes?.status==='published'&&notes?.versionLabel?.trim()!==originalVersion
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
  async function updatePublishedVersion(){
    if(!notes||busy||!versionChanged)return
    if(!window.confirm('Update only this published release version number? The build and release notes will remain unchanged.'))return
    setBusy(true);setError('');setSuccess('')
    try{
      const response=await api('/api/v1/updates/dev-notes/version',{
        method:'PUT',body:JSON.stringify({buildSha:notes.buildSha,versionLabel:notes.versionLabel})})
      setNotes(current=>({...current,versionSyncState:'pending'}))
      setSuccess(response.message||'Customer version correction requested.')
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(loading)return <p className="hi5-updates-placeholder">Loading Dev release editor…</p>
  if(!notes)return error?<p role="alert" className="hi5-updates-error">{error}</p>:null
  return <section className="hi5-updates-editor" aria-label="Hi5Central Dev release-note editor">
    <div className="hi5-updates-change-header">
      <div><h3>Dev team · Prepare release notes</h3>
        <p>Choose a customer version number and write what changed. The technical build ID is tracked separately.</p>
      </div>
      <span className="hi5-updates-status">{pendingVersion?'Updating version':notes.status==='draft'?'Unpublished draft':notes.status==='publication_requested'?'Publishing requested':'Published'}</span>
    </div>
    {error?<p role="alert" className="hi5-updates-error"><CircleAlert size={16}/>{error}</p>:null}
    {success?<p role="status" className="hi5-updates-success">{success}</p>:null}
    <div className="hi5-updates-editor-fields">
      <label>Customer version number<input maxLength={32} disabled={!versionEditable} value={notes.versionLabel||''}
        onChange={e=>field('versionLabel',e.target.value)} placeholder="e.g. 1.0.1 or 2026.10.1"/>
        <small className="hi5-updates-field-hint">Customer-facing label only. Build {short(notes.buildSha)} remains unchanged.</small>
      </label>
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
    </div>:notes.status==='published'
      ?<div className="hi5-updates-version-correction">
        <p>The notes are published and locked. You can still correct the customer version number without deploying new code.</p>
        {pendingVersion?<small>Version correction submitted. It will appear to customers after central synchronisation. Refresh this page to see the result.</small>
          :<button type="button" disabled={busy||!versionChanged||!notes.versionLabel?.trim()}
            onClick={updatePublishedVersion}><Save size={15}/> Update published version number</button>}
      </div>
      :<small>Publication is pending central verification. The page refreshes automatically. If it remains pending, the release needs an official successful CI build and a healthy trusted publisher; it is not yet queued for customer deployment.</small>}
  </section>
}
function DevPublishedVersionManager(){
  const [releases,setReleases]=useState([])
  const [selected,setSelected]=useState('')
  const [version,setVersion]=useState('')
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  async function load(){
    setError('')
    try{
      const response=await api('/api/v1/updates/dev-notes/history')
      const list=Array.isArray(response.releases)?response.releases:[]
      setReleases(list)
      const chosen=list.find(item=>item.buildSha===selected)||list[0]
      setSelected(chosen?.buildSha||'')
      setVersion(displayVersion(chosen?.versionLabel))
    }catch(e){if(e.status!==403)setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{load()},[])
  const chosen=releases.find(item=>item.buildSha===selected)
  async function save(){
    if(!chosen||busy||!version.trim())return
    if(!window.confirm('Change the published customer version for '+chosen.title+'? Its application build and release notes will not change.'))return
    setBusy(true);setError('');setMessage('')
    try{
      const result=await api('/api/v1/updates/dev-notes/version',{
        method:'PUT',body:JSON.stringify({buildSha:chosen.buildSha,versionLabel:version.trim()})})
      setMessage(result.message||'The customer version is ready.')
      await load()
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(loading)return null
  if(!releases.length&&!error)return null
  return <section className="hi5-updates-version-manager" aria-label="Manage published customer version numbers">
    <div className="hi5-updates-change-header">
      <div><h3>Manage published versions</h3>
        <p>Correct a previous version number without changing its release notes or technical build.</p>
      </div>
      <button className="hi5-updates-add-note" type="button" onClick={load} title="Refresh published versions"><RefreshCw size={15}/></button>
    </div>
    {error?<p role="alert" className="hi5-updates-error">{error}</p>:null}
    {message?<p role="status" className="hi5-updates-success">{message}</p>:null}
    {releases.length?<div className="hi5-updates-editor-fields">
      <label>Published release
        <select value={selected} onChange={e=>{
          const next=releases.find(item=>item.buildSha===e.target.value)
          setSelected(next?.buildSha||'')
          setVersion(displayVersion(next?.versionLabel))
          setMessage('')
        }}>
          {releases.map(item=><option key={item.buildSha} value={item.buildSha}>
            {displayVersion(item.versionLabel)} · {item.title} (build {short(item.buildSha)})
          </option>)}
        </select>
      </label>
      <label>Customer version number
        <input maxLength={32} value={version} disabled={chosen?.versionSyncState==='pending'}
          onChange={e=>setVersion(e.target.value)} placeholder="e.g. 1.0.1"/>
        <small className="hi5-updates-field-hint">Build {short(chosen?.buildSha)} stays unchanged.</small>
      </label>
    </div>:null}
    {chosen?.versionSyncState==='pending'
      ?<small>The version correction is synchronising with the central customer catalogue. Refresh to check its status.</small>
      :<button className="hi5-updates-version-save" type="button"
        disabled={busy||!version.trim()||version.trim()===chosen?.versionLabel}
        onClick={save}><Save size={15}/> Update customer version</button>}
  </section>
}


const UAT_CHECKS=[
  {id:'login',name:'Login, MFA and environment access',hint:'Check that only authorised testers can sign in'},
  {id:'navigation',name:'New feature and navigation review',hint:'Open the changed areas and verify expected behaviour'},
  {id:'records',name:'Existing record and workflow regression',hint:'Inspect an incident, task and service request in UAT'},
  {id:'mobile',name:'Mobile layout and permissions',hint:'Check a small screen and the appropriate user roles'},
]
function encodeEvidence(checks,notes){
  const lines=UAT_CHECKS.map(check=>`- [${checks.includes(check.id)?'x':' '}] ${check.name}`)
  return ['UAT release acceptance checklist',...lines,'','Test evidence:',notes.trim()].join('\n')
}
function decodeEvidence(value){
  const text=String(value||'')
  if(!text.startsWith('UAT release acceptance checklist\n'))return {checks:[],notes:text}
  const checks=UAT_CHECKS.filter(check=>text.includes(`- [x] ${check.name}`)).map(check=>check.id)
  const noteStart=text.indexOf('\nTest evidence:\n')
  return {checks,notes:noteStart>=0?text.slice(noteStart+'\nTest evidence:\n'.length):''}
}
function DevReleaseReadiness({data}){
  const [uat,setUat]=useState(null)
  const [checking,setChecking]=useState(true)
  useEffect(()=>{
    let active=true
    fetch('https://uat-api.hi5central.com/api/v1/updates/version',{cache:'no-store'})
      .then(response=>response.ok?response.json():null)
      .then(version=>{if(active)setUat(version)})
      .catch(()=>{})
      .finally(()=>{if(active)setChecking(false)})
    return()=>{active=false}
  },[data?.sha])
  const published=(data?.releases||[]).some(item=>item.buildSha===data?.sha)
  const same=Boolean(uat?.sha&&uat.sha===data?.sha)
  return <section className="hi5-release-readiness" aria-label="New feature: release readiness summary">
    <div className="hi5-updates-change-header">
      <div><h3><ShieldCheck size={16}/> Release readiness</h3>
        <p>Track this Dev candidate before sending it to customer UAT environments.</p></div>
      <span className="hi5-updates-status">New in Dev</span>
    </div>
    <div className="hi5-release-readiness-items">
      <div><CheckCircle2 size={17}/><span><strong>Versioned build available</strong>
        <small>Immutable build {short(data?.sha)} is running in Dev</small></span></div>
      <div className={published?'is-ready':'is-pending'}>{published?<CheckCircle2 size={17}/>:<CircleAlert size={17}/>}
        <span><strong>{published?'Release notes published':'Release notes awaiting publication'}</strong>
          <small>Customers see release notes only after explicit Dev publication</small></span></div>
      <div className={same?'is-ready':'is-pending'}>{same?<CheckCircle2 size={17}/>:<CircleAlert size={17}/>}
        <span><strong>{checking?'Checking UAT application…':same?'UAT already on this build':'UAT staging required'}</strong>
          <small>{same?'Ready for UAT testing and sign-off':uat?.sha?'UAT currently on '+short(uat.sha):'UAT version could not be verified'}</small></span></div>
    </div>
  </section>
}
export function Hi5CentralUpdatesPanel({compact=false,visible=true,onClose=null,showUatPromotion=true}){
  const [data,setData]=useState(null)
  const [review,setReview]=useState(null)
  const [reviewScope,setReviewScope]=useState(null)
  const [canReview,setCanReview]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [evidence,setEvidence]=useState('')
  const [uatChecks,setUatChecks]=useState([])
  const [busy,setBusy]=useState(false)
  const [expanded,setExpanded]=useState(null)
  const [copyStatus,setCopyStatus]=useState('')
  async function refresh(){
    setError('')
    try{
      const response=await api('/api/v1/updates')
      setData(response)
      if(ENV==='uat'&&showUatPromotion){
        try{
          const {review:next}=await api('/api/v1/updates/uat-review')
          const restored=decodeEvidence(next?.evidence)
          setReview(next);setEvidence(restored.notes);setUatChecks(restored.checks);setCanReview(true)
          const scope=await api('/api/v1/updates/uat-review-scope')
            .catch(error=>({knownBaseline:false,reason:error.message}))
          setReviewScope(scope)
        }catch(e){if(e.status===403)setCanReview(false);else throw e}
      }
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{refresh()},[])
  useEffect(()=>{setCopyStatus('')},[data?.sha])
  async function requestLive(){
    if(uatChecks.length!==UAT_CHECKS.length||evidence.trim().length<12){setError('Complete all UAT checks and enter test evidence before requesting promotion.');return}
    if(!reviewScope?.knownBaseline||!reviewScope.reviewChangeCount){setError(reviewScope?.reason||'Full Live-to-UAT history has not been verified.');return}
    if(!data||busy||!window.confirm('Confirm testing and approval of ALL '+reviewScope.reviewChangeCount+' commits since Production '+short(reviewScope.baselineSha)+'? This requests shared Live deployment review only; it does not deploy code.'))return
    setBusy(true);setError('')
    try{
      await api('/api/v1/updates/uat-review',{method:'POST',body:JSON.stringify({
        acceptWholeBuild:true,baselineSha:reviewScope.baselineSha,evidence:encodeEvidence(uatChecks,evidence),requestLive:true})})
      setReview({status:'requested',buildSha:data.sha,evidence})
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(!visible)return null
  const releases=data?.releases||[]
  const installed=releases.find(release=>release.buildSha===data?.sha)
  const latest=releases[0]
  const candidate=releases.find(release=>release.buildSha===data?.sha)
  const preview=ENV!=='live'&&!installed
  const available=Boolean(ENV==='live'&&installed&&latest&&latest.buildSha!==data?.sha)
  const installedVersionDetails=formatInstalledVersionDetails({
    versionLabel:displayVersion(installed?.versionLabel),buildSha:data?.sha,environment:ENV,
  })
  async function copyVersionDetails(){
    if(!installedVersionDetails)return
    try{
      if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable')
      await navigator.clipboard.writeText(installedVersionDetails)
      setCopyStatus('Version details copied')
    }catch{setCopyStatus('Could not copy. Check your browser clipboard permissions.')}
  }
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
          <strong>{displayVersion(installed?.versionLabel)||(preview?'Preview build':'Not yet published')}</strong>
          <small>Build {short(data.sha)} · {ENV.toUpperCase()}</small>
          <button type="button" className="hi5-updates-copy-version"
            disabled={!installedVersionDetails} onClick={copyVersionDetails}
            title={installedVersionDetails?'Copy full installed build details':'Installed build identifier is unavailable'}>
            <Copy size={14}/> Copy version details
          </button>
          {copyStatus?<span className="hi5-updates-copy-status" role="status" aria-live="polite">{copyStatus}</span>:null}
        </article>
        <article><span className="hi5-updates-kicker">Latest published</span>
          <strong>{displayVersion(latest?.versionLabel)||'No releases yet'}</strong>
          <small>{latest?dateLabel(latest.publishedAt):'Updates will appear when Hi5Central publishes a version'}</small></article>
        <article><span className="hi5-updates-kicker">Update status</span>
          <strong>{preview?'Preview':available?'Available':installed?'Up to date':'No published update'}</strong>
          <small>{preview?'This build has not been published to customers':available?'A newer version has been released by Hi5Central':'Only officially released versions are listed'}</small></article>
      </div>
      {ENV==='dev'?<DevReleaseReadiness data={data}/>:null}
      {ENV==='dev'?<>
        <DevReleaseEditor key={data.sha} installed={data.sha} onPublished={refresh}/>
        <DevPublishedVersionManager/>
      </>:null}
      {ENV==='uat'&&canReview?<div className="hi5-updates-approval">
        <div><strong><GitBranch size={17}/> UAT release review</strong>
          <small>{review?.status==='requested'?'Promotion requested':candidate?'Published candidate':'Awaiting Dev release'}</small></div>
        <p>{candidate?'Review the Dev-authored release notes above and record testing before requesting Live deployment.':
          'The Dev team must release the customer-facing notes for this version before UAT can request promotion.'}</p>
        <div className="hi5-release-scope" aria-live="polite">
          {reviewScope?.knownBaseline
            ?<p><strong>Complete code-change scope:</strong> {reviewScope.reviewChangeCount} commits from Production {short(reviewScope.baselineSha)} to UAT {short(reviewScope.buildSha)}. Approval covers the whole build, not selected code commits. Read the release notes and verify the affected workflows.</p>
            :<p role="alert"><CircleAlert size={15}/> {reviewScope?.reason||'Checking complete Live-to-UAT history…'} Production approval is unavailable until the full history is verified.</p>}
        </div>
        <div className="hi5-release-acceptance-checklist" aria-label="New feature: UAT acceptance checklist">
          <strong><ClipboardCheck size={16}/> UAT acceptance checklist</strong>
          <small>Complete these checks against the running candidate before requesting Production promotion.</small>
          {UAT_CHECKS.map(item=><label key={item.id}>
            <input type="checkbox" checked={uatChecks.includes(item.id)}
              onChange={e=>setUatChecks(old=>e.target.checked?[...old,item.id]:old.filter(id=>id!==item.id))}/>
            <span><strong>{item.name}</strong><small>{item.hint}</small></span>
          </label>)}
          <span className="hi5-updates-kicker">{uatChecks.length} of {UAT_CHECKS.length} checks completed</span>
        </div>
        <textarea rows={2} placeholder="What was tested in UAT, and what passed?" aria-label="UAT test evidence"
          value={evidence} onChange={e=>setEvidence(e.target.value)} />
        <div className="hi5-updates-approval-actions">
          <button type="button" className="is-primary" disabled={busy||!candidate||!reviewScope?.knownBaseline||!reviewScope.reviewChangeCount||review?.status==='requested'||evidence.trim().length<12||uatChecks.length!==UAT_CHECKS.length}
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
            <span><strong>{displayVersion(release.versionLabel)} · {release.title}</strong>
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
