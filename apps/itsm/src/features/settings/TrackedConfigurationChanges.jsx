import {useEffect,useState} from 'react'
import {GitBranch,RefreshCw,ShieldCheck} from 'lucide-react'
import {deploymentConfig} from '../../lib/deploymentConfig.js'
import './TrackedConfigurationChanges.css'

const API_BASE=window.__HI5_API_BASE__
async function api(path='',opts={}){
  const res=await fetch(`${API_BASE}/api/v1/release-management/configuration-changes${path}`,{
    credentials:'include',headers:{'Content-Type':'application/json'},cache:'no-store',...opts,
  })
  const data=await res.json().catch(()=>({}))
  if(!res.ok)throw Error(data.error||`HTTP ${res.status}`)
  return data
}
export function TrackedConfigurationChanges({environment}){
  const uat=environment==='uat'
  const [data,setData]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  const [selected,setSelected]=useState([])
  const [tested,setTested]=useState(false)
  const [note,setNote]=useState('')
  const config=deploymentConfig()
  const slug=window.location.hostname.split('.')[0].replace(/-(uat|test)$/,'')
  const liveUrl=`https://${slug}.${config.rootDomain}/settings/platform/releases`
  async function load(){
    setError('')
    try{setData(await api())}catch(e){setError(e.message)}
  }
  useEffect(()=>{load()},[])
  const changes=data?.changes||[]
  const events=data?.trackedEvents||[]
  const pending=changes.filter(x=>x.promotable&&!x.versionUpgradeRequired)
  const readyToPromote=selected.length>0&&tested&&note.trim().length>=20&&!busy
  const missingRequirements=[
    !selected.length?'Select the change you want to promote.':null,
    !tested?'Confirm that the selected change has been tested in UAT.':null,
    note.trim().length<20?`Add test evidence (at least 20 characters; ${note.trim().length}/20 entered).`:null,
  ].filter(Boolean)
  const seen=new Set()
  const recent=events.filter(item=>{
    const key=[item.source,item.recordKey,(item.path||[]).join('.')].join(':')
    if(seen.has(key))return false
    seen.add(key);return true
  }).slice(0,30)
  async function promote(){
    const picks=pending.filter(x=>selected.includes(x.id))
    if(!picks.length||!tested||note.trim().length<20)return
    if(!window.confirm(`Promote ${picks.length} tested settings to Production? No test tickets or user sessions will be copied.`))return
    setBusy(true);setError('');setMessage('')
    try{
      const r=await api('/promote',{
        method:'POST',
        body:JSON.stringify({confirmed:true,tested:true,note,
          changes:picks.map(x=>({id:x.id,beforeHash:x.beforeHash,afterHash:x.afterHash}))}),
      })
      setMessage(`${r.promoted.count} tested setting(s) promoted to Production.`)
      setSelected([]);setTested(false);setNote('')
      await load()
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <section className="production-settings-panel" data-hi5-auto-config-tracking={environment}>
    <header><div><h2>Tracked configuration changes</h2>
      <p>{uat
        ? 'Changes are recorded automatically when saved. There is no need to create a release item.'
        : 'Configuration differences are detected automatically. Promote only what has been tested and approved.'}</p>
    </div><button type="button" disabled={busy} onClick={load} className="hi5-release-refresh"><RefreshCw size={15}/> Refresh</button></header>
    <div className="production-settings-panel-body hi5-tracked-config">
      {error?<p className="hi5-release-message is-error" role="alert">{error}</p>:null}
      {message?<p className="hi5-release-message is-success" role="status">{message}</p>:null}
      {!data&&!error?<p>Checking configuration changes…</p>:null}
      {uat?<>
        <p>Recent automatically recorded changes: <strong>{recent.length}</strong></p>
        {recent.map((x,i)=><div className="hi5-tracked-config-row" key={i}>
          <strong>{x.source.replaceAll('_',' ')} · {(x.path||[]).join(' / ')||'configuration'}</strong>
          <small>{x.operation} · {x.recordedAt?new Date(x.recordedAt).toLocaleString():'UAT change'}</small>
        </div>)}
        {!recent.length?<p>Changes made before automatic tracking are still detected when comparing UAT against Production.</p>:null}
        <a className="hi5-release-open-live" href={liveUrl}><GitBranch size={16}/> Review pending changes in Production ↗</a>
      </>:<>
        <p>{changes.length
          ? `${changes.length} UAT configuration difference(s) waiting for review.`
          : 'UAT settings match Production. No pending differences.'}</p>
        {data?.baselineExcludedCount>0?<p><small>{data.baselineExcludedCount} older UAT/Production baseline differences are excluded from this MFA-only pilot until their change history and safe promotion handlers have been reviewed.</small></p>:null}
        {changes.map(x=><label className="hi5-tracked-config-row" key={x.id}>
          <span className="hi5-tracked-config-selection">
            <input type="checkbox" checked={selected.includes(x.id)}
              disabled={!x.promotable||x.versionUpgradeRequired||busy}
              onChange={e=>setSelected(old=>e.target.checked?[...old,x.id]:old.filter(id=>id!==x.id))}/>
            <span><strong>{x.title}</strong>
              <small>{x.category} · {x.from!==null||x.to!==null?`${String(x.from)} → ${String(x.to)}`:'Setting updated'}</small>
            </span>
          </span>
          {x.versionUpgradeRequired?<small>Requires an application version upgrade to support this change.</small>:null}
          {!x.promotable?<small>Tracked; a safe promotion handler is not yet available for this setting.</small>:null}
        </label>)}
        {pending.length?<div className="hi5-tracked-config-approval">
          <label><input type="checkbox" checked={tested} onChange={e=>setTested(e.target.checked)}/> I have tested the selected changes in UAT.</label>
          <textarea rows={3} maxLength={3000} value={note} onChange={e=>setNote(e.target.value)}
            placeholder="Describe what passed in UAT (minimum 20 characters)"/>
          {!readyToPromote?<div className="hi5-tracked-config-prerequisites" role="status">
            <strong>To enable promotion:</strong>
            <ul>{missingRequirements.map(item=><li key={item}>{item}</li>)}</ul>
          </div>:<p role="status" className="hi5-tracked-config-ready">Ready to promote the selected, tested UAT configuration.</p>}
          <button type="button" disabled={!readyToPromote}
            aria-describedby="hi5-promotion-help"
            onClick={promote}><ShieldCheck size={16}/> {busy?'Promoting…':selected.length?`Promote ${selected.length} selected change(s)`:'Select changes to promote'}</button>
          <small id="hi5-promotion-help">Production is not changed until you confirm this action.</small>
        </div>:null}
      </>}
    </div>
  </section>
}
