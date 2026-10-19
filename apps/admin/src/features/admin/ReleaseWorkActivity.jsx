import {useEffect,useMemo,useState} from 'react'
import {AlertTriangle,CheckCircle2,Clock3,Pause,RefreshCw,RotateCcw,ShieldAlert,Trash2} from 'lucide-react'
import './ReleaseWorkActivity.css'

const short=value=>String(value||'').slice(0,8)||'—'
const dt=value=>value?new Date(value).toLocaleString('en-GB'):'—'
const duration=value=>Number.isFinite(Number(value))&&value!==null
  ?Math.max(0,Math.round(Number(value)))+'s':'—'

export function ReleaseWorkActivity({api,canApprove}){
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [filter,setFilter]=useState('all')
  const [rollbackData,setRollbackData]=useState(null)
  const [rollbackScope,setRollbackScope]=useState('one')
  const [rollbackEnvironment,setRollbackEnvironment]=useState('live')
  const [rollbackTenant,setRollbackTenant]=useState('')
  const [rollbackReason,setRollbackReason]=useState('')
  const [rollbackBusy,setRollbackBusy]=useState(false)
  async function refresh(){
    try{
      const response=await api('/releases/rollout-jobs/activity')
      setData(response)
      if(canApprove){
        try{
          const rollbackResult=await api('/releases/rollback/candidates?environment='+rollbackEnvironment)
          setRollbackData(rollbackResult)
        }catch{setRollbackData(null)}
      }
      setError('')
    }catch(err){setError(err.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{refresh()},[])
  const jobs=data?.jobs||[]
  const shown=useMemo(()=>filter==='all'?jobs:jobs.filter(j=>j.status===filter),[filter,jobs])
  const totals=useMemo(()=>Object.fromEntries(['scheduled','deferred','running','succeeded','failed','cancelled']
    .map(s=>[s,jobs.filter(j=>j.status===s).length])),[jobs])

  async function run(key,request){
    setBusy(key);setError('');setNotice('')
    try{const result=await request();setNotice(
      result.action==='cancel'?'Job safely cancelled and audited.':
      result.action==='retry'?'Retry scheduled; global rollout remains paused.':
      'New rollout claims paused. Any running deployment must still finish or be handled by the host operator.')
      await refresh()
    }catch(err){setError(err.message)}
    finally{setBusy('')}
  }
  async function requestStageRollback(){
    if(!canApprove||!rollbackData?.queueEnabled){
      setError('Stage rollback executor is not enabled. No changes were made.');return
    }
    if(rollbackScope==='one'&&!rollbackTenant){
      setError('Select a customer to roll back.');return
    }
    if(rollbackReason.trim().length<20){
      setError('Provide at least 20 characters for the rollback audit.');return
    }
    const chosen=rollbackScope==='all'?'ALL eligible Production customers':rollbackTenant
    const confirmed=rollbackScope==='all'?'ROLLBACK ALL PRODUCTION CUSTOMERS':'ROLLBACK ONE CUSTOMER'
    if(!window.confirm(confirmed+'? '+chosen+
      ' / '+rollbackEnvironment.toUpperCase()+
      '. Each customer must be independently verified. This queues recovery work; it does not immediately switch the gateway.'))return
    setRollbackBusy(true);setError('');setNotice('')
    try{
      const result=await api('/releases/rollback/request',{method:'POST',body:JSON.stringify({
        scope:rollbackScope,environment:rollbackEnvironment,
        tenantSlug:rollbackScope==='one'?rollbackTenant:undefined,
        reason:rollbackReason.trim(),confirm:'HI5CENTRAL_ROLLBACK_CONFIRMED',
      })})
      setNotice(result.queued.length+' customer rollback job(s) queued; '+
        (result.skipped?.length||0)+' blocked. Each host route requires separate verification.')
      setRollbackReason('')
      await refresh()
    }catch(e){setError(e.message)}finally{setRollbackBusy(false)}
  }
  async function pause(){
    const reason=window.prompt('Reason for pausing all release rollouts (20 characters minimum)','')
    if(reason===null)return
    if(reason.trim().length<20){setError('Enter at least 20 characters for the audit log.');return}
    if(!window.confirm('Pause all new release job claims? Running jobs are not stopped.'))return
    await run('pause',()=>api('/releases/rollout-jobs/pause',{method:'POST',body:JSON.stringify({
      confirm:'PAUSE_RELEASE_ROLLOUTS',reason,
    })}))
  }
  async function resume(){
    const evidence=data?.resumeReadiness
    if(!data?.canResume||!evidence?.buildSha||!evidence?.jobIds?.length){
      setError(data?.resumeBlockedReason||'The server has not approved fleet resume.');return
    }
    const rows=evidence.jobs.map(j=>j.tenantSlug+' / '+j.environment.toUpperCase()+
      ' / '+dt(j.scheduledAt)).join('\n')
    const reason=window.prompt(
      'Resume the certified release '+short(evidence.buildSha)+
      ' for these exact customers?\n'+rows+
      '\nReason for staff audit (20–500 characters):','')
    if(reason===null)return
    if(reason.trim().length<20){setError('Enter a specific audit reason of at least 20 characters.');return}
    if(!window.confirm(
      'Final confirmation: enable automatic customer releases for this approved SHA. '+
      'Only currently scheduled and independently authorised jobs can deploy, '+
      'and only in their saved maintenance windows. The previously rolled-back '+
      'Managed pilot will NOT automatically redeploy. Continue?'))return
    setBusy('resume');setNotice('');setError('')
    try{
      const result=await api('/releases/rollout-jobs/resume',{
        method:'POST',body:JSON.stringify({
          confirm:'RESUME_VERIFIED_CUSTOMER_RELEASE_FLEET',
          buildSha:evidence.buildSha,expectedJobIds:evidence.jobIds,reason,
        }),
      })
      if(result.paused!==false)throw Error('Central release control has not confirmed activation.')
      setNotice('Customer release automation enabled. '+result.scheduledJobs.length+
        ' approved jobs remain scheduled in their own maintenance windows. '+
        'The completed rollback pilot is not requeued.')
      await refresh()
    }catch(err){setError(err.message)}
    finally{setBusy('')}
  }
  async function armPilot(job){
    const reason=window.prompt(
      'Authorise ONE Managed Production pilot for '+job.tenantSlug+' / LIVE / '+short(job.buildSha)+
      '? Specify your verification and rollback reason (20–500 characters).','')
    if(reason===null)return
    if(reason.trim().length<20){setError('Enter a specific staff audit reason (at least 20 characters).');return}
    if(!window.confirm(
      'Arm ONLY this exact Managed Production job for 30 minutes? The other tenants stay PAUSED. '+
      'The worker must still pass all maintenance, lease, version, gateway and rollback gates.'))return
    setBusy('pilot-'+job.id);setError('');setNotice('')
    try{
      const result=await api('/releases/rollout-jobs/pilot/arm',{
        method:'POST',body:JSON.stringify({
          jobId:job.id,tenantSlug:job.tenantSlug,environment:job.environment,
          buildSha:job.buildSha,reason,confirm:'ARM_SINGLE_MANAGED_PRODUCTION_PILOT',
        }),
      })
      if(!result.pilotArmed)throw Error('The control service did not confirm a pilot permit.')
      setNotice('One Managed Production job armed until '+dt(result.expiresAt)+
        '. Global rollout remains paused; verify the exact customer and rollback before fleet activation.')
      await refresh()
    }catch(err){setError(err.message)}
    finally{setBusy('')}
  }
  async function act(job,action){
    const title=action==='cancel'?'Cancel permanently':'Request guarded retry for'
    const reason=window.prompt(title+' '+job.tenantSlug+' / '+job.environment.toUpperCase()+
      ' / '+short(job.buildSha)+'? Explain the reason for the staff audit.','')
    if(reason===null)return
    if(reason.trim().length<20){setError('Enter at least 20 characters for the audit log.');return}
    if(!window.confirm(action==='cancel'
      ?'Cancel this exact unclaimed job? It cannot be automatically resumed.'
      :'Retry this failed job? The API checks publication, certification and stage approval; rollout stays paused.'))return
    await run(job.id,()=>api('/releases/rollout-jobs/action',{method:'POST',body:JSON.stringify({
      action,jobId:job.id,tenantSlug:job.tenantSlug,
      environment:job.environment,buildSha:job.buildSha,reason,
      confirm:action==='cancel'?'CANCEL_UNCLAIMED_RELEASE_JOB':'RETRY_FAILED_RELEASE_JOB',
    })}))
  }

  if(loading)return <section className="rmm-card h5a-release-work">
    <p className="h5a-release-work-note">Checking release worker activity…</p></section>
  return <section className="rmm-card h5a-release-work" aria-label="Release work activity">
    <div className="rmm-card-heading">
      <div><span className="rmm-eyebrow">AUDITED RELEASE OPERATIONS</span>
        <h2>Work activity</h2>
        <p>Customer rollout jobs, deployment history, timestamps and safe staff actions. Changing a job never bypasses the maintenance window or approval controls.</p>
      </div>
      <button type="button" className="rmm-secondary compact" disabled={Boolean(busy)}
        onClick={refresh} title="Refresh release jobs"><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="h5a-release-work-state">
      <div className={data?.control?.paused?'h5a-release-work-paused':'h5a-release-work-active'}>
        {data?.control?.paused?<Pause size={16}/>:<AlertTriangle size={16}/>}
        <span><strong>{data?.control?.paused?'Globally paused':'New claims permitted'}</strong>
          <small>{data?.control?.reason||'No global pause description recorded.'}</small></span>
      </div>
      {data?.activeLivePilot?<p className="h5a-release-work-note" role="status">
        Exact Managed pilot armed for <strong>{data.activeLivePilot.tenantSlug}</strong>
        {' '}until {dt(data.activeLivePilot.expiresAt)}.
        All other customer release jobs remain globally paused.
      </p>:null}
      <div className="h5a-release-work-controls">
        {canApprove?<button type="button" className="rmm-secondary compact"
          disabled={Boolean(busy)||data?.control?.paused} onClick={pause}>
          <Pause size={14}/> Pause all</button>:null}
        <button type="button" className="rmm-secondary compact"
          disabled={Boolean(busy)||!canApprove||!data?.canResume||!data?.control?.paused}
          onClick={resume}
          title={data?.resumeBlockedReason||'Staff-confirmed fleet activation following verified Production rollback'}>
          <ShieldAlert size={14}/> {data?.canResume?'Resume verified rollout':'Resume locked'}</button>
      </div>
    </div>
    {error?<p className="h5a-release-work-error" role="alert">{error}</p>:null}
    {notice?<p className="h5a-release-work-success" role="status"><CheckCircle2 size={15}/>{notice}</p>:null}
    {canApprove?<div className="h5a-release-work-state" data-hi5-admin-rollbacks>
      <div className="h5a-release-work-controls">
        <strong><RotateCcw size={16}/> Customer rollback</strong>
        <small>Hi5Central controls Production rollback. Custom customers may roll back their own UAT only.</small>
      </div>
      <div className="h5a-release-work-controls">
        <label>Scope <select value={rollbackScope} onChange={e=>{
          const value=e.target.value
          setRollbackScope(value)
          if(value==='all'){
            setRollbackEnvironment('live')
            setRollbackTenant('')
            setRollbackData(null)
            api('/releases/rollback/candidates?environment=live')
              .then(setRollbackData).catch(err=>setError(err.message))
          }
        }}>
          <option value="one">One customer</option>
          <option value="all">All Production customers</option>
        </select></label>
        <label>Environment <select value={rollbackEnvironment}
          disabled={rollbackScope==='all'}
          onChange={async e=>{
            const stage=e.target.value
            setRollbackEnvironment(stage);setRollbackTenant('')
            try{setRollbackData(await api('/releases/rollback/candidates?environment='+stage))}
            catch(err){setError(err.message)}
          }}>
          <option value="live">Production</option>
          <option value="uat">Custom UAT</option>

        </select></label>
        {rollbackScope==='one'?<label>Customer <select value={rollbackTenant}
          onChange={e=>setRollbackTenant(e.target.value)}>
          <option value="">Select a verified customer</option>
          {(rollbackData?.candidates||[]).map(x=><option key={x.tenantId} value={x.tenantSlug}>
            {x.tenantSlug} · {short(x.fromBuildSha)} → {short(x.toBuildSha)}
          </option>)}
        </select></label>:<small>
          Eligible fleet: {rollbackData?.candidates?.length||0} customers; independently queued and verified
        </small>}
      </div>
      <label>Reason for rollback <textarea value={rollbackReason} rows={2}
        maxLength={1000} onChange={e=>setRollbackReason(e.target.value)}
        placeholder="Reason for restoring the previous verified version." /></label>
      <div className="h5a-release-work-controls">
        <button className="rmm-secondary compact" type="button"
          disabled={rollbackBusy||!rollbackData?.queueEnabled||
            rollbackReason.trim().length<20||(rollbackScope==='one'&&!rollbackTenant)}
          onClick={requestStageRollback}>
          <RotateCcw size={14}/> {rollbackScope==='all'?'Queue fleet rollback':'Queue customer rollback'}
        </button>
        {!rollbackData?.queueEnabled?<small>
          Executor not activated — request controls stay locked until verified.
        </small>:null}
      </div>
      {rollbackData?.history?.length?<p className="h5a-release-work-note" role="status">
        Latest recovery: {rollbackData.history[0].tenant_slug} ·
        {rollbackData.history[0].environment.toUpperCase()} ·
        {rollbackData.history[0].state.replaceAll('_',' ')}
      </p>:null}
    </div>:null}
    <div className="h5a-release-work-overview">
      {['scheduled','deferred','running','succeeded','failed','cancelled'].map(status=>
        <button type="button" key={status} className={filter===status?'is-active':''}
          onClick={()=>setFilter(f=>f===status?'all':status)}>
          <strong>{totals[status]||0}</strong><span>{status.replaceAll('_',' ')}</span></button>)}
    </div>
    <div className="h5a-release-work-filter">
      <span><Clock3 size={14}/> Latest {shown.length} of {jobs.length} recorded jobs (up to 100)</span>
      <select value={filter} onChange={e=>setFilter(e.target.value)} aria-label="Filter release job status">
        <option value="all">All statuses</option>
        {['scheduled','deferred','running','succeeded','failed','cancelled','pending','rolled_back'].map(s=>
          <option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}
      </select>
    </div>
    <div className="h5a-release-work-scroll">
      <table>
        <thead><tr><th>Customer / stage</th><th>Build</th><th>Status</th>
          <th>Scheduled / completed</th><th>Attempts</th><th>Duration</th><th>Actions</th></tr></thead>
        <tbody>{shown.map(job=><tr key={job.id}>
          <td><strong>{job.tenantSlug}</strong><small>{job.environment.toUpperCase()}</small></td>
          <td><code title={job.buildSha}>{short(job.buildSha)}</code></td>
          <td><span className={'h5a-release-work-status is-'+job.status}>{job.status.replaceAll('_',' ')}</span>
            {job.lastError?<small title={job.lastError}>{job.lastError.slice(0,110)}</small>:null}</td>
          <td><small>{dt(job.scheduledAt)}</small><small>{dt(job.completedAt)}</small></td>
          <td>{job.attemptCount} / {job.maxAttempts}</td>
          <td>{duration(job.durationSeconds)}</td>
          <td><div className="h5a-release-work-row-actions">
            {canApprove&&data?.control?.paused&&!data?.activeLivePilot
              &&job.environment==='live'&&job.updateMode==='hi5_managed'
              &&job.managedAutoPromote&&job.status==='scheduled'&&job.attemptCount===0
              ?<button type="button" className="rmm-secondary compact" disabled={Boolean(busy)}
                onClick={()=>armPilot(job)} title="Staff-approved single Managed Production pilot, 30-minute expiry; fleet stays paused">
                <ShieldAlert size={13}/> Arm one pilot</button>:null}
            {canApprove&&['pending','scheduled','deferred'].includes(job.status)&&job.attemptCount===0
              ?<button type="button" className="rmm-secondary compact danger" disabled={Boolean(busy)||!data?.control?.paused}
                onClick={()=>act(job,'cancel')} title="Cancel this exact unclaimed job while globally paused">
                <Trash2 size={13}/> Cancel</button>:null}
            {canApprove&&job.status==='failed'
              ?<button type="button" className="rmm-secondary compact" disabled={Boolean(busy)||!data?.control?.paused}
                onClick={()=>act(job,'retry')} title="Strictly gated, audited retry; no direct execution">
                <RotateCcw size={13}/> Try again</button>:null}
            {job.status==='running'?<small>Host-controlled</small>:null}
            {!['pending','scheduled','deferred','failed','running'].includes(job.status)?<small>Recorded</small>:null}
          </div></td>
        </tr>)}
        {!shown.length?<tr><td colSpan={7} className="h5a-release-work-empty">No matching jobs recorded.</td></tr>:null}</tbody>
      </table>
    </div>
    <p className="h5a-release-work-footnote">Fleet Resume requires certified release approvals, safe scheduled customer windows, healthy restricted workers, an audited real Managed Production deployment and rollback, and explicit platform owner/admin confirmation. The API rechecks everything when you confirm. Customer routes do not change immediately, and existing rolled-back jobs are not automatically requeued. Pause all remains available after resuming.</p>
  </section>
}
