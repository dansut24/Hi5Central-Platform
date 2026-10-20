import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, ClipboardCheck, GitBranch, Plus, RefreshCw, Rocket, Save, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import { deploymentConfig } from '../lib/deploymentConfig.js'
import {publishedCustomerVersion} from '../lib/customerReleaseVersion.js'
import './ProductionApplicationUpdates.css'

const API_BASE=window.__HI5_API_BASE__||''
const ENV=deploymentConfig().runtimeEnvironment
const CATEGORIES=[{value:'feature',label:'New feature'},{value:'improvement',label:'Improvement'},
  {value:'fix',label:'Fix'},{value:'security',label:'Security update'},{value:'other',label:'Other'}]
const EMPTY_ENTRY=()=>({category:'feature',title:'',description:''})
function dateLabel(value){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function short(sha){return String(sha||'').slice(0,8)||'Unknown'}
const VALID_SHA=/^[a-f0-9]{40}$/
async function portalFrontendManifest(){
  // This URL is served by the customer's actual web deployment, not the
  // shared central API. Do not substitute a central API build on errors.
  try{
    const response=await fetch('/release-manifest.json',{cache:'no-store'})
    if(!response.ok)return null
    const data=await response.json()
    return VALID_SHA.test(String(data?.sha||''))?{sha:data.sha}:null
  }catch{return null}
}
function displayVersion(value){return publishedCustomerVersion(value)||''}
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
  const [candidates,setCandidates]=useState([])
  const [sha,setSha]=useState(installed||'')
  const [runUrl,setRunUrl]=useState('')
  const [notes,setNotes]=useState({versionLabel:'',title:'',summary:'',entries:[EMPTY_ENTRY()]})
  const [status,setStatus]=useState('draft')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [success,setSuccess]=useState('')
  const [loading,setLoading]=useState(true)
  useEffect(()=>{
    let active=true
    api('/api/v1/updates/dev-release/candidates')
      .then(data=>{if(active)setCandidates(data.candidates||[])})
      .catch(e=>{if(active)setError(e.message)})
      .finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[installed])
  useEffect(()=>{
    let active=true
    if(!sha)return()=>{active=false}
    setError('');setSuccess('')
    api('/api/v1/updates/dev-release/'+sha).then(data=>{
      if(!active)return
      setStatus(data.submission?.status||'draft')
      setNotes(data.submission?.notes||{versionLabel:'',title:'',summary:'',entries:[EMPTY_ENTRY()]})
      setRunUrl(data.submission?.ci_run_url||'')
    }).catch(e=>{if(active)setError(e.message)})
    return()=>{active=false}
  },[sha])
  const candidate=candidates.find(item=>item.buildSha===sha)
  const current=sha===installed
  const editable=['draft','rejected'].includes(status)
  const chosenRun=candidate?.ciRunUrl||runUrl
  const update=(key,value)=>setNotes(old=>({...old,[key]:value}))
  const change=(index,key,value)=>update('entries',notes.entries.map((row,i)=>i===index?{...row,[key]:value}:row))
  async function act(submit){
    if(busy)return
    if(!sha||!candidate){setError('Select a successful GitHub release candidate.');return}
    if(submit&&!current){setError('Deploy and verify this exact GitHub commit in Dev before submitting it.');return}
    setBusy(true);setError('');setSuccess('')
    try{
      await api('/api/v1/updates/dev-release',{method:'PUT',
        body:JSON.stringify({sha,notes})})
      if(submit){
        await api('/api/v1/updates/dev-release/submit',{method:'POST',
          body:JSON.stringify({sha,ciRunUrl:chosenRun})})
        setStatus('submitted')
        setSuccess('Submitted to Platform Admin for review. Customers have not been released.')
      }else{
        setStatus('draft')
        setSuccess('Central release draft saved; Platform Admin has not approved it.')
      }
      onPublished?.()
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  return <section className="hi5-updates-editor" aria-label="Dev release preparation and submission">
    <div className="hi5-updates-change-header">
      <div><h3>Dev team · Prepare customer release</h3>
        <p>Select the tested GitHub commit, record the release details, then submit to Platform Admin for approval. Submission never deploys to customers.</p></div>
      <span className="hi5-updates-status">{status==='submitted'?'Awaiting Admin approval':status==='approved'?'Approved':status==='rejected'?'Rejected — revise draft':'Dev draft'}</span>
    </div>
    {error?<p role="alert" className="hi5-updates-error"><CircleAlert size={16}/>{error}</p>:null}
    {success?<p role="status" className="hi5-updates-success">{success}</p>:null}
    <div className="hi5-updates-editor-fields">
      <label>Verified GitHub commit
        <select value={sha} disabled={busy||loading} onChange={e=>setSha(e.target.value)}>
          <option value="">Select commit</option>
          {candidates.map(item=><option key={item.ciRunUrl} value={item.buildSha}>
            {short(item.buildSha)} · {item.branch||'main'} {item.buildSha===installed?'(running in Dev)':''}
          </option>)}
        </select>
        <small className="hi5-updates-field-hint">{current?'This commit matches the running Dev build.':
          'Only the commit currently running in Dev may be submitted.'}</small>
      </label>
      <label>Customer version<input disabled={!editable||busy} value={notes.versionLabel||''}
        onChange={e=>update('versionLabel',e.target.value)} placeholder="2026.10.19.1"/></label>
      <label>Release title<input disabled={!editable||busy} value={notes.title||''}
        onChange={e=>update('title',e.target.value)} placeholder="October ITSM improvements"/></label>
      <label>Release summary<textarea rows={2} disabled={!editable||busy} value={notes.summary||''}
        onChange={e=>update('summary',e.target.value)}/></label>
    </div>
    <div className="hi5-updates-change-header"><h3>Features and release notes</h3>
      {editable?<button className="hi5-updates-add-note" type="button" disabled={busy||notes.entries.length>=35}
        onClick={()=>update('entries',[...notes.entries,EMPTY_ENTRY()])}><Plus size={15}/> Add change</button>:null}
    </div>
    <div className="hi5-updates-editor-entries">
      {notes.entries.map((entry,i)=><div className="hi5-updates-edit-row" key={i}>
        <div className="hi5-updates-edit-head"><strong>Change {i+1}</strong>
          {editable&&notes.entries.length>1?<button type="button"
            onClick={()=>update('entries',notes.entries.filter((_,j)=>i!==j))}><Trash2 size={15}/></button>:null}
        </div>
        <select disabled={!editable||busy} value={entry.category||'feature'} onChange={e=>change(i,'category',e.target.value)}>
          {CATEGORIES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <input disabled={!editable||busy} value={entry.title||''}
          onChange={e=>change(i,'title',e.target.value)} placeholder="What changed?"/>
        <textarea disabled={!editable||busy} rows={2} value={entry.description||''}
          onChange={e=>change(i,'description',e.target.value)} placeholder="Customer-facing description"/>
      </div>)}
    </div>
    {editable?<div className="hi5-updates-approval-actions">
      <button type="button" disabled={busy||!candidate} onClick={()=>act(false)}><Save size={15}/> Save draft</button>
      <button type="button" className="is-primary" disabled={busy||!current||!candidate||
        !notes.versionLabel?.trim()||!notes.title?.trim()||notes.entries.some(e=>!e.title?.trim())}
        onClick={()=>act(true)}><Send size={15}/> Submit for Platform Admin approval</button>
    </div>:<p className="hi5-updates-field-hint">
      {status==='submitted'?'This immutable release submission is awaiting Platform Admin approval or rejection.':
        'Platform Admin has decided this submission. Release history remains available below.'}</p>}
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
export function Hi5CentralUpdatesPanel({compact=false,visible=true,onClose=null}){
  const [data,setData]=useState(null)
  const [review,setReview]=useState(null)
  const [canReview,setCanReview]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [evidence,setEvidence]=useState('')
  const [uatChecks,setUatChecks]=useState([])
  const [busy,setBusy]=useState(false)
  const [expanded,setExpanded]=useState(null)
  async function refresh(){
    setError('')
    try{
      const [response,portalBuild]=await Promise.all([
        api('/api/v1/updates'),portalFrontendManifest(),
      ])
      // API SHA is still used for Dev release authorship and UAT review;
      // installedVersionSha is the actual frontend served by this portal.
      setData({...response,installedVersionSha:portalBuild?.sha||''})
      if(ENV==='uat'){
        try{
          const {review:next}=await api('/api/v1/updates/uat-review')
          const restored=decodeEvidence(next?.evidence)
          setReview(next);setEvidence(restored.notes);setUatChecks(restored.checks);setCanReview(true)
        }catch(e){if(e.status===403)setCanReview(false);else throw e}
      }
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{refresh()},[])
  async function requestLive(){
    if(uatChecks.length!==UAT_CHECKS.length||evidence.trim().length<12){setError('Complete all UAT checks and enter test evidence before requesting promotion.');return}
    if(!data||busy||!window.confirm('Submit this tested UAT version for a Platform Admin to approve for Live? This will not deploy code automatically.'))return
    setBusy(true);setError('')
    try{
      const response=await fetch('https://api.hi5central.com/api/v1/updates/version',{cache:'no-store'})
      const live= response.ok?await response.json():{}
      await api('/api/v1/updates/uat-review',{method:'POST',body:JSON.stringify({
        acceptWholeBuild:true,baselineSha:live.sha||'',evidence:encodeEvidence(uatChecks,evidence),requestLive:true})})
      setReview({status:'requested',buildSha:data.sha,evidence})
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  if(!visible)return null
  const releases=data?.releases||[]
  const installedSha=data?.installedVersionSha||''
  const installed=releases.find(release=>release.buildSha===installedSha)
  const latest=releases[0]
  const candidate=releases.find(release=>release.buildSha===data?.sha)
  const preview=ENV!=='live'&&Boolean(installedSha)&&!installed
  const latestNotInstalled=Boolean(latest&&installedSha&&latest.buildSha!==installedSha)
  const unverified=!installedSha
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
        <article><span className="hi5-updates-kicker">Running portal version</span>
          <strong>{displayVersion(installed?.versionLabel)||(unverified?'Version not verified':'Version not published')}</strong>
          <small>{installed?'Published Hi5Central release':'No published Hi5Central release for this installation'} · {ENV.toUpperCase()}</small></article>
        <article><span className="hi5-updates-kicker">Latest published release</span>
          <strong>{displayVersion(latest?.versionLabel)||'No releases yet'}</strong>
          <small>{latest?dateLabel(latest.publishedAt)+' · Publication does not install an update':'No published release recorded'}</small></article>
        <article><span className="hi5-updates-kicker">Update status</span>
          <strong>{unverified?'Unable to verify':preview?'Preview':latestNotInstalled?'Published, not installed':installed?'Portal build current':'No confirmed update'}</strong>
          <small>{unverified?'The portal frontend build could not be verified. No installation claim is made.':
            preview?'The running frontend build has no published customer version label.':
            latestNotInstalled?'The latest catalogue release has not been verified as installed here.':
            installed?'This portal matches the latest published frontend build.':
            'The installed build is not associated with a current published version.'}</small></article>
      </div>
      {ENV==='dev'?<DevReleaseReadiness data={data}/>:null}
      {ENV==='dev'?<>
        <DevReleaseEditor key={data.sha} installed={data.sha} onPublished={refresh}/>
        {/* Central submission is the sole authoritative Dev release workflow. */}
      </>:null}
      {ENV==='uat'&&canReview?<div className="hi5-updates-approval">
        <div><strong><GitBranch size={17}/> UAT release review</strong>
          <small>{review?.status==='requested'?'Promotion requested':candidate?'Published candidate':'Awaiting Dev release'}</small></div>
        <p>{candidate?'Review the Dev-authored release notes above and record testing before requesting Live deployment.':
          'The Dev team must release the customer-facing notes for this version before UAT can request promotion.'}</p>
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
          <button type="button" className="is-primary" disabled={busy||!candidate||review?.status==='requested'||evidence.trim().length<12||uatChecks.length!==UAT_CHECKS.length}
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
                {release.buildSha===installedSha?' · Running portal':''}</small></span>
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
