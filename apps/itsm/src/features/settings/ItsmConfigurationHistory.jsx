import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

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
      setState({loading:false,error:'',changes:payload.changes||[],
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
      <div className="hi5-release-history">
        {state.changes.map(change=><div key={change.id} className="hi5-release-history-row">
          <strong>{(change.changedKeys||[]).join(', ')||'ITSM settings changed'}</strong>
          <span>{change.environment?.toUpperCase()} · {new Date(change.recordedAt).toLocaleString()} · {change.actorUserId||'System'}</span>
          <small>Revision {String(change.afterHash||'').slice(0,12)}</small>
        </div>)}
      </div>
    </div>
  </section>
}
