import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import './ItsmConfigurationHistory.css'

function settingLabel(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/\./g, ' → ')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(sla|cmdb|itsm)\b/gi, token => token.toUpperCase())
    .replace(/\bLive Chat\b/gi, 'Live Chat')
    .trim() || 'ITSM setting'
}

function changeDate(value) {
  const parsed=new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Date unavailable'
}

/** Per-environment ITSM change history, not an unverified ahead/behind count. */
export function ItsmConfigurationHistory() {
  const [state,setState]=useState({loading:true,error:'',changes:[],tracked:false,environment:''})
  const refresh=useCallback(async()=>{
    setState(old=>({...old,loading:true,error:''}))
    try {
      const base=window.__HI5_API_BASE__||''
      const response=await fetch(base+'/api/v1/release-management/configuration-changes',{
        credentials:'include',cache:'no-store',
      })
      const payload=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(payload.error||'Configuration history unavailable.')
      setState({loading:false,error:'',changes:Array.isArray(payload.changes)?payload.changes:[],
        tracked:payload.tracked===true,environment:payload.environment||''})
    }catch(error){
      setState(old=>({...old,loading:false,error:error.message||'Could not load changes.'}))
    }
  },[])
  useEffect(()=>{refresh()},[refresh])
  if(state.environment==='test')return null
  return <section className="production-settings-panel" data-hi5-itsm-config-history>
    <header><div>
      <h2>ITSM configuration change history</h2>
      <p>Environment-specific ITSM settings only. People, login, theme, billing and live RMM devices are excluded. Comparison and selective promotion will follow in a separate reviewed phase.</p>
    </div><button type="button" className="hi5-release-refresh" onClick={refresh} disabled={state.loading}>
      <RefreshCw size={15}/>Refresh
    </button></header>
    <div className="production-settings-panel-body">
      {state.loading?<p>Loading ITSM configuration history…</p>:null}
      {state.error?<p role="alert" className="hi5-release-message is-error">{state.error}</p>:null}
      {!state.loading&&!state.error&&!state.changes.length?
        <p>No environment-specific ITSM settings changes have been recorded yet.</p>:null}
      <div className="hi5-config-history-list">
        {state.changes.map(change=>{
          const keys=Array.isArray(change.changedKeys)?change.changedKeys:[]
          const legacy=change.entityKey!=='tenant_settings.itsm.delta-v2'
          const count=keys.length
          const at=new Date(change.recordedAt)
          const validAt=Number.isFinite(at.getTime())
          return <article key={change.id} className="hi5-config-history-entry">
            <div className="hi5-config-history-head">
              <div className="hi5-config-history-title">
                <span className="hi5-config-history-env">{change.environment?.toUpperCase()||'ITSM'}</span>
                <strong>{legacy?'Legacy full-settings save':count?count+' ITSM setting'+(count===1?'':'s')+' changed':'ITSM settings changed'}</strong>
              </div>
              <time dateTime={validAt?at.toISOString():undefined}>{changeDate(change.recordedAt)}</time>
            </div>
            <details className="hi5-config-history-details">
              {legacy?<p className="hi5-config-history-legacy">This older save included {count} configuration section{count===1?'':'s'} and built-in defaults. It does not prove that you manually changed each one.</p>:null}
              <summary>{legacy?'View included sections':'View changed settings'}</summary>
              {keys.length?<ul className="hi5-config-history-keys">
                {keys.map(key=><li key={key}>{settingLabel(key)}</li>)}
              </ul>:<p>Changed keys were not recorded for this revision.</p>}
              <div className="hi5-config-history-metadata">
                <span>Revision {String(change.afterHash||'').slice(0,12)||'unknown'}</span>
                <span title={change.actorUserId||''}>{change.actorUserId?'Changed by user '+String(change.actorUserId).slice(0,8):'System change'}</span>
              </div>
            </details>
          </article>
        })}
      </div>
    </div>
  </section>
}
