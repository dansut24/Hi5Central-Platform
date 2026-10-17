import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, GitBranch, RefreshCw, RotateCcw, ShieldCheck, XCircle } from 'lucide-react'
import { deploymentConfig } from '../../lib/deploymentConfig.js'
import {TenantRuntimeUpdates} from './TenantRuntimeUpdates.jsx'
import { ItsmConfigurationHistory } from './ItsmConfigurationHistory.jsx'
import { UatSelectiveConfigurationPromotion } from './UatSelectiveConfigurationPromotion.jsx'
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
  const [uatLiveChatEnabled,setUatLiveChatEnabled]=useState(null)
  useEffect(()=>{
    let active=true
    fetch(`${API_BASE}/api/v1/workspace-features`,{credentials:'include',cache:'no-store'})
      .then(async response=>response.ok?response.json():null)
      .then(payload=>{if(active)setUatLiveChatEnabled(payload?.liveChatEnabled===true)})
      .catch(()=>{if(active)setUatLiveChatEnabled(null)})
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
        <div className="hi5-release-sandbox-guidance">
          <strong>Tenant feature validation</strong>
          <p><strong>Live Chat:</strong> {uatLiveChatEnabled===null?'Checking environment policy…':
            uatLiveChatEnabled?'Enabled for this environment':'Not enabled by this organisation’s release policy'}</p>
          <small>Feature access is separate from the application version displayed above. Test changes in this environment; approve promotion from Live.</small>
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
    {isUat?<ItsmConfigurationHistory/>:null}
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
  const [liveChatRelease,setLiveChatRelease]=useState(null)
  const [uatEvidence,setUatEvidence]=useState('')
  const [platformAvailable,setPlatformAvailable]=useState(false)
  const [platformApplicationDeployments,setPlatformApplicationDeployments]=useState(null)
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
      if(tenantState?.preference?.updateMode==='admin_controlled') {
        // Only tenant owners/admins see this release ledger in their Live workspace.
        const feature=await tenantReleaseApi('/feature-rollouts/live-chat')
        setLiveChatRelease(feature)
      } else setLiveChatRelease(null)
      if(platformResult.status==='fulfilled') {
        setData(platformResult.value)
        setPlatformAvailable(true)
        try {
          setPlatformApplicationDeployments(await releaseApi('/application-deployments'))
        } catch {
          setPlatformApplicationDeployments(null)
        }
        // Customer Settings must never inherit the platform installation
        // policy; only their own per-tenant release preferences are editable.
        if(tenantState.preference)setPolicy(tenantState.preference)
      } else {
        setPlatformAvailable(false)
        setPlatformApplicationDeployments(null)
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
  const appDeployment=liveChatRelease?.applicationDeployment
  const deploymentMatches=appDeployment?.ready === true
  const uatApplicationVerified=appDeployment?.uat?.verified === true

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
      // Never mutate shared platform defaults from a customer Settings page.
      // Platform-wide deployment ownership is exclusive to Platform Admin.
    },'Your update preference was saved. Future approved releases still follow the maintenance window and release gates.')
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

  async function manageLiveChat(actionName) {
    if (actionName==='confirm-uat' && uatEvidence.trim().length<10) {
      setError('Record what you tested in UAT (at least 10 characters).')
      return
    }
    if (actionName==='promote-live' && !deploymentMatches) {
      setError(appDeployment?.reason || 'The approved application must be deployed and verified in Production first.')
      return
    }
    if (actionName==='promote-live' &&
      !window.confirm('The approved application version is verified in Live. Enable the tested Live Chat feature for this organisation?')) return
    await action('live-chat-'+actionName,()=>tenantReleaseApi('/feature-rollouts/live-chat/'+actionName,{
      method:'POST',
      body:JSON.stringify({notes:actionName==='confirm-uat'?uatEvidence:
        actionName==='stage-uat'?'UAT staging requested from customer release centre':'Customer approval to promote UAT-passed Live Chat'}),
    }), actionName==='stage-uat'?'Live Chat enabled in UAT, not Live.':
      actionName==='confirm-uat'?'UAT acceptance and evidence recorded.':
      'Live Chat enabled for this tenant in Live.')
    if(actionName==='confirm-uat')setUatEvidence('')
  }

  async function deployApplication(environment) {
    const source=environment==='live'?'UAT':'Dev'
    if(!window.confirm(`Queue the exact host-verified ${source} application revision for ${environment.toUpperCase()} deployment? This affects the shared API and ITSM used by all tenants.`))return
    await action('app-deploy-'+environment,()=>releaseApi('/application-deployments/promote',{
      method:'POST',body:JSON.stringify({environment}),
    }), 'Application deployment queued. Wait for host verification before approving tenant feature activation.')
  }

  async function decideUatRequest(requestKey,decision){
    if(!window.confirm(decision==='approve'
      ?'Approve the requested UAT build and queue its matching API/ITSM images for Production?'
      :'Reject this UAT release request?'))return
    await action('uat-decision-'+requestKey,()=>releaseApi('/application-release-requests/decision',{
      method:'POST',body:JSON.stringify({requestKey,decision}),
    }),decision==='approve'?'Approved UAT build queued for verified deployment.':'UAT release request rejected.')
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
            <RefreshCw size={18}/><span><strong>Hi5Central managed</strong><small>Test releases are checked automatically. Production follows Hi5Central's verified Test gate, your delay and maintenance window; no UAT is required.</small></span>
          </button>
        </div>
        <div className="hi5-release-policy-fields">
          {policy.updateMode==='hi5_managed'?<label>Production delay after verified Test
            <div><input type="number" min="0" max="720" value={policy.liveDelayHours??24} onChange={e=>setPolicy({...policy,liveDelayHours:e.target.value})}/><span>hours</span></div>
          </label>:null}
          <label>Maintenance window start
            <input type="time" value={policy.maintenanceWindow?.start||'02:00'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),start:e.target.value}})}/>
          </label>
          <label>Maintenance window end
            <input type="time" value={policy.maintenanceWindow?.end||'05:00'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),end:e.target.value}})}/>
          </label>
          <label>Time zone
            <input value={policy.maintenanceWindow?.timezone||'Europe/London'} onChange={e=>setPolicy({...policy,maintenanceWindow:{...(policy.maintenanceWindow||{}),timezone:e.target.value}})}/>
          </label>
          <fieldset className="hi5-release-maintenance-days" style={{gridColumn:'1 / -1',border:0,padding:0}}>
            <legend style={{fontWeight:600,fontSize:13,marginBottom:8}}>Allowed maintenance days</legend>
            <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
              {['mon','tue','wed','thu','fri','sat','sun'].map((day,index)=><label key={day} style={{display:'flex',alignItems:'center',gap:5}}>
                <input type="checkbox" checked={(policy.maintenanceWindow?.days||[]).includes(day)}
                  onChange={event=>setPolicy(current=>{
                    const days=current.maintenanceWindow?.days||[]
                    return {...current,maintenanceWindow:{...current.maintenanceWindow,
                      days:event.target.checked?[...days,day]:days.filter(v=>v!==day)}}
                  })}/>
                {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][index]}
              </label>)}
            </div>
            <small>Application updates will run only inside the chosen window. Empty days are not a valid automatic schedule.</small>
          </fieldset>
          <button className="hi5-release-policy-save" disabled={Boolean(busy)||!(policy.maintenanceWindow?.days||[]).length} onClick={()=>savePolicy()} type="button">Save update policy</button>
        </div>
      </div>
    </section>

    <TenantRuntimeUpdates updateMode={policy.updateMode}/>
    <section className="production-settings-panel" data-hi5-tenant-workspaces>
      <header><div><h2>Your release environments</h2><p>Every customer has an isolated Test and Production workspace. Custom update policies also use UAT before Production approval.</p></div>
        <button type="button" className="hi5-release-refresh" onClick={load} disabled={Boolean(busy)}><RefreshCw size={15}/> Refresh</button>
      </header>
      <div className="production-settings-panel-body">
        <div className="hi5-release-env-grid">
          {['test',...(policy.updateMode==='admin_controlled'?['uat']:[]),'live'].map(name=>{
            const env=tenantEnvironments.find(item=>item.environment===name)
            return <article key={name} className="hi5-release-env-card">
              <header><div><span>{name.toUpperCase()}</span><strong>{name==='uat'?'Acceptance testing':name==='test'?'Automatic Test':'Production'}</strong></div>
                <ResultPill value={env?.status||'pending'}/></header>
              <p>{name==='uat'?'Review and accept the exact tested version before scheduling Live.':
                name==='test'?'Hi5Central stages certified versions for safe validation.':
                'Only verified and approved updates enter your Live workspace during the selected window.'}</p>
              {name==='live'?<small>This is your Production workspace.</small>:
                env?.status==='ready'&&env?.url
                ?<button type="button" disabled={Boolean(busy)} onClick={()=>openEnvironment(name)}>Open {name.toUpperCase()} ↗</button>
                :<small>{env?.status==='error'?'Environment requires provisioning review.':
                  'The workspace will be available when provisioned.'}</small>}
            </article>
          })}
        </div>
        {tenantEnvironments.some(e=>e.status==='error')?
          <button className="hi5-release-refresh" type="button" disabled={Boolean(busy)} onClick={provisionEnvironments}>
            <RefreshCw size={15}/> Retry environment provisioning
          </button>:null}
      </div>
    </section>
    {error?<p role="alert" className="hi5-release-message is-error"><CircleAlert size={15}/>{error}</p>:null}
    {message?<p role="status" className="hi5-release-message is-success"><CheckCircle2 size={15}/>{message}</p>:null}
    <details className="production-settings-panel" data-hi5-advanced-release-tools>
      <summary style={{cursor:'pointer',padding:16,fontWeight:600}}>Advanced feature and configuration release tools</summary>
      <div className="production-settings-panel-body">
        <p>Existing feature flags, selective configuration promotion, shared application operator reports and manual release actions remain here for compatibility. Application-version approvals are handled above.</p>

    {policy.updateMode==='admin_controlled'?<UatSelectiveConfigurationPromotion/>:null}
    <ItsmConfigurationHistory/>

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

    {platformAvailable&&platformApplicationDeployments ? (
      <section className="production-settings-panel" data-hi5-shared-app-deployments>
        <header><div>
          <h2>Shared application deployment</h2>
          <p>Platform Admin only. Deploy exact verified API/ITSM revisions; tenant feature switches cannot upgrade shared application code.</p>
        </div><button className="hi5-release-refresh" type="button" onClick={load}><RefreshCw size={15}/>Refresh</button></header>
        <div className="production-settings-panel-body">
          <div className="hi5-release-env-grid">
            {['dev','uat','live'].map(environment=>{
              const image=platformApplicationDeployments.environments?.[environment]
              return <article className="hi5-release-env-card" key={environment}>
                <header><div><span>{environment.toUpperCase()}</span>
                  <strong>{image?.verified?'Host verified':image?.status==='stale'?'Verification expired':'Not verified'}</strong></div>
                  <ResultPill value={image?.verified?'ready':'pending'} /></header>
                <small>API {image?.apiSha?.slice(0,8)||'unknown'} · ITSM {image?.itsmSha?.slice(0,8)||'unknown'}</small>
                <small>{image?.observedAt?'Verified: '+new Date(image.observedAt).toLocaleString():'Awaiting host report'}</small>
                {environment!=='dev' ? <button type="button" disabled={Boolean(busy)||
                  !platformApplicationDeployments.environments?.[environment==='live'?'uat':'dev']?.verified}
                  onClick={()=>deployApplication(environment)}>
                  <GitBranch size={15}/> Queue {environment==='live'?'UAT → Live':'Dev → UAT'} deployment
                </button> : null}
              </article>
            })}
          </div>
          <div className="hi5-release-sandbox-guidance">
            <strong>UAT change-review requests</strong>
            {(platformApplicationDeployments.reviewRequests||[]).length?
              <div className="hi5-release-history">{platformApplicationDeployments.reviewRequests.slice(0,15).map(req=>
                <div className="hi5-release-history-row" key={req.request_key}>
                  <strong>{req.source_tenant_slug} · Build {req.build_sha?.slice(0,8)} · {statusLabel(req.status)}</strong>
                  <span>{Array.isArray(req.approved_change_shas)?req.approved_change_shas.length:0} changes tested · {new Date(req.received_at).toLocaleString()}</span>
                  {req.evidence?<p>{req.evidence}</p>:null}
                  {req.status==='pending'?<div className="hi5-updates-approval-actions">
                    <button type="button" disabled={Boolean(busy)} onClick={()=>decideUatRequest(req.request_key,'approve')}>
                      <CheckCircle2 size={15}/> Approve and queue Live
                    </button>
                    <button type="button" disabled={Boolean(busy)} onClick={()=>decideUatRequest(req.request_key,'reject')}>
                      <XCircle size={15}/> Reject
                    </button>
                  </div>:null}
                </div>)}</div>
              :<p>No UAT application-release requests are awaiting review.</p>}
          </div>
          <div className="hi5-release-sandbox-guidance">
            <strong>Recent platform deployment jobs</strong>
            {(platformApplicationDeployments.jobs||[]).length?
              <div className="hi5-release-history">{platformApplicationDeployments.jobs.slice(0,8).map(job=>
                <div className="hi5-release-history-row" key={job.id}>
                  <strong>{job.from_environment?.toUpperCase()} → {job.to_environment?.toUpperCase()} · {statusLabel(job.status)}</strong>
                  <span>API {job.api_sha?.slice(0,8)} · ITSM {job.itsm_sha?.slice(0,8)} · {new Date(job.requested_at).toLocaleString()}</span>
                  {job.error_message?<p>{job.error_message}</p>:null}
                </div>)}</div>
              :<p>No application deployments have been queued by Platform Admin yet.</p>}
          </div>
        </div>
      </section>
    ):null}

    {policy.updateMode==='admin_controlled' ? (
      <section className="production-settings-panel" data-hi5-tenant-feature-releases>
        <header><div>
          <h2>Customer feature releases</h2>
          <p>Stage and test individual features for this organisation. Live changes only after recorded UAT acceptance and administrator approval; this does not deploy a new application binary.</p>
        </div></header>
        <div className="production-settings-panel-body">
          <div className="hi5-release-env-grid">
            <article className="hi5-release-env-card">
              <header><div><span>LIVE CHAT · UAT</span><strong>{liveChatRelease?.releaseRef || 'Not staged'}</strong></div>
                <ResultPill value={liveChatRelease?.uatEnabled?'ready':'available'}/></header>
              <p>{liveChatRelease?.uatEnabled?'Enabled for this organisation in UAT. Test it at your UAT URL.':'Stage Live Chat for this tenant in UAT without changing Live.'}</p>
              <button type="button" disabled={Boolean(busy)||!liveChatRelease||
                !tenantEnvironments.some(item=>item.environment==='uat'&&item.status==='ready')}
                onClick={()=>manageLiveChat('stage-uat')}>
                <GitBranch size={15}/>{liveChatRelease?.state==='promoted'?'Stage a new UAT test':'Enable Live Chat in UAT'}
              </button>
              {liveChatRelease?.state==='staged' ? <>
                <label className="hi5-release-uat-evidence-label" htmlFor="hi5-uat-livechat-evidence">
                  UAT test evidence (required for approval)
                </label>
                <textarea id="hi5-uat-livechat-evidence" rows={3} maxLength={2000}
                  value={uatEvidence} onChange={event=>setUatEvidence(event.target.value)}
                  placeholder="Describe the Live Chat actions checked in UAT and whether they worked."/>
                <button type="button" disabled={Boolean(busy)||uatEvidence.trim().length<10||!uatApplicationVerified}
                  onClick={()=>manageLiveChat('confirm-uat')}>
                  <CheckCircle2 size={15}/>Mark UAT passed
                </button>
              </>:null}
              {liveChatRelease?.state==='staged'&&!uatApplicationVerified
                ?<small>The UAT host must report a verified application version before acceptance can be recorded.</small>:null}
              {liveChatRelease?.state==='uat_passed'
                ?<small>{deploymentMatches?'Approved application images match Live; you may enable the feature.':'UAT passed, but application deployment is pending or unverified.'}</small>:null}
            </article>
            <article className="hi5-release-env-card">
              <header><div><span>LIVE CHAT · LIVE</span><strong>{liveChatRelease?.liveEnabled?'Enabled':'Not enabled by this release'}</strong></div>
                <ResultPill value={liveChatRelease?.liveEnabled?'ready':'available'}/></header>
              <p>The feature will be enabled only after the platform has deployed and verified the exact application revision approved in UAT.</p>
              <button type="button" disabled={Boolean(busy)||liveChatRelease?.state!=='uat_passed'||!deploymentMatches}
                onClick={()=>manageLiveChat('promote-live')}>
                <CheckCircle2 size={15}/>Promote approved UAT change to Live
              </button>
              <small>Each decision is recorded against a unique release reference.</small>
            </article>
          </div>
          <div className="hi5-release-sandbox-guidance">
            <strong>Application deployment · shared across tenants</strong>
            <p>Feature approval does not deploy code. Only the platform release operator deploys and verifies shared application images.</p>
            <div className="hi5-release-env-grid">
              {['uat','live'].map(env=>{
                const report=appDeployment?.[env]
                return <article key={env} className="hi5-release-env-card">
                  <header><div><span>{env.toUpperCase()} APPLICATION</span><strong>{report?.verified?'Verified':report?.status==='stale'?'Verification expired':'Not verified'}</strong></div>
                    <ResultPill value={report?.verified?'ready':'pending'}/></header>
                  <small>API: {report?.apiSha?.slice(0,8)||'unknown'} · ITSM: {report?.itsmSha?.slice(0,8)||'unknown'}</small>
                  <small>{report?.observedAt?'Last host check: '+new Date(report.observedAt).toLocaleString():'Awaiting first host verification'}</small>
                </article>
              })}
            </div>
            {liveChatRelease?.state==='uat_passed'&&!deploymentMatches
              ?<p className="hi5-release-message is-error"><CircleAlert size={16}/>{appDeployment?.reason||'Deploy and verify the approved images before enabling the Live feature.'}</p>
              :null}
          </div>
          <div className="hi5-release-sandbox-guidance">
            <strong>Release history · Live Chat</strong>
            {(liveChatRelease?.history||[]).length ? (
              <div className="hi5-release-history">
                {liveChatRelease.history.map(entry=><div className="hi5-release-history-row" key={entry.id}>
                  <strong>{entry.action==='staged_uat'?'Enabled in UAT':
                    entry.action==='uat_passed'?'UAT passed':'Feature enabled in Live'}</strong>
                  <span>{entry.releaseRef} · {entry.actorName} · {new Date(entry.recordedAt).toLocaleString()}</span>
                  {entry.notes?<p>{entry.notes}</p>:null}
                </div>)}
              </div>
            ):<p>No customer feature releases have been recorded yet. Application deployments are tracked separately.</p>}
          </div>
        </div>
      </section>
    ):null}

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
    </details>
  </div>
}
