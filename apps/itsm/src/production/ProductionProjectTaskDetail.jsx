import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, ExternalLink, RefreshCw, Save, Users } from 'lucide-react'
import './ProductionProjectTaskDetail.css'

const API_BASE = window.__HI5_API_BASE__
const statuses = ['Backlog','To Do','In Progress','Blocked','Done']
const priorities = ['Low','Medium','High','Critical']
const dateValue = value => value ? String(value).slice(0,10) : ''
async function apiJson(path,options={}) {
  const response = await fetch(`${API_BASE}${path}`,{
    credentials:'include',cache:'no-store',...options,
    headers:{...(options.body ? {'Content-Type':'application/json'} : {}),...(options.headers||{})},
  })
  const value = await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(value.error || `Request failed (${response.status})`)
  return value
}
export function ProjectTaskDetail({taskKey,onNavigate}) {
  const projectId = taskKey.replace(/-T\d+$/i,'')
  const [project,setProject] = useState(null)
  const [draft,setDraft] = useState(null)
  const [loading,setLoading] = useState(true)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  async function load(quiet=false) {
    if(!quiet)setLoading(true)
    setError('')
    try{
      const next=await apiJson(`/api/v1/projects/${encodeURIComponent(projectId)}`)
      const task=(next.tasks||[]).find(item=>item.id.toUpperCase()===taskKey.toUpperCase())
      if(!task)throw new Error('Project task not found.')
      setProject(next)
      setDraft({status:task.status,priority:task.priority,assigneeId:task.assigneeId||'',dueDate:dateValue(task.dueDate),title:task.title})
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{void load()},[taskKey])
  const task=(project?.tasks||[]).find(item=>item.id.toUpperCase()===taskKey.toUpperCase())
  async function save() {
    if(!task || saving || !draft)return
    setSaving(true);setError('');setNotice('')
    try{
      await apiJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}`,{
        method:'PATCH',body:JSON.stringify(draft),
      })
      await load(true)
      setNotice('Project task saved. The Project board and Tasks queue use the same record.')
    }catch(e){setError(e.message)}
    finally{setSaving(false)}
  }
  const changed=Boolean(task && draft && (
    draft.title!==task.title||draft.status!==task.status||draft.priority!==task.priority||
    draft.assigneeId!==(task.assigneeId||'')||draft.dueDate!==dateValue(task.dueDate)
  ))
  return <section className="production-task-experience project-task-detail production-motion-enter">
    <nav className="task-detail-breadcrumbs" aria-label="Breadcrumb">
      <button type="button" onClick={()=>onNavigate('/tasks')}><ArrowLeft size={14}/> Tasks</button>
      <span> / </span><strong>{taskKey}</strong>
    </nav>
    {loading?<div className="production-record-state"><strong>Loading project task…</strong></div>:null}
    {error?<div className="activity-canvas-banner is-error" role="alert"><AlertTriangle size={16}/>{error}<button type="button" onClick={()=>void load()}>Retry</button></div>:null}
    {notice?<div className="activity-canvas-banner is-success"><CheckCircle2 size={16}/>{notice}</div>:null}
    {task&&project&&draft?<div className="project-task-detail-workspace">
      <div className="project-task-detail-heading">
        <span className="project-task-detail-icon"><ClipboardList size={20}/></span>
        <div><small>Project task · {task.id}</small><h1>{task.title}</h1><p>{project.name} · {project.id}</p></div>
        <button type="button" onClick={()=>void load(true)} title="Refresh task"><RefreshCw size={16}/></button>
      </div>
      <div className="project-task-detail-grid">
        <section className="project-task-detail-main">
          <h2>Task details</h2>
          <label>Title<input value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
          <div className="project-task-detail-fields">
            <label>Status<select value={draft.status} onChange={event=>setDraft({...draft,status:event.target.value})}>{statuses.map(x=><option key={x}>{x}</option>)}</select></label>
            <label>Priority<select value={draft.priority} onChange={event=>setDraft({...draft,priority:event.target.value})}>{priorities.map(x=><option key={x}>{x}</option>)}</select></label>
            <label>Assignee<select value={draft.assigneeId} onChange={event=>setDraft({...draft,assigneeId:event.target.value})}><option value="">Unassigned</option>{(project.members||[]).map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
            <label>Due date<input type="date" value={draft.dueDate} onChange={event=>setDraft({...draft,dueDate:event.target.value})}/></label>
          </div>
          <div className="project-task-detail-save"><button type="button" disabled={!changed||!draft.title.trim()||saving} onClick={()=>void save()}><Save size={15}/>{saving?'Saving…':'Save task'}</button></div>
        </section>
        <aside className="project-task-detail-context">
          <h2>Project context</h2>
          <div><span>Project</span><strong>{project.name}</strong><small>{project.id}</small></div>
          <div><span>Team</span><strong>{project.team||'Unassigned'}</strong></div>
          <div><span>Assigned to</span><strong>{task.assignee||'Unassigned'}</strong></div>
          <div><span>Planned hours</span><strong>{task.plannedHours||0}h</strong></div>
          <div><span>Dependency</span><strong>{task.dependsOn?.length?task.dependsOn.join(', '):'None'}</strong></div>
          {task.linkedRecord?<div><span>Linked ITSM record</span><strong>{task.linkedRecord}</strong></div>:null}
          <div><span>Project progress</span><strong>{(project.tasks||[]).filter(x=>x.status==='Done').length} / {(project.tasks||[]).length} tasks done</strong></div>
          <p><Users size={15}/> Updates are saved directly to the project, without duplicating task records.</p>
        </aside>
      </div>
    </div>:null}
  </section>
}
