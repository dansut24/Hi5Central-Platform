/**
 * Staff-authorised, globally-paused release queue supersession.
 *
 * Does not certify a release, create jobs, grant worker permissions,
 * change customer routes, or unpause anything. Must run inside the
 * same database transaction as the Platform Admin audit row.
 */
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/
const STAGES=new Set(['test','uat','live'])
const fail=message=>Object.assign(new Error(message),{code:'ROLLOUT_SUPERSESSION_DENIED'})
function exactExpected(raw){
  if(!Array.isArray(raw)||raw.length<1||raw.length>20)
    throw fail('Specify the exact 1–20 reviewed customer and environment pairs.')
  const items=raw.map(item=>{
    const slug=String(item?.slug||'')
    const environment=String(item?.environment||'')
    if(!SLUG.test(slug)||!STAGES.has(environment))
      throw fail('Invalid reviewed customer stage.')
    return {slug,environment}
  })
  const unique=new Set(items.map(x=>x.slug+':'+x.environment))
  if(unique.size!==items.length)
    throw fail('Duplicate reviewed customer stage.')
  return unique
}
/**
 * Requires authenticated ACTIVE platform owner/admin in the calling route.
 * Caller starts a transaction, holds it through both this function and audit.
 */
export async function supersedeScheduledReleaseJobs(db,{
  oldSha,newSha,expected,reason,actorId,
}={}){
  if(!SHA.test(String(oldSha||''))||!SHA.test(String(newSha||''))
    ||oldSha===newSha||!UUID.test(String(actorId||'')))
    throw fail('Distinct immutable releases and a verified staff actor are required.')
  if(typeof reason!=='string'||reason.trim().length<20||reason.length>500)
    throw fail('Enter a meaningful 20–500 character audit reason.')
  const requested=exactExpected(expected)
  const pause=await db.query(
    'SELECT paused FROM platform_release_rollout_control WHERE singleton=true FOR SHARE')
  if(pause.rows[0]?.paused!==true)
    throw fail('The global release worker must remain paused.')
  const active=await db.query(
    "SELECT count(*)::int AS total FROM tenant_release_rollout_jobs WHERE status='running'")
  if(active.rows[0]?.total!==0)
    throw fail('A release deployment is already running; no cancellation allowed.')
  const destination=await db.query([
    'SELECT build_sha FROM hi5central_published_release_notes',
    'WHERE build_sha=$1 LIMIT 1',
  ].join(' '),[newSha])
  if(destination.rowCount!==1)
    throw fail('Replacement release is not yet published in the central catalogue.')
  const jobs=await db.query([
    'SELECT j.id,j.tenant_id,j.environment,j.build_sha,j.status,',
    'j.attempt_count,j.lease_token,j.lease_expires_at,j.lease_fence,',
    'j.routed_generation,t.slug',
    'FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    "WHERE j.build_sha=$1 AND j.status IN ('scheduled','deferred','running')",
    'ORDER BY t.slug,j.environment FOR UPDATE OF j',
  ].join(' '),[oldSha])
  const real=jobs.rows
  if(real.length!==requested.size)
    throw fail('Obsolete queue count differs from the exact reviewed cohort.')
  for(const j of real){
    if(!requested.has(j.slug+':'+j.environment)
      ||j.status!=='scheduled'||j.attempt_count!==0
      ||j.lease_token!==null||j.lease_expires_at!==null
      ||Number(j.lease_fence)!==0||j.routed_generation!==null)
      throw fail('An obsolete job was claimed, routed, deferred or outside the reviewed scope.')
  }
  const ids=real.map(r=>r.id)
  const change=await db.query([
    "UPDATE tenant_release_rollout_jobs SET status='cancelled',",
    'updated_at=now(),completed_at=now(),',
    'last_error=$2',
    "WHERE id=ANY($1::uuid[]) AND status='scheduled'",
    'AND attempt_count=0 AND lease_token IS NULL AND lease_expires_at IS NULL',
    'AND lease_fence=0 AND routed_generation IS NULL',
    'RETURNING id,tenant_id,environment,build_sha,lease_fence',
  ].join(' '),[ids,'Superseded by published release '+newSha])
  if(change.rowCount!==real.length)
    throw fail('Concurrent queue modification detected; roll back the transaction.')
  for(const j of change.rows){
    await db.query([
      'INSERT INTO tenant_release_rollout_events',
      '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
      "VALUES ($1,$2,$3,$4,'cancelled',$5,$6::jsonb)",
    ].join(' '),[j.id,j.tenant_id,j.environment,j.build_sha,j.lease_fence,
      JSON.stringify({reason:reason.trim(),supersededBy:newSha,
        staffActorId:actorId,globalReleasePauseWasEnabled:true})])
  }
  return {
    oldSha,newSha,cancelled:real.length,auditEvents:real.length,
    reviewedPairs:real.map(x=>({slug:x.slug,environment:x.environment})),
    globallyPaused:true,routeChanges:0,
  }
}
