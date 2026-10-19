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
// All stage executors edit ONE Caddyfile. A stage-specific lock allowed Live and
// UAT to overwrite each other's source during concurrent maintenance windows.
const LOCK_NAMESPACE='hi5central-release-gateway'
const SHARED_CADDY_SOURCE='hi5central-gateway-1:/etc/caddy/Caddyfile'
const invalid=reason=>Object.assign(new Error(reason),{code:'GATEWAY_LEASE_GUARD'})
function assertArguments(opts){
  if(!gatewayNames.has(opts?.gateway)
    ||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(String(opts?.workerId||'')))
    throw invalid('Invalid gateway or worker identity.')
}
const acquireSql='SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired'
const releaseSql='SELECT pg_advisory_unlock(hashtext($1),hashtext($2)) AS released'

/**
 * Acquire the physical shared Caddy gateway mutex BEFORE claiming a pending rollout.
 * Test, UAT and Live MUST contend on the same advisory-lock key.
 *
 * The callback claims a job under its ordinary SKIP LOCKED transaction,
 * then calls registerClaim(job) with jobId/tenantId/leaseToken/leaseFence.
 * The callback must call assertFencedLease directly BEFORE the route write
 * and again before declaring deployment success. Retain this PG session
 * for the entire cutover, including its public health verification.
 *
 * Lock contention returns {acquired:false}; the other tenant remains queued
 * and is claimed on the next scheduler iteration.
 */
export async function withGatewayLock(pool,opts,operation){
  assertArguments(opts)
  if(typeof operation!=='function')throw invalid('Worker cutover callback missing.')
  const client=await pool.connect()
  let held=false,owner=null
  const {gateway,workerId}=opts
  async function assertFencedLease(){
    if(!owner)throw invalid('Gateway writer has not registered a fenced rollout job.')
    const state=await client.query([
      'SELECT j.id FROM tenant_release_rollout_jobs j',
      'JOIN platform_release_gateway_owners o ON o.job_id=j.id',
      'WHERE j.id=$1 AND j.tenant_id=$2 AND j.lease_token=$3',
      "AND j.lease_fence=$4 AND j.status='running'",
      'AND j.lease_expires_at>now()',
      'AND o.gateway=$5 AND o.worker_id=$6 AND o.lease_fence=j.lease_fence',
    ].join(' '),[owner.jobId,owner.tenantId,owner.leaseToken,
      owner.leaseFence,gateway,workerId])
    if(state.rowCount!==1)
      throw invalid('Stale gateway fence or expired worker lease: route write denied.')
    return true
  }
  async function registerClaim(job){
    if(owner)throw invalid('This gateway already owns a rollout claim.')
    const {jobId,tenantId,leaseToken,leaseFence}=job||{}
    if(!UUID.test(String(jobId||''))||!UUID.test(String(tenantId||''))
      ||!UUID.test(String(leaseToken||''))
      ||!Number.isSafeInteger(leaseFence)||leaseFence<1)
      throw invalid('Invalid fenced release claim.')
    const eligible=await client.query([
      'SELECT id FROM tenant_release_rollout_jobs WHERE id=$1 AND tenant_id=$2',
      "AND environment=$3 AND status='running'",
      'AND lease_token=$4 AND lease_fence=$5 AND lease_expires_at>now()',
    ].join(' '),[jobId,tenantId,gateway,leaseToken,leaseFence])
    if(eligible.rowCount!==1)throw invalid('Unleased, expired or mismatched job.')
    const previous=await client.query(
      'SELECT job_id FROM platform_release_gateway_owners WHERE gateway=$1',
      [gateway])
    if(previous.rowCount&&previous.rows[0].job_id!==jobId){
      const old=await client.query([
        'SELECT 1 FROM tenant_release_rollout_jobs WHERE id=$1',
        "AND status='running' AND lease_expires_at>now()",
      ].join(' '),[previous.rows[0].job_id])
      if(old.rowCount)throw invalid('Previous gateway owner still holds a valid lease.')
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
    owner={jobId,tenantId,leaseToken,leaseFence}
    await assertFencedLease()
  }
  async function heartbeat(){
    await assertFencedLease()
    await client.query([
      'UPDATE platform_release_gateway_owners SET heartbeat_at=now()',
      'WHERE gateway=$1 AND job_id=$2 AND worker_id=$3',
    ].join(' '),[gateway,owner.jobId,workerId])
  }
  try{
    const attempt=await client.query(acquireSql,[LOCK_NAMESPACE,SHARED_CADDY_SOURCE])
    if(!attempt.rows[0]?.acquired)
      return {acquired:false,reason:'Another tenant is deploying through '+gateway+'.'}
    held=true
    const result=await operation({
      gateway,workerId,registerClaim,assertFencedLease,heartbeat,
    })
    return {acquired:true,result}
  }finally{
    if(held){
      try{
        if(owner)await client.query([
          'DELETE FROM platform_release_gateway_owners',
          'WHERE gateway=$1 AND job_id=$2 AND worker_id=$3 AND lease_fence=$4',
        ].join(' '),[gateway,owner.jobId,workerId,owner.leaseFence])
      }finally{
        try{await client.query(releaseSql,[LOCK_NAMESPACE,SHARED_CADDY_SOURCE])}
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
