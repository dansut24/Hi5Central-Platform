/**
 * Read-only Admin Centre release-worker audit.
 * Timestamps come from PostgreSQL queue and per-attempt events, not Docker logs.
 * Caller must require Hi5Central platform admin authentication.
 */
const statuses=new Set(['pending','scheduled','deferred','running','succeeded','failed','rolled_back','cancelled'])
const environments=new Set(['test','uat','live'])
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const clamp=(v,fallback,max)=>{
  const n=Number(v)
  return Number.isInteger(n)&&n>=0?Math.min(n,max):fallback
}
export function auditFilters(query={}){
  const tenant=String(query.tenant||'').trim()
  const status=String(query.status||'').trim()
  const environment=String(query.environment||'').trim()
  if(tenant&&!/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenant))
    throw new Error('Invalid tenant slug.')
  if(status&&!statuses.has(status))throw new Error('Invalid worker status.')
  if(environment&&!environments.has(environment))throw new Error('Invalid environment.')
  return {tenant,status,environment,limit:Math.max(1,clamp(query.limit,50,100)),offset:clamp(query.offset,0,100000)}
}
export async function readWorkerDeployments(db,input={}){
  const f=auditFilters(input)
  const statement=[
    'SELECT j.id,j.tenant_id,t.slug AS tenant_slug,t.company_name,j.environment,',
    'j.build_sha,j.previous_build_sha,j.release_ref,j.status,j.scheduled_at,',
    'j.created_at,j.completed_at,j.updated_at,j.attempt_count,j.max_attempts,',
    'j.lease_fence,j.lease_expires_at,j.last_error,',
    'n.version_label,n.title AS release_title,',
    'started.occurred_at AS started_at,finished.occurred_at AS finished_at,',
    "started.details ->> 'operator' AS worker_name,",
    "COALESCE(finished.details ->> 'snapshot','') AS snapshot,",
    'CASE WHEN started.occurred_at IS NULL THEN NULL ELSE',
    'ROUND(EXTRACT(EPOCH FROM (COALESCE(finished.occurred_at,',
    "CASE WHEN j.status='running' THEN now() ELSE j.completed_at END,",
    'j.updated_at) - started.occurred_at))*1000)::bigint END AS duration_ms,',
    'CASE WHEN started.occurred_at IS NULL THEN NULL ELSE',
    'ROUND(EXTRACT(EPOCH FROM (started.occurred_at-j.scheduled_at))*1000)::bigint',
    'END AS queue_delay_ms,count(*) OVER()::int AS total',
    'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
    'LEFT JOIN hi5central_published_release_notes n ON n.build_sha=j.build_sha',
    'LEFT JOIN LATERAL (SELECT e.occurred_at,e.details,e.fence',
    'FROM tenant_release_rollout_events e',
    "WHERE e.job_id=j.id AND e.event_type='claimed'",
    'ORDER BY e.fence DESC,e.occurred_at DESC,e.id DESC LIMIT 1) started ON true',
    'LEFT JOIN LATERAL (SELECT e.occurred_at,e.details',
    'FROM tenant_release_rollout_events e',
    "WHERE e.job_id=j.id AND e.fence=started.fence AND e.event_type",
    "IN ('verified','failed','rolled_back','cancelled')",
    'ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) finished ON true',
    'WHERE ($1::text IS NULL OR t.slug=$1)',
    'AND ($2::text IS NULL OR j.status=$2)',
    'AND ($3::text IS NULL OR j.environment=$3)',
    'ORDER BY j.created_at DESC,j.id DESC LIMIT $4 OFFSET $5',
  ].join(' ')
  const result=await db.query(statement,[
    f.tenant||null,f.status||null,f.environment||null,f.limit,f.offset])
  return {items:result.rows.map(({total,...row})=>({
    ...row,duration_ms:row.duration_ms==null?null:Number(row.duration_ms),
    queue_delay_ms:row.queue_delay_ms==null?null:Number(row.queue_delay_ms),
    lease_fence:Number(row.lease_fence),
  })),total:Number(result.rows[0]?.total||0),limit:f.limit,offset:f.offset}
}
export async function readWorkerDeploymentEvents(db,id){
  if(!uuid.test(String(id||'')))throw new Error('Invalid rollout job ID.')
  const sql=[
    'SELECT e.id,e.event_type,e.fence,e.occurred_at,e.details,',
    'j.build_sha,j.previous_build_sha,j.environment,',
    'j.release_ref,j.status,t.slug AS tenant_slug',
    'FROM tenant_release_rollout_events e',
    'JOIN tenant_release_rollout_jobs j ON j.id=e.job_id',
    'JOIN tenants t ON t.id=j.tenant_id',
    'WHERE e.job_id=$1 ORDER BY e.occurred_at ASC,e.id ASC LIMIT 250',
  ].join(' ')
  return (await db.query(sql,[id])).rows
}
