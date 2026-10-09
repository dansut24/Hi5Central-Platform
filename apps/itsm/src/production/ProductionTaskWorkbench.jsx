import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUpRight, CheckCircle2, ChevronRight, ClipboardList,
  Clock3, FileText, MessageSquareText, RefreshCw, Send, ShieldCheck, UserRound, X,
} from 'lucide-react'
import { RichNoteEditor, RichActivityBody, sanitizeNoteHtml } from './ProductionRichNoteEditor.jsx'
import './ProductionTaskWorkbench.css'

const stamp = value => {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date)
}
function initials(name) { return String(name || 'HC').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() }

export function TaskActivityFeed({ events, onSave, busy, allowCustomer = false, taskId }) {
  const [mode,setMode] = useState('')
  const [drafts,setDrafts] = useState({internal:{text:'',html:''},customer:{text:'',html:''}})
  const [error,setError] = useState('')
  const listRef = useRef(null)
  useEffect(()=>{setMode('');setError('');setDrafts({internal:{text:'',html:''},customer:{text:'',html:''}})},[taskId])
  useEffect(()=>{if(mode) listRef.current?.scrollTo({top:0})},[mode])
  const draft = drafts[mode]||{text:'',html:''}
  const canSubmit = Boolean(draft.text.trim() || /<img\b/i.test(draft.html))
  async function submit() {
    if (!canSubmit || busy) return
    setError('')
    const didSave = await onSave({
      text:draft.text.trim() || '[Inline image]',
      html:sanitizeNoteHtml(draft.html),
      visibility:mode,
    })
    if (!didSave) { setError('Could not save this note. Your draft has been preserved.'); return }
    setDrafts(prev=>({...prev,[mode]:{text:'',html:''}}))
    setMode('')
    listRef.current?.scrollTo({top:0,behavior:'smooth'})
  }
  return <div className="task-record-feed">
    <div className="task-record-feed-toolbar">
      <button type="button" className={mode==='internal'?'is-selected':''} onClick={()=>{setError('');setMode(v=>v==='internal'?'':'internal')}}><MessageSquareText size={15}/>Internal note</button>
      {allowCustomer?<button type="button" className={mode==='customer'?'is-selected':''} onClick={()=>{setError('');setMode(v=>v==='customer'?'':'customer')}}><Send size={15}/>Customer update</button>:null}
      <small>{events.length} update{events.length===1?'':'s'}</small>
    </div>
    <div ref={listRef} className="task-record-feed-scroll">
      {mode?<article className="task-record-composer">
        <header><span className="task-record-avatar"><UserRound size={15}/></span><strong>{mode==='customer'?'Customer update':'Internal note'} · Draft</strong><button type="button" disabled={busy} onClick={()=>setMode('')}><X size={14}/>Cancel</button></header>
        <RichNoteEditor key={mode} html={draft.html} text={draft.text} placeholder={mode==='customer'?'Write a requester-visible update…':'Write an internal task note…'} onChange={patch=>setDrafts(prev=>({...prev,[mode]:{...prev[mode],...patch}}))}/>
        {error?<p role="alert" className="task-record-compose-error">{error}</p>:null}
        <footer><span>{mode==='customer'?'Visible to the requester':'Only visible to technicians'}</span><button type="button" onClick={()=>void submit()} disabled={busy||!canSubmit}><Send size={14}/>{busy?'Saving…':mode==='customer'?'Send update':'Save note'}</button></footer>
      </article>:null}
      {events.length?events.map((entry,index)=>{
        const html = entry.html || entry.metadata?.richHtml || ''
        const type=entry.visibility==='customer'?'Customer update':entry.kind==='system'?'Workflow event':entry.metadata?.event?.includes('task')?'Task update':'Internal note'
        return <article key={entry.id||index} className="task-record-event">
          <span className="task-record-avatar">{initials(entry.actor)}</span>
          <div className="task-record-event-body">
            <header><strong>{entry.actor||'Hi5Central'}</strong><time>{stamp(entry.createdAt)}</time><small>{type}</small></header>
            <RichActivityBody html={html} text={entry.text || entry.action || 'Task updated'}/>
          </div>
        </article>
      }):<div className="task-record-empty"><MessageSquareText size={20}/><strong>No task activity yet</strong><p>Add a note to start the timeline.</p></div>}
    </div>
  </div>
}

export function TaskWorkbenchFrame({
  taskId,title,status,priority,parentId,parentTitle,parentType,onBack,onOpenParent,
  onRefresh,left,activity,details,context,alert,notice,
}) {
  const [tab,setTab] = useState('activity')
  return <section className="production-task-experience task-record-workbench production-motion-enter">
    <nav className="task-record-breadcrumb" aria-label="Breadcrumb"><button type="button" onClick={onBack}><ArrowLeft size={14}/>Tasks</button><ChevronRight size={13}/><span>{taskId}</span></nav>
    <div className="task-record-header">
      <span className="task-record-header-icon"><ClipboardList size={18}/></span>
      <div className="task-record-header-identity">
        <span>{taskId} · {parentType} task</span>
        <h1>{title}</h1>
        <div><strong className="task-record-status">{status}</strong><small>{priority || 'Medium'} priority</small></div>
      </div>
      <div className="task-record-header-actions">
        <button type="button" className="task-record-parent-button" disabled={!parentId} onClick={onOpenParent}><ArrowUpRight size={16}/>Open {parentType.toLowerCase()}</button>
        <button type="button" className="task-record-refresh" aria-label="Refresh task" title="Refresh task" onClick={onRefresh}><RefreshCw size={16}/></button>
      </div>
    </div>
    <div className="task-record-feedback">
      {alert?<p className="task-record-alert" role="alert">{alert}</p>:null}
      {notice?<p className="task-record-notice" role="status"><CheckCircle2 size={15}/>{notice}</p>:null}
    </div>
    <nav className="task-record-tabs" aria-label="Task sections">
      <button type="button" className={tab==='activity'?'is-active':''} onClick={()=>setTab('activity')}>Activity</button>
      <button type="button" className={tab==='details'?'is-active':''} onClick={()=>setTab('details')}>Details</button>
    </nav>
    <div className="task-record-three-panel">
      <aside className="task-record-info-rail" aria-label="Task information">{left}</aside>
      <main className="task-record-main" aria-label={tab==='activity'?'Task activity':'Task details'}>
        {tab==='activity'?activity:<div className="task-record-details-content">{details || <p>Task information and controls are available in the left panel.</p>}</div>}
      </main>
      <aside className="task-record-context-rail" aria-label="Parent record context">
        <h2>{parentType} context</h2>
        <button type="button" className="task-record-context-parent" disabled={!parentId} onClick={onOpenParent}><FileText size={16}/><span><strong>{parentId}</strong><small>{parentTitle || parentType}</small></span><ArrowUpRight size={14}/></button>
        {context}
      </aside>
    </div>
  </section>
}
export function TaskContextField({label,value}) {return <div className="task-record-context-field"><span>{label}</span><strong>{value===0?'0':value||'Not recorded'}</strong></div>}
export function TaskRailField({label,children}) {return <div className="task-record-rail-field"><span>{label}</span>{children}</div>}
