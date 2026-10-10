import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, GitBranch, RefreshCw, RotateCcw, ShieldCheck, XCircle } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'
import './ProductionReleaseManagement.css'

const API_BASE = window.__HI5_API_BASE__

async function tenantReleaseApi(path = '', options = {}) {
  const response = await fetch(`${API_BASE}/api/v1/release-management${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`)
  return payload
}

async function releaseApi(path, options = {}) {
  const response = await fetch(`${API_BASE}/api/platform/v1/releases${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`)
  return payload
}

function statusLabel(value = '') {
  return String(value || 'pending').replaceAll('_', ' ')
}

function ResultPill({ value }) {
  const normalized = String(value || 'pending').toLowerCase()
  return <span className={`hi5-release-result is-${normalized}`}>{statusLabel(normalized)}</span>
}

function EnvironmentCard({ item, onReset, busy }) {
  const name = item.environment
  const title = name === 'test' ? 'Test' : name === 'uat' ? 'UAT' : name === 'live' ? 'Live' : 'Development'
  const copy = name === 'test'
    ? 'Disposable test data. Every registered feature for this edition is enabled automatically.'
    : name === 'uat'
      ? 'Controlled acceptance environment. Enable only the features you are actively validating.'
      : name === 'live'
        ? 'Production environment. Only explicitly selected, UAT-passed changes are activated.'
        : 'Hi5Central engineering source environment.'
  return <article className="hi5-release-env-card">
    <header><div><span>{name.toUpperCase()}</span><strong>{title}</strong></div><ResultPill value={item.featureMode === 'all_enabled' ? 'all_enabled' : 'controlled'} /></header>
    <p>{copy}</p>
    <small>{item.activeReleaseRef ? `Release ${item.activeReleaseRef}` : 'No release reference recorded yet.'}</small>
    {name === 'test' ? <button className="is-danger" disabled={busy} onClick={onReset} type="button"><RotateCcw size={15} />Reset Test to default</button> : null}
  </article>
}

function SandboxReleaseOverview() {
  const config=deploymentConfig()
  const environment=config.runtimeEnvironment
  const slug=window.location.hostname.split('.')[0].replace(/-(uat|test)$/, '')
  const liveUrl=`https://${slug}.${config.rootDomain}/settings/platform/releases`
  const [state,setState]=useState({loading:true,error:'',releaseRef:'',lastDeployedAt:null})
  useEffect(()=>{
    let active=true
    tenantReleaseApi().then(payload=>{
      if(!active)return
      const matching=(payload.environments||[]).find(item=>item.environment===environment)
      setState({loading:false,error:'',releaseRef:matching?.activeReleaseRef||'',lastDeployedAt:matching?.lastDeployedAt||null})
    }).catch(error=>{
      if(active)setState({loading:false,error:error.message,releaseRef:'',lastDeployedAt:null})
    })
    return ()=>{active=false}
  },[environment])
  const isUat=environment==='uat'
  return <div className="hi5-release-settings" data-hi5-sandbox-releases={environment}>
    <section className="production-settings-panel">
      <header><div>
        <h2>{isUat?'UAT release validation':'Test release overview'}</h2>
        <p>{isUat
          ? 'This workspace is for checking staged features before they are approved for Production.'
          : 'This disposable workspace is for testing features before they are staged in UAT.'}</p>
      </div></header>
      <div className="production-settings-panel-body">
        <div className="hi5-release-env-grid">
          <article className="hi5-release-env-card">
            <header><div><span>ENVIRONMENT</span><strong>{isUat?'UAT / Staging':'Test'}</strong></div><ResultPill value="ready"/></header>
            <p>{isUat?'Controlled, isolated release acceptance':'All-feature testing, isolated from Live'}</p>
            <small>Tenant: {window.location.hostname}</small>
          </article>
          <article className="hi5-release-env-card">
            <header><div><span>DEPLOYED RELEASE</span><strong>{state.loading?'Checking…':state.releaseRef||'Not assigned'}</strong></div></header>
            <p>{state.releaseRef
              ? 'Latest tenant-specific release reference reported by this environment.'
              : 'No tenant-specific release reference has been recorded here yet.'}</p>
            <small>{state.lastDeployedAt?'Last recorded deployment: '+new Date(state.lastDeployedAt).toLocaleString():'No deployment timestamp recorded'}</small>
          </article>
        </div>
        {state.error?<p className="hi5-release-message is-error"><CircleAlert size={16}/>{state.error}</p>:null}
        <div className="hi5-release-sandbox-guidance">
          <strong>{isUat?'How to validate a release':'How Test fits into releases'}</strong>
          <p>{isUat
            ? 'Use this environment to exercise the staged change and confirm it works. Your organisation’s Live release centre is where an administrator selects what enters UAT and approves the promotion to Production.'
            : 'Test is the unrestricted sandbox. When a change has been qualified, use the Live release centre to select it for UAT acceptance.'}</p>
          <a className="hi5-release-open-live" href={liveUrl}>
            <GitBranch size={16}/> Open Live release management ↗
          </a>
          <small>Release approval and promotion are not performed from this sandbox. A feature is not promoted merely by appearing here.</small>
        </div>
      </div>
    </section>
  </div>
}

