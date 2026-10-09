import { hasPermission } from './access.js'
import { pool } from './db.js'

// A single read model over two authoritative task tables. Updates continue to
// use their native endpoints and are never replicated into another task table.
const validScopes = new Set(['mine','team','unassigned','blocked','all','completed'])
const validStatuses = new Set(['Ready','In Progress','Blocked','Completed','Backlog','To Do','Done'])
const validDue = new Set(['Overdue','Next 24 hours','Next 7 days','No due date'])
const validSources = new Set(['All','service-request','project'])
const clean = (value, max=160) => String(value ?? '').trim().slice(0,max)

const baseSql = (allowProjects) => `
WITH queue AS (
  SELECT
    'service-request'::text AS source,
    t.external_key AS id, t.title, t.status, r.priority,
    COALESCE(r.requester_snapshot->>'name','') AS requester,
    COALESCE(r.service, 'Service Request') AS service,
    COALESCE(team.name,t.team_snapshot->>'name','Unassigned') AS team,
    COALESCE(assignee.name,t.assignee_snapshot->>'name','Unassigned') AS assignee,
    COALESCE(assignee.email,t.assignee_snapshot->>'email','') AS assignee_email,
    t.team_id, t.assignee_person_id,
    t.due_at, t.updated_at,
    r.reference AS parent_id, r.title AS parent_title,
    (t.status = 'Completed') AS is_complete,
    (t.status = 'Blocked') AS is_blocked
  FROM service_request_tasks t
  JOIN service_requests r ON r.id=t.request_id AND r.tenant_id=t.tenant_id
  LEFT JOIN organisation_teams team ON team.id=t.team_id
  LEFT JOIN organisation_people assignee ON assignee.id=t.assignee_person_id
  WHERE t.tenant_id=$1 AND (
    t.status='Completed' OR
    (t.status IN ('Ready','In Progress','Blocked')
     AND r.status NOT IN ('Pending Approval','Rejected','Closed')
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(COALESCE(t.dependencies,'[]'::jsonb)) dep(task_key)
       LEFT JOIN service_request_tasks prev ON prev.request_id=t.request_id AND prev.external_key=dep.task_key
       WHERE prev.id IS NULL OR prev.status<>'Completed'
     ))
  )
  UNION ALL
  SELECT
    'project'::text AS source,
    t.external_key AS id, t.title, t.status, t.priority,
    ''::text AS requester, 'Project'::text AS service,
    COALESCE(team.name,p.team_snapshot->>'name','Unassigned') AS team,
    COALESCE(assignee.name,t.assignee_snapshot->>'name','Unassigned') AS assignee,
    COALESCE(assignee.email,t.assignee_snapshot->>'email','') AS assignee_email,
    p.team_id, t.assignee_person_id,
    ((t.due_date::timestamp + interval '1 day' - interval '1 second') AT TIME ZONE 'UTC') AS due_at,
    t.updated_at, p.reference AS parent_id, p.name AS parent_title,
    (t.status = 'Done') AS is_complete,
    (t.status = 'Blocked') AS is_blocked
  FROM project_tasks t
  JOIN projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id
  LEFT JOIN organisation_teams team ON team.id=p.team_id
  LEFT JOIN organisation_people assignee ON assignee.id=t.assignee_person_id
  WHERE t.tenant_id=$1
    AND ${allowProjects ? "p.status<>'Cancelled' AND (p.status<>'Complete' OR t.status='Done')" : 'FALSE'}
)`

