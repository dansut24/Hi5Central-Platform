import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronRight, Clock3,
  FileText, Laptop, Mail, MessageSquareText, Paperclip, Send, UserRound,
} from 'lucide-react'
import { RichActivityBody, RichNoteEditor, sanitizeNoteHtml } from './ProductionRichNoteEditor.jsx'

function dateLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(date)
}
const display = (value, fallback = 'Not recorded') => String(value == null || value === '' ? fallback : value)
function nameInitials(value) {
  return display(value,'HC').split(/\s+/).slice(0,2).map(v=>v[0]?.toUpperCase()).join('') || 'HC'
}

export function PeekRecordRail({ detail, route, children }) {
  const summary = detail.description || detail.summary || (route.type === 'Service Request' ? detail.catalogueItemTitle : '') || ''
  const [fullSummary, setFullSummary] = useState(false)
  const summaryLong = summary.length > 165 || summary.split('\n').length > 4
  return <aside className="hi5-peek-rail hi5-peek-record-rail" aria-label="Record information">
    <div className="hi5-peek-record-identity">
      <span className="hi5-peek-type-icon">{route.type === 'Incident' ? <AlertTriangle size={17}/> : route.type === 'Change' ? <CheckCircle2 size={17}/> : <FileText size={17}/>}</span>
      <div><strong>{detail.id || detail.reference || route.reference}</strong><small>{route.type}</small></div>
    </div>
    <h2>{detail.title || 'Untitled record'}</h2>
    <div className="hi5-peek-badges"><span className="hi5-peek-status">{display(detail.status,'New')}</span><span>{display(detail.priority,'Normal')}</span></div>
    {summary ? <section className="hi5-peek-summary">
      <h3>{route.type === 'Service Request' ? 'Request summary' : 'Issue summary'}</h3>
      <p className={!fullSummary && summaryLong ? 'is-clamped' : ''}>{summary}</p>
      {summaryLong ? <button type="button" onClick={()=>setFullSummary(v=>!v)}>{fullSummary?'Show less':'Read full description'} <ChevronRight size={13}/></button> : null}
    </section> : null}
    <section className="hi5-peek-record-fields" aria-label="Record facts">
      {detail.service ? <div><span>Service</span><strong>{detail.service}</strong></div> : null}
      {detail.category || detail.catalogueItemTitle ? <div><span>Category</span><strong>{detail.category || detail.catalogueItemTitle}</strong></div> : null}
      {detail.source ? <div><span>Source</span><strong>{detail.source}</strong></div> : null}
      {detail.sla?.resolution?.label || detail.sla?.resolutionTarget ? <div><span><Clock3 size={13}/> Resolution SLA</span><strong>{detail.sla.resolution?.label || dateLabel(detail.sla.resolutionTarget)}</strong></div> : null}
      <div><span>Updated</span><strong>{dateLabel(detail.updatedAt)}</strong></div>
    </section>
    <section className="hi5-peek-rail-assignment" aria-label="Quick record actions">
      <h3>Quick actions</h3>
      {children}
    </section>
  </aside>
}

export function PeekContextRail({ detail, route, onDetails }) {
  const name = typeof detail.requester === 'object' ? detail.requester?.name : detail.requester
  const email = detail.requesterEmail || (typeof detail.requester === 'object' && detail.requester?.email) || ''
  const phone = detail.requesterPhone || (typeof detail.requester === 'object' && detail.requester?.phone) || ''
  const links = Array.isArray(detail.relationships) ? detail.relationships : []
  const assets = Array.isArray(detail.assets) ? detail.assets : Array.isArray(detail.linkedAssets) ? detail.linkedAssets : []
  return <aside className="hi5-peek-rail hi5-peek-context-rail" aria-label="Requester and related context">
    <h3>Requester</h3>
    <div className="hi5-peek-requester">
      <span className="hi5-peek-avatar">{nameInitials(name)}</span>
      <div><strong>{display(name,'Requester unknown')}</strong><small>{display(detail.requesterJobTitle,'End user')}</small></div>
    </div>
    {email ? <a className="hi5-peek-contact" href={`mailto:${email}`}><Mail size={15}/><span>{email}</span></a> : null}
    {phone ? <a className="hi5-peek-contact" href={`tel:${String(phone).replace(/[^+\d]/g,'')}`}><UserRound size={15}/><span>{phone}</span></a> : null}
    <div className="hi5-peek-context-facts">
      {detail.requesterDepartment ? <div><span>Department</span><strong>{detail.requesterDepartment}</strong></div> : null}
      {detail.requesterSite || detail.requesterLocation ? <div><span>Site</span><strong>{detail.requesterSite || detail.requesterLocation}</strong></div> : null}
      {detail.team ? <div><span>Assigned team</span><strong>{detail.team}</strong></div> : null}
      {detail.assignee ? <div><span>Technician</span><strong>{detail.assignee}</strong></div> : null}
      {route.type === 'Incident' && detail.impact ? <div><span>Impact</span><strong>{detail.impact}</strong></div> : null}
      {route.type === 'Incident' && detail.urgency ? <div><span>Urgency</span><strong>{detail.urgency}</strong></div> : null}
      {route.type === 'Service Request' && (detail.oneOffCost || detail.monthlyCost) ? <>
        <div><span>One-off cost</span><strong>{detail.currency || 'GBP'} {Number(detail.oneOffCost || 0).toFixed(2)}</strong></div>
        <div><span>Monthly cost</span><strong>{detail.currency || 'GBP'} {Number(detail.monthlyCost || 0).toFixed(2)}</strong></div>
      </> : null}
    </div>
    {assets.length ? <section className="hi5-peek-related"><h3><Laptop size={15}/> Linked assets</h3>{assets.slice(0,3).map((item,i)=><div key={item.id || item.reference || i}><strong>{item.name || item.hostname || item.reference || 'Asset'}</strong><small>{item.type || item.status || 'Related device'}</small></div>)}</section> : null}
    {links.length ? <section className="hi5-peek-related"><h3>Related records</h3>{links.slice(0,4).map((item,i)=><div key={item.id || i}><strong>{item.reference || item.targetReference || 'Related'}</strong><small>{item.title || item.relationshipType || item.type || ''}</small></div>)}</section> : null}
    <button type="button" className="hi5-peek-context-more" onClick={onDetails}>All record details <ChevronRight size={14}/></button>
  </aside>
}

