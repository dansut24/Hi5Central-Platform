import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clock3,
  FileText,
  Columns3,
  ExternalLink,
  Filter,
  LayoutGrid,
  List,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  PlayCircle,
  RefreshCw,
  Search,
  TableProperties,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react'
import './ProductionItsmWorkspace.css'
import './ProductionItsmWorkspaceEnhancements.css'
import './ProductionActivityCanvasRecord.css'
import './ProductionActivityActionRecord.css'
import { Hi5EntityTypeahead } from './Hi5EntityTypeahead.jsx'
import { ProjectTaskDetail } from './ProductionProjectTaskDetail.jsx'
import { TaskWorkbenchFrame, TaskActivityFeed, TaskContextField, TaskRailField } from './ProductionTaskWorkbench.jsx'
import './ProductionTaskExperience.css'

const API_BASE = window.__HI5_API_BASE__
const PAGE_SIZES = [25, 50, 100]
const VIEW_STYLES = [
  { id: 'table', label: 'Table', icon: TableProperties },
  { id: 'compact', label: 'Compact', icon: List },
  { id: 'cards', label: 'Cards', icon: LayoutGrid },
]
const WORK_VIEWS = [
  { id: 'mine', label: 'My Tasks', description: 'Work currently assigned to you' },
  { id: 'team', label: 'Team Queue', description: 'Work assigned to you or your teams' },
  { id: 'project', label: 'Project Tasks', description: 'Active tasks across accessible projects' },
  { id: 'unassigned', label: 'Unassigned', description: 'Ready work waiting to be taken' },
  { id: 'blocked', label: 'Blocked', description: 'Work that needs attention' },
]
const COLUMNS = [
  { key: 'reference', label: 'Reference', width: 140, locked: true },
  { key: 'summary', label: 'Summary', width: 245, locked: true },
  { key: 'priority', label: 'Priority / risk', width: 110 },
  { key: 'status', label: 'Status', width: 125 },
  { key: 'requester', label: 'Requester / project', width: 170 },
  { key: 'service', label: 'Type / service', width: 140 },
  { key: 'assignment', label: 'Assignment', width: 180 },
  { key: 'due', label: 'Due / target', width: 155 },
  { key: 'updated', label: 'Updated', width: 145 },
  { key: 'actions', label: 'Action', width: 125, locked: true },
]
const DEFAULT_FILTERS = { scope: 'team', status: 'All', priority: 'All', team: 'All', assignee: 'All', service: 'All', source: 'All', due: 'All' }

function routeFromPath(pathname = window.location.pathname) {
  if (pathname === '/tasks' || pathname === '/tasks/') return { kind: 'list' }
  const match = pathname.match(/^\/tasks\/([^/]+)\/?$/i)
  return match ? { kind: 'detail', taskKey: decodeURIComponent(match[1]).toUpperCase() } : null
}

function navigate(path) {
  if (window.location.pathname === path) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new CustomEvent('hi5-routechange', { detail: { path } }))
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`)
  return payload
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function readSession() {
  try { return JSON.parse(window.localStorage.getItem('hi5central-production-session-v1') || '{}') || {} } catch { return {} }
}

function statusClass(value = '') {
  return `is-${String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function priorityClass(value = '') {
  return `is-${String(value).toLowerCase().replace(/\s+/g, '-')}`
}

function dueMeta(value, status = '') {
  if (status === 'Completed' || status === 'Done') return { className: 'is-complete', label: 'Completed', overdue: false }
  if (!value) return { className: 'is-none', label: 'No due date', overdue: false }
  const due = new Date(value)
  if (Number.isNaN(due.getTime())) return { className: 'is-none', label: 'No due date', overdue: false }
  const now = new Date()
  if (due.getTime() < now.getTime()) return { className: 'is-overdue', label: 'Overdue', overdue: true }
  const sameDay = due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth() && due.getDate() === now.getDate()
  if (sameDay) return { className: 'is-today', label: 'Due today', overdue: false }
  if (due.getTime() - now.getTime() <= 7 * 24 * 60 * 60 * 1000) return { className: 'is-soon', label: 'Due soon', overdue: false }
  return { className: 'is-scheduled', label: 'Scheduled', overdue: false }
}

function taskRecord(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    source: task.source || 'service-request',
    project: task.project || null,
    priority: task.priority || task.primaryRequest?.priority || 'Medium',
    requester: task.source === 'project' ? task.project?.name || 'Project' : task.primaryRequest?.requester || 'Not recorded',
    service: task.source === 'project' ? 'Project' : task.primaryRequest?.service || 'Unclassified',
    team: task.team || 'Unassigned team',
    assignee: task.assignee || 'Unassigned',
    assigneeEmail: task.assigneeEmail || '',
    updatedAt: task.updatedAt,
    primaryRequest: task.primaryRequest?.id || '',
    dueAt: task.dueAt,
  }
}

