/**
 * Cross-process/cross-VPS gateway exclusion: a PostgreSQL SESSION advisory
 * lock is held for the ENTIRE cutover, not just the queue-claim transaction.
 * When a worker dies its PG connection closes and the lock is released.
 *
 * Never call this with a shared/transaction-pooling PgBouncer connection.
 * All writers of a shared gateway must use this same gate. No UI can invoke
 * this function or choose upstream targets directly.
 */
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const gatewayNames=new Set(['test','uat','live'])
const LOCK_NAMESPACE='hi5central-release-gateway'
const invalid=reason=>Object.assign(new Error(reason),{code:'GATEWAY_LEASE_GUARD'})
function assertArguments(opts){
  if(!gatewayNames.has(opts?.gateway)
    ||!UUID.test(String(opts?.jobId||''))
    ||!UUID.test(String(opts?.tenantId||''))
    ||!UUID.test(String(opts?.leaseToken||''))
    ||!Number.isSafeInteger(opts?.leaseFence)||opts.leaseFence<1
    ||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(String(opts?.workerId||'')))
    throw invalid('Invalid gateway resource, worker identity or fenced rollout lease.')
}
const acquireSql='SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired'
const releaseSql='SELECT pg_advisory_unlock(hashtext($1),hashtext($2)) AS released'
/**
 * @returns {Promise<{acquired:boolean,result?:any,reason?:string}>}
 * If busy, the caller MUST preserve the queued job for the next worker poll.
 * Only call claimDueRollouts after obtaining this lock.
 */
export async function withGatewayLock(pool,opts,operation){
  assertArguments(opts)
  if(typeof operation!=='function')throw invalid('Worker cutover callback missing.')
  const client=await pool.connect()
  let held=false
  const {gateway,jobId,tenantId,leaseToken,leaseFence,workerId}=opts
  async function assertFencedLease(){
    const state=await client.query([
      'SELECT j.id FROM tenant_release_rollout_jobs j',
      'JOIN platform_release_gateway_owners o ON o.job_id=j.id',
      'WHERE j.id=$1 AND j.tenant_id=$2 AND j.lease_token=$3',
      "AND j.lease_fence=$4 AND j.status='running'",
      'AND j.lease_expires_at>now()',
      'AND o.gateway=$5 AND o.worker_id=$6 AND o.lease_fence=j.lease_fence',
    ].join(' '),[jobId,tenantId,leaseToken,leaseFence,gateway,workerId])
    if(state.rowCount!==1)throw invalid('Stale gateway fence or expired worker lease: no route write permitted.')
    return true
  }
  try{
    const attempt=await client.query(acquireSql,[LOCK_NAMESPACE,gateway])
    if(!attempt.rows[0]?.acquired)
      return {acquired:false,reason:'Shared '+gateway+' gateway is deploying another tenant.'}
    held=true
    const eligible=await client.query([
      'SELECT id FROM tenant_release_rollout_jobs WHERE id=$1 AND tenant_id=$2',
      "AND environment=$3 AND status='running'",
      'AND lease_token=$4 AND lease_fence=$5 AND lease_expires_at>now()',
    ].join(' '),[jobId,tenantId,gateway,leaseToken,leaseFence])
    if(eligible.rowCount!==1)throw invalid('Unleased, expired or mismatched rollout job.')
    const previous=await client.query(
      'SELECT job_id,tenant_id,lease_fence FROM platform_release_gateway_owners WHERE gateway=$1',
      [gateway])
    if(previous.rowCount&&previous.rows[0].job_id!==jobId){
      const old=await client.query(
        "SELECT 1 FROM tenant_release_rollout_jobs WHERE id=$1 AND status='running' AND lease_expires_at>now()",
        [previous.rows[0].job_id])
      if(old.rowCount)return {acquired:false,reason:'Previous gateway owner has a valid lease.'}
    }
    await client.query([
      'INSERT INTO platform_release_gateway_owners',
      '(gateway,job_id,tenant_id,lease_fence,worker_id,acquired_at,heartbeat_at)',
      'VALUES($1,$2,$3,$4,$5,now(),now())',
      'ON CONFLICT(gateway) DO UPDATE SET',
      'job_id=excluded.job_id,tenant_id=excluded.tenant_id,',
      'lease_fence=excluded.lease_fence,worker_id=excluded.worker_id,',
      'acquired_at=now(),heartbeat_at=now()',
    ].join(' '),[gateway,jobId,tenantId,leaseFence,workerId])
    await assertFencedLease()
    const heartbeat=async()=>{
      await assertFencedLease()
      await client.query('UPDATE platform_release_gateway_owners SET heartbeat_at=now() WHERE gateway=$1 AND job_id=$2 AND worker_id=$3',
        [gateway,jobId,workerId])
    }
    const result=await operation({gateway,jobId,workerId,assertFencedLease,heartbeat})
    return {acquired:true,result}
  }finally{
    if(held){
      try{
        await client.query([
          'DELETE FROM platform_release_gateway_owners',
          'WHERE gateway=$1 AND job_id=$2 AND worker_id=$3 AND lease_fence=$4',
        ].join(' '),[gateway,jobId,workerId,leaseFence])
      }finally{
        try{await client.query(releaseSql,[LOCK_NAMESPACE,gateway])}
        finally{client.release()}
      }
    }else client.release()
  }
}
export async function recordReleaseWorkerHeartbeat(db,{
  workerId,gateway,state,jobId=null,sha=null,error='',
}){
  if(!gatewayNames.has(gateway)||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(String(workerId||''))
    ||!['idle','busy','paused','error'].includes(state)
    ||(jobId&&!UUID.test(String(jobId)))
    ||(sha&&!/^[a-f0-9]{40}$/.test(sha)))
    throw invalid('Invalid worker heartbeat.')
  await db.query([
    'INSERT INTO platform_release_worker_heartbeats',
    '(worker_id,gateway,state,current_job_id,version_sha,last_poll_at,last_success_at,last_error)',
    'VALUES($1,$2,$3,$4,$5,now(),',
    "CASE WHEN $3='error' THEN NULL ELSE now() END,$6)",
    'ON CONFLICT(worker_id) DO UPDATE SET',
    'gateway=excluded.gateway,state=excluded.state,',
    'current_job_id=excluded.current_job_id,version_sha=excluded.version_sha,',
    'last_poll_at=now(),updated_at=now(),last_error=excluded.last_error,',
    "last_success_at=CASE WHEN excluded.state='error'",
    'THEN platform_release_worker_heartbeats.last_success_at ELSE now() END',
  ].join(' '),[workerId,gateway,state,jobId,sha,String(error).slice(0,500)])
}
