import {useCallback,useEffect,useState} from 'react'
import {Activity,ArrowLeft,Building2,CalendarClock,CloudDownload,HardDrive,RefreshCw,ShieldCheck} from 'lucide-react'
import './TenantAdminDetail.css'

const date=v=>{if(!v)return 'Not recorded';const d=new Date(v);return Number.isNaN(d.getTime())?'Not recorded':d.toLocaleString()}
const money=(pence,currency='GBP')=>{
  if(pence==null)return 'Not configured'
  try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency||'GBP'}).format(Number(pence)/100)}
  catch{return String(Number(pence)/100)+' '+currency}
}
const size=bytes=>bytes==null?'Not recorded':new Intl.NumberFormat('en-GB',{
  style:'unit',unit:'megabyte',maximumFractionDigits:1,
}).format(Number(bytes)/1048576)
function Field({label,children}){return <div className="h5a-detail-field"><small>{label}</small><strong>{children??'Not recorded'}</strong></div>}
function Panel({title,subtitle,children}){return <section className="rmm-card h5a-detail-panel">
  <header><h3>{title}</h3>{subtitle?<p>{subtitle}</p>:null}</header>
  <div className="h5a-detail-content">{children}</div>
</section>}

export function TenantAdminDetail({tenant,fetchOverview,onBack,editTenant,editBilling,refresh}){
  const [summary,setSummary]=useState(null)
  const [loading,setLoading]=useState(true)
  const [notice,setNotice]=useState('')
  const load=useCallback(async()=>{
    setLoading(true);setNotice('')
    try{setSummary(await fetchOverview(tenant.id))}
    catch(e){setSummary(null);setNotice(e.status===404
      ?'Detailed billing, backup and environment evidence is awaiting the secure Admin API rollout.'
      :e.message||'Unable to load verified tenant metrics.')}
    finally{setLoading(false)}
  },[fetchOverview,tenant.id])
  useEffect(()=>{void load()},[load])
  const t=summary?.tenant||{}
  const s=summary?.subscription||{}
  const d=summary?.deviceUsage
  const environments=summary?.environments||[]
  const invoices=summary?.invoices?.items||[]
  const available=Boolean(summary)
  return <div className="h5a-tenant-detail" data-tenant-admin-id={tenant.id}>
    <div className="h5a-detail-heading">
      <div>
        <button type="button" className="rmm-secondary compact" onClick={onBack}><ArrowLeft size={14}/> All tenants</button>
        <span className="rmm-eyebrow">TENANT MANAGEMENT · {tenant.slug}</span>
        <h2>{t.companyName||tenant.company_name}</h2>
        <p>{tenant.owner_email||'No assigned owner'} · {t.status||tenant.status}</p>
      </div>
      <button type="button" className="rmm-secondary compact" onClick={load} disabled={loading}>
        <RefreshCw size={14}/>{loading?'Loading…':'Refresh tenant'}
      </button>
    </div>
    {notice?<p className="h5a-detail-warning" role="status">{notice}</p>:null}
    <div className="h5a-detail-metrics">
      <div><Building2 size={17}/><small>Subscription</small><strong>{s.status||tenant.billing_status||'Not set'}</strong></div>
      <div><CalendarClock size={17}/><small>Renewal / trial</small><strong>{date(s.renewalAt||s.trialEndsAt||tenant.renewal_at||tenant.trial_ends_at)}</strong></div>
      <div><Activity size={17}/><small>Billable RMM devices</small><strong>{d?.billable??'Not verified'}</strong></div>
      <div><HardDrive size={17}/><small>Last verified backup</small><strong>{summary?.backup?.availability==='verified_records'
        ?date(Object.values(summary.backup.environments||{}).map(x=>x.completed_at).sort().at(-1))
        :'Not available'}</strong></div>
    </div>
    <div className="h5a-detail-grid">
      <Panel title="Products and subscription" subtitle="Customer entitlements and the recorded commercial settings">
        <div className="h5a-detail-fields">
          <Field label="ITSM">{(t.modules||tenant.modules)?.itsm?'Enabled':'Not enabled'}</Field>
          <Field label="RMM">{(t.modules||tenant.modules)?.rmm?'Enabled':'Not enabled'}</Field>
          <Field label="Plan">{s.plan||tenant.plan_key||'Not configured'}</Field>
          <Field label="Billing cycle">{s.cycle||tenant.billing_cycle||'Not configured'}</Field>
          <Field label="Trial ends">{date(s.trialEndsAt||tenant.trial_ends_at)}</Field>
          <Field label="Next renewal">{date(s.renewalAt||tenant.renewal_at)}</Field>
          <Field label="Next invoice date">{date(s.nextInvoiceAt)}</Field>
          <Field label="Current configured monthly amount">{money(s.configuredMonthlyPence??tenant.monthly_price_pence,s.currency||tenant.currency)}</Field>
        </div>
      </Panel>
      <Panel title="RMM and billable devices" subtitle="Live tenant database counts; bill only qualifying devices in the last 30 days">
        {d?<div className="h5a-detail-fields">
          <Field label="All registered agents">{d.total}</Field>
          <Field label="Connected (reported)">{d.connected}</Field>
          <Field label="Billable (≤ 30 days)">{d.billable}</Field>
          <Field label="Offline / no check-in over 30 days">{d.offlineOver30Days}</Field>
          <Field label="Disabled / not billable">{d.disabled}</Field>
          <Field label="Price per billable device">{money(s.deviceUnitPricePence,s.currency)}</Field>
          <Field label="Base subscription">{money(s.baseMonthlyPence,s.currency)}</Field>
          <Field label="Estimated monthly total">{money(s.estimatedMonthlyPence,s.currency)}</Field>
        </div>:<p className="h5a-detail-muted">Device billing cannot be verified until the tenant overview API is active.</p>}
        <p className="h5a-detail-muted">Charges are estimates, before tax and billing adjustments. Disabled devices and devices without a check-in within 30 days are excluded. Only issued invoices are authoritative.</p>
      </Panel>
      <Panel title="Environments and releases" subtitle="Provisioned environments, last deploy, and pending customer updates">
        {environments.length?<div className="h5a-env-list">{environments.map(e=><div className="h5a-env-row" key={e.environment}>
          <div className="h5a-env-title"><strong>{e.environment==='live'?'Production':e.environment.toUpperCase()}</strong><span>{e.status||'Unknown'}</span></div>
          <div className="h5a-detail-fields">
            <Field label="Verified runtime version">{e.verifiedBuildSha?.slice(0,12)||'Not host-verified'}</Field>
            <Field label="Recorded release">{e.active_release_ref||'None recorded'}</Field>
            <Field label="Last deployed">{date(e.last_deployed_at||e.assigned_at)}</Field>
            <Field label="Pending updates">{e.pendingUpdates?.length||0}</Field>
          </div>
          {e.pendingUpdates?.map((x,i)=><p key={i} className="h5a-detail-muted">Pending {x.state}: {String(x.build_sha||'').slice(0,12)} · eligible {date(x.maintenance_not_before)}</p>)}
        </div>)}</div>:<p className="h5a-detail-muted">Verified environment assignments and pending updates are not available from this Admin build.</p>}
        <p className="h5a-detail-muted">Runtime version displays only when a recorded assignment matches a verified pool. Public host routing still requires an independent deployment attestation.</p>
      </Panel>
      <Panel title="Backups and retention" subtitle="Verified backup metadata only — never a guessed backup">
        {environments.length?<div className="h5a-env-list">{environments.map(e=><div className="h5a-detail-fields" key={e.environment}>
          <Field label={e.environment.toUpperCase()+' backup date'}>{date(e.lastVerifiedBackup?.completed_at)}</Field>
          <Field label="Backup size">{size(e.lastVerifiedBackup?.size_bytes)}</Field>
        </div>)}</div>:<p className="h5a-detail-muted">No verified backup records available.</p>}
        <div className="h5a-detail-fields">
          <Field label="Lifecycle state">{summary?.lifecycle?.state||'Awaiting verification'}</Field>
          <Field label="Archive restore deadline">{date(summary?.lifecycle?.restoreDeadline)}</Field>
          <Field label="Retention">{summary?.lifecycle?.retentionDays?summary.lifecycle.retentionDays+' days':'Not set'}</Field>
          <Field label="Legal hold">{summary?.lifecycle?.legalHold?'Active':available?'None recorded':'Not verified'}</Field>
        </div>
      </Panel>
      <Panel title="Invoices" subtitle="Amounts and dates from recorded issued invoices; not estimates">
        {invoices.length?<div className="h5a-invoices">{invoices.map(i=><div className="h5a-invoice-row" key={i.external_invoice_id}>
          <strong>{i.external_invoice_id}</strong><span>{money(i.total_pence,i.currency)}</span>
          <small>Issued {date(i.issued_at)} · due {date(i.due_at)} · {i.status}</small>
        </div>)}</div>:<p className="h5a-detail-muted">No verified issued invoices have been recorded for this tenant.</p>}
      </Panel>
      <Panel title="Data access, archive and export" subtitle="Revoke, archive, restore, export, import and purge require a protected audited lifecycle API">
        <div className="h5a-detail-fields">
          <Field label="Current lifecycle">{summary?.lifecycle?.state||'Not verified'}</Field>
          <Field label="Purge request">{summary?.lifecycle?.purgeRequestedAt?date(summary.lifecycle.purgeRequestedAt):'None recorded'}</Field>
        </div>
        <p className="h5a-detail-muted">These controls require administrator confirmation, retention validation and independent review before destructive operations. They are not enabled in the public Admin API yet.</p>
        <div className="h5a-detail-actions">
          {['Suspend / revoke','Archive','Restore','Request export','Request import','Request purge'].map(label=><button key={label} type="button" disabled className="rmm-secondary compact" title="Protected lifecycle deployment pending">{label}</button>)}
        </div>
      </Panel>
    </div>
    <Panel title="Customer settings" subtitle="Edit existing tenant properties and recorded subscription settings">
      <div className="h5a-detail-editors">{editTenant}{editBilling}</div>
    </Panel>
    <div className="h5a-detail-footnote"><ShieldCheck size={15}/> Verified operational evidence is timestamped; customer data is never erased by opening this page. {summary?.asOf?'Read at '+date(summary.asOf):''}</div>
  </div>
}
