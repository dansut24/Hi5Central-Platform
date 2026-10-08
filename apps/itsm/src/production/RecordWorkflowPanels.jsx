import { useState } from 'react'
import { CalendarDays, CheckCircle2, ChevronDown, CircleDot, Clock3, Plus, ShieldCheck, X } from 'lucide-react'

const TASK_STATES = ['Open', 'In Progress', 'Blocked', 'Completed', 'Cancelled']
const FINISHED_STATES = new Set(['Completed', 'Cancelled'])

function statusTone(status) {
  const value = String(status || '').toLowerCase()
  if (['completed', 'approved', 'ready'].includes(value)) return 'good'
  if (['rejected', 'blocked', 'cancelled'].includes(value)) return 'danger'
  if (['pending', 'waiting', 'in progress'].includes(value)) return 'warning'
  return 'neutral'
}

function dateLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function StatePill({ status }) {
  return <span className={`record-workflow-status is-${statusTone(status)}`}>{status || 'Not set'}</span>
}

export function RecordTasksPanel({ tasks = [], isServiceRequest = false, canManage = false, saving = false, onCreate, onChangeStatus, onOpenTask }) {
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [dueAt, setDueAt] = useState('')
  const completeCount = tasks.filter((task) => FINISHED_STATES.has(task.status)).length
  const addTask = async (event) => {
    event.preventDefault()
    if (!title.trim() || !onCreate) return
    const saved = await onCreate({ title: title.trim(), instructions: instructions.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null })
    if (saved) { setTitle(''); setInstructions(''); setDueAt(''); setShowCreate(false) }
  }

  return <section className="record-lab-panel record-lab-tab-panel record-workflow-panel">
    <header className="record-workflow-header">
      <div><span>Work</span><h2>{isServiceRequest ? 'Fulfilment tasks' : 'Record tasks'}</h2><small>Track the actions required to complete this record.</small></div>
      <div className="record-workflow-header-actions"><span className="record-workflow-count">{completeCount} of {tasks.length} finished</span>{canManage && !isServiceRequest ? <button type="button" className="record-workflow-add-button" aria-expanded={showCreate} onClick={() => setShowCreate((current) => !current)}><Plus size={15} />New task</button> : null}</div>
    </header>
    {showCreate && canManage && !isServiceRequest ? <form className="record-workflow-form" onSubmit={addTask}>
      <div className="record-workflow-form-title"><strong>Add record task</strong><button type="button" onClick={() => setShowCreate(false)} aria-label="Close new task"><X size={16} /></button></div>
      <label>Task title<input required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" /></label>
      <label>Instructions<textarea rows={2} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Optional details for the assigned technician" /></label>
      <label>Due date <span className="record-workflow-optional">(optional)</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      <div className="record-workflow-form-actions"><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="is-primary" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Create task'}</button></div>
    </form> : null}
    {tasks.length ? <div className="record-workflow-list">{tasks.map((task, index) => {
      const isFinished = FINISHED_STATES.has(task.status)
      return <article className="record-workflow-row" key={task.id || `${task.title}-${index}`}>
        <span className={`record-workflow-icon${isFinished ? ' is-complete' : ''}`}>{isFinished ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}</span>
        <div className="record-workflow-row-main">
          <strong>{task.title || 'Untitled task'}</strong>
          <small>{[task.team, task.assignee || 'Unassigned', task.dueAt ? `Due ${dateLabel(task.dueAt)}` : ''].filter(Boolean).join(' · ')}</small>
          {task.instructions ? <p>{task.instructions}</p> : null}
          {task.completionNotes ? <small className="record-workflow-result">Completion: {task.completionNotes}</small> : null}
        </div>
        <div className="record-workflow-row-actions">
          {isServiceRequest ? <><StatePill status={task.status} />{onOpenTask && task.id ? <button type="button" onClick={() => onOpenTask(task)}>Open task</button> : null}</> : canManage ? <label className="record-workflow-status-picker"><span>Task status</span><select aria-label={`Status for ${task.title}`} disabled={saving} value={TASK_STATES.includes(task.status) ? task.status : 'Open'} onChange={(event) => onChangeStatus?.(task, event.target.value)}>{TASK_STATES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : <StatePill status={task.status} />}
        </div>
      </article>
    })}</div> : <div className="record-workflow-empty"><CircleDot size={24} /><strong>No tasks yet</strong><p>{isServiceRequest ? 'This request has no fulfilment tasks attached.' : 'Add a task to assign and track the remaining work.'}</p></div>}
  </section>
}

export function RecordApprovalsPanel({ approvals = [], isServiceRequest = false, saving = false, canDecideApproval = () => false, onDecision }) {
  const [reviewingId, setReviewingId] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [decision, setDecision] = useState('Approved')
  const pending = approvals.filter((item) => item.status === 'Pending').length

  const submitDecision = async (event, approval) => {
    event.preventDefault()
    if (!onDecision || (decision === 'Rejected' && !decisionNote.trim())) return
    const saved = await onDecision(approval, decision, decisionNote.trim())
    if (saved) { setReviewingId(''); setDecisionNote(''); setDecision('Approved') }
  }

  return <section className="record-lab-panel record-lab-tab-panel record-workflow-panel">
    <header className="record-workflow-header"><div><span>Governance</span><h2>Approvals</h2><small>{isServiceRequest ? 'Requests remain controlled by their assigned approvers.' : 'Change approval and authorisation context.'}</small></div><div className="record-workflow-count">{pending ? `${pending} awaiting decision` : `${approvals.length} total`}</div></header>
    {approvals.length ? <div className="record-workflow-list">{approvals.map((approval) => {
      const canDecide = isServiceRequest && approval.status === 'Pending' && canDecideApproval(approval)
      const reviewing = reviewingId === approval.id
      return <article className="record-workflow-approval" key={approval.id}>
        <div className="record-workflow-approval-main">
          <span className="record-workflow-icon"><ShieldCheck size={18} /></span>
          <div><strong>{approval.label || 'Approval'}</strong><small>{approval.approver || 'Unassigned approver'}{approval.updated ? ` · Updated ${dateLabel(approval.updated)}` : ''}</small>{approval.decisionNote ? <p>{approval.decisionNote}</p> : null}</div>
          <StatePill status={approval.status} />
        </div>
        {canDecide ? <div className="record-workflow-approval-action">{!reviewing ? <button type="button" onClick={() => { setReviewingId(approval.id); setDecision('Approved'); setDecisionNote('') }}>Review decision <ChevronDown size={14} /></button> : <form className="record-workflow-form" onSubmit={(event) => submitDecision(event, approval)}>
          <div className="record-workflow-form-title"><strong>Confirm approval decision</strong><button type="button" onClick={() => setReviewingId('')} aria-label="Close approval review"><X size={16} /></button></div>
          <label>Decision<select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="Approved">Approve</option><option value="Rejected">Reject</option></select></label>
          <label>{decision === 'Rejected' ? 'Reason for rejection' : 'Decision note (optional)'}<textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} rows={2} placeholder="Provide context for this decision" required={decision === 'Rejected'} /></label>
          <div className="record-workflow-form-actions"><button type="button" onClick={() => setReviewingId('')}>Cancel</button><button type="submit" className={decision === 'Rejected' ? 'is-danger' : 'is-primary'} disabled={saving || (decision === 'Rejected' && !decisionNote.trim())}>{saving ? 'Saving…' : decision === 'Approved' ? 'Confirm approval' : 'Confirm rejection'}</button></div>
        </form>}</div> : null}
      </article>
    })}</div> : <div className="record-workflow-empty"><Clock3 size={24} /><strong>No approvals required</strong><p>{isServiceRequest ? 'This service request does not have an approval step.' : 'No approval steps are linked to this change yet.'}</p></div>}
  </section>
}