export function ProductionReleaseManagement() {
  const environment=deploymentConfig().runtimeEnvironment
  return environment==='uat'||environment==='test'
    ? <SandboxReleaseOverview/>
    : <LiveProductionReleaseManagement/>
}

function LiveProductionReleaseManagement() {
  const [data,setData]=useState({environments:[],features:[],changes:[],actions:[]})
  const [tenantEnvironments,setTenantEnvironments]=useState([])
  const [platformAvailable,setPlatformAvailable]=useState(false)
  const [policy,setPolicy]=useState({updateMode:'admin_controlled',releaseChannel:'stable',liveDelayHours:24,allowEmergencySecurityUpdates:true,maintenanceWindow:{timezone:'Europe/London',days:[],start:'02:00',end:'05:00'}})
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  const [uatSelection,setUatSelection]=useState([])

  async function load() {
    setError('')
    try {
      const [platformResult,tenantResult]=await Promise.allSettled([releaseApi('/overview'),tenantReleaseApi()])
      if(tenantResult.status!=='fulfilled') throw tenantResult.reason
      const tenantState=tenantResult.value
      setTenantEnvironments(tenantState?.environments || [])
      if(platformResult.status==='fulfilled') {
        setData(platformResult.value)
        setPlatformAvailable(true)
        setPolicy(platformResult.value?.deploymentPolicy || tenantState.preference)
      } else {
        setPlatformAvailable(false)
        setData({environments:[],features:[],changes:[],actions:[]})
        if(tenantState?.preference)setPolicy(tenantState.preference)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(()=>{load()},[])

  const liveSelected=useMemo(()=>data.changes.filter(item=>item.state==='selected_for_live'),[data.changes])

  async function action(key,fn,success='') {
    setBusy(key);setError('');setMessage('')
    try {
      await fn()
      if(success)setMessage(success)
      await load()
    } catch(err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }


  async function savePolicy(nextMode = policy.updateMode) {
    const next={...policy,updateMode:nextMode}
    setPolicy(next)
    await action('policy',async()=>{
      const payload={
        updateMode:next.updateMode,
        releaseChannel:next.releaseChannel||'stable',
        liveDelayHours:Number(next.liveDelayHours||0),
        allowEmergencySecurityUpdates:next.allowEmergencySecurityUpdates!==false,
        maintenanceWindow:next.maintenanceWindow||{},
      }
      const tenantResult=await tenantReleaseApi('/preferences',{method:'PATCH',body:JSON.stringify(payload)})
      if(tenantResult?.preference)setPolicy(tenantResult.preference)
      if(platformAvailable) {
        const deploymentResult=await releaseApi('/deployment/preferences',{method:'PATCH',body:JSON.stringify(payload)})
        if(deploymentResult?.preference)setPolicy(deploymentResult.preference)
      }
    },nextMode==='hi5_managed'?'Hi5Central managed updates enabled.':'Admin-controlled updates enabled.')
  }

  async function openEnvironment(environment) {
    setBusy('environment-'+environment)
    setError('')
    try {
      const result=await tenantReleaseApi('/environment-access',{
        method:'POST',body:JSON.stringify({environment}),
      })
      if (!result?.url) throw new Error('The environment is not ready to open.')
      window.location.assign(result.url)
    } catch (error) {
      setError(error.message)
      setBusy('')
    }
  }

  async function provisionEnvironments() {
    await action('provision',()=>tenantReleaseApi('/provision',{method:'POST',body:'{}'}),'Test and UAT provisioning checked.')
  }

  async function resetTest() {
    if(!window.confirm('Reset Test to its default state? All Test data will be destroyed.'))return
    await action('reset',()=>releaseApi('/environments/test/reset',{method:'POST',body:'{}'}),'Test reset queued.')
  }

  async function record(change,environment,result) {
    const notes=window.prompt(`${environment.toUpperCase()} ${result} notes`,'')
    if(notes===null)return
    await action(`result-${change.id}`,()=>releaseApi(`/changes/${change.id}/test-results`,{
      method:'POST',body:JSON.stringify({environment,result,notes}),
    }),`${environment.toUpperCase()} result recorded.`)
  }

  async function toggleFeature(feature,environment) {
    await action(`feature-${feature.key}-${environment}`,()=>releaseApi(`/features/${encodeURIComponent(feature.key)}/${environment}`,{
      method:'PATCH',body:JSON.stringify({enabled:!feature.flags?.[environment]}),
    }))
  }

  async function toggleLive(change) {
    const selected=change.state==='selected_for_live'
    await action(`live-${change.id}`,()=>releaseApi(`/changes/${change.id}/${selected?'unselect-live':'select-live'}`,{method:'POST',body:'{}'}))
  }

  async function sendToUat() {
    if(!uatSelection.length)return
    const releaseRef=window.prompt('UAT release reference',`uat-${new Date().toISOString().slice(0,10)}`)
    if(releaseRef===null)return
    await action('uat',async()=>{
      await releaseApi('/promotions',{method:'POST',body:JSON.stringify({toEnvironment:'uat',changeIds:uatSelection,releaseRef})})
      setUatSelection([])
    },'UAT deployment queued.')
  }

  async function pushLive() {
    if(!liveSelected.length)return
    if(!window.confirm(`Push ${liveSelected.length} selected UAT-approved change${liveSelected.length===1?'':'s'} to Live?`))return
    const releaseRef=window.prompt('Live release reference',`release-${new Date().toISOString().slice(0,10)}`)
    if(releaseRef===null)return
    await action('live',()=>releaseApi('/promotions',{method:'POST',body:JSON.stringify({toEnvironment:'live',changeIds:liveSelected.map(item=>item.id),releaseRef})}),'Live promotion queued.')
  }

  if(loading)return <section className="production-settings-panel"><div className="hi5-release-loading"><RefreshCw size={18}/>Loading release control…</div></section>

  return <div className="hi5-release-settings">

    <section className="production-settings-panel">
      <header><div><h2>Who manages platform updates?</h2><p>Choose whether your administrators approve each release or Hi5Central handles the release flow automatically using your policy.</p></div></header>
      <div className="production-settings-panel-body">
        <div className="hi5-release-policy-grid">
          <button className={policy.updateMode==='admin_controlled'?'is-selected':''} disabled={Boolean(busy)} onClick={()=>savePolicy('admin_controlled')} type="button">
            <ShieldCheck size={18}/><span><strong>Admin controlled</strong><small>Hi5Central publishes the update to Test, but your admin chooses what enters UAT and exactly what is promoted to Production.</small></span>
          </button>
          <button className={policy.updateMode==='hi5_managed'?'is-selected':''} disabled={Boolean(busy)} onClick={()=>savePolicy('hi5_managed')} type="button">
            <RefreshCw size={18}/><span><strong>Hi5Central managed</strong><small>The local release operator follows Hi5Central's signed release feed, stages UAT automatically and promotes approved releases inside your update window.</small></span>
          </button>
        </div>
        <div className="hi5-release-policy-fields">
          <label>Production delay after UAT
            <div><input type="number" min="0" max="720" value={policy.liveDelayHours??24} onChange={e=>setPolicy({...policy,liveDelayHours:e.target.value})}/><span>hours</span></div>
          </label>
          <label>Maintenance window start
            <input type="time" value={policy.maintenanceWindow?.start||'02:00'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),start:e.target.value}})}/>
          </label>
          <label>Maintenance window end
            <input type="time" value={policy.maintenanceWindow?.end||'05:00'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),end:e.target.value}})}/>
          </label>
          <label>Time zone
            <input value={policy.maintenanceWindow?.timezone||'Europe/London'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),timezone:e.target.value}})}/>
          </label>
          <label className="hi5-release-policy-check"><input type="checkbox" checked={policy.allowEmergencySecurityUpdates!==false} onChange={e=>setPolicy({...policy,allowEmergencySecurityUpdates:e.target.checked})}/><span><strong>Allow emergency security updates</strong><small>Critical security fixes can bypass the normal delay, but still use signed release artifacts and audit logging.</small></span></label>
          <button className="hi5-release-policy-save" disabled={Boolean(busy)} onClick={()=>savePolicy()} type="button">Save update policy</button>
        </div>
      </div>
    </section>

    {platformAvailable ? (
    <section className="production-settings-panel">
      <header><div><h2>Release environments</h2><p>Test everything safely, validate selected features in UAT, then explicitly promote approved changes to Live.</p></div><button className="hi5-release-refresh" onClick={load} type="button"><RefreshCw size={15}/>Refresh</button></header>
      <div className="production-settings-panel-body">
        {error?<div className="hi5-release-message is-error"><CircleAlert size={16}/>{error}</div>:null}
        {message?<div className="hi5-release-message is-success"><CheckCircle2 size={16}/>{message}</div>:null}
        <div className="hi5-release-env-grid">
          {['dev','test','uat','live'].map(name=>{
            const item=data.environments.find(env=>env.environment===name)||{environment:name,featureMode:name==='dev'||name==='test'?'all_enabled':'controlled'}
            return <EnvironmentCard key={name} item={item} busy={Boolean(busy)} onReset={resetTest}/>
          })}
        </div>
      </div>
    </section>
    ) : null}

    <section className="production-settings-panel">
      <header><div><h2>Your organisation environments</h2><p>Live, UAT and Test use tenant-isolated records. Each sandbox shares the relevant environment's application infrastructure, not a separate installation.</p></div>
        <button disabled={Boolean(busy)} onClick={provisionEnvironments} type="button"><RefreshCw size={15}/>Provision / retry</button></header>
      <div className="production-settings-panel-body">
        {error?<div className="hi5-release-message is-error"><CircleAlert size={16}/>{error}</div>:null}
        {message?<div className="hi5-release-message is-success"><CheckCircle2 size={16}/>{message}</div>:null}
        <div className="hi5-release-env-grid">
          {['test','uat','live'].map(name=>{
            const env=tenantEnvironments.find(item=>item.environment===name)
            return <article key={name} className="hi5-release-env-card">
              <header><div><span>{name.toUpperCase()}</span><strong>{name==='uat'?'Acceptance':name==='test'?'Sandbox':'Production'}</strong></div><ResultPill value={env?.status || 'available'} /></header>
              <p>{name==='test'?'Isolated, disposable Test data':name==='uat'?'Tenant acceptance and release validation':'Your live tenant workspace'}</p>
              {name==='live' && env?.status==='ready'
                ? <small>You are already in the Live (Production) workspace. No separate provisioning is required.</small>
                : env?.url && env.status==='ready'
                  ? <button type="button" disabled={Boolean(busy)} onClick={()=>openEnvironment(name)}>Open {name.toUpperCase()} workspace ↗</button>
                  : <small>{env?.status==='error'
                    ? 'Provisioning requires attention. Use retry or contact support.'
                    : env?.status==='ready'
                      ? 'Workspace is ready, but its link is not available.'
                      : 'Workspace is not yet provisioned.'}</small>}
            </article>
          })}
        </div>
      </div>
    </section>

    {platformAvailable ? (
    <section className="production-settings-panel">
      <header><div><h2>Feature activation</h2><p>Test is always enabled for your edition. UAT and Live switches are controlled independently.</p></div></header>
      <div className="production-settings-panel-body">
        {data.features.length?<div className="hi5-release-feature-table">
          <div className="hi5-release-feature-head"><span>Feature</span><span>Test</span><span>UAT</span><span>Live</span></div>
          {data.features.map(feature=><div className="hi5-release-feature-row" key={feature.key}>
            <div><strong>{feature.title}</strong><small>{feature.key} · {feature.component}</small></div>
            <span className="hi5-release-always-on">ON</span>
            {['uat','live'].map(environment=><label className="hi5-release-switch" key={environment}>
              <input type="checkbox" checked={Boolean(feature.flags?.[environment])} disabled={Boolean(busy)} onChange={()=>toggleFeature(feature,environment)}/><span/>
            </label>)}
          </div>)}
        </div>:<div className="hi5-release-empty">No feature-gated changes are currently published for this installation.</div>}
      </div>
    </section>
    ) : null}

    {platformAvailable ? (
    <section className="production-settings-panel">
      <header><div><h2>Changes</h2><p>Every change keeps independent Test and UAT evidence. Only UAT-passed items can be selected for Live.</p></div>
        <div className="hi5-release-toolbar"><button disabled={!uatSelection.length||Boolean(busy)} onClick={sendToUat} type="button"><GitBranch size={15}/>Send selected to UAT ({uatSelection.length})</button><button className="is-primary" disabled={!liveSelected.length||Boolean(busy)} onClick={pushLive} type="button"><ShieldCheck size={15}/>Push selected to Live ({liveSelected.length})</button></div>
      </header>
      <div className="production-settings-panel-body hi5-release-change-list">
        {data.changes.map(change=>{
          const testPassed=change.testResult?.result==='passed'
          const uatPassed=change.uatResult?.result==='passed'
          const selectedForUat=uatSelection.includes(change.id)
          return <article className="hi5-release-change" key={change.id}>
            <div className="hi5-release-change-title"><div><span>{change.changeKey} · {change.component}</span><strong>{change.title}</strong><p>{change.description||'No additional release notes.'}</p></div><ResultPill value={change.state}/></div>
            <div className="hi5-release-stage-grid">
              <div><header><strong>Test</strong><ResultPill value={change.testResult?.result}/></header><small>{change.testResult?.notes||'Awaiting result.'}</small><div><button onClick={()=>record(change,'test','passed')} disabled={Boolean(busy)}><CheckCircle2 size={13}/>Pass</button><button onClick={()=>record(change,'test','failed')} disabled={Boolean(busy)}><XCircle size={13}/>Error</button></div></div>
              <div><header><strong>UAT</strong><ResultPill value={change.uatResult?.result}/></header><small>{change.uatResult?.notes||'Requires a passed Test result first.'}</small><div><button onClick={()=>record(change,'uat','passed')} disabled={!testPassed||Boolean(busy)}><CheckCircle2 size={13}/>Pass</button><button onClick={()=>record(change,'uat','failed')} disabled={!testPassed||Boolean(busy)}><XCircle size={13}/>Error</button></div></div>
              <div className="hi5-release-selection">
                <label><input type="checkbox" checked={selectedForUat} disabled={!testPassed||Boolean(busy)} onChange={()=>setUatSelection(current=>current.includes(change.id)?current.filter(id=>id!==change.id):[...current,change.id])}/>Include in next UAT deployment</label>
                <label><input type="checkbox" checked={change.state==='selected_for_live'} disabled={!uatPassed||Boolean(busy)} onChange={()=>toggleLive(change)}/>Selected for Live</label>
              </div>
            </div>
          </article>
        })}
        {!data.changes.length?<div className="hi5-release-empty">No Hi5Central release changes are waiting for validation.</div>:null}
      </div>
    </section>
    ) : null}

    {platformAvailable ? (
    <section className="production-settings-panel">
      <header><div><h2>Deployment actions</h2><p>Reset and promotion jobs are executed by the isolated Hi5Central Release Operator, not by the web application.</p></div></header>
      <div className="production-settings-panel-body">
        <div className="hi5-release-action-list">
          {(data.actions||[]).slice(0,12).map(item=><div key={item.id}><span>{item.environment.toUpperCase()}</span><strong>{statusLabel(item.action)}</strong><ResultPill value={item.status}/><small>{item.errorMessage||new Date(item.requestedAt).toLocaleString()}</small></div>)}
          {!data.actions?.length?<div className="hi5-release-empty">No deployment actions have been requested yet.</div>:null}
        </div>
      </div>
    </section>
    ) : null}
  </div>
}
