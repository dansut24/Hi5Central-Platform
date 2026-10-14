import { useCallback, useEffect, useState } from 'react'
import {
  Bell, Building2, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight,
  CircleHelp, CreditCard, FileText, LayoutDashboard, LockKeyhole, LogOut,
  Menu, Monitor, Moon, RefreshCw, ShieldCheck, Sun, Users, Wallet, X,
} from 'lucide-react'
import { ProductionLogin } from './ProductionWorkspaceBootstrap.jsx'
import './Qa26AccountAdmin.css'

const QA=new Set(['h5c-managed-qa26','h5c-custom-qa26'])
const API=window.__HI5_API_BASE__
const money=value=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format((Number(value)||0)/100)
const fmt=value=>value?new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—'
const links=[
  {id:'overview',name:'Overview',icon:LayoutDashboard},
  {id:'invoices',name:'Invoices & payments',icon:FileText},
  {id:'subscription',name:'Subscription',icon:Wallet},
  {id:'billing-admins',name:'Billing admins',icon:Users},
  {id:'trial',name:'Trial & reminders',icon:CalendarClock},
  {id:'account',name:'Company & account',icon:Building2},
  {id:'security',name:'Security & access',icon:ShieldCheck},
]
function slugFromHost(){
  const match=window.location.hostname.match(/^(h5c-(?:managed|custom)-qa26)-admin\.hi5central\.com$/)
  return match?.[1]||''
}
const tenantSlug=slugFromHost()
function endpoint(resource,options={}) {
  return fetch('/api/v1/qa26/'+resource,{credentials:'include',cache:'no-store',...options})
    .then(async response=>{
      const json=await response.json().catch(()=>({}))
      if(!response.ok)throw Object.assign(new Error(json.error||'Account service unavailable'),{status:response.status})
      if(json.demo!==true||json.realPayments===true)throw new Error('A verified QA-only simulation response is required.')
      return json
    })
}
function Glyph({icon:Icon,...props}){return <Icon size={18} strokeWidth={1.8} {...props}/>}
export function Qa26AccountAdmin(){
  const [session,setSession]=useState(null)
  const [phase,setPhase]=useState('checking')
  const [access,setAccess]=useState('checking')
  const [account,setAccount]=useState(null)
  const [ledger,setLedger]=useState(null)
  const [view,setView]=useState('overview')
  const [sidebar,setSidebar]=useState('expanded')
  const [mobile,setMobile]=useState(false)
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const [email,setEmail]=useState('')
  const [theme,setTheme]=useState('light')
  const [userMenu,setUserMenu]=useState(false)
  const [refresh,setRefresh]=useState(0)

  useEffect(()=>{
    let active=true
    if(!QA.has(tenantSlug)){setPhase('invalid');return()=>{active=false}}
    fetch(API+'/api/v1/auth/session',{credentials:'include',cache:'no-store'})
      .then(async response=>response.ok?response.json():null)
      .then(json=>{
        if(!active)return
        if(json?.authenticated&&json?.tenant?.slug===tenantSlug&&json?.security?.mfaVerified){
          setSession(json);setPhase('ready')
          if(window.location.pathname==='/login')window.history.replaceState({},'','/')
        }else{setPhase('login')}
      }).catch(()=>{if(active)setPhase('login')})
    return()=>{active=false}
  },[refresh])

  // The existing ProductionLogin performs the exact same password/SSO and MFA
  // verification and cookie retention check as the normal ITSM workspace.
  function authenticated(json){
    if(json?.tenant?.slug!==tenantSlug||!json?.security?.mfaVerified) {
      setError('The verified login does not belong to this billing account.')
      return
    }
    setSession(json);setPhase('ready');setError('')
    window.history.replaceState({},'','/')
  }

  const load=useCallback(async()=>{
    if(phase!=='ready')return
    setError('')
    try{
      const [a,l]=await Promise.all([endpoint('demo-account'),endpoint('demo-billing')])
      if(a.tenant?.slug!==tenantSlug||l.tenant?.slug!==tenantSlug)throw new Error('Wrong tenant. Billing data withheld.')
      setAccount(a);setLedger(l);setAccess('allowed')
    }catch(e){
      if(e.status===401){setPhase('login');setSession(null);setAccess('checking')}
      else if(e.status===403)setAccess('denied')
      else setError(e.message)
    }
  },[phase])
  useEffect(()=>{void load()},[load])

  const act=async(resource,body={},method='POST')=>{
    if(busy||!window.confirm('QA26 DEMO ONLY: This action is simulated. No real payment, email, subscription or device access will change. Continue?'))return
    setBusy(true);setError('');setNotice('')
    try{
      await endpoint(resource,{method,headers:method==='DELETE'?{}:{'content-type':'application/json'},
        ...(method==='DELETE'?{}:{body:JSON.stringify(body)})})
      setNotice('Demo saved. No real payment, email or commercial change was made.')
      await load()
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const logout=async()=>{
    try{await fetch(API+'/api/v1/auth/logout',{method:'POST',credentials:'include'})}catch{}
    setSession(null);setAccount(null);setLedger(null);setPhase('login');setAccess('checking');setUserMenu(false)
    window.history.replaceState({},'','/login')
  }
  const navigate=id=>{setView(id);setMobile(false);setNotice('');setUserMenu(false)}
  const user=session?.user||{}
  const tenantName=session?.tenant?.companyName||tenantSlug.replaceAll('-',' ')
  const canOwn=account?.access?.owner===true
  const trial=account?.trial
  const colors=session?.settings?.theme
  const primary=typeof colors?.accent==='string'&&/^#[0-9a-f]{6}$/i.test(colors.accent)?colors.accent:'#2966c0'
  const isDark=theme==='dark'
  useEffect(()=>{
    if(phase==='ready'){
      const setting=session?.preferences?.appearance?.theme||session?.settings?.theme?.mode
      setTheme(setting==='dark'?'dark':setting==='light'?'light':window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light')
    }
  },[phase,session])

  if(phase==='checking')return <div className="production-auth-shell"><div className="production-auth-card production-auth-loading"><img src="/hi5central-logo.png" alt=""/><strong>Hi5Central Account Admin</strong><span>Checking your secure tenant session…</span></div></div>
  if(phase==='invalid')return <div className="production-auth-shell"><div className="production-auth-card production-auth-loading"><strong>Account administration unavailable</strong><span>This QA billing portal is restricted to the two QA26 tenant domains.</span></div></div>
  if(phase==='login')return <div className="h5-account-login">
    <div className="h5-account-login-banner"><img src="/hi5central-logo.png" alt=""/>
      <strong>Hi5Central Account Administration</strong>
      <span>Sign in using your existing Hi5Central credentials and MFA.</span>
      <small>QA26 sandbox · No real charges</small>
    </div>
    <ProductionLogin tenant={{slug:tenantSlug,companyName:tenantSlug,status:'active'}} onAuthenticated={authenticated} surfaceLabel="Hi5Central Account Admin"/>
    {error?<div className="h5-account-login-error" role="alert">{error}</div>:null}
  </div>

  const billView=(rows)=> <div className="h5-account-table-scroll"><table className="h5-account-table">
    <thead><tr><th>Invoice</th><th>Due date</th><th>Status</th><th>Amount</th><th>Actions</th></tr></thead>
    <tbody>{rows.map(invoice=><tr key={invoice.key}>
      <td><strong>{invoice.number}</strong><small>{invoice.items.map(x=>x.title).join(', ')}</small></td>
      <td>{fmt(invoice.dueOn)}</td>
      <td><span className={'h5-account-pill '+(invoice.status==='paid'?'success':invoice.status==='payment_failed'?'danger':'pending')}>{invoice.status==='paid'?'Paid (fake)':invoice.status==='payment_failed'?'Declined (fake)':'Outstanding (fake)'}</span></td>
      <td><strong>{money(invoice.amountPence)}</strong></td>
      <td>{invoice.status==='paid'?<span className="h5-account-muted">Example paid</span>:<div className="h5-account-actions">
        <button disabled={busy} onClick={()=>act('demo-billing/'+encodeURIComponent(invoice.key)+'/simulate',{outcome:'succeeded'})}>Simulate payment</button>
        <button disabled={busy} className="secondary" onClick={()=>act('demo-billing/'+encodeURIComponent(invoice.key)+'/simulate',{outcome:'declined'})}>Simulate decline</button>
      </div>}</td>
    </tr>)}</tbody>
  </table></div>
  const stat=(label,value,icon:Icon)=> <div className="h5-account-stat"><span className="h5-account-stat-icon"><Icon size={19}/></span><span>{label}</span><strong>{value}</strong></div>
  const moduleCards=<div className="h5-account-grid two">
    {['itsm','rmm'].map(module=><div className="h5-account-module" key={module}>
      <div className="h5-account-icon">{module==='itsm'?<FileText size={21}/>:<Monitor size={21}/>}</div>
      <h3>{module.toUpperCase()}</h3>
      <p>{module==='itsm'?'Service management, requests and workflows':'Remote monitoring, devices and automation'}</p>
      <span className={'h5-account-pill '+(account?.modules?.[module]?'success':'pending')}>{account?.modules?.[module]?'Included (demo)':'Not included'}</span>
      {!account?.modules?.[module]&&canOwn?<button disabled={busy} onClick={()=>act('demo-account/add-module',{module})}>Add {module.toUpperCase()} (fake)</button>:null}
    </div>)}
    <p className="h5-account-hint full">RMM uses one managed portal, with no RMM Test or UAT environments. ITSM Managed/Custom release settings stay separate.</p>
  </div>
  const trialCard=<div className="h5-account-panel">
    <div className="h5-account-panel-heading"><div><h2>Trial & subscription</h2><p>30-day demonstration · no real subscription changes</p></div><span className="h5-account-pill pending">{trial?.upgradedToPaidDemo?'Activated (fake)':trial?.expired?'Trial expired':(trial?.daysRemaining??'—')+' days remaining'}</span></div>
    <div className="h5-account-trial"><div><strong>{account?.banner||'QA26 trial'}</strong><small>Example trial ends {fmt(trial?.endsAt)}</small></div><div className="h5-account-progress"><span style={{width:Math.min(100,100*(trial?.daysElapsed||0)/30)+'%'}}/></div></div>
    {canOwn?<div className="h5-account-actions">{!trial?.upgradedToPaidDemo?<button disabled={busy} onClick={()=>act('demo-account/activate',{fake:true})}>Simulate upgrade</button>:null}
      {trial?.canRestore?<button disabled={busy} className="secondary" onClick={()=>act('demo-account/extend',{fake:true})}>Simulate extra 14 days</button>:null}</div>:null}
  </div>

  let content=null
  if(access==='denied')content=<div className="h5-account-panel"><h2>Billing permission required</h2><p>Your credentials are valid, but you aren't authorised to view this tenant's billing records. Ask the tenant owner to grant Billing Admin access.</p><a href={'https://'+tenantSlug+'.hi5central.com/'}>Return to your workspace</a></div>
  else if(!account||!ledger)content=<div className="h5-account-panel"><h2>Loading billing records</h2><p>Retrieving the QA26 simulation ledger and trial information…</p></div>
  else if(view==='overview')content=<>
    {trialCard}
    <div className="h5-account-grid three">
      {stat('Example amount outstanding',money(ledger.totals.openPence),Wallet)}
      {stat('Example invoice history',money(ledger.totals.paidPence),CheckCircle2)}
      {stat('Payment environment','FAKE ONLY',CreditCard)}
    </div>
    <div className="h5-account-panel"><div className="h5-account-panel-heading"><div><h2>Your services</h2><p>Simulated account modules</p></div><button className="secondary" onClick={()=>navigate('subscription')}>Manage services <ChevronRight size={15}/></button></div>{moduleCards}</div>
    <div className="h5-account-panel"><div className="h5-account-panel-heading"><div><h2>Latest invoices</h2><p>Illustrative payments and balances</p></div><button className="secondary" onClick={()=>navigate('invoices')}>View all invoices <ChevronRight size={15}/></button></div>{billView(ledger.invoices.slice(0,3))}</div>
  </>
  else if(view==='invoices')content=<div className="h5-account-panel"><div className="h5-account-panel-heading"><div><h2>Invoices & payments</h2><p>All amounts are fictional and exclude VAT. No cards are collected.</p></div><button className="secondary" onClick={load} disabled={busy}><RefreshCw size={15}/> Refresh</button></div>{billView(ledger.invoices)}</div>
  else if(view==='subscription')content=<>{trialCard}<div className="h5-account-panel"><div className="h5-account-panel-heading"><div><h2>Service modules</h2><p>Add ITSM or RMM in this demonstration</p></div></div>{moduleCards}</div></>
  else if(view==='billing-admins')content=<div className="h5-account-panel"><h2>Billing administrators</h2><p>Owners can delegate billing-only access to existing active tenant members. MFA is still required.</p>
    <div className="h5-account-stack">{account.billingAdmins.map(a=><div className="h5-account-person" key={a.id}><div><strong>{a.name||a.email}</strong><small>{a.email}</small></div>{canOwn?<button className="secondary" disabled={busy} onClick={()=>act('demo-account/billing-admins/'+encodeURIComponent(a.id),{},'DELETE')}>Revoke</button>:null}</div>)}
      {!account.billingAdmins.length?<p className="h5-account-muted">No delegated Billing Admins.</p>:null}</div>
    {canOwn?<form className="h5-account-add-person" onSubmit={e=>{e.preventDefault();if(email)void act('demo-account/billing-admins',{email:email.trim()})}}><label>Existing member email<input type="email" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="billing@example.com"/></label><button type="submit" disabled={busy}>Grant Billing Admin</button></form>:null}
  </div>
  else if(view==='trial')content=<>{trialCard}<div className="h5-account-panel"><h2>Trial communications</h2><p>These messages are previews only. Nothing is sent by email.</p>{canOwn?<div className="h5-account-actions"><button disabled={busy} onClick={()=>act('demo-account/reminder',{kind:'day14_checkin'})}>Preview day-14 check-in</button><button className="secondary" disabled={busy} onClick={()=>act('demo-account/reminder',{kind:'day30_expired'})}>Preview trial-expiry email</button></div>:null}<p className="h5-account-hint">Simulated reminders logged: {account.reminders.fakeEvents.length}. Actual emails sent: 0.</p></div></>
  else if(view==='account')content=<div className="h5-account-panel"><h2>Company & account</h2><div className="h5-account-account-row"><span>Organisation</span><strong>{tenantName}</strong></div><div className="h5-account-account-row"><span>Billing portal</span><strong>{tenantSlug}-admin.hi5central.com</strong></div><div className="h5-account-account-row"><span>Account environment</span><strong>QA26 demo</strong></div><p className="h5-account-hint">Registered company details, VAT numbers, billing address, purchase order reference and invoice exports will be added as part of the real billing release, not this demo.</p></div>
  else if(view==='security')content=<div className="h5-account-panel"><h2>Security & access</h2><p>This portal uses your existing Hi5Central identity, permissions and MFA. Billing Admin does not grant technical ITSM or RMM permissions.</p><div className="h5-account-actions"><a className="h5-account-btn secondary" href={'https://'+tenantSlug+'.hi5central.com/profile'}>Manage profile and MFA</a><a className="h5-account-btn secondary" href={'https://'+tenantSlug+'.hi5central.com/people'}>Manage tenant members</a></div></div>
  const selected=links.find(x=>x.id===view)||links[0]
  return <div className={'h5-account-shell'+(sidebar==='collapsed'?' collapsed':'')+(isDark?' dark':'')} style={{'--h5-account-accent':primary}}>
    {mobile?<button className="h5-account-overlay" aria-label="Close navigation" onClick={()=>setMobile(false)}/>:null}
    <aside className={'h5-account-sidebar'+(mobile?' mobile-open':'')}>
      <div className="h5-account-sidebar-brand"><img src="/hi5central-logo.png" alt=""/><span><strong>Hi5Central</strong><small>ACCOUNT ADMIN</small></span>
        <button className="h5-account-collapse" aria-label="Toggle sidebar" onClick={()=>setSidebar(x=>x==='expanded'?'collapsed':'expanded')}><ChevronLeft size={17}/></button>
        <button className="h5-account-mobile-close" aria-label="Close menu" onClick={()=>setMobile(false)}><X size={20}/></button>
      </div>
      <div className="h5-account-nav-caption">Account</div>
      <nav aria-label="Account administration" className="h5-account-nav">
        {links.map(item=><button key={item.id} className={view===item.id?'active':''} title={item.name} onClick={()=>navigate(item.id)}>
          <Glyph icon={item.icon}/><span>{item.name}</span></button>)}
      </nav>
      <div className="h5-account-sidebar-bottom"><div className="h5-account-demo-pill"><ShieldCheck size={16}/> QA26 SANDBOX</div>
        <a href={'https://'+tenantSlug+'.hi5central.com/'} title="Return to workspace"><ChevronLeft size={16}/> <span>Back to workspace</span></a>
      </div>
    </aside>
    <div className="h5-account-workspace">
      <header className="h5-account-topbar">
        <button className="h5-account-mobile-toggle" aria-label="Open navigation" onClick={()=>setMobile(true)}><Menu size={22}/></button>
        <div className="h5-account-topbar-title"><span>Account administration</span><strong>{selected.name}</strong></div>
        <div className="h5-account-top-actions">
          <button className="h5-account-icon-button" aria-label="Toggle theme" onClick={()=>setTheme(x=>x==='dark'?'light':'dark')}>{isDark?<Sun size={19}/>:<Moon size={19}/>}</button>
          <button className="h5-account-icon-button" aria-label="Refresh billing data" onClick={load}><RefreshCw size={19}/></button>
          <div className="h5-account-profile-wrap">
            <button className="h5-account-profile" onClick={()=>setUserMenu(x=>!x)} aria-expanded={userMenu} aria-label="Open profile menu"><span>{user.name?.[0]?.toUpperCase()||'U'}</span><div><strong>{user.name||'Account user'}</strong><small>{user.email}</small></div></button>
            {userMenu?<div className="h5-account-profile-menu"><a href={'https://'+tenantSlug+'.hi5central.com/profile'}>My profile</a><button onClick={logout}><LogOut size={16}/> Sign out</button></div>:null}
          </div>
        </div>
      </header>
      <main className="h5-account-main">
        <div className="h5-account-title"><div><h1>{selected.name}</h1><p>{tenantName} · Customer account management</p></div><span className="h5-account-tag">FAKE BILLING · QA26</span></div>
        {notice?<p className="h5-account-alert success" role="status">{notice}</p>:null}
        {error?<p className="h5-account-alert error" role="alert">{error}</p>:null}
        {content}
        <p className="h5-account-footer">QA DEMO ONLY. No real Stripe transactions, subscription upgrades, device changes, external emails or chargeable invoices.</p>
      </main>
    </div>
  </div>
}
