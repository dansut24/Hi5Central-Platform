// Shared transactional transition for fulfilment tasks. Called only after
// the task update (and dependency unlock) has succeeded in the same transaction.
// Never bypass request approvals or the Closed/Rejected state.
export async function syncServiceRequestTaskFlow(db, {
  tenantId, requestId, actorUserId, actorPersonId, actorSnapshot, triggeringTaskKey, taskStatus,
}) {
  if (!['In Progress','Completed'].includes(taskStatus)) return null
  const requestResult = await db.query(
    'SELECT id,status,operational_data FROM service_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
    [requestId,tenantId],
  )
  const request = requestResult.rows[0]
  if (!request || !['New','Approved','In Progress'].includes(request.status)) return null

  const approvals = await db.query(
    "SELECT count(*)::int AS pending FROM service_request_approvals WHERE request_id=$1 AND status IN ('Pending','Rejected')",
    [requestId],
  )
  if (Number(approvals.rows[0]?.pending || 0)>0) return null

  const counts = await db.query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status='Completed')::int AS done
     FROM service_request_tasks WHERE request_id=$1 AND tenant_id=$2`,
    [requestId,tenantId],
  )
  const {total,done} = counts.rows[0] || {total:0,done:0}
  if (!Number(total)) return null
  const fullyComplete = Number(total)===Number(done)
  const next = fullyComplete ? 'Completed' : 'In Progress'
  if (request.status===next) return {status:next,total:Number(total),done:Number(done),changed:false}

  const summary = fullyComplete ? await db.query(
    `SELECT external_key,title,completion_notes FROM service_request_tasks
     WHERE request_id=$1 AND tenant_id=$2 ORDER BY created_at,external_key`,
    [requestId,tenantId],
  ) : null
  const completionSummary = fullyComplete ? summary.rows
    .map(task=>`${task.external_key} · ${task.title}: ${task.completion_notes || 'Completed'}`)
    .join('\n').slice(0,10000) : ''
  const operational = request.operational_data && typeof request.operational_data==='object' && !Array.isArray(request.operational_data)
    ? request.operational_data : {}
  await db.query(
    `UPDATE service_requests SET status=$2,
       operational_data=CASE WHEN $2='Completed'
         THEN jsonb_set(COALESCE(operational_data,'{}'::jsonb),'{completionNotes}',to_jsonb($3::text),true)
         ELSE operational_data END,
       resolved_at=CASE WHEN $2='Completed' THEN COALESCE(resolved_at,now()) ELSE resolved_at END,
       updated_at=now()
     WHERE id=$1`,
    [requestId,next,completionSummary],
  )
  await db.query(
    `INSERT INTO service_request_activities
      (tenant_id,request_id,actor_user_id,actor_person_id,actor_snapshot,
       kind,visibility,body_text,metadata)
     VALUES($1,$2,$3,$4,$5::jsonb,'system','customer',$6,$7::jsonb)`,
    [
      tenantId,requestId,actorUserId,actorPersonId,JSON.stringify(actorSnapshot || {}),
      fullyComplete
        ? `All ${done} fulfilment tasks completed. Request moved to Completed; ready for closure.`
        : `Fulfilment started. ${done} of ${total} tasks completed.`,
      JSON.stringify({event:'request.task_flow_advanced',taskKey:triggeringTaskKey,from:request.status,to:next,completed:Number(done),total:Number(total)}),
    ],
  )
  return {status:next,total:Number(total),done:Number(done),changed:true}
}
