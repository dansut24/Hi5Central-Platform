export const APPLICATION_RELEASE_EXECUTOR_ID='managed-vps-api-itsm-v1'
export const APPLICATION_RELEASE_EXECUTOR_CAPABILITY='api-itsm-live-backup-rollback'
export const APPLICATION_RELEASE_EXECUTOR_TTL_MS=2*60*1000

/** A legacy release-operator action poll is not an application image worker. */
export function applicationReleaseExecutorState(row,now=new Date()) {
  if(!row||row.worker_id!==APPLICATION_RELEASE_EXECUTOR_ID
    ||row.capability!==APPLICATION_RELEASE_EXECUTOR_CAPABILITY) {
    return {ready:false,reason:'The application deployment executor has not reported readiness.'}
  }
  const age=now.getTime()-new Date(row.observed_at||'').getTime()
  if(!Number.isFinite(age)||age<0||age>APPLICATION_RELEASE_EXECUTOR_TTL_MS) {
    return {ready:false,reason:'The application deployment executor heartbeat has expired.'}
  }
  return {ready:true,reason:'Trusted image deployment executor is online.',lastSeenAt:row.observed_at}
}

export async function readApplicationReleaseExecutor(database,now=new Date()) {
  const result=await database.query(
    'SELECT worker_id,capability,observed_at FROM platform_application_release_executor_heartbeats WHERE worker_id=$1',
    [APPLICATION_RELEASE_EXECUTOR_ID],
  )
  return applicationReleaseExecutorState(result.rows[0],now)
}
