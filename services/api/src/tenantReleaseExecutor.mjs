#!/usr/bin/env node
/**
 * Persistent generic ITSM release executor, one container per Caddy gateway.
 * Never invents approved releases or tenants. Uses a PG session lock across
 * image deployment, gateway CAS, HTTPS proof and durable completion.
 */
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {withGatewayLock,recordReleaseWorkerHeartbeat} from './releaseGatewayCoordinator.js'
import {claimDueRollouts,finishRollout,activateNextPendingRollout} from './tenantReleaseQueue.js'
import {activeTenantMaintenanceWindow} from './releaseRolloutPlanner.js'
import {releasePair} from './tenantCaddyVersionRoutes.js'
import {parseQaReleaseTenantSlugs,assertQaReleaseTenantAllowed} from './releaseQaCohort.js'
import {assertRestrictedGenericDatabaseIdentity} from './releaseWorkerIdentity.js'

// QA remains allowlisted by default. Generic execution requires an explicit
// reviewed worker configuration AND fresh exact-release stage approval.
const workerScope=process.env.RELEASE_WORKER_SCOPE||'qa'
if(!['qa','generic'].includes(workerScope))throw Error('Unknown rollout worker scope.')
if(workerScope==='generic'
  &&process.env.RELEASE_GENERIC_WORKER_ACK!=='reviewed-stage-approval-only')
  throw Error('Generic worker requires explicit reviewed execution scope.')
const qaTenantSlugs=workerScope==='qa'
  ?parseQaReleaseTenantSlugs(process.env.RELEASE_QA_TENANT_SLUGS):null
const gateway=process.env.RELEASE_GATEWAY
if(!['test','uat','live'].includes(gateway))
  throw Error('Set RELEASE_GATEWAY to test, uat or live.')
if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
  throw Error('Real shared control-plane PostgreSQL connection is required.')
const ID='h5c-dynamic-'+gateway+'-'+(process.env.RELEASE_WORKER_ID||'primary')
if(!/^[a-z0-9-]{4,120}$/.test(ID))throw Error('Invalid release worker identifier.')
const one=process.argv.includes('--once'),preflight=process.argv.includes('--preflight')
if(process.argv.slice(2).some(x=>!['--once','--preflight'].includes(x)))
  throw Error('Worker accepts only --once or --preflight.')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  max:5,connectionTimeoutMillis:7000,idleTimeoutMillis:25000})
