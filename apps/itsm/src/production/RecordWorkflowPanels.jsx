import { useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, CircleDot, Clock3, Plus, ShieldCheck, X } from 'lucide-react'
import './RecordWorkflowPanels.css'

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
  const [expandedTaskId, setExpandedTaskId] = useState('')
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
      const taskKey = String(task.id || task.title + '-' + index)
      const expanded = expandedTaskId === taskKey
      return <article className="record-workflow-row" key={taskKey}>
        <span className={`record-workflow-icon${isFinished ? ' is-complete' : ''}`}>{isFinished ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}</span>
        <div className="record-workflow-row-main">
          <strong>{task.title || 'Untitled task'}</strong>
          <small>{[task.team, task.assignee || 'Unassigned', task.dueAt ? `Due ${dateLabel(task.dueAt)}` : ''].filter(Boolean).join(' · ')}</small>
          {task.completionNotes ? <small className="record-workflow-result">Completion recorded</small> : null}
        </div>
        <div className="record-workflow-row-actions">
          <button type="button" className="record-workflow-details-toggle" aria-expanded={expanded} aria-label={(expanded ? 'Hide' : 'Show') + ' details for ' + task.title} onClick={() => setExpandedTaskId(expanded ? '' : taskKey)}>{expanded ? 'Less' : 'Details'} <ChevronDown size={13} /></button>
          {isServiceRequest ? <><StatePill status={task.status} />{onOpenTask && task.id ? <button type="button" onClick={() => onOpenTask(task)}>Open task</button> : null}</> : canManage ? <label className="record-workflow-status-picker"><span>Task status</span><select aria-label={`Status for ${task.title}`} disabled={saving} value={TASK_STATES.includes(task.status) ? task.status : 'Open'} onChange={(event) => onChangeStatus?.(task, event.target.value)}>{TASK_STATES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : <StatePill status={task.status} />}
        </div>
        {expanded ? <div className="record-workflow-task-details">
          <div><strong>Instructions</strong><p>{task.instructions || 'No instructions supplied.'}</p></div>
          {task.completionNotes ? <div><strong>Completion notes</strong><p>{task.completionNotes}</p></div> : null}
          {task.dueAt ? <small>Due {dateLabel(task.dueAt)}</small> : null}
        </div> : null}
      </article>
    })}</div> : <div className="record-workflow-empty"><CircleDot size={24} /><strong>No tasks yet</strong><p>{isServiceRequest ? 'This request has no fulfilment tasks attached.' : 'Add a task to assign and track the remaining work.'}</p></div>}
  </section>
}

