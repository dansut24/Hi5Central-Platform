/**
 * Automatically supersede unclaimed older customer jobs in the SAME transaction
 * as an authenticated staff "Release to customers" certification.
 *
 * This replaces the former manual paused/cohort-specific cancellation for
 * ordinary releases. Running, claimed, attempted or succeeded jobs are NEVER
 * changed. Stage and tenant maintenance-window policies remain untouched.
 */
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const fail=message=>Object.assign(new Error(message),{code:'RELEASE_SUPERSESSION_DENIED'})

export async function supersedeOlderCustomerReleases(db,{newSha,actorId}={}){
  if(!SHA.test(String(newSha||''))||!UUID.test(String(actorId||'')))
    throw fail('A verified staff actor and exact new release SHA are required.')

  // Two simultaneous publication transactions cannot rearrange the newest
  // release order and its queue concurrently.
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('h5c-customer-release-supersession'))")

  const latest=await db.query([
    'SELECT n.build_sha FROM hi5central_published_release_notes n',
    'JOIN platform_certified_application_releases c ON c.build_sha=n.build_sha',
    "WHERE c.status='approved' AND c.approved_by IS NOT NULL",
    'AND EXISTS (SELECT 1 FROM platform_release_generic_stage_approvals a',
    ' WHERE a.build_sha=c.build_sha AND a.environment IN (\'uat\',\'live\')',
    ' AND a.planning_enabled=true AND a.execution_enabled=true',
    ' AND a.approved_by IS NOT NULL AND a.expires_at>now())',
    'ORDER BY n.published_at DESC,c.approved_at DESC,n.build_sha DESC LIMIT 1',
  ].join(' '))
  if(latest.rows[0]?.build_sha!==newSha)
    throw fail('Only the newest officially published, staff-approved customer release may queue or supersede jobs.')

  // The exact customer's maintenance window is not modified. Only obsolete,
  // never-attempted jobs can be cancelled. Row-level UPDATE locking serializes
  // against worker claims; any claim that wins becomes protected by its status
  // and nonzero fence. The worker independently rejects non-latest releases.
  const changed=await db.query([
    'UPDATE tenant_release_rollout_jobs j',
    "SET status='cancelled',completed_at=now(),updated_at=now(),",
    " last_error='Superseded by newer certified customer release ' || $1",
    'FROM hi5central_published_release_notes older',
    'JOIN platform_release_generic_stage_approvals a',
    ' ON a.build_sha=older.build_sha',
    "WHERE j.build_sha=older.build_sha AND j.build_sha<>$1",
    'AND j.environment=a.environment AND j.environment IN (\'uat\',\'live\')',
    'AND a.evidence @> \'{"releaseToCustomers":true}\'::jsonb',
    "AND j.status IN ('pending','scheduled','deferred')",
    'AND j.attempt_count=0 AND j.lease_token IS NULL',
    'AND j.lease_expires_at IS NULL AND j.lease_fence=0',
    'AND j.routed_generation IS NULL',
    'RETURNING j.id,j.tenant_id,j.environment,j.build_sha,j.lease_fence',
  ].join(' '),[newSha])
  const cancelled=changed.rows
  if(cancelled.length){
    for(const j of cancelled){
      await db.query([
        'INSERT INTO tenant_release_rollout_events',
        '(job_id,tenant_id,environment,build_sha,event_type,fence,details)',
        "VALUES($1,$2,$3,$4,'cancelled',$5,$6::jsonb)",
      ].join(' '),[j.id,j.tenant_id,j.environment,j.build_sha,j.lease_fence,
        JSON.stringify({reason:'superseded_by_newer_certified_customer_release',
          supersededBy:newSha,previousSha:j.build_sha,staffActorId:actorId,
          notClaimed:true,completedJobsPreserved:true})])
    }
  }
  return {supersededCount:cancelled.length,supersededJobIds:cancelled.map(j=>j.id)}
}