const sleep=ms=>new Promise(done=>setTimeout(done,ms))
let running=true
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{running=false})
const clientTx=async fn=>{
  const client=await pool.connect()
  try{
    await client.query('BEGIN')
    const out=await fn(client)
    await client.query('COMMIT')
    return out
  }catch(err){await client.query('ROLLBACK').catch(()=>{});throw err}
  finally{client.release()}
}
async function shell(program,args,env={},timeout=330000){
  return new Promise((resolve,reject)=>{
    const p=spawn(program,args,{env:{...process.env,...env},
      stdio:['ignore','pipe','pipe']})
    let out='',err='',settled=false
    const timer=setTimeout(()=>{if(!settled){p.kill('SIGKILL')
      reject(Error('Host executor exceeded bounded timeout.'))}},timeout)
    p.stdout.on('data',d=>{out+=d;if(out.length>400000)p.kill('SIGKILL')})
    p.stderr.on('data',d=>{err+=d;if(err.length>200000)p.kill('SIGKILL')})
    p.on('error',error=>{clearTimeout(timer);reject(error)})
    p.on('close',code=>{settled=true;clearTimeout(timer)
      if(code===0)return resolve(out)
      reject(Error('Host version switch failed: '+err.slice(-350)))})
  })
}
async function heartbeat(state,job=null,error=''){
  await recordReleaseWorkerHeartbeat(pool,{workerId:ID,gateway,state,
    jobId:job?.id||null,sha:job?.buildSha||null,error})
}
async function jobContext(job){
  const query=await pool.query([
    'SELECT j.id,j.tenant_id,j.environment,j.build_sha,',
    'j.expected_duration_minutes,t.slug,t.status AS tenant_status,',
    'p.update_mode,p.test_auto_sync,p.uat_auto_stage,p.maintenance_window,',
    'p.blackout_periods,p.live_auto_promote,',
    'c.status AS release_state,coalesce(ts.modules->> $2,$3) AS itsm',
    'FROM tenant_release_rollout_jobs j',
    'JOIN tenants t ON t.id=j.tenant_id',
    'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
    'JOIN tenant_settings ts ON ts.tenant_id=j.tenant_id',
    'JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha',
    'WHERE j.id=$1',
  ].join(' '),[job.id,'itsm','false'])
  if(query.rowCount!==1)return null
  return query.rows[0]
}
async function guards(job){
  const ctx=await jobContext(job)
  if(!ctx||ctx.environment!==gateway||ctx.tenant_id!==job.tenantId
    ||ctx.build_sha!==job.buildSha||ctx.tenant_status!=='active'
    ||ctx.release_state!=='approved'||ctx.itsm!=='true')
    throw Error('Tenant, release or product entitlement changed; deployment denied.')
  if(workerScope==='qa')assertQaReleaseTenantAllowed(ctx.slug,qaTenantSlugs)
  if(workerScope==='generic'){
    const eligible=await pool.query(
      'SELECT public.hi5_release_generic_tenant_permitted($1) AS allowed',
      [job.tenantId])
    if(eligible.rows[0]?.allowed!==true)
      throw Error('Tenant is outside the independently approved generic rollout scope.')
  }
  const approval=await pool.query([
    'SELECT 1 FROM platform_release_generic_stage_approvals a',
    'WHERE a.build_sha=$1 AND a.environment=$2',
    'AND a.planning_enabled=true AND a.execution_enabled=true',
    'AND a.approved_by IS NOT NULL AND a.approved_at<=now()',
    'AND a.expires_at>now()',
    "AND a.evidence<>'{}'::jsonb LIMIT 1",
  ].join(' '),[job.buildSha,gateway])
  if(approval.rowCount!==1)
    throw Error('Exact generic release execution-stage approval missing or expired.')
  if(gateway==='test'&&ctx.test_auto_sync!==true)
    throw Error('Customer Test auto-updates are disabled.')
  if(gateway==='uat'&&
    (ctx.update_mode!=='admin_controlled'||ctx.uat_auto_stage!==true))
    throw Error('Managed customers have no UAT.')
  if(gateway==='uat'||gateway==='live'){
    const verifiedTest=await pool.query([
      'SELECT 1 FROM tenant_release_rollout_jobs j',
      'WHERE j.tenant_id=$1 AND j.environment=$2 AND j.build_sha=$3',
      "AND j.status='succeeded' AND j.completed_at IS NOT NULL",
      'AND EXISTS (SELECT 1 FROM tenant_release_rollout_events e',
      "WHERE e.job_id=j.id AND e.event_type='verified'",
      'AND e.fence=j.lease_fence) LIMIT 1',
    ].join(' '),[job.tenantId,'test',job.buildSha])
    if(!verifiedTest.rowCount)
      throw Error('The exact tenant Test release must be verified before UAT or Production.')
  }
  if(gateway==='live'&&ctx.update_mode==='admin_controlled'){
    const verifiedUat=await pool.query([
      'SELECT 1 FROM tenant_release_rollout_jobs j',
      'WHERE j.tenant_id=$1 AND j.environment=$2 AND j.build_sha=$3',
      "AND j.status='succeeded' AND j.completed_at IS NOT NULL",
      'AND EXISTS (SELECT 1 FROM tenant_release_rollout_events e',
      "WHERE e.job_id=j.id AND e.event_type='verified'",
      'AND e.fence=j.lease_fence) LIMIT 1',
    ].join(' '),[job.tenantId,'uat',job.buildSha])
    if(!verifiedUat.rowCount)
      throw Error('Custom Production requires the matching, host-verified UAT deployment.')
  }
  const within=activeTenantMaintenanceWindow({
    policy:ctx.maintenance_window,blackouts:ctx.blackout_periods,
    durationMinutes:ctx.expected_duration_minutes,now:new Date(),
  })
  if(!within.allowed)throw Error('Tenant cutover no longer fits maintenance window: '+within.reason)
  if(gateway==='live'){
    if(ctx.update_mode==='admin_controlled'){
      const approved=await pool.query([
        'SELECT 1 FROM tenant_runtime_update_offers o',
        'JOIN tenant_runtime_update_offers u ON u.tenant_id=o.tenant_id',
        "AND u.environment='uat' AND u.build_sha=o.build_sha",
        "WHERE o.tenant_id=$1 AND o.environment='live' AND o.build_sha=$2",
        "AND o.state='scheduled' AND o.promotion_approved_at IS NOT NULL",
        'AND o.promotion_approved_by IS NOT NULL',
        'AND o.maintenance_not_before<=now()',
        "AND u.state IN ('uat_accepted','active') AND u.uat_accepted_at IS NOT NULL",
      ].join(' '),[job.tenantId,job.buildSha])
      if(!approved.rowCount)throw Error('A real tenant-admin UAT approval and Production schedule are mandatory.')
    }else if(ctx.update_mode==='hi5_managed'){
      if(!ctx.live_auto_promote)throw Error('Managed automatic Production is disabled.')
      const gate=await pool.query([
        'SELECT 1 FROM platform_release_test_qa_gates',
        "WHERE build_sha=$1 AND state='passed' AND passed_canary_count>=2",
      ].join(' '),[job.buildSha])
      if(!gate.rowCount)throw Error('Platform Test/canary release approval is missing.')
    }else throw Error('Invalid update model at cutover.')
  }
  return ctx
}
async function registerVerifiedPool(tx,environment,sha){
  const pair=releasePair(sha,environment),id='h5pool-'+environment+'-'+sha.slice(0,12)
  await tx.query([
    'INSERT INTO platform_runtime_pools',
    '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at,health)',
    "VALUES($1,$2,$3,$4,$5,'verified',now(),now(),$6::jsonb)",
    'ON CONFLICT(id) DO UPDATE SET',
    "state='verified',verified_at=now(),last_seen_at=now(),updated_at=now(),",
    'health=excluded.health',
  ].join(' '),[id,environment,sha,pair.api+':3001',pair.web+':80',
    JSON.stringify({status:'healthy',source:'host-verified-https'})])
  return id
}
async function persistVerified(job,ctx,result){
  return clientTx(async tx=>{
    const poolId=await registerVerifiedPool(tx,gateway,job.buildSha)
    const generation=Date.now()
    if(gateway!=='test'){
      await tx.query([
        'INSERT INTO tenant_runtime_assignments',
        '(tenant_id,environment,pool_id,build_sha,generation)',
        'VALUES($1,$2,$3,$4,$5)',
        'ON CONFLICT (tenant_id,environment) DO UPDATE SET',
        'pool_id=excluded.pool_id,build_sha=excluded.build_sha,',
        'generation=excluded.generation,activated_at=now()',
      ].join(' '),[job.tenantId,gateway,poolId,job.buildSha,generation])
      await tx.query([
        'INSERT INTO tenant_runtime_route_attestations',
        '(tenant_id,environment,pool_id,build_sha,public_host,state,checked_at)',
        "VALUES($1,$2,$3,$4,$5,'active',now())",
        'ON CONFLICT(tenant_id,environment) DO UPDATE SET',
        'pool_id=excluded.pool_id,build_sha=excluded.build_sha,',
        "public_host=excluded.public_host,state='active',checked_at=now()",
      ].join(' '),[job.tenantId,gateway,poolId,job.buildSha,result.host])
      if(gateway==='uat'){
        const stagedLivePool=await registerVerifiedPool(tx,'live',job.buildSha)
        await tx.query([
          'INSERT INTO tenant_runtime_update_offers',
          '(tenant_id,environment,pool_id,build_sha,update_mode,state)',
          "SELECT $1,'live',$2,$3,'admin_controlled','offered'",
          'WHERE NOT EXISTS (SELECT 1 FROM tenant_runtime_update_offers',
          "WHERE tenant_id=$1 AND environment='live' AND build_sha=$3)",
        ].join(' '),[job.tenantId,stagedLivePool,job.buildSha])
        await tx.query([
          'INSERT INTO tenant_runtime_update_offers',
          '(tenant_id,environment,pool_id,build_sha,update_mode,state)',
          "SELECT $1,'uat',$2,$3,'admin_controlled','uat_testing'",
          'WHERE NOT EXISTS (SELECT 1 FROM tenant_runtime_update_offers',
          "WHERE tenant_id=$1 AND environment='uat' AND build_sha=$3)",
        ].join(' '),[job.tenantId,poolId,job.buildSha])
      }else if(gateway==='live'){
        await tx.query([
          'UPDATE tenant_runtime_update_offers',
          "SET state='active',updated_at=now()",
          'WHERE tenant_id=$1 AND environment=$2 AND build_sha=$3',
        ].join(' '),[job.tenantId,gateway,job.buildSha])
      }
    }
    await tx.query([
      'UPDATE tenant_release_rollout_jobs SET previous_build_sha=$2',
      'WHERE id=$1 AND status=$3 AND lease_token=$4 AND lease_fence=$5',
    ].join(' '),[job.id,result.previousSha,'running',job.leaseToken,job.leaseFence])
    await finishRollout(tx,{jobId:job.id,leaseToken:job.leaseToken,
      leaseFence:job.leaseFence,outcome:'succeeded',
      proof:{tenantId:job.tenantId,environment:gateway,
        buildSha:job.buildSha,routeGeneration:generation,checkedAt:new Date()}})
    await tx.query([
      'UPDATE tenant_release_rollout_events',
      'SET details=details||$2::jsonb WHERE id=(',
      'SELECT id FROM tenant_release_rollout_events',
      "WHERE job_id=$1 AND event_type='verified' ORDER BY id DESC LIMIT 1)",
    ].join(' '),[job.id,JSON.stringify({workerId:ID,previousSha:result.previousSha,
      elapsedMs:result.elapsedMs,backup:result.backup,
      publicHost:result.host,verifiedAt:new Date().toISOString()})])
  })
}
async function failJob(job,reason,outcome='failed'){
  await clientTx(async tx=>{
    await finishRollout(tx,{jobId:job.id,leaseToken:job.leaseToken,
      leaseFence:job.leaseFence,outcome,now:new Date()})
    await tx.query('UPDATE tenant_release_rollout_jobs SET last_error=$2 WHERE id=$1',
      [job.id,String(reason).slice(0,400)])
  })
}
let lastHealthScan=0
async function refreshVerifiedPools(){
  // Never extend a health attestation just because a worker is running.
  // Inspect both Docker containers; then independently check each active
  // customer route before renewing its 15-minute UAT approval evidence.
  const candidates=await pool.query([
    'SELECT id,environment,build_sha,api_target,web_target',
    'FROM platform_runtime_pools',
    "WHERE environment=$1 AND state='verified'",
    'ORDER BY last_seen_at ASC LIMIT 200',
  ].join(' '),[gateway])
  for(const record of candidates.rows){
    try{
      const pair=releasePair(record.build_sha,gateway)
      const raw=await shell('docker',['inspect',pair.api,pair.web],{},20000)
      const images=JSON.parse(raw)
      if(images.length!==2||images.some(x=>x.State?.Health?.Status!=='healthy'))continue
      await pool.query([
        'UPDATE platform_runtime_pools SET last_seen_at=now(),updated_at=now()',
        "WHERE id=$1 AND build_sha=$2 AND state='verified'",
      ].join(' '),[record.id,record.build_sha])
      if(gateway==='test')continue
      const assigned=await pool.query([
        'SELECT a.tenant_id,t.slug FROM tenant_runtime_assignments a',
        'JOIN tenants t ON t.id=a.tenant_id',
        'WHERE a.pool_id=$1 AND a.environment=$2 AND a.build_sha=$3',
        "AND t.status='active' LIMIT 500",
      ].join(' '),[record.id,gateway,record.build_sha])
      for(const tenant of assigned.rows){
        try{
          const publicHost=tenant.slug+(gateway==='live'?'':'-'+gateway)+'.hi5central.com'
          const version=JSON.parse(await shell('curl',[
            '-fsS','--max-time','8','https://'+publicHost+'/api/v1/updates/version',
          ],{},12000))
          if(version.sha!==record.build_sha)continue
          await pool.query([
            'UPDATE tenant_runtime_route_attestations SET checked_at=now()',
            'WHERE tenant_id=$1 AND environment=$2 AND pool_id=$3',
            "AND build_sha=$4 AND state='active' AND public_host=$5",
          ].join(' '),[tenant.tenant_id,gateway,record.id,record.build_sha,publicHost])
        }catch{}
      }
    }catch{}
  }
}
async function step(){
  if(Date.now()-lastHealthScan>240000){
    lastHealthScan=Date.now()
    await refreshVerifiedPools().catch(e=>console.error('POOL_HEALTH_REFRESH_ERROR',e.message))
  }
  await heartbeat('idle')
  return withGatewayLock(pool,{gateway,workerId:ID},async gate=>{
    const claim=await clientTx(tx=>claimDueRollouts(tx,{
      limit:1,environment:gateway,leaseSeconds:600,qaTenantSlugs,
      genericTenantScope:workerScope==='generic'}))
    const job=claim.claimed?.[0]
    if(!job){await heartbeat(claim.paused?'paused':'idle');return false}
    await gate.registerClaim({jobId:job.id,tenantId:job.tenantId,
      leaseToken:job.leaseToken,leaseFence:job.leaseFence})
    await heartbeat('busy',job)
    let leaseTimer=null,leaseFailed=false
    const renew=async()=>{
      const changed=await pool.query([
        'UPDATE tenant_release_rollout_jobs',
        "SET lease_expires_at=now()+interval '10 minutes'",
        "WHERE id=$1 AND status='running' AND lease_token=$2",
        'AND lease_fence=$3 AND lease_expires_at>now() RETURNING id',
      ].join(' '),[job.id,job.leaseToken,job.leaseFence])
      if(!changed.rowCount)leaseFailed=true
    }
    leaseTimer=setInterval(()=>renew().catch(()=>{leaseFailed=true}),45000)
    const started=Date.now()
    let activated=null,activatedSlug=null,durableSuccess=false
    try{
      const ctx=await guards(job)
      activatedSlug=ctx.slug
      await gate.assertFencedLease()
      if(gateway==='uat'){
        // Pre-stage the immutable Production pair without altering any tenant route.
        // Customer approval must see a verified candidate Live pool.
        const staged=await shell('node',[
          'deployment/qa26/tenant-release-host-executor.mjs',
          'live',ctx.slug,job.buildSha,'--stage',
        ])
        const poolProof=JSON.parse(staged.trim().split('\n').at(-1))
        if(poolProof.status!=='pool_verified'||poolProof.buildSha!==job.buildSha)
          throw Error('Official immutable Production candidate could not be pre-staged.')
      }
      const output=await shell('node',[
        'deployment/qa26/tenant-release-host-executor.mjs',
        gateway,ctx.slug,job.buildSha,'--apply',
      ],{H5C_RELEASE_LEASE_AUTH:'worker-gateway-fenced',
        H5C_RELEASE_JOB_ID:job.id,H5C_RELEASE_LEASE_TOKEN:job.leaseToken,
        H5C_RELEASE_LEASE_FENCE:String(job.leaseFence)})
      const line=output.trim().split('\n').at(-1)
      const result=JSON.parse(line)
      activated=result
      if(result.status!=='verified'||result.buildSha!==job.buildSha
        ||result.environment!==gateway)throw Error('Host execution proof mismatches the lease.')
      if(leaseFailed)throw Error('Database lease renewal failed during host cutover.')
      await gate.assertFencedLease()
      await persistVerified(job,ctx,{...result,elapsedMs:Date.now()-started})
      durableSuccess=true
      // Confirmation follows the durable event commit. If this call is lost,
      // the independent watchdog checks the same fenced DB proof before restore.
      try{
        const confirmation=await shell('node',[
          'deployment/qa26/tenant-release-host-executor.mjs',
          gateway,ctx.slug,job.buildSha,'--confirm',result.backup,
        ],{H5C_RELEASE_JOB_ID:job.id},25000)
        if(!confirmation.includes('watchdog_confirmed'))
          throw Error('Exact host watchdog confirmation missing.')
      }catch(error){
        console.error('POSTCOMMIT_GENERIC_WATCHDOG_CONFIRM_WARNING',error.message)
      }
      // A committed, host-verified job may NEVER be downgraded because
      // worker telemetry became temporarily unavailable.
      await heartbeat('idle').catch(error=>
        console.error('POSTCOMMIT_GENERIC_HEARTBEAT_WARNING',error.message))
      console.log(JSON.stringify({type:'deployment_verified',jobId:job.id,
        host:result.host,sha:job.buildSha,elapsedMs:Date.now()-started}))
    }catch(e){
      if(durableSuccess){
        // Preserve the successful database commit and working route.
        console.error('POSTCOMMIT_GENERIC_WARNING_NOT_ROLLED_BACK',
          String(e?.message||e).slice(0,250))
      }else{
      let compensated=false
      if(activated?.status==='verified'&&activated.backup&&activatedSlug){
        try{
          const output=await shell('node',[
            'deployment/qa26/tenant-release-host-executor.mjs',
            gateway,activatedSlug,job.buildSha,'--restore',activated.backup,
          ],{H5C_RELEASE_LEASE_AUTH:'worker-gateway-fenced',
            H5C_RELEASE_JOB_ID:job.id,H5C_RELEASE_LEASE_TOKEN:job.leaseToken,
            H5C_RELEASE_LEASE_FENCE:String(job.leaseFence)},90000)
          const proof=JSON.parse(output.trim().split('\n').at(-1))
          compensated=proof.status==='rolled_back'&&proof.environment===gateway
        }catch(restoreError){
          console.error('DURABLE_RELEASE_ROLLBACK_FAILED',restoreError.message)
        }
      }
      if(activated&&!compensated){
        // This fail-closed emergency stop is the ONLY allowed write to
        // rollout control from a restricted executor. The reviewed database
        // function can set paused=true, never unpause, and audits the caller.
        // Direct UPDATE privileges on rollout control remain forbidden.
        try{
          const stopped=await pool.query(
            'SELECT public.hi5_release_emergency_pause($1,$2) AS paused',
            [ID,'Host cutover could not be confirmed rolled back; operator review required'])
          if(stopped.rows[0]?.paused!==true)
            throw Error('Emergency pause was not confirmed by PostgreSQL.')
        }catch(pauseError){
          // Never silently swallow a failed emergency-stop request.
          // Stop THIS worker immediately after finalising the failed job;
          // the operator must independently halt remaining worker services.
          running=false
          process.exitCode=1
          console.error('DURABLE_RELEASE_EMERGENCY_PAUSE_FAILED',
            String(pauseError.message||pauseError).slice(0,300))
        }
      }
      console.error(JSON.stringify({type:'deployment_failed',jobId:job.id,
        gateway,compensated,error:String(e.message||e).slice(0,400)}))
      try{await failJob(job,e.message,compensated?'rolled_back':'failed')}catch(err){
        console.error('DURABLE_JOB_FINALISATION_FAILED',err.message)}
      await heartbeat('error',null,e.message).catch(()=>{})
      }
    }finally{clearInterval(leaseTimer)}
    // Allow the next version to be activated only after this job is terminal.
    await clientTx(tx=>activateNextPendingRollout(tx,{
      tenantId:job.tenantId,environment:gateway})).catch(()=>{})
    return true
  })
}
try{
  if(workerScope==='generic')
    await assertRestrictedGenericDatabaseIdentity(pool,{kind:'executor',stage:gateway})
  if(preflight){
    const r=await pool.query([
      "SELECT to_regclass('public.platform_certified_application_releases') IS NOT NULL AS certification,",
      "to_regclass('public.platform_release_gateway_owners') IS NOT NULL AS lock_table,",
      "to_regclass('public.tenant_release_rollout_jobs') IS NOT NULL AS queue",
    ].join(' '))
    if(Object.values(r.rows[0]).some(x=>x!==true))throw Error('Executor schema incomplete.')
    console.log('GENERIC_RELEASE_EXECUTOR_PREFLIGHT_PASS',gateway,
      'scope='+workerScope,'qaTenants='+(qaTenantSlugs?.length||0))
  }else{
    do{
      try{await step()}catch(e){
        console.error('RELEASE_EXECUTOR_POLL_ERROR',gateway,String(e.message||e).slice(0,400))
        if(one)process.exitCode=1
      }
      if(!one&&running)await sleep(30000)
    }while(!one&&running)
  }
}finally{await pool.end()}