function TaskDue({ record, compact = false }) {
  const meta = dueMeta(record.dueAt, record.status)
  return <span className={`production-task-due ${meta.className}${compact ? ' is-compact' : ''}`}><strong>{meta.label}</strong><small>{record.dueAt ? formatDate(record.dueAt) : 'No target set'}</small></span>
}

function TaskNavButton({ target }) {
  if (!target) return null
  return createPortal(
    <button
      type="button"
      className={window.location.pathname.startsWith('/tasks') ? 'production-task-nav is-active' : 'production-task-nav'}
      onClick={() => navigate('/tasks')}
    >
      <ListChecks size={16} aria-hidden="true" />
      <span>Tasks</span>
    </button>,
    target,
  )
}

function AwaitingApprovalButton({ target, statusSelect }) {
  if (!target || !statusSelect) return null
  const active = statusSelect.value === 'Pending Approval'
  return createPortal(
    <button
      type="button"
      className={active ? 'is-active production-awaiting-approval-view' : 'production-awaiting-approval-view'}
      onClick={() => {
        statusSelect.value = 'Pending Approval'
        statusSelect.dispatchEvent(new Event('change', { bubbles: true }))
      }}
    >Awaiting approval</button>,
    target,
  )
}

function useWorkspaceTargets(taskRoute) {
  const [content, setContent] = useState(null)
  const [nav, setNav] = useState(null)
  const [approvalTarget, setApprovalTarget] = useState(null)
  const [approvalSelect, setApprovalSelect] = useState(null)

  useEffect(() => {
    const find = () => {
      setContent(taskRoute ? document.querySelector('.content-frame') : null)
      const serviceDesk = [...document.querySelectorAll('.nav-group')].find((node) => node.querySelector('.nav-group-title')?.textContent?.trim() === 'Service Desk')
      setNav(serviceDesk?.querySelector('.nav-items') || null)

      if (window.location.pathname === '/requests' || window.location.pathname === '/requests/') {
        const shell = [...document.querySelectorAll('.production-record-shell')].find((node) => node.querySelector('.production-record-filter-heading strong')?.textContent?.trim() === 'Service Requests')
        const viewList = shell?.querySelector('.production-record-view-list') || null
        const fields = [...(shell?.querySelectorAll('.production-record-filter-field') || [])]
        const statusField = fields.find((field) => field.querySelector('span')?.textContent?.trim() === 'Status')
        setApprovalTarget(viewList)
        setApprovalSelect(statusField?.querySelector('select') || null)
      } else {
        setApprovalTarget(null)
        setApprovalSelect(null)
      }
    }

    find()
    const observer = new MutationObserver(find)
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setInterval(find, 500)
    return () => { observer.disconnect(); window.clearInterval(timer) }
  }, [taskRoute])

  return { content, nav, approvalTarget, approvalSelect }
}

function FilterSelect({ label, value, options, onChange }) {
  return <label className="production-record-filter-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option>All</option>{(options || []).filter((option) => option && option !== 'All').map((option) => <option key={option}>{option}</option>)}</select></label>
}