export async function unifiedTaskQueue(session, query, viewer) {
  const tenantId = session.tenant_id
  const allowProjects = hasPermission(session.access, 'projects.view')
  const scope = clean(query('scope') || 'team',30).toLowerCase()
  if (!validScopes.has(scope)) return { error: 'Unsupported task queue view.' }
  const status = clean(query('status'),40)
  if (status && status!=='All' && !validStatuses.has(status)) return { error: 'Unsupported task status.' }
  const due = clean(query('due'),40)
  if (due && due!=='All' && !validDue.has(due)) return { error: 'Unsupported due-date filter.' }
  const source = clean(query('source')||'All',40)
  if (!validSources.has(source)) return { error: 'Unsupported task source filter.' }

  const teamIds = Array.isArray(viewer?.team_ids) ? viewer.team_ids : []
  const values = [tenantId, viewer?.id || null, teamIds]
  const where = [scope==='completed' ? 'q.is_complete' : 'NOT q.is_complete']
  if (scope==='mine') where.push('q.assignee_person_id=$2::uuid')
  if (scope==='team') where.push('q.team_id=ANY($3::uuid[])')
  if (scope==='unassigned') where.push('q.assignee_person_id IS NULL')
  if (scope==='blocked') where.push('q.is_blocked')
  const add = (fragment, value) => {
    values.push(value)
    where.push(fragment.replaceAll('?', '$'+values.length))
  }
  if (status && status!=='All') add('q.status=?',status)
  if (source!=='All') add('q.source=?',source)
  const search = clean(query('search'),200)
  if (search) add("(q.id ILIKE '%'||?||'%' OR q.title ILIKE '%'||?||'%' OR q.parent_id ILIKE '%'||?||'%' OR q.parent_title ILIKE '%'||?||'%')",search)
  const priority = clean(query('priority'),40)
  if (priority && priority!=='All') add('q.priority=?',priority)
  const team = clean(query('team'))
  if (team && team!=='All') team==='Unassigned' ? where.push("q.team='Unassigned'") : add('q.team=?',team)
  const assignee = clean(query('assignee'))
  if (assignee && assignee!=='All') assignee==='Unassigned' ? where.push('q.assignee_person_id IS NULL') : add('q.assignee=?',assignee)
  const service = clean(query('service'))
  if (service && service!=='All') add('q.service=?',service)
  if (due==='Overdue') where.push('q.due_at IS NOT NULL AND q.due_at<now()')
  if (due==='Next 24 hours') where.push("q.due_at>=now() AND q.due_at<now()+interval '24 hours'")
  if (due==='Next 7 days') where.push("q.due_at>=now() AND q.due_at<now()+interval '7 days'")
  if (due==='No due date') where.push('q.due_at IS NULL')

  const sql = baseSql(allowProjects)
  const selection = where.join(' AND ')
  const limit = Math.max(1,Math.min(200,Number(query('limit')||50)||50))
  const offset = Math.max(0,Math.floor(Number(query('offset')||0)||0))
  // Do not paginate each source independently: this is one sorted queue.
  const [page,count,aggregates] = await Promise.all([
    pool.query(`${sql}
      SELECT q.* FROM queue q WHERE ${selection}
      ORDER BY
        CASE WHEN NOT q.is_complete AND q.due_at<now() THEN 0 ELSE 1 END,
        CASE q.status WHEN 'In Progress' THEN 0 WHEN 'Ready' THEN 1 WHEN 'To Do' THEN 2 WHEN 'Backlog' THEN 3 WHEN 'Blocked' THEN 4 ELSE 5 END,
        q.due_at NULLS LAST, q.updated_at DESC, q.id
      LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,limit,offset]),
    pool.query(`${sql} SELECT count(*)::int total FROM queue q WHERE ${selection}`,values),
    pool.query(`${sql}
      SELECT
        count(*) FILTER (WHERE NOT is_complete)::int AS all,
        count(*) FILTER (WHERE NOT is_complete AND assignee_person_id=$2::uuid)::int AS mine,
        count(*) FILTER (WHERE NOT is_complete AND team_id=ANY($3::uuid[]))::int AS team,
        count(*) FILTER (WHERE NOT is_complete AND assignee_person_id IS NULL)::int AS unassigned,
        count(*) FILTER (WHERE NOT is_complete AND is_blocked)::int AS blocked,
        count(*) FILTER (WHERE NOT is_complete AND due_at<now())::int AS overdue,
        count(*) FILTER (WHERE is_complete)::int AS completed,
        array_remove(array_agg(DISTINCT status),NULL) AS statuses,
        array_remove(array_agg(DISTINCT priority),NULL) AS priorities,
        array_remove(array_agg(DISTINCT team),NULL) AS teams,
        array_remove(array_agg(DISTINCT assignee),NULL) AS assignees,
        array_remove(array_agg(DISTINCT service),NULL) AS services
      FROM queue`,[tenantId,viewer?.id||null,teamIds]),
  ])
  const totals = aggregates.rows[0]||{}
  return {
    items:page.rows.map(row=>({
      id:row.id,taskKey:row.id,source:row.source,
      title:row.title,status:row.status,
      priority:row.priority,team:row.team,assignee:row.assignee,
      assigneeEmail:row.assignee_email,dueAt:row.due_at,updatedAt:row.updated_at,
      ...(row.source==='project'
        ? {project:{id:row.parent_id,name:row.parent_title}}
        : {primaryRequest:{id:row.parent_id,title:row.parent_title,priority:row.priority,service:row.service,requester:row.requester}}),
    })),
    total:Number(count.rows[0]?.total||0),
    viewer:{
      personId:viewer?.external_key||'',name:viewer?.name||session.name||'',
      email:viewer?.email||session.email||'',teams:Array.isArray(viewer?.team_names)?viewer.team_names:[],
    },
    views:Object.fromEntries(['mine','team','unassigned','blocked','overdue','all','completed'].map(key=>[key,Number(totals[key]||0)])),
    filters:{
      statuses:totals.statuses||[],priorities:totals.priorities||[],
      teams:totals.teams||[],assignees:totals.assignees||[],
      services:totals.services||[],
      sources:allowProjects?['service-request','project']:['service-request'],
      due:['Overdue','Next 24 hours','Next 7 days','No due date'],
    },
  }
}