export function RecordApprovalsPanel({ approvals = [], isServiceRequest = false, saving = false, canDecideApproval = () => false, onDecision }) {
  const [reviewingId, setReviewingId] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [decision, setDecision] = useState('Approved')
  const pending = approvals.filter((item) => item.status === 'Pending').length
  const approved = approvals.filter((item) => item.status === 'Approved').length
  const rejected = approvals.filter((item) => item.status === 'Rejected').length

  const beginDecision = (id, nextDecision) => {
    setReviewingId(id)
    setDecision(nextDecision)
    setDecisionNote('')
  }
  const submitDecision = async (event, approval) => {
    event.preventDefault()
    if (!onDecision || (decision === 'Rejected' && !decisionNote.trim())) return
    const saved = await onDecision(approval, decision, decisionNote.trim())
    if (saved) {
      setReviewingId('')
      setDecisionNote('')
      setDecision('Approved')
    }
  }

  return <section className="record-lab-panel record-lab-tab-panel record-workflow-panel">
    <header className="record-workflow-header">
      <div><span>Governance</span><h2>Approvals</h2><small>{isServiceRequest ? 'Review decisions and the authorisation history for this request.' : 'Change authorisation overview.'}</small></div>
      <div className="record-workflow-approval-counts" aria-label="Approval progress">
        {pending ? <span className="is-pending">{pending} Pending</span> : null}
        {approved ? <span className="is-approved">{approved} Approved</span> : null}
        {rejected ? <span className="is-rejected">{rejected} Rejected</span> : null}
        {!approvals.length ? <span>No approvals</span> : null}
      </div>
    </header>
    {approvals.length ? <div className="record-workflow-list">{approvals.map((approval) => {
      const canDecide = isServiceRequest && approval.status === 'Pending' && canDecideApproval(approval)
      const reviewing = reviewingId === approval.id
      const completed = approval.status === 'Approved' || approval.status === 'Rejected'
      return <article className="record-workflow-approval" key={approval.id}>
        <div className="record-workflow-approval-main">
          <span className="record-workflow-icon"><ShieldCheck size={18} /></span>
          <div>
            <strong>{approval.label || 'Approval required'}</strong>
            <small>Assigned to {approval.approver || 'an approver'}</small>
          </div>
          <StatePill status={approval.status} />
        </div>
        {completed ? <div className="record-workflow-decision-history">
          <div className="record-workflow-decision-heading">{approval.status === 'Rejected' ? <AlertTriangle className="is-rejected" size={15} /> : <CheckCircle2 size={15} />}<strong>{approval.status} decision recorded</strong>{approval.decidedAt || approval.updated ? <time dateTime={approval.decidedAt || approval.updated}>{dateLabel(approval.decidedAt || approval.updated)}</time> : null}</div>
          {approval.decisionNote ? <p>{approval.decisionNote}</p> : <small>No decision note supplied.</small>}
        </div> : null}
        {canDecide ? <div className="record-workflow-approval-action">
          {!reviewing ? <div className="record-workflow-decision-buttons">
            <button type="button" className="is-approve" disabled={saving} onClick={() => beginDecision(approval.id, 'Approved')}><Check size={14} />Approve</button>
            <button type="button" className="is-reject" disabled={saving} onClick={() => beginDecision(approval.id, 'Rejected')}><X size={14} />Reject</button>
          </div> : <form className="record-workflow-form record-workflow-decision-form" onSubmit={(event) => submitDecision(event, approval)}>
            <div className="record-workflow-form-title"><strong>{decision === 'Approved' ? 'Confirm approval' : 'Confirm rejection'}</strong><button type="button" onClick={() => setReviewingId('')} aria-label="Cancel approval decision"><X size={16} /></button></div>
            <p className="record-workflow-decision-explanation">{decision === 'Approved' ? 'Confirming this approval allows fulfilment to proceed once all required approvals are complete.' : 'Rejecting this request will mark it as rejected. Please provide a clear reason.'}</p>
            <label>{decision === 'Rejected' ? 'Reason for rejection' : 'Decision note (optional)'}<textarea value={decisionNote} maxLength={5000} onChange={(event) => setDecisionNote(event.target.value)} rows={3} placeholder={decision === 'Rejected' ? 'Explain why this request cannot proceed' : 'Add context for this approval'} required={decision === 'Rejected'} /></label>
            <div className="record-workflow-form-actions"><button type="button" disabled={saving} onClick={() => setReviewingId('')}>Cancel</button><button type="submit" className={decision === 'Rejected' ? 'is-danger' : 'is-primary'} disabled={saving || (decision === 'Rejected' && !decisionNote.trim())}>{saving ? 'Saving…' : decision === 'Approved' ? 'Confirm approval' : 'Confirm rejection'}</button></div>
          </form>}
        </div> : null}
        {approval.status === 'Pending' && !canDecide ? <div className="record-workflow-approval-waiting"><Clock3 size={14} />Awaiting a decision from the assigned approver</div> : null}
      </article>
    })}</div> : <div className="record-workflow-empty">
      <ShieldCheck size={24} />
      <strong>{isServiceRequest ? 'No approval required' : 'No approval workflow configured'}</strong>
      <p>{isServiceRequest ? 'This request can progress without an approval step.' : 'Change approval decisions are not yet available from this record. Review the change status and tasks instead.'}</p>
    </div>}
  </section>
}