function TaskFilters({ payload, filters, onChange, onClear, query, onQueryChange }) {
  const options = payload.filters || {}

  return <div className="production-record-filter-content">
    <section>
      <span className="production-record-filter-label">Search</span>
      <label className="production-record-drawer-search"><Search size={15} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search tasks or parent requests…" type="search" /></label>
    </section>
    <section>
      <span className="production-record-filter-label">Filters</span>
      <FilterSelect label="Status" value={filters.status} options={options.statuses} onChange={(value) => onChange({ ...filters, status: value })} />
      <FilterSelect label="Priority / risk" value={filters.priority} options={options.priorities} onChange={(value) => onChange({ ...filters, priority: value })} />
      <FilterSelect label="Assignment group" value={filters.team} options={options.teams} onChange={(value) => onChange({ ...filters, team: value })} />
      <FilterSelect label="Assignee" value={filters.assignee} options={options.assignees} onChange={(value) => onChange({ ...filters, assignee: value })} />
      <FilterSelect label="Type" value={filters.source} options={['service-request','project'].filter(value => (options.sources || []).includes(value))} onChange={(value) => onChange({ ...filters, source: value })} />
      <FilterSelect label="Service" value={filters.service} options={options.services} onChange={(value) => onChange({ ...filters, service: value })} />
      <FilterSelect label="Due / target" value={filters.due} options={options.due} onChange={(value) => onChange({ ...filters, due: value })} />
      <button className="production-record-clear" type="button" onClick={onClear}>Reset to Team Queue</button>
    </section>
  </div>
}

function TaskWorkViews({ payload, active, onChange }) {
  const counts = payload.views || {}
  return <nav className="production-task-work-views" aria-label="Task work queues">{WORK_VIEWS.map((view) => <button key={view.id} type="button" className={active === view.id ? 'is-active' : ''} onClick={() => onChange(view.id)}><span><strong>{view.label}</strong><small>{view.description}</small></span><b>{Number(counts[view.id] || 0)}</b></button>)}</nav>
}

function renderCell(record, key) {
  if (key === 'reference') return <strong className="production-record-reference">{record.id}</strong>
  if (key === 'summary') return <><strong>{record.title}</strong><small>{record.project ? `Project ${record.project.id} · ${record.project.name}` : record.primaryRequest ? `Primary ${record.primaryRequest}` : 'Workflow task'}</small></>
  if (key === 'priority') return <span className={`production-record-priority ${priorityClass(record.priority)}`}>{record.priority}</span>
  if (key === 'status') return <span className={`production-record-status ${statusClass(record.status)}`}>{record.status}</span>
  if (key === 'requester') return <span>{record.requester}</span>
  if (key === 'service') return <span>{record.source === 'project' ? 'Project task' : record.service}</span>
  if (key === 'assignment') return <span className="production-task-assignment"><strong>{record.team}</strong><small>{record.assignee}</small></span>
  if (key === 'due') return <TaskDue record={record} />
  if (key === 'updated') return <span>{formatDate(record.updatedAt)}</span>
  return null
}

function taskCanBeTaken(record) {
  return record.source !== 'project' && record.status === 'Ready' && (!record.assignee || record.assignee === 'Unassigned')
}

function TaskOwnershipButton({ record, onTake, busyTask }) {
  if (record.source === 'project') return <button type="button" className="production-task-ownership-button" onClick={(event) => { event.stopPropagation(); navigate(`/tasks/${encodeURIComponent(record.id)}`) }}><ExternalLink size={14}/>Open task</button>
  if (!taskCanBeTaken(record)) return <span className="production-task-ownership-state">{record.status === 'Ready' ? record.assignee : '—'}</span>
  const busy = busyTask === record.id
  return <button type="button" className="production-task-ownership-button" disabled={busy} onClick={(event) => { event.stopPropagation(); void onTake(record) }}><UserPlus size={14} />{busy ? 'Taking…' : 'Take task'}</button>
}

