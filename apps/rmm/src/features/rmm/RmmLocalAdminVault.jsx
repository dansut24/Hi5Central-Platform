import { useCallback,useEffect,useMemo,useState } from 'react'
import { AlertTriangle,CheckCircle2,Eye,EyeOff,KeyRound,RefreshCw,ShieldCheck } from 'lucide-react'
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
  const refresh=useCallback(async()=>{
    const result=await localAdminApi.list()
    setData(result)
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
    {!data && <p>Loading managed administrator accounts…</p>}
    {error && <p className="rmm-local-admin-error" role="alert">{error}</p>}
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
            <div className="rmm-local-admin-buttons">
              <button type="button" disabled={busy||!account.agentConnected||!data.canRotate||!data.recentlyVerified} onClick={rotate}><RefreshCw size={15}/> Rotate password now</button>
            </div>
            {account.lastError&&<p className="rmm-local-admin-error">{account.lastError}</p>}
            {!data.recentlyVerified && data.canReveal && <p className="rmm-local-admin-warning">Password rotation and reveal require MFA within the last five minutes. Sign in again with MFA to enable either action.</p>}
            <h4>Rotation history</h4>
            {history.map((r)=><div className="rmm-local-admin-history" key={r.id}>
              <span><strong>{r.state}</strong><small>{friendlyTime(r.activatedAt||r.createdAt)}{r.escrowedAt?' · Escrowed':''}</small></span>
              {['active','escrowed','uncertain'].includes(r.state)&&<button disabled={busy||!data.canReveal||!data.recentlyVerified} type="button" onClick={()=>reveal(r)}><Eye size={15}/> Reveal</button>}
            </div>)}
            {!history.length&&<p>No rotation history yet.</p>}
            {visible && <div className="rmm-local-admin-secret"><strong>{visible.accountName} · {visible.status}</strong><code>{visible.password}</code><button type="button" onClick={()=>setVisible(null)}><EyeOff size={15}/> Hide now</button>{visible.warning&&<p>{visible.warning}</p>}</div>}
          </> : <p>Choose a managed account to see its vault status and history.</p>}
        </section>
      </div>
    </>}
  </div>
}
