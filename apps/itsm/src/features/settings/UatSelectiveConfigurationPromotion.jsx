import {useCallback,useEffect,useState} from 'react'
import {ArrowRight,CheckCircle2,RefreshCw,RotateCcw,ShieldCheck,TriangleAlert} from 'lucide-react'
import {auditSettingName,auditValueText} from './itsmAuditDescriptions.js'
import './UatSelectiveConfigurationPromotion.css'

const api=window.__HI5_API_BASE__||''
const labels={
  ready:'Ready to promote',
  promoted:'Promoted',
  reverted:'Previously reverted',
  already_applied:'Already matches Production',
  conflict:'Production differs from the UAT starting value',
  unknown_baseline:'Original Production value is unknown',
  superseded:'Superseded by a later UAT edit',
}
function when(value) {
  const date=new Date(value)
  return Number.isFinite(date.getTime())?date.toLocaleString():'Date unavailable'
}
function SettingValue({value}) {
  return <strong>{auditValueText(value)}</strong>
}
export function UatSelectiveConfigurationPromotion() {
  const [state,setState]=useState({loading:true,error:'',candidates:[],history:[]})
  const [busy,setBusy]=useState('')
  const [message,setMessage]=useState('')
  const refresh=useCallback(async()=>{
    setState(old=>({...old,loading:true,error:''}))
    try {
      const response=await fetch(api+'/api/v1/release-management/configuration-promotions',{
        credentials:'include',cache:'no-store',
      })
      const body=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(body.error||'Unable to compare UAT and Production safely.')
      setState({loading:false,error:'',candidates:body.candidates||[],history:body.history||[]})
    }catch(error){
      setState(old=>({...old,loading:false,error:error.message}))
    }
  },[])
  useEffect(()=>{refresh()},[refresh])
  async function act(action,item) {
    const path=item.path
    const name=auditSettingName(path)
    const approving=action==='promote'
    if(!window.confirm(approving
      ?'Apply this exact UAT ITSM setting to Production?\n\n'+name+': '+
        auditValueText(item.liveValue)+' → '+auditValueText(item.after)+
        '\n\nNo other settings, People records or RMM devices will change.'
      :'Revert this Production ITSM setting?\n\n'+name+': '+
        auditValueText(item.after)+' → '+auditValueText(item.before)+
        '\n\nThis will be blocked if someone has edited Production since promotion.'))return
    setBusy(approving?item.eventId+':'+path:item.id)
    setMessage('')
    try{
      const response=await fetch(api+'/api/v1/release-management/configuration-promotions'+
        (approving?'':'/'+encodeURIComponent(item.id)+'/revert'),{
          method:'POST',credentials:'include',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(approving?{eventId:item.eventId,path}:{}),
        })
      const payload=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(payload.error||'The change could not be approved safely.')
      setMessage(approving
        ?name+' has been promoted to Production.'
        :name+' has been reverted in Production.')
      await refresh()
    }catch(error){setState(old=>({...old,error:error.message}))}
    finally{setBusy('')}
  }
  const ready=state.candidates.filter(x=>x.status==='ready')
  const other=state.candidates.filter(x=>x.status!=='ready')
  return <section className="production-settings-panel" data-hi5-selective-config-promotion>
    <header><div>
      <h2>Promote individual ITSM settings from UAT</h2>
      <p>Review precisely what changed, compare the current Production value,
        then approve only the setting you want. No database snapshots or application updates are copied.</p>
    </div><button type="button" disabled={state.loading||Boolean(busy)} onClick={refresh}>
      <RefreshCw size={15}/>Refresh
    </button></header>
    <div className="production-settings-panel-body h5c-selective-body">
      {state.error?<p role="alert" className="hi5-release-message is-error"><TriangleAlert size={15}/>{state.error}</p>:null}
      {message?<p role="status" className="hi5-release-message is-success"><CheckCircle2 size={15}/>{message}</p>:null}
      {state.loading?<p>Comparing current UAT and Production settings…</p>:null}
      {!state.loading&&ready.length===0?<p className="h5c-selective-empty">
        No new safe-to-promote ITSM settings. Changes already made in Production are automatically marked as matched.
      </p>:null}
      {ready.map(item=><article key={item.eventId+':'+item.path} className="h5c-selective-item">
        <div className="h5c-selective-title">
          <div><small>UAT change · {when(item.recordedAt)}</small>
            <strong>{auditSettingName(item.path)}</strong></div>
          <span className="h5c-selective-state">Ready</span>
        </div>
        <div className="h5c-selective-values">
          <div><small>Production now</small><SettingValue value={item.liveValue}/></div>
          <ArrowRight size={17} aria-hidden="true"/>
          <div><small>Tested in UAT</small><SettingValue value={item.after}/></div>
        </div>
        <button className="is-primary" disabled={Boolean(busy)}
          onClick={()=>act('promote',item)}><ShieldCheck size={15}/>
          {busy===item.eventId+':'+item.path?'Applying…':'Promote this setting'}
        </button>
      </article>)}
      {other.length>0?<details className="h5c-selective-other">
        <summary>Other UAT changes ({other.length})</summary>
        {other.map(item=><div key={item.eventId+':'+item.path} className="h5c-selective-other-item">
          <strong>{auditSettingName(item.path)}</strong>
          <small>{labels[item.status]||'Needs review'} · UAT {auditValueText(item.after)}
            {item.liveKnown?' · Production '+auditValueText(item.liveValue):''}</small>
        </div>)}
      </details>:null}
      {state.history.length>0?<div className="h5c-selective-history">
        <h3>Promotion and rollback history</h3>
        {state.history.slice(0,20).map(item=><div key={item.id} className="h5c-selective-history-row">
          <div><strong>{auditSettingName(item.path)}</strong>
            <small>{item.status==='reverted'?'Reverted':'Applied'} · {when(item.appliedAt)}</small>
            <small>{auditValueText(item.before)} → {auditValueText(item.after)}</small>
          </div>
          {item.status==='applied'?<button type="button" disabled={Boolean(busy)}
            onClick={()=>act('revert',item)}><RotateCcw size={14}/>Revert</button>:null}
        </div>)}
      </div>:null}
    </div>
  </section>
}