function TaskTable({ items, columns, onOpen, onTake, busyTask }) {
  return <div className="production-record-table-wrap"><table className="production-record-table production-record-table-enhanced"><colgroup>{columns.map((column) => <col key={column.key} style={{ width: `${column.width}px` }} />)}</colgroup><thead><tr>{columns.map((column) => <th key={column.key}><span>{column.label}</span></th>)}</tr></thead><tbody>{items.map((record) => <tr key={record.id} className={dueMeta(record.dueAt, record.status).overdue ? 'is-task-overdue' : ''} onClick={() => onOpen(record)}>{columns.map((column) => <td key={column.key}>{column.key === 'actions' ? <TaskOwnershipButton record={record} onTake={onTake} busyTask={busyTask} /> : renderCell(record, column.key)}</td>)}</tr>)}</tbody></table></div>
}

function TaskCompactList({ items, onOpen, onTake, busyTask }) {
  return <div className="production-record-compact-list">{items.map((record) => <div className={`production-task-compact-row${dueMeta(record.dueAt, record.status).overdue ? ' is-task-overdue' : ''}`} key={record.id}><button className="production-task-compact-open" onClick={() => onOpen(record)} type="button"><strong>{record.id}</strong><span>{record.title}</span><span className={`production-record-priority ${priorityClass(record.priority)}`}>{record.priority}</span><span className={`production-record-status ${statusClass(record.status)}`}>{record.status}</span><small>{record.team} · {record.assignee}</small><TaskDue record={record} compact /><ChevronRight size={15} /></button><TaskOwnershipButton record={record} onTake={onTake} busyTask={busyTask} /></div>)}</div>
}

function TaskCardList({ items, onOpen, onTake, busyTask }) {
  return <div className="production-record-card-list production-task-mobile-card-list">{items.map((record) => {
    const due = dueMeta(record.dueAt, record.status)
    return <article className={`production-record-card production-record-card-enhanced production-task-mobile-card${due.overdue ? ' is-task-overdue' : ''}`} key={record.id}>
      <button className="production-record-card-open production-task-mobile-card-open" type="button" onClick={() => onOpen(record)}>
        <span className={`production-record-card-icon ${record.source === 'project' ? 'is-project' : 'is-service-request'}`}><ListChecks size={18}/></span>
        <span className="production-record-card-copy">
          <strong>{record.id}</strong>
          <b>{record.title}</b>
          <small>{record.project ? `Project ${record.project.id}` : record.primaryRequest ? `Primary ${record.primaryRequest}` : 'Workflow task'} · {record.team || 'Unassigned'}</small>
        </span>
        <span className={`production-record-status ${statusClass(record.status)}`}>{record.status}</span>
        <span className="production-record-card-facts">
          <span><small>Priority</small><strong>{record.priority || 'Not set'}</strong></span>
          <span><small>Due</small><strong className={due.overdue ? 'is-overdue' : ''}>{due.label}</strong></span>
          <span><small>Assignee</small><strong>{record.assignee || 'Unassigned'}</strong></span>
        </span>
        <ChevronRight className="production-record-card-chevron" size={17} />
      </button>
      {taskCanBeTaken(record) ? <div className="production-task-mobile-card-action"><TaskOwnershipButton record={record} onTake={onTake} busyTask={busyTask} /></div> : null}
    </article>
  })}</div>
}

