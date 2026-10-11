import {useEffect,useState} from 'react'
import {RefreshCw,DatabaseZap,ShieldCheck} from 'lucide-react'
const API_BASE=window.__HI5_API_BASE__
export function EnvironmentReferenceSync(){
  const [data,setData]=useState(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  async function load(){
    setBusy(true);setError('')
    try{
      const r=await fetch(`${API_BASE}/api/v1/release-management/environment-sync`,{
        credentials:'include',cache:'no-store'})
      const j=await r.json().catch(()=>({}))
      if(!r.ok)throw Error(j.error||'Cannot inspect environment sync status.')
      setData(j)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  useEffect(()=>{void load()},[])
  return <section className="production-settings-panel" data-hi5-environment-reference-sync="live">
    <header><div><h2><DatabaseZap size={19}/> Environment data synchronisation</h2>
      <p>Production is the source for shared People and organisation reference fields. UAT and Test keep independent configuration and records.</p>
    </div><button type="button" disabled={busy} onClick={load}><RefreshCw size={15}/> Refresh</button></header>
    <div className="production-settings-panel-body">
      {error?<p role="alert">{error}</p>:null}
      {!data&&!error?<p>Checking tenant-scoped synchronisation…</p>:null}
      {data?.environments?.map(env=><div key={env.environment}
        style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16,padding:'12px 0',borderBottom:'1px solid rgba(128,128,128,.2)'}}>
        <div>
          <strong>{env.environment.toUpperCase()}</strong>
          <p style={{margin:'5px 0',fontSize:13}}>
            {env.totals.updates} safe field updates pending · {env.totals.conflicts} conflicts · {env.totals.missing} new source references awaiting mapping
          </p>
          <small>People, departments, teams and sites. Local UAT/Test edits are protected.</small>
        </div>
        <ShieldCheck size={19} aria-label="Synchronisation is isolated"/>
      </div>)}
      <p style={{fontSize:12,opacity:.75}}>
        Automatic reconciliation is opt-in and tenant-scoped. Passwords, MFA secrets, tenant permissions,
        incidents, messages, live devices and unapproved UAT configuration are never copied.
        Conflicting fields need review rather than being overwritten.
      </p>
    </div>
  </section>
}