export function PeekActivity({ activities = [], busy = false, onPost, reference }) {
  const [mode,setMode] = useState('')
  const [drafts,setDrafts] = useState({internal:{text:'',html:''},customer:{text:'',html:''}})
  const [error,setError] = useState('')
  const feedRef = useRef(null)
  const note = drafts[mode] || {text:'',html:''}
  useEffect(()=>{setMode('');setDrafts({internal:{text:'',html:''},customer:{text:'',html:''}});setError('')},[reference])
  useEffect(()=>{if(mode&&feedRef.current)feedRef.current.scrollTop=0},[mode])
  async function submit() {
    if (busy || (!note.text.trim() && !/<img\b/i.test(note.html))) return
    setError('')
    const success = await onPost({ visibility: mode, text:note.text.trim() || '[Inline image]', html:sanitizeNoteHtml(note.html) })
    if (success) {
      setDrafts(previous=>({...previous,[mode]:{text:'',html:''}}))
      setMode('')
      feedRef.current?.scrollTo({top:0})
    } else setError('Could not save this update. Your draft has been kept.')
  }
  const ordered = [...activities].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))
  return <div className="hi5-peek-activity-surface">
    <div className="hi5-peek-note-toolbar">
      <button type="button" className={mode==='internal'?'is-active':''} onClick={()=>setMode(m=>m==='internal'?'':'internal')}><MessageSquareText size={15}/> Internal note</button>
      <button type="button" className={mode==='customer'?'is-active':''} onClick={()=>setMode(m=>m==='customer'?'':'customer')}><Send size={15}/> Customer update</button>
      <small>{ordered.length} update{ordered.length===1?'':'s'}</small>
    </div>
    <div className="hi5-peek-feed" ref={feedRef}>
      {mode ? <div className="hi5-peek-inline-composer" aria-label="Draft activity update">
        <div className="hi5-peek-draft-heading"><strong>{mode==='customer'?'Customer update':'Internal note'} · Draft</strong><button type="button" disabled={busy} onClick={()=>setMode('')}>Cancel</button></div>
        <RichNoteEditor key={mode} html={note.html} text={note.text} onChange={patch=>setDrafts(prev=>({...prev,[mode]:{...prev[mode],...patch}}))} placeholder={mode==='customer'?'Write a customer-visible update…':'Write an internal note…'} />
        {error ? <p className="hi5-peek-save-error" role="alert">{error}</p> : null}
        <div className="hi5-peek-draft-footer"><small>{mode==='customer'?'Visible to the requester':'Only visible to technicians'}</small><button type="button" disabled={busy || (!note.text.trim() && !/<img\b/i.test(note.html))} onClick={submit}><Send size={15}/>{busy?'Saving…':mode==='customer'?'Send update':'Save note'}</button></div>
      </div> : null}
      {ordered.length ? ordered.map((item,index)=> {
        const kind = item.visibility==='customer'||item.kind==='customer'?'customer':item.kind==='origin'?'origin':'internal'
        const attachmentList = [...(Array.isArray(item.attachments)?item.attachments:[]),...(Array.isArray(item.metadata?.attachments)?item.metadata.attachments:[])]
        return <article className={`hi5-peek-note is-${kind}`} key={item.id || index}>
          <span className="hi5-peek-avatar">{nameInitials(item.actor)}</span>
          <div className="hi5-peek-note-body">
            <header><strong>{item.actor || 'Hi5Central'}</strong><time>{dateLabel(item.createdAt)}</time><em>{kind==='customer'?'Customer update':kind==='origin'?'Original request':item.kind==='system'?'System event':'Internal note'}</em></header>
            <RichActivityBody html={item.html || item.metadata?.richHtml} text={item.text || 'Record updated'} />
            {attachmentList.length ? <div className="hi5-peek-note-attachments">{attachmentList.map((file,i)=><span key={file.id||i}><Paperclip size={12}/>{file.fileName||file.name||'Attachment'}</span>)}</div> : null}
          </div>
        </article>
      }) : <div className="hi5-working-peek-empty">No activity yet.</div>}
    </div>
  </div>
}