function TaskQueue() {
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS })
  const [viewStyle, setViewStyle] = useState(window.matchMedia?.('(max-width: 720px)').matches ? 'cards' : 'table')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(0)
  const [payload, setPayload] = useState({ items: [], total: 0, filters: {}, views: {}, viewer: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [mobileFilters, setMobileFilters] = useState(false)
  const [hiddenColumns, setHiddenColumns] = useState(['updated'])
  const [ownershipBusy, setOwnershipBusy] = useState('')
  const [ownershipError, setOwnershipError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize), scope: filters.scope })
    if (query.trim()) params.set('search', query.trim())
    for (const key of ['status', 'priority', 'team', 'assignee', 'service', 'source', 'due']) {
      if (filters[key] && filters[key] !== 'All') params.set(key, filters[key])
    }
    apiJson(`/api/v1/task-work-queue?${params}`)
      .then((next) => { if (active) setPayload(next) })
      .catch((loadError) => { if (active) setError(loadError.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [filters, page, pageSize, query, revision])

  const records = useMemo(() => (payload.items || []).map(taskRecord), [payload.items])
  const columns = COLUMNS.filter((column) => column.locked || !hiddenColumns.includes(column.key))
  const total = Number(payload.total || 0)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const renderedViewStyle = window.matchMedia?.('(max-width: 760px)').matches ? 'cards' : 'table'
  const changeFilters = (next) => { setFilters(next); setPage(0) }
  const clearFilters = () => { setFilters({ ...DEFAULT_FILTERS }); setPage(0) }
  const selectScope = (scope) => changeFilters({ ...DEFAULT_FILTERS, scope })
  const currentView = [...WORK_VIEWS, { id: 'all', label: 'All active' }, { id: 'completed', label: 'Completed' }].find((view) => view.id === filters.scope)
  const taskViews = [...WORK_VIEWS, { id: 'all', label: 'All active' }, { id: 'completed', label: 'Completed' }]
  const activeFilterCount = [
    query.trim(),
    filters.status !== 'All' ? filters.status : '',
    filters.priority !== 'All' ? filters.priority : '',
    filters.team !== 'All' ? filters.team : '',
    filters.assignee !== 'All' ? filters.assignee : '',
    filters.service !== 'All' ? filters.service : '',
    filters.source !== 'All' ? filters.source : '',
    filters.due !== 'All' ? filters.due : '',
  ].filter(Boolean).length

  async function takeTask(record) {
    if (!taskCanBeTaken(record) || ownershipBusy) return
    setOwnershipBusy(record.id)
    setOwnershipError('')
    try {
      await apiJson(`/api/v1/tasks/${encodeURIComponent(record.id)}/take`, { method: 'POST' })
      setRevision((value) => value + 1)
    } catch (takeError) {
      setOwnershipError(takeError.message)
      setRevision((value) => value + 1)
    } finally {
      setOwnershipBusy('')
    }
  }

  return <section className="production-task-experience production-record-shell production-motion-enter production-record-shell-enhanced">
    <main className="production-record-main">
      <div className="production-record-viewbar production-task-viewbar">
        <div className="production-record-view-pills" aria-label="Task quick views">
          {taskViews.map((view) => <button className={filters.scope === view.id ? 'is-active' : ''} key={view.id} onClick={() => selectScope(view.id)} type="button">{view.label}</button>)}
        </div>
        <button className="production-record-viewbar-filter" type="button" onClick={() => setMobileFilters(true)}><Filter size={15} />Filters{activeFilterCount > 0 ? <b>{activeFilterCount}</b> : null}</button>
      </div>

      {ownershipError ? <div className="production-task-ownership-error"><AlertTriangle size={15} /><span>{ownershipError}</span><button type="button" aria-label="Dismiss" onClick={() => setOwnershipError('')}><X size={14} /></button></div> : null}

      <div className="production-record-content">
        {loading ? <div className="production-record-state"><strong>Loading tasks…</strong><span>Checking your current fulfilment queues.</span></div> : null}
        {!loading && error ? <div className="production-record-state is-error"><strong>Could not load this queue</strong><span>{error}</span><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></div> : null}
        {!loading && !error && !records.length ? <div className="production-record-state"><strong>No tasks in {currentView?.label || 'this view'}</strong><span>{filters.scope === 'project' && !(payload.filters?.sources || []).includes('project') ? 'Project tasks require Projects: View permission. Ask an administrator to check your role.' : filters.scope === 'project' ? 'No active project tasks match these filters. Completed tasks are in the Completed view.' : 'Check My Tasks, Project Tasks or All active, or adjust filters to see more work.'}</span></div> : null}
        {!loading && !error && records.length ? <div className="production-motion-enter production-motion-enter-fast">{renderedViewStyle === 'cards' ? <TaskCardList items={records} onOpen={(record) => navigate(`/tasks/${encodeURIComponent(record.id)}`)} onTake={takeTask} busyTask={ownershipBusy} /> : <TaskTable items={records} columns={columns} onOpen={(record) => navigate(`/tasks/${encodeURIComponent(record.id)}`)} onTake={takeTask} busyTask={ownershipBusy} />}</div> : null}
      </div>

      <footer className="production-record-pagination"><label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0) }}>{PAGE_SIZES.map((size) => <option key={size}>{size}</option>)}</select></label><span>Page {Math.min(page + 1, pageCount)} of {pageCount}</span><div><button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} type="button"><ChevronLeft size={15} /></button><button disabled={page >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} type="button"><ChevronRight size={15} /></button></div></footer>
    </main>

    {mobileFilters ? <><button className="production-record-filter-backdrop" aria-label="Close filters" type="button" onClick={() => setMobileFilters(false)} /><aside className="production-record-mobile-filter production-motion-drawer"><header><div><span>Queue filters</span><strong>Tasks</strong></div><button type="button" onClick={() => setMobileFilters(false)}><X size={17} /></button></header><TaskFilters payload={payload} filters={filters} onChange={changeFilters} onClear={clearFilters} query={query} onQueryChange={(value) => { setQuery(value); setPage(0) }} /></aside></> : null}
  </section>
}

