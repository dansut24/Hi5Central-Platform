import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, PlayCircle, Save } from 'lucide-react'
import { TaskWorkbenchFrame, TaskActivityFeed, TaskContextField, TaskRailField } from './ProductionTaskWorkbench.jsx'

const API_BASE=window.__HI5_API_BASE__
const statuses=['Backlog','To Do','In Progress','Blocked','Done']
const priorities=['Low','Medium','High','Critical']
const dateValue=value=>value?String(value).slice(0,10):''
async function apiJson(path,options={}) {
  const response=await fetch(`${API_BASE}${path}`,{credentials:'include',cache:'no-store',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}})
  const result=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(result.error || `Request failed (${response.status})`)
  return result
}
export function ProjectTaskDetail({taskKey,onNavigate}) {
  const projectId=taskKey.replace(/-T\d+$/i,'')
  const [project,setProject]=useState(null)
  const [draft,setDraft]=useState(null)
  const [completionNote,setCompletionNote]=useState('')
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const load=async(quiet=false)=>{
    if(!quiet)setLoading(true)
    try {
      const next=await apiJson(`/api/v1/projects/${encodeURIComponent(projectId)}`)
      const task=(next.tasks||[]).find(item=>item.id.toUpperCase()===taskKey.toUpperCase())
      if(!task)throw new Error('Project task not found.')
      setProject(next)
      setDraft({status:task.status,priority:task.priority,assigneeId:task.assigneeId||'',dueDate:dateValue(task.dueDate),title:task.title})
      setError('')
    } catch(e) {setError(e.message)}
    finally{setLoading(false)}
  }
  useEffect(()=>{void load()},[taskKey])
  const task=useMemo(()=>(project?.tasks||[]).find(item=>item.id.toUpperCase()===taskKey.toUpperCase()),[project,taskKey])
  const events=useMemo(()=>(project?.activity||[]).filter(item=>item.metadata?.taskId===taskKey).map(item=>({
    ...item,text:item.action,html:item.metadata?.richHtml,visibility:'internal',
  })).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)),[project,taskKey])
  const isCompleting=Boolean(task && draft?.status==='Done' && task.status!=='Done')
  const changed=Boolean(task&&draft&&(draft.title!==task.title||draft.status!==task.status||draft.priority!==task.priority||draft.assigneeId!==(task.assigneeId||'')||draft.dueDate!==dateValue(task.dueDate)))
  async function save() {
    if(!task||saving||!draft||!changed||!draft.title.trim())return
    if(isCompleting&&!completionNote.trim()){setError('A completion note is required before finishing this task.');return}
    setSaving(true);setError('');setNotice('')
    try {
      await apiJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}`,{
        method:'PATCH',body:JSON.stringify({...draft,...(isCompleting?{completionNotes:completionNote.trim()}:{})}),
      })
      await load(true)
      setCompletionNote('')
      setNotice(isCompleting?'Task completed. Project progress and activity are updated.':'Project task updated.')
    }catch(e){setError(e.message)}finally{setSaving(false)}
  }
  async function saveNote(note) {
    setSaving(true);setError('');setNotice('')
    try {
      await apiJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/notes`,{method:'POST',body:JSON.stringify(note)})
      await load(true)
      setNotice('Note added to the task and project activity.')
      return true
    }catch(e){setError(e.message);return false}
    finally{setSaving(false)}
  }
  if(loading)return <section className="task-record-loading">Loading project task…</section>
  if(!project||!task||!draft)return <section className="task-record-loading" role="alert">{error||'Project task not found.'}<button type="button" onClick={()=>void load()}>Retry</button></section>
  const done=(project.tasks||[]).filter(item=>item.status==='Done').length
  const left=<>
    <h2>Task information</h2>
    <TaskRailField label="Title"><input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></TaskRailField>
    <TaskRailField label="Status"><select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value})}>{statuses.map(item=><option key={item}>{item}</option>)}</select></TaskRailField>
    <TaskRailField label="Priority"><select value={draft.priority} onChange={e=>setDraft({...draft,priority:e.target.value})}>{priorities.map(item=><option key={item}>{item}</option>)}</select></TaskRailField>
    <TaskRailField label="Assignee"><select value={draft.assigneeId} onChange={e=>setDraft({...draft,assigneeId:e.target.value})}><option value="">Unassigned</option>{(project.members||[]).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></TaskRailField>
    <TaskRailField label="Due date"><input type="date" value={draft.dueDate} onChange={e=>setDraft({...draft,dueDate:e.target.value})}/></TaskRailField>
    {isCompleting?<div className="task-record-rail-section"><h3><ClipboardCheck size={15}/> Completion notes</h3><TaskRailField label="Required for completion"><textarea rows={4} value={completionNote} onChange={e=>setCompletionNote(e.target.value)} placeholder="What was completed? Include the outcome." /></TaskRailField></div>:null}
    <div className="task-record-rail-actions"><button type="button" className="is-primary" onClick={()=>void save()} disabled={!changed||saving||!draft.title.trim()||(isCompleting&&!completionNote.trim())}><Save size={14}/>{saving?'Saving…':isCompleting?'Complete task':'Save changes'}</button></div>
    {task.status==='Done'?<div className="task-record-completed"><CheckCircle2 size={16}/>Completed · {task.completedAt?new Date(task.completedAt).toLocaleDateString('en-GB'):'Done'}</div>:null}
  </>
  const context=<>
    <TaskContextField label="Project status" value={project.status}/>
    <TaskContextField label="Project team" value={project.team}/>
    <TaskContextField label="Project owner" value={project.owner}/>
    <TaskContextField label="Project progress" value={`${done} of ${project.tasks.length} tasks completed`}/>
    <TaskContextField label="Target date" value={project.targetDate}/>
    <TaskContextField label="Planned work" value={`${task.plannedHours||0} hours`}/>
    <TaskContextField label="Dependencies" value={task.dependsOn?.length?task.dependsOn.join(', '):'None'}/>
    {task.linkedRecord?<TaskContextField label="Linked ITSM record" value={task.linkedRecord}/>:null}
  </>
  return <TaskWorkbenchFrame
    taskId={taskKey} title={task.title} status={task.status} priority={task.priority}
    parentId={project.id} parentTitle={project.name} parentType="Project"
    onBack={()=>onNavigate('/tasks')} onOpenParent={()=>onNavigate(`/projects/${encodeURIComponent(projectId)}`)}
    onRefresh={()=>void load(true)} left={left}
    details={<><h2>Task details</h2><p>{project.description||'No additional project description.'}</p><p>This task contributes to the parent project's progress and linked milestones.</p></>}
    activity={<TaskActivityFeed taskId={taskKey} events={events} busy={saving} onSave={saveNote}/>}
    context={context} alert={error} notice={notice}
  />
}
