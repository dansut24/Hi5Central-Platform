import { useCallback,useEffect,useMemo,useState } from 'react'
import { AlertTriangle,CheckCircle2,Eye,EyeOff,KeyRound,RefreshCw,ShieldCheck,Trash2,PauseCircle,PlayCircle } from 'lucide-react'
import { localAdminApi } from '../../lib/rmmLocalAdminApi.js'
import './RmmLocalAdminVault.css'

const friendlyTime=(value)=>value?new Date(value).toLocaleString():'Not yet'
export function RmmLocalAdminVault() {
  const [data,setData]=useState(null)
  const [selected,setSelected]=useState('')
  const [device,setDevice]=useState('')
  const [accountName,setAccountName]=useState('Hi5Recovery')
  const [history,setHistory]=useState([])
  const [reason,setReason]=useState('')
  const [visible,setVisible]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [removeOpen,setRemoveOpen]=useState(false)
  const [removeConfirm,setRemoveConfirm]=useState('')
  const [alternativeAdminConfirmed,setAlternativeAdminConfirmed]=useState(false)
  const refresh=useCallback(async()=>{
    const result=await localAdminApi.list()
    setData(result)
    setError('')
    setSelected((old)=>old||result.accounts[0]?.id||'')
  },[])
  useEffect(()=>{refresh().catch((e)=>setError(e.message))},[refresh])
  useEffect(()=>{
    if(!selected){setHistory([]);return}
    let active=true
    localAdminApi.history(selected).then((response)=>{if(active)setHistory(response.rotations||[])})
      .catch((e)=>{if(active)setError(e.message)})
    return()=>{active=false}
  },[selected,data])
  useEffect(()=>{
    if(!visible)return
    const t=window.setTimeout(()=>setVisible(null),30000)
    const hide=()=>{if(document.visibilityState==='hidden')setVisible(null)}
    document.addEventListener('visibilitychange',hide)
    return()=>{window.clearTimeout(t);document.removeEventListener('visibilitychange',hide)}
  },[visible])
  useEffect(()=>{
    const t=window.setInterval(()=>{
      if(!selected)return
      refresh().catch(()=>{})
    },12000)
    return()=>window.clearInterval(t)
  },[refresh,selected])
  const accounts=data?.accounts||[]
  const account=useMemo(()=>accounts.find((a)=>a.id===selected),[accounts,selected])
  const agentPatchVersion=Number(String(account?.agentVersion||'').match(/^1\.0\.(\d+)/)?.[1]||0)
  const agentSupportsRotation=Boolean(account&&agentPatchVersion>=509)
  const agentSupportsRemoval=Boolean(account&&agentPatchVersion>=510)
  async function enrol() {
    if(!device)return
    if(!window.confirm('Register a dedicated Hi5Central local administrator account on this device? No Windows password changes will occur until the first authorised rotation.'))return
    setBusy(true);setError('');setNotice('')
    try{
      const added=await localAdminApi.enrol(device,accountName)
      await refresh()
      setSelected(added.id)
      setNotice('Local admin account registered. Rotate after the compatible agent is installed.')
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  async function rotate() {
    if(!account||!data?.canRotate)return
    if(reason.trim().length<10){setError('Provide a business justification of at least 10 characters.');return}
    if(!window.confirm('Rotate the dedicated local administrator password immediately on '+account.deviceName+'? The new credential must be escrowed in Hi5Central before it is applied.'))return
    setBusy(true);setError('');setNotice('');setVisible(null)
    try{
      await localAdminApi.rotate(account.id,reason.trim())
      await refresh()
      setNotice('Rotation requested. The device will securely escrow and then apply its new password.')
      setReason('')
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  async function pauseOrResume(action) {
    if(!account||!data?.canRotate)return
    if(reason.trim().length<10){setError('Enter a business reason of at least 10 characters.');return}
    const message=action==='pause'
      ?'Stop managing '+account.name+' on '+account.deviceName+'? Windows account and vaulted password will be preserved, but automatic/on-demand rotations will be blocked.'
      :'Resume managing the existing '+account.name+' account? No Windows password change will occur now.'
    if(!window.confirm(message))return
    setBusy(true);setError('');setNotice('');setVisible(null)
    try {
      await localAdminApi.management(account.id,action,reason.trim())
      await refresh()
      setNotice(action==='pause'
        ?'Management paused. The existing Windows account and escrowed password have been preserved.'
        :'Management resumed. No password changed.')
      setReason('')
    } catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  function beginRemoval() {
    if(!account||!data?.canRemove)return
    setRemoveConfirm('');setAlternativeAdminConfirmed(false);setRemoveOpen(true);setError('');setVisible(null)
  }
  async function confirmRemoval(event) {
    event.preventDefault()
    if(!account||busy)return
    if(reason.trim().length<12){setError('A removal justification of at least 12 characters is required.');return}
    const isManaged=Boolean(account.sid||account.currentRotation?.id)
    const name=isManaged?'REMOVE '+account.name:account.name
    if(removeConfirm.trim()!==name){setError('Type the exact confirmation phrase.');return}
    if(!window.confirm(isManaged
      ?'FINAL CHECK: Delete '+account.name+' from Windows on '+account.deviceName+' and permanently retire its encrypted password only AFTER the Agent verifies the account is absent?'
      :'Remove the unused Hi5Central account registration? No Windows account will be modified.'))return
    setBusy(true);setError('');setNotice('');setVisible(null)
    try {
      if(isManaged) await localAdminApi.remove(account.id,reason.trim(),name,alternativeAdminConfirmed)
      else await localAdminApi.unregister(account.id,reason.trim(),name)
      await refresh()
      setRemoveOpen(false)
      setNotice(isManaged
        ?'Windows account removal requested. The escrow remains protected until Windows confirms deletion.'
        :'Unused vault registration removed. No Windows account was changed.')
      setReason('')
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  async function reveal(rotation) {
    if(!data?.canReveal)return
    if(reason.trim().length<12){setError('Provide a recovery reason of at least 12 characters.');return}
    if(rotation.state!=='active'&&!window.confirm('This password is only escrowed/uncertain and may not be active on the device. Continue?'))return
    setBusy(true);setError('');setNotice('');setVisible(null)
    try{
      const result=await localAdminApi.reveal(account.id,rotation.id,reason.trim())
      setVisible({...result,rotationId:rotation.id})
      setNotice('Password revealed for 30 seconds. Reveal is recorded in the security audit.')
      setReason('')
      await refresh()
    }catch(e){setError(e.message)}
    finally{setBusy(false)}
  }
  return <div className="rmm-local-admin-vault">
    <div className="rmm-local-admin-header"><div><h2><KeyRound size={21}/> Local administrator vault</h2><p>Per-device managed local administrator credentials, on-demand rotation and audited recovery.</p></div><button type="button" onClick={()=>refresh().catch((e)=>setError(e.message))}><RefreshCw size={16}/> Refresh</button></div>
    <div className="rmm-local-admin-warning"><AlertTriangle size={18}/><span><strong>Separate from Windows LAPS.</strong> Native Windows LAPS continues to back up to Entra ID or Active Directory; Hi5Central-managed vaults use a dedicated local account and encrypted escrow. Never manage the same account with both systems.</span></div>
    {!data && !error && <p>Loading managed administrator accounts…</p>}
    {error && !account && <p className="rmm-local-admin-error" role="alert">{error}</p>}
    {notice && <p className="rmm-local-admin-notice" role="status">{notice}</p>}
    {data && <>
      <div className="rmm-local-admin-stats"><div><strong>{accounts.length}</strong><span>Managed accounts</span></div><div><strong>{accounts.filter((a)=>a.state==='active').length}</strong><span>Active escrow</span></div><div><strong>{accounts.filter((a)=>a.state==='error'||a.state==='pending').length}</strong><span>Not yet active</span></div></div>
      <section className="rmm-local-admin-card">
        <h3>Add a managed account</h3>
        <p>Start with a dedicated account. Existing built-in and user administrator accounts will not be adopted or modified.</p>
        <div className="rmm-local-admin-grid"><label>Windows device<select value={device} onChange={(e)=>setDevice(e.target.value)}><option value="">Select device</option>{(data.availableDevices||[]).map((item)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Account name<input maxLength={20} value={accountName} onChange={(e)=>setAccountName(e.target.value)}/></label></div>
        <button type="button" disabled={busy||!device||!data.canRotate} onClick={enrol}>Register account</button>
      </section>
      <div className="rmm-local-admin-grid-main">
        <section className="rmm-local-admin-card">
          <h3>Managed devices</h3>
          {accounts.map((item)=><button type="button" key={item.id} className={'rmm-local-admin-device'+(selected===item.id?' selected':'')} onClick={()=>{setSelected(item.id);setVisible(null);setError('');setNotice('')}}><span><strong>{item.deviceName}</strong><small>{item.name} · Agent {item.agentVersion}</small></span><span>{item.state}</span></button>)}
          {!accounts.length&&<p>No devices registered yet.</p>}
        </section>
        <section className="rmm-local-admin-card">
          {account ? <>
            <h3><ShieldCheck size={17}/>{account.deviceName}</h3>
            <dl><div><dt>Managed account</dt><dd>{account.name}</dd></div><div><dt>Vault status</dt><dd>{account.state}</dd></div><div><dt>Last rotation</dt><dd>{friendlyTime(account.lastRotatedAt)}</dd></div><div><dt>Next planned review</dt><dd>{friendlyTime(account.nextRotationAt)}</dd></div><div><dt>Agent connectivity</dt><dd>{account.agentConnected?'Online':'Not recently connected'}</dd></div></dl>
            <label>Reason for rotation or password reveal<textarea rows={3} value={reason} onChange={(e)=>setReason(e.target.value)} placeholder="Explain the recovery or administrative requirement." /></label>
            <p className="rmm-local-admin-hint">Enter a reason before each action (at least 10 characters for rotation, 12 for reveal). A password marked uncertain may not work on Windows.</p>
            {error&&<p className="rmm-local-admin-error" role="alert">{error}</p>}
            <div className="rmm-local-admin-buttons">
              <button type="button" disabled={busy||!['pending','active','error'].includes(account.state)||!account.agentConnected||!agentSupportsRotation||!data.canRotate} onClick={rotate}><RefreshCw size={15}/> Rotate password now</button>
            </div>
            {!agentSupportsRotation&&<p className="rmm-local-admin-warning">Agent 1.0.509 or newer is required before another local administrator rotation. Existing installations remain untouched.</p>}
            <div className="rmm-local-admin-management">
              <strong>Protection management</strong>
              <p>Pausing stops future rotation without touching the Windows account or its stored password. Removing the account is a separate, verified and audited operation.</p>
              <div className="rmm-local-admin-buttons">
                {['active','pending','error'].includes(account.state)&&<button type="button" disabled={busy||!data.canRotate} onClick={()=>pauseOrResume('pause')}><PauseCircle size={15}/> Stop managing</button>}
                {account.state==='disabled'&&<button type="button" disabled={busy||!data.canRotate} onClick={()=>pauseOrResume('resume')}><PlayCircle size={15}/> Resume management</button>}
                {['active','disabled','pending','error'].includes(account.state)&&<button className="rmm-local-admin-danger" disabled={busy||!data.canRemove||Boolean(account.sid)&&(!account.agentConnected||!agentSupportsRemoval)} type="button" onClick={beginRemoval}><Trash2 size={15}/>{account.sid?'Remove Windows account & vault':'Remove registration'}</button>}
              </div>
              {Boolean(account.sid)&&!agentSupportsRemoval&&<p className="rmm-local-admin-warning">Agent 1.0.510 or newer is required to verify Windows account removal by SID. The existing account remains available.</p>}
              {account.state==='removing'&&<p>Removal is in progress. The vault remains protected until the Agent verifies the Windows account no longer exists.</p>}
              {account.state==='removal_uncertain'&&<p className="rmm-local-admin-warning">Windows account deletion is unconfirmed. Do not request another removal until the device SID has been checked.</p>}
              {account.state==='removed'&&<p className="rmm-local-admin-notice">Management removed. Historical rotation and audit entries are retained, but previous encrypted credentials are no longer recoverable.</p>}
            </div>
            {removeOpen && <form className="rmm-local-admin-remove-dialog" onSubmit={confirmRemoval}>
              <strong>{account.sid?'Remove Windows recovery account':'Remove unused registration'}</strong>
              <p>{account.sid?'Windows will delete the dedicated recovery account. After verification, Hi5Central will permanently discard its encrypted password. Existing Windows sign-ins may be disrupted and this cannot be undone.':'The account has not been activated on Windows, so only the Hi5Central registration is withdrawn.'}</p>
              <label>Confirmation phrase<input value={removeConfirm} onChange={(e)=>setRemoveConfirm(e.target.value)} placeholder={account.sid?'REMOVE '+account.name:account.name}/></label>
              {Boolean(account.sid)&&<label className="rmm-local-admin-risk-ack"><input type="checkbox" checked={alternativeAdminConfirmed} onChange={(e)=>setAlternativeAdminConfirmed(e.target.checked)}/> I have verified another working administrator login on this device. Removing this recovery account will revoke its password.</label>}
              <p>Use the reason above (minimum 12 characters) and type the exact phrase to confirm.</p>
              <div className="rmm-local-admin-buttons"><button type="submit" className="rmm-local-admin-danger" disabled={busy||removeConfirm.trim()!==(account.sid?'REMOVE '+account.name:account.name)||reason.trim().length<12||(Boolean(account.sid)&&!alternativeAdminConfirmed)}>Confirm removal</button><button type="button" onClick={()=>setRemoveOpen(false)}>Cancel</button></div>
            </form>}
            {account.lastError&&<p className="rmm-local-admin-error">{account.lastError}</p>}
            <h4>Rotation history</h4>
            {history.map((r)=><div className="rmm-local-admin-history" key={r.id}>
              <span><strong>{r.state}</strong><small>{friendlyTime(r.activatedAt||r.createdAt)}{r.escrowedAt?' · Escrowed':''}</small></span>
              {account.state!=='removed'&&['active','escrowed','uncertain'].includes(r.state)&&<button disabled={busy||!data.canReveal} type="button" onClick={()=>reveal(r)}><Eye size={15}/> Reveal</button>}
            </div>)}
            {!history.length&&<p>No rotation history yet.</p>}
            {visible && <div className="rmm-local-admin-secret"><strong>{visible.accountName} · {visible.status}</strong><code>{visible.password}</code><button type="button" onClick={()=>setVisible(null)}><EyeOff size={15}/> Hide now</button>{visible.warning&&<p>{visible.warning}</p>}</div>}
          </> : <p>Choose a managed account to see its vault status and history.</p>}
        </section>
      </div>
    </>}
  </div>
}