function Field({ label, children, hint }) {
  return <label className="activity-canvas-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>
}

function InspectorRow({ label, value, meta, onClick }) {
  return <button type="button" className="activity-canvas-inspector-row" onClick={onClick}><span><small>{label}</small><strong>{value || 'Not recorded'}</strong>{meta ? <em>{meta}</em> : null}</span><ChevronRight size={17} /></button>
}

function TaskDetail({ taskKey }) {
  const [task,setTask] = useState(null)
  const [directory,setDirectory] = useState({people:[],teams:[]})
  const [parentRequest,setParentRequest] = useState(null)
  const [team,setTeam] = useState('')
  const [assignee,setAssignee] = useState('Unassigned')
  const [completionNotes,setCompletionNotes] = useState('')
  const [completionOpen,setCompletionOpen] = useState(false)
  const [loading,setLoading] = useState(true)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')

  async function load(quiet = false) {
    if(!quiet)setLoading(true)
    try {
      const next=await apiJson(`/api/v1/tasks/${encodeURIComponent(taskKey)}`)
      const [options,parent]=await Promise.all([
        apiJson('/api/v1/assignment/options?recordType=Service%20Request').catch(()=>({people:[],teams:[]})),
        next.primaryRequest?.id ? apiJson(`/api/v1/service-requests/${encodeURIComponent(next.primaryRequest.id)}`).catch(()=>null) : null,
      ])
      setTask(next);setDirectory(options||{people:[],teams:[]});setParentRequest(parent)
      setTeam(next.team||'');setAssignee(next.assignee||'Unassigned')
      setCompletionNotes(next.completionNotes||'')
      setError('')
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{void load()},[taskKey])
  async function patch(body,message) {
    if(saving)return false
    setSaving(true);setError('');setNotice('')
    try {
      await apiJson(`/api/v1/tasks/${encodeURIComponent(taskKey)}`,{method:'PATCH',body:JSON.stringify(body)})
      await load(true)
      setCompletionOpen(false)
      setNotice(message||'Task updated')
      return true
    }catch(e){setError(e.message);return false}
    finally{setSaving(false)}
  }
  async function ownership(action,message) {
    if(saving)return
    setSaving(true);setError('');setNotice('')
    try {
      await apiJson(`/api/v1/tasks/${encodeURIComponent(taskKey)}/${action}`,{method:'POST'})
      await load(true)
      setNotice(message)
    }catch(e){setError(e.message)}finally{setSaving(false)}
  }
  async function saveNote(note) {
    if(saving)return false
    setSaving(true);setError('');setNotice('')
    try {
      await apiJson(`/api/v1/tasks/${encodeURIComponent(taskKey)}/notes`,{method:'POST',body:JSON.stringify(note)})
      await load(true)
      setNotice(note.visibility==='customer'?'Customer update sent to the parent request.':'Task note added to the parent request.')
      return true
    }catch(e){setError(e.message);return false}
    finally{setSaving(false)}
  }
  if(loading)return <section className="task-record-loading">Loading task details…</section>
  if(!task)return <section className="task-record-loading" role="alert">{error||'Task not found.'}<button type="button" onClick={()=>void load()}>Retry</button></section>
  const parent=task.primaryRequest||{}
  const completed=task.status==='Completed'
  const user=readSession()
  const unassigned=!task.assignee||task.assignee==='Unassigned'
  const isMine=!unassigned && Boolean(
    (task.assigneeEmail&&user.email&&task.assigneeEmail.toLowerCase()===String(user.email).toLowerCase())
    || (task.assignee&&user.name&&task.assignee===user.name)
  )
  const teams=directory.teams||[]
  const people=directory.people||[]
  const selectedTeam=teams.find(item=>item.name===team)||null
  const selectedAssignee=people.find(item=>item.name===assignee)||null
  const events=(parentRequest?.activities||[]).filter(item=>item.metadata?.taskKey===task.id).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))
  const parentTasks=parentRequest?.requestTasks||[]
  const completedCount=parentTasks.filter(item=>item.status==='Completed').length
  const assignmentChanged=team!==(task.team||'')||assignee!==(task.assignee||'Unassigned')
  const approvers=parentRequest?.requestApprovals||[]
  const pending=approvers.filter(item=>item.status==='Pending').length
  const blocked=task.status==='Blocked'
  const matchPerson=(a,b)=>Boolean(a&&b&&((a.id&&a.id===b.id)||(a.email&&b.email&&a.email.toLowerCase()===b.email.toLowerCase())||(a.name&&a.name===b.name)))
  const changeTeam=(value)=>{
    setTeam(value?.name||'')
    if(!value||(selectedAssignee&&!(value.members||[]).some(person=>matchPerson(person,selectedAssignee))))setAssignee('Unassigned')
  }
  const changePerson=(value)=>{
    setAssignee(value?.name||'Unassigned')
    if(!value)return
    const compatible=teams.find(item=>(item.members||[]).some(person=>matchPerson(person,value)))
    if(compatible&&!((selectedTeam?.members)||[]).some(person=>matchPerson(person,value)))setTeam(compatible.name)
  }
  const left=<>
    <h2>Task information</h2>
    <TaskRailField label="Status"><strong className="task-record-status">{task.status}</strong></TaskRailField>
    <TaskRailField label="Assigned team"><Hi5EntityTypeahead items={teams} value={selectedTeam} disabled={saving||completed} onSelect={changeTeam} placeholder="Search teams…" minimumCharacters={2} getSearchText={item=>item.name||''} getMeta={item=>`${(item.members||[]).length} technicians`}/></TaskRailField>
    <TaskRailField label="Technician"><Hi5EntityTypeahead items={selectedTeam?.members||people} value={selectedAssignee} disabled={saving||completed} onSelect={changePerson} placeholder="Search technicians…" minimumCharacters={2}/></TaskRailField>
    {assignmentChanged?<div className="task-record-rail-actions"><button type="button" disabled={saving||completed} onClick={()=>void patch({team,assignee},'Assignment saved')}>Save assignment</button></div>:null}
    <div className="task-record-rail-actions">
      {task.status==='Ready'&&unassigned?<button type="button" disabled={saving} onClick={()=>void ownership('take','Task assigned to you')}><UserPlus size={14}/>Take task</button>:null}
      {task.status==='Ready'&&isMine?<button type="button" disabled={saving} onClick={()=>void ownership('release','Task returned to team queue')}><UserMinus size={14}/>Release</button>:null}
      {!completed?<><button type="button" disabled={!isMine||saving} onClick={()=>void patch({status:'In Progress'},'Task started')}><PlayCircle size={14}/>Start</button><button type="button" disabled={!isMine||saving} onClick={()=>void patch({status:'Blocked'},'Task blocked')}><CircleStop size={14}/>Block</button><button type="button" className="is-primary" disabled={!isMine||saving} onClick={()=>setCompletionOpen(v=>!v)}><CheckCircle2 size={14}/>Complete</button></>:null}
    </div>
    {completionOpen&&!completed?<div className="task-record-rail-section"><h3>Completion notes</h3><TaskRailField label="Required to complete fulfilment"><textarea rows={4} value={completionNotes} onChange={e=>setCompletionNotes(e.target.value)} placeholder="Record the outcome before completing the task…" /></TaskRailField><button className="task-record-action is-primary" type="button" disabled={!isMine||saving||!completionNotes.trim()} onClick={()=>void patch({status:'Completed',completionNotes},'Task completed. The parent request and its next workflow step were updated.')}><CheckCircle2 size={14}/>Confirm completion</button></div>:null}
    {completed?<div className="task-record-rail-section task-record-completed"><CheckCircle2 size={15}/>Completed {task.completedAt?formatDate(task.completedAt):''}</div>:null}
    {task.instructions?<div className="task-record-rail-section"><h3>Instructions</h3><p>{task.instructions}</p></div>:null}
  </>
  const context=<>
    <TaskContextField label="Request status" value={parentRequest?.status||parent.status}/>
    <TaskContextField label="Requester" value={parent.requester}/>
    <TaskContextField label="Service" value={parent.service}/>
    <TaskContextField label="Priority" value={parent.priority}/>
    <TaskContextField label="Fulfilment progress" value={parentTasks.length?`${completedCount} of ${parentTasks.length} completed`:'No progress data'}/>
    <TaskContextField label="Approvals outstanding" value={pending}/>
    <TaskContextField label="Due" value={task.dueAt?formatDate(task.dueAt):'Not set'}/>
    <TaskContextField label="Prerequisites" value={task.dependencies?.length?task.dependencies.join(', '):'None'}/>
    {completed&&parentRequest?.status==='Completed'?<div className="task-record-rail-section"><h3>Fulfilment complete</h3><p>The parent Service Request is marked Completed and can proceed to Closed through its workflow.</p></div>:null}
  </>
  const details=<>
    <h2>Fulfilment instructions</h2>
    <p>{task.instructions||'No additional instructions were provided.'}</p>
    {task.completionNotes?<div className="task-record-rail-section"><h3>Recorded outcome</h3><p>{task.completionNotes}</p></div>:null}
    <div className="task-record-rail-section"><h3>Workflow</h3><p>Task completion unlocks any dependent tasks. Once all required tasks are complete, the parent request advances to Completed, ready for closure.</p></div>
  </>
  return <TaskWorkbenchFrame
    taskId={task.id} title={task.title} status={task.status} priority={parent.priority}
    parentId={parent.id} parentTitle={parent.title} parentType="Service Request"
    onBack={()=>navigate('/tasks')} onOpenParent={()=>navigate(`/requests/${encodeURIComponent(parent.id)}`)}
    onRefresh={()=>void load(true)} left={left} details={details}
    activity={<TaskActivityFeed taskId={taskKey} events={events} busy={saving} onSave={saveNote} allowCustomer/>}
    context={context} alert={error} notice={notice}
  />
}

export function ProductionTaskExperience() {
  const [taskRoute, setTaskRoute] = useState(() => routeFromPath())
  const targets = useWorkspaceTargets(taskRoute)

  useEffect(() => {
    const update = () => setTaskRoute(routeFromPath())
    window.addEventListener('popstate', update)
    window.addEventListener('hi5-routechange', update)
    const timer = window.setInterval(update, 250)
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('hi5-routechange', update); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const node = targets.content
    if (!(node instanceof HTMLElement) || !taskRoute) return undefined
    node.classList.add('production-task-mounted')
    return () => node.classList.remove('production-task-mounted')
  }, [targets.content, taskRoute])

  return <>
    <TaskNavButton target={targets.nav} />
    <AwaitingApprovalButton target={targets.approvalTarget} statusSelect={targets.approvalSelect} />
    {taskRoute && targets.content ? createPortal(taskRoute.kind === 'detail' ? (/^PRJ-\d+-T\d+$/i.test(taskRoute.taskKey) ? <ProjectTaskDetail key={taskRoute.taskKey} taskKey={taskRoute.taskKey} onNavigate={navigate} /> : <TaskDetail key={taskRoute.taskKey} taskKey={taskRoute.taskKey} />) : <TaskQueue />, targets.content) : null}
  </>
}
