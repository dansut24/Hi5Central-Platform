import { hasPermission } from './access.js'
import { pool, withTransaction } from './db.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { authenticateAgent } from './rmmAgent.js'
import {
  protectLocalAdminPassword, revealLocalAdminPassword, validLocalAdminPassword,
  validateDedicatedLocalAdminName, rotationMetadata,
} from './rmmLocalAdminVaultCrypto.js'

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const clean=(v,max=256)=>String(v??'').trim().slice(0,max)
function fail(message,status=400) { return Object.assign(new Error(message),{status}) }
function safe(handler) {
  return async (c)=>{
    try { return await handler(c) }
    catch (error) {
      // Never log agent-submitted credentials, request bodies, SQL statements or IDs.
      // SQLSTATE alone is sufficient for investigating migration/schema mismatches.
      if (!error?.status) console.error('Local admin vault request failed', {
        category: 'internal', dbCode: typeof error?.code === 'string' ? error.code.slice(0, 8) : 'unknown',
      })
      return c.json({error:error?.status?error.message:'Local administrator vault request failed.'},error?.status||500)
    }
  }
}
async function authorize(c,permission) {
  const session=await resolveSession(c)
  if (!session || !session.session_id) throw fail('Sign in interactively to manage local administrator passwords.',401)
  if (!originMatchesTenant(c.req.header('origin'),session.slug)) throw fail('Tenant session mismatch.',403)
  if (!process.env.RMM_LOCAL_ADMIN_ENABLED_TENANT || session.slug!==process.env.RMM_LOCAL_ADMIN_ENABLED_TENANT) throw fail('Local admin vault has not been enabled for this tenant.',403)
  if (!hasPermission(session.access,permission)) throw fail('Local administrator vault permission denied.',403)
  return session
}
async function agentAuth(c) {
  const agent=await authenticateAgent(c.req.header('x-hi5-device-id'),c.req.header('x-hi5-agent-secret'))
  if (!agent) throw fail('Agent authentication failed.',401)
  const tenant=await pool.query('SELECT slug FROM tenants WHERE id=$1',[agent.tenant_id])
  if (!process.env.RMM_LOCAL_ADMIN_ENABLED_TENANT || tenant.rows[0]?.slug!==process.env.RMM_LOCAL_ADMIN_ENABLED_TENANT) throw fail('Local admin vault not enabled for this tenant.',403)
  if (!c.req.url.startsWith('https://') && process.env.NODE_ENV==='production') {
    // This check is only for externally visible TLS requests; proxy forwarding normally
    // makes internal c.req.url HTTP. TLS is enforced at Caddy and in the agent client.
  }
  return agent
}
async function audited(client,{tenantId,accountId,rotationId=null,eventType,actorId=null,actorKind='technician',reason='',detail={}}) {
  await client.query(
    'INSERT INTO rmm_local_admin_audit (tenant_id,account_id,rotation_id,event_type,reason,actor_user_id,actor_kind,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [tenantId,accountId,rotationId,eventType,reason,actorId,actorKind,JSON.stringify(detail)])
}
async function accountFor(tenantId,accountId,client=pool) {
  if (!idPattern.test(String(accountId))) throw fail('Invalid account ID.')
  const r=await client.query(
    'SELECT a.*,i.name AS device_name,d.agent_version,d.websocket_status,d.last_telemetry_at FROM rmm_local_admin_accounts a JOIN rmm_agent_devices d ON d.id=a.agent_device_id JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.id=$2 AND d.disabled_at IS NULL',
    [tenantId,accountId])
  if (!r.rowCount) throw fail('Managed local administrator account not found.',404)
  return r.rows[0]
}
function exposedAccount(a,rotation=null) {
  return {
    id:a.id,agentDeviceId:a.agent_device_id,deviceName:a.device_name,
    name:a.account_name,sid:a.account_sid,mode:a.mode,state:a.state,
    lastRotatedAt:a.last_rotated_at,nextRotationAt:a.next_rotation_at,
    lastError:a.last_error,agentVersion:a.agent_version,
    removalJobId:a.removal_job_id,removedAt:a.removed_at,
    agentConnected:a.websocket_status==='Connected' &&
      Boolean(a.last_telemetry_at) && Date.now()-new Date(a.last_telemetry_at).getTime()<90000,
    currentRotation:rotationMetadata(rotation),
  }
}
function context(account,rotationId) {
  return {tenantId:account.tenant_id,agentId:account.agent_device_id,accountId:account.id,rotationId}
}
export function registerRmmLocalAdminVaultRoutes(app) {
  app.get('/api/v1/rmm/local-admin/accounts',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.view')
    // Reconcile expired requests without silently retrying a credential-changing job.
    await withTransaction(async(client)=>{
      await client.query(
        "UPDATE rmm_agent_jobs SET status='cancelled',completed_at=now(),error_message='Vault rotation job expired before agent claim.',updated_at=now() "+
        "WHERE tenant_id=$1 AND status='queued' AND request_metadata->>'source'='local_admin_vault' "+
        "AND request_metadata ? 'expires_at' AND (request_metadata->>'expires_at')::timestamptz<now()",
        [session.tenant_id])
      await client.query(
        "UPDATE rmm_agent_jobs SET status='failed',completed_at=now(),error_message='Vault rotation acknowledgement timeout. No automatic retry is allowed.',updated_at=now() "+
        "WHERE tenant_id=$1 AND status='claimed' AND job_type='laps.rotate' AND claimed_at<now()-interval '20 minutes'",
        [session.tenant_id])
      await client.query(
        "UPDATE rmm_local_admin_rotations r SET state=CASE WHEN r.state='escrowed' THEN 'uncertain' ELSE 'failed' END,updated_at=now() "+
        "FROM rmm_agent_jobs j WHERE r.job_id=j.id AND r.tenant_id=$1 AND r.state IN ('queued','escrowed') "+
        "AND j.status IN ('cancelled','failed')",
        [session.tenant_id])
    })
    // No blind retry of an account-deletion job: a lost acknowledgement may
    // mean Windows already removed the user. Queued/never-claimed jobs can be
    // safely reverted to the previous managed state; claimed timeouts cannot.
    await withTransaction(async(client)=>{
      const unsettled=await client.query(
        "SELECT a.id,a.tenant_id,a.state,j.id AS job_id,j.status,j.claimed_at,j.request_metadata FROM rmm_local_admin_accounts a JOIN rmm_agent_jobs j ON j.id=a.removal_job_id WHERE a.tenant_id=$1 AND a.state='removing' AND j.job_type='laps.remove' AND (j.status IN ('failed','cancelled') OR (j.status='claimed' AND j.claimed_at<now()-interval '20 minutes')) FOR UPDATE OF a",
        [session.tenant_id])
      for(const item of unsettled.rows){
        if(item.status==='cancelled' && !item.claimed_at){
          const previous=['active','disabled'].includes(item.request_metadata?.previous_state)?item.request_metadata.previous_state:'disabled'
          await client.query("UPDATE rmm_local_admin_accounts SET state=$2,removal_job_id=NULL,last_error='Removal request expired before device claim; no account deletion was sent.',updated_at=now() WHERE id=$1",[item.id,previous])
          await audited(client,{tenantId:item.tenant_id,accountId:item.id,eventType:'removal.not_dispatched',actorKind:'system',detail:{jobId:item.job_id}})
        }else{
          await client.query("UPDATE rmm_local_admin_accounts SET state='removal_uncertain',last_error='Windows account removal cannot be confirmed. Check device account SID before retrying.',updated_at=now() WHERE id=$1",[item.id])
          await audited(client,{tenantId:item.tenant_id,accountId:item.id,eventType:'removal.uncertain',actorKind:'system',detail:{jobId:item.job_id}})
          if(item.status==='claimed')
            await client.query("UPDATE rmm_agent_jobs SET status='failed',error_message='Removal acknowledgement timed out; do not automatically replay account deletion.',updated_at=now(),completed_at=now() WHERE id=$1 AND status='claimed'",[item.job_id])
        }
      }
    })
    // If a result callback succeeded but its reconciliation was interrupted,
    // complete the same verified receipt on the next authenticated read.
    const unprocessed=await pool.query(
      "SELECT j.* FROM rmm_local_admin_accounts a JOIN rmm_agent_jobs j ON j.id=a.removal_job_id WHERE a.tenant_id=$1 AND a.state='removing' AND j.job_type='laps.remove' AND j.status='completed' LIMIT 20",
      [session.tenant_id])
    for(const job of unprocessed.rows) await reconcileLocalAdminJobResult(job,true)
    const result=await pool.query(
      'SELECT a.*,i.name AS device_name,d.agent_version,d.websocket_status,d.last_telemetry_at,r.state AS rotation_state,r.escrowed_at,r.activated_at,r.reveal_count,r.revealed_at,r.created_at AS rotation_created_at FROM rmm_local_admin_accounts a JOIN rmm_agent_devices d ON d.id=a.agent_device_id JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=a.tenant_id LEFT JOIN rmm_local_admin_rotations r ON r.id=a.current_rotation_id WHERE a.tenant_id=$1 AND d.disabled_at IS NULL ORDER BY i.name',
      [session.tenant_id])
    const deviceRows=await pool.query(
      "SELECT a.id AS agent_device_id,i.name,i.platform,a.agent_version,a.last_telemetry_at,a.websocket_status FROM rmm_agent_devices a JOIN rmm_device_inventory i ON i.id=a.inventory_id WHERE a.tenant_id=$1 AND a.disabled_at IS NULL AND i.active=true AND i.platform ILIKE '%windows%' AND NOT EXISTS(SELECT 1 FROM rmm_local_admin_accounts m WHERE m.tenant_id=a.tenant_id AND m.agent_device_id=a.id AND m.state<>'removed') ORDER BY i.name",
      [session.tenant_id])
    return c.json({accounts:result.rows.map((a)=>exposedAccount(a,a.rotation_state?{id:a.current_rotation_id,state:a.rotation_state,escrowed_at:a.escrowed_at,activated_at:a.activated_at,reveal_count:a.reveal_count,revealed_at:a.revealed_at,created_at:a.rotation_created_at}:null)),
      availableDevices:deviceRows.rows.map((row)=>({id:row.agent_device_id,name:row.name,version:row.agent_version,online:row.websocket_status==='Connected'&&row.last_telemetry_at&&Date.now()-new Date(row.last_telemetry_at).getTime()<90000})),
      canRotate:hasPermission(session.access,'rmm.security.local_admin.rotate'),
      canRemove:hasPermission(session.access,'rmm.security.local_admin.remove'),
      canReveal:hasPermission(session.access,'rmm.security.local_admin.read'),
      vaultMode:'hi5central-managed-separate-from-native-windows-laps'})
  }))
  app.post('/api/v1/rmm/local-admin/accounts',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.rotate')
    const body=await c.req.json().catch(()=>({}))
    const agentDeviceId=clean(body.agentDeviceId,70)
    if (!idPattern.test(agentDeviceId)) throw fail('Choose an enrolled Windows agent.')
    const name=validateDedicatedLocalAdminName(clean(body.name||'Hi5Recovery',40))
    const agent=await pool.query(
      "SELECT a.id,a.inventory_id,a.agent_version,i.platform FROM rmm_agent_devices a JOIN rmm_device_inventory i ON i.id=a.inventory_id WHERE a.tenant_id=$1 AND a.id=$2 AND a.disabled_at IS NULL AND i.active=true",
      [session.tenant_id,agentDeviceId])
    if (!agent.rowCount || !/windows/i.test(agent.rows[0].platform||'')) throw fail('This device does not have an active Windows agent.',409)
    const saved=await withTransaction(async(client)=>{
      const result=await client.query(
        "INSERT INTO rmm_local_admin_accounts(tenant_id,agent_device_id,inventory_id,account_name,created_by_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,agent_device_id) DO UPDATE SET account_name=EXCLUDED.account_name,account_sid=NULL,state='pending',current_rotation_id=NULL,last_rotated_at=NULL,next_rotation_at=NULL,last_error=NULL,removal_job_id=NULL,removed_at=NULL,created_by_user_id=EXCLUDED.created_by_user_id,updated_at=now() WHERE rmm_local_admin_accounts.state='removed' RETURNING *",
        [session.tenant_id,agentDeviceId,agent.rows[0].inventory_id,name,session.user_id])
      if (!result.rowCount) throw fail('This device already has a registered managed local administrator account.',409)
      const row=result.rows[0]
      await audited(client,{tenantId:session.tenant_id,accountId:row.id,eventType:'account.registered',actorId:session.user_id,reason:'Enable separate Hi5Central local administrator vault'})
      return row
    })
    return c.json({id:saved.id,name:saved.account_name,state:saved.state,created:true},201)
  }))
  app.post('/api/v1/rmm/local-admin/accounts/:accountId/rotate',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.rotate')
    const body=await c.req.json().catch(()=>({}))
    const reason=clean(body.reason,500)
    if (reason.length<10) throw fail('Provide a business reason for password rotation.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    if (!['pending','active','error'].includes(account.state)) throw fail('Local admin management is paused, being removed, or already removed.',409)
    if (account.websocket_status!=='Connected'||!account.last_telemetry_at||Date.now()-new Date(account.last_telemetry_at).getTime()>90000) throw fail('The device must be online for immediate rotation.',409)
    const version=String(account.agent_version||'').match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)/)
    if (!version || Number(version[1])!==1 || Number(version[2])!==0 || Number(version[3])<509) throw fail('Hi5Central Agent 1.0.509 or newer is required for secure local administrator rotation.',409)
    const saved=await withTransaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[session.tenant_id+':laps:'+account.id])
      const pending=await client.query(
        "SELECT id FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND state IN ('queued','escrowed','uncertain') LIMIT 1",
        [session.tenant_id,account.id])
      if (pending.rowCount) throw fail('There is already a pending rotation. Resolve it before another request.',409)
      const inserted=await client.query(
        "INSERT INTO rmm_agent_jobs(tenant_id,agent_device_id,job_type,payload,queued_by_user_id,initiated_by,initiated_by_label,request_metadata) VALUES($1,$2,'laps.rotate',$3::jsonb,$4,'technician',$5,$6::jsonb) RETURNING id",
        [session.tenant_id,account.agent_device_id,JSON.stringify({
          account_id:account.id,account_name:account.account_name,
          expected_sid:account.account_sid||'',create:!account.account_sid,
        }),session.user_id,clean(session.name||session.email||'Technician',120),
          JSON.stringify({source:'local_admin_vault',expires_at:new Date(Date.now()+180000).toISOString(),account_id:account.id})])
      const jobId=inserted.rows[0].id
      const rotation=await client.query(
        "INSERT INTO rmm_local_admin_rotations(tenant_id,account_id,agent_device_id,job_id,reason,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [session.tenant_id,account.id,account.agent_device_id,jobId,reason,session.user_id])
      await audited(client,{tenantId:session.tenant_id,accountId:account.id,rotationId:rotation.rows[0].id,eventType:'rotation.requested',actorId:session.user_id,reason})
      return {jobId,rotationId:rotation.rows[0].id}
    })
    return c.json({state:'queued',...saved},202)
  }))
  // Pausing is reversible and intentionally preserves the Windows account,
  // the current escrow and historical audit; it only blocks future rotations.
  app.post('/api/v1/rmm/local-admin/accounts/:accountId/management',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.rotate')
    const body=await c.req.json().catch(()=>({}))
    const action=clean(body.action,24)
    const reason=clean(body.reason,500)
    if (!['pause','resume'].includes(action)) throw fail('Choose pause or resume.')
    if (reason.length<10) throw fail('Enter a business reason of at least 10 characters.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    if (action==='pause' && !['pending','active','error'].includes(account.state)) throw fail('This account cannot be paused in its current state.',409)
    if (action==='resume' && account.state!=='disabled') throw fail('This account is not paused.',409)
    const updated=await withTransaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[session.tenant_id+':laps:'+account.id])
      const locked=await accountFor(session.tenant_id,account.id,client)
      if (locked.state!==account.state) throw fail('Account changed. Refresh before continuing.',409)
      const pending=await client.query("SELECT id FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND state IN ('queued','escrowed','uncertain') LIMIT 1",
        [session.tenant_id,account.id])
      if (pending.rowCount) throw fail('Resolve the unfinished rotation before changing management state.',409)
      const newState=action==='pause'?'disabled':locked.account_sid?'active':'pending'
      await client.query("UPDATE rmm_local_admin_accounts SET state=$2,last_error=NULL,updated_at=now() WHERE id=$1",[account.id,newState])
      await audited(client,{tenantId:session.tenant_id,accountId:account.id,eventType:action==='pause'?'management.paused':'management.resumed',
        actorId:session.user_id,reason,detail:{windowsAccountPreserved:true,credentialPreserved:true}})
      return newState
    })
    return c.json({state:updated,windowsAccountPreserved:true,credentialPreserved:true})
  }))
  // Registered-but-never-created account can be removed without touching
  // Windows. Active accounts must use the dedicated SID-verifying Agent job.
  app.post('/api/v1/rmm/local-admin/accounts/:accountId/unregister',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.remove')
    const body=await c.req.json().catch(()=>({}))
    const reason=clean(body.reason,500)
    if (reason.length<12) throw fail('A removal reason of at least 12 characters is required.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    if (body.confirmName!==account.account_name) throw fail('Type the exact account name to confirm.',409)
    if (account.account_sid||account.current_rotation_id) throw fail('This account exists on Windows or has an active credential. Use verified device removal.',409)
    if (!['pending','error','disabled'].includes(account.state)) throw fail('This registration cannot be removed while a credential operation is in progress.',409)
    await withTransaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[session.tenant_id+':laps:'+account.id])
      const pending=await client.query("SELECT id FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND state IN ('queued','escrowed','uncertain') LIMIT 1",
        [session.tenant_id,account.id])
      if (pending.rowCount) throw fail('Finish the pending rotation before unregistering.',409)
      const protectedCredential=await client.query("SELECT 1 FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND credential_ciphertext IS NOT NULL LIMIT 1",
        [session.tenant_id,account.id])
      if (protectedCredential.rowCount) throw fail('This account still has protected credentials; do not unregister without verified Windows removal.',409)
      const row=await client.query(
        "UPDATE rmm_local_admin_accounts SET state='removed',removed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND account_sid IS NULL AND current_rotation_id IS NULL RETURNING id",
        [account.id,session.tenant_id])
      if (!row.rowCount) throw fail('The account registration changed; refresh.',409)
      await audited(client,{tenantId:session.tenant_id,accountId:account.id,eventType:'registration.removed',
        actorId:session.user_id,reason,detail:{windowsAccountTouched:false}})
    })
    return c.json({removed:true,windowsAccountTouched:false})
  }))
  app.post('/api/v1/rmm/local-admin/accounts/:accountId/remove',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.remove')
    const body=await c.req.json().catch(()=>({}))
    const reason=clean(body.reason,500)
    if (reason.length<12) throw fail('Enter a removal justification of at least 12 characters.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    if (body.confirmName!==('REMOVE '+account.account_name)) throw fail('Type REMOVE followed by the exact managed account name.',409)
    if(body.confirmedAlternativeAdmin!==true) throw fail('Confirm that another working administrator login is available before deleting the recovery account.',409)
    if (!account.account_sid||!account.current_rotation_id) throw fail('This registration has no activated Windows account; unregister it instead.',409)
    if (!['active','disabled'].includes(account.state)) throw fail('This account is being changed or requires a manual security review.',409)
    if (account.websocket_status!=='Connected'||!account.last_telemetry_at||
        Date.now()-new Date(account.last_telemetry_at).getTime()>90000) throw fail('The device must be online to verify account removal.',409)
    const v=String(account.agent_version||'').match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)/)
    if (!v||Number(v[1])!==1||Number(v[2])!==0||Number(v[3])<510)
      throw fail('Hi5Central Agent 1.0.510 or newer is required for SID-verified removal.',409)
    const queued=await withTransaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[session.tenant_id+':laps:'+account.id])
      const locked=await accountFor(session.tenant_id,account.id,client)
      if (locked.state!==account.state||locked.account_sid!==account.account_sid) throw fail('Account changed before removal. Refresh.',409)
      const pending=await client.query("SELECT id FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND state IN ('queued','escrowed','uncertain') LIMIT 1",
        [session.tenant_id,account.id])
      if (pending.rowCount) throw fail('Resolve pending rotation before removal.',409)
      const job=await client.query(
        "INSERT INTO rmm_agent_jobs(tenant_id,agent_device_id,job_type,payload,queued_by_user_id,initiated_by,initiated_by_label,request_metadata) VALUES($1,$2,'laps.remove',$3::jsonb,$4,'technician',$5,$6::jsonb) RETURNING id",
        [session.tenant_id,account.agent_device_id,JSON.stringify({account_id:account.id,account_name:account.account_name,expected_sid:account.account_sid}),
          session.user_id,clean(session.name||session.email||'Technician',120),
          JSON.stringify({source:'local_admin_vault',action:'remove',account_id:account.id,previous_state:account.state,
            expires_at:new Date(Date.now()+180000).toISOString()})])
      await client.query(
        "UPDATE rmm_local_admin_accounts SET state='removing',removal_job_id=$2,last_error=NULL,updated_at=now() WHERE id=$1",
        [account.id,job.rows[0].id])
      await audited(client,{tenantId:session.tenant_id,accountId:account.id,eventType:'removal.requested',
        actorId:session.user_id,reason,detail:{jobId:job.rows[0].id,verifiedWindowsRemovalRequired:true}})
      return job.rows[0].id
    })
    return c.json({jobId:queued,state:'removing'},202)
  }))
  app.get('/api/v1/rmm/local-admin/accounts/:accountId/rotations',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.view')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    const rotations=await pool.query(
      'SELECT id,state,created_at,escrowed_at,activated_at,revealed_at,reveal_count FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 25',
      [session.tenant_id,account.id])
    return c.json({account:exposedAccount(account),rotations:rotations.rows.map(rotationMetadata)})
  }))
  app.post('/api/v1/rmm/local-admin/accounts/:accountId/rotations/:rotationId/reveal',safe(async(c)=>{
    const session=await authorize(c,'rmm.security.local_admin.read')
    const body=await c.req.json().catch(()=>({}))
    const reason=clean(body.reason,500)
    if (reason.length<12) throw fail('Enter a reason for revealing this local administrator password.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    const rotationId=c.req.param('rotationId')
    if (!idPattern.test(rotationId)) throw fail('Invalid rotation ID.')
    const payload=await withTransaction(async(client)=>{
      const result=await client.query(
        "SELECT id,state,credential_ciphertext FROM rmm_local_admin_rotations WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND state IN ('active','escrowed','uncertain') FOR UPDATE",
        [session.tenant_id,account.id,rotationId])
      if (!result.rowCount || !result.rows[0].credential_ciphertext) throw fail('Recoverable credential not found.',404)
      // Expose an escrowed/uncertain candidate only with clear warning: it might not be the current password.
      const password=revealLocalAdminPassword(result.rows[0].credential_ciphertext,context(account,rotationId))
      await client.query(
        'UPDATE rmm_local_admin_rotations SET reveal_count=reveal_count+1,revealed_at=now(),updated_at=now() WHERE id=$1',
        [rotationId])
      await audited(client,{tenantId:session.tenant_id,accountId:account.id,rotationId,eventType:'credential.revealed',actorId:session.user_id,reason,detail:{state:result.rows[0].state}})
      return {password,state:result.rows[0].state}
    })
    c.header('Cache-Control','no-store, private')
    c.header('Pragma','no-cache')
    return c.json({accountName:account.account_name,password:payload.password,status:payload.state,
      warning:payload.state==='active'?null:'Password escrowed but activation is unconfirmed; it may not be the device current password.'})
  }))
  app.post('/api/v1/agent/laps/escrow',safe(async(c)=>{
    const agent=await agentAuth(c)
    const body=await c.req.json().catch(()=>({}))
    const jobId=clean(body.jobId,70)
    const accountId=clean(body.accountId,70)
    const password=body.password
    if (!idPattern.test(jobId)||!idPattern.test(accountId)||!validLocalAdminPassword(password)) throw fail('Invalid rotation escrow request.')
    const result=await withTransaction(async(client)=>{
      const rotation=await client.query(
        "SELECT r.*,a.account_name,a.account_sid FROM rmm_local_admin_rotations r JOIN rmm_local_admin_accounts a ON a.id=r.account_id JOIN rmm_agent_jobs j ON j.id=r.job_id WHERE r.tenant_id=$1 AND r.agent_device_id=$2 AND r.account_id=$3 AND r.job_id=$4 AND r.state='queued' AND j.job_type='laps.rotate' AND j.status='claimed' AND j.agent_device_id=$2 AND j.request_metadata->>'source'='local_admin_vault' AND j.request_metadata->>'account_id'=r.account_id::text FOR UPDATE OF r",
        [agent.tenant_id,agent.id,accountId,jobId])
      if (!rotation.rowCount) throw fail('Rotation escrow is not available or has already been recorded.',409)
      const item=rotation.rows[0]
      const ciphertext=protectLocalAdminPassword(password,{tenantId:agent.tenant_id,agentId:agent.id,accountId,rotationId:item.id})
      await client.query(
        "UPDATE rmm_local_admin_rotations SET credential_ciphertext=$2,state='escrowed',escrowed_at=now(),updated_at=now() WHERE id=$1",
        [item.id,ciphertext])
      await audited(client,{tenantId:agent.tenant_id,accountId,rotationId:item.id,eventType:'credential.escrowed',actorKind:'agent'})
      return {id:item.id}
    })
    return c.json({accepted:true,rotationId:result.id})
  }))
  app.post('/api/v1/agent/laps/commit',safe(async(c)=>{
    const agent=await agentAuth(c)
    const body=await c.req.json().catch(()=>({}))
    const jobId=clean(body.jobId,70)
    const rotationId=clean(body.rotationId,70)
    const accountId=clean(body.accountId,70)
    const sid=clean(body.accountSid,180)
    if (![jobId,rotationId,accountId].every((item)=>idPattern.test(item))|| !/^S-1-5-21-(\d+-){3}\d+$/.test(sid)||sid.endsWith('-500')) throw fail('Invalid rotation confirmation.')
    const result=await withTransaction(async(client)=>{
      const pending=await client.query(
        "SELECT r.*,a.account_sid FROM rmm_local_admin_rotations r JOIN rmm_local_admin_accounts a ON a.id=r.account_id JOIN rmm_agent_jobs j ON j.id=r.job_id WHERE r.tenant_id=$1 AND r.agent_device_id=$2 AND r.account_id=$3 AND r.id=$4 AND r.job_id=$5 AND r.state='escrowed' AND r.credential_ciphertext IS NOT NULL AND j.status='claimed' AND j.job_type='laps.rotate' AND j.agent_device_id=$2 FOR UPDATE OF r",
        [agent.tenant_id,agent.id,accountId,rotationId,jobId])
      if (!pending.rowCount) throw fail('No escrowed rotation awaiting activation.',409)
      if (pending.rows[0].account_sid && pending.rows[0].account_sid!==sid) throw fail('Managed account identity changed; refusing activation.',409)
      await client.query(
        "UPDATE rmm_local_admin_rotations SET state='superseded',credential_ciphertext=NULL,retired_at=now(),updated_at=now() WHERE tenant_id=$1 AND account_id=$2 AND state='active'",
        [agent.tenant_id,accountId])
      await client.query(
        "UPDATE rmm_local_admin_rotations SET state='active',activated_at=now(),updated_at=now() WHERE id=$1",
        [rotationId])
      await client.query(
        "UPDATE rmm_local_admin_accounts SET account_sid=$2,state='active',current_rotation_id=$3,last_rotated_at=now(),next_rotation_at=now()+interval '30 days',last_error=NULL,updated_at=now() WHERE id=$1",
        [accountId,sid,rotationId])
      await audited(client,{tenantId:agent.tenant_id,accountId,rotationId,eventType:'credential.activated',actorKind:'agent'})
      return {id:rotationId}
    })
    return c.json({accepted:true,rotationId:result.id})
  }))
}
// Called only after a dedicated non-secret agent job result.
export async function reconcileLocalAdminJobResult(job,success) {
  if (job.request_metadata?.source!=='local_admin_vault') return
  if (job.job_type==='laps.remove') {
    await withTransaction(async(client)=>{
      const result=await client.query(
        "SELECT id,tenant_id,account_sid,agent_device_id FROM rmm_local_admin_accounts WHERE tenant_id=$1 AND agent_device_id=$2 AND removal_job_id=$3 AND state='removing' FOR UPDATE",
        [job.tenant_id,job.agent_device_id,job.id])
      if(!result.rowCount)return
      const a=result.rows[0]
      const receipt=job.result||{}
      const verified=success && receipt.status==='removed' && receipt.verified_absent===true
        && receipt.account_sid===a.account_sid && a.account_sid
      if (verified){
        await client.query(
          "UPDATE rmm_local_admin_rotations SET credential_ciphertext=NULL,retired_at=COALESCE(retired_at,now()),state=CASE WHEN state='active' THEN 'superseded' ELSE state END,updated_at=now() WHERE tenant_id=$1 AND account_id=$2",
          [job.tenant_id,a.id])
        await client.query(
          "UPDATE rmm_local_admin_accounts SET state='removed',account_sid=NULL,current_rotation_id=NULL,next_rotation_at=NULL,removal_job_id=NULL,removed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",
          [a.id])
        await audited(client,{tenantId:job.tenant_id,accountId:a.id,eventType:'removal.verified',
          actorKind:'agent',detail:{jobId:job.id,windowsAccountAbsent:true,escrowRetired:true}})
      } else {
        await client.query(
          "UPDATE rmm_local_admin_accounts SET state='removal_uncertain',last_error='The Windows account removal result was not verified. Inspect the device SID before any retry.',updated_at=now() WHERE id=$1",
          [a.id])
        await audited(client,{tenantId:job.tenant_id,accountId:a.id,eventType:'removal.uncertain',
          actorKind:'agent',detail:{jobId:job.id,receiptVerified:false}})
      }
    })
    return
  }
  if (job.job_type!=='laps.rotate') return
  await withTransaction(async(client)=>{
    const result=await client.query(
      'SELECT r.id,r.state,r.account_id FROM rmm_local_admin_rotations r WHERE r.job_id=$1 AND r.tenant_id=$2 AND r.agent_device_id=$3 FOR UPDATE',
      [job.id,job.tenant_id,job.agent_device_id])
    if (!result.rowCount) return
    const row=result.rows[0]
    if (success && row.state==='active') return
    // A first-time account creation can fail *after* escrow but *before*
    // activation. The native Agent reports an explicit marker ONLY after
    // NetUserDel succeeds and a follow-up SID lookup confirms no account
    // remains. In that proven rollback case the escrowed candidate is not
    // a usable credential and must not be exposed or block a retry.
    const verifiedCreationRollback = !success && ['escrowed','uncertain'].includes(row.state)
      && String(job.error_message||'').startsWith('LAPS_ACCOUNT_CREATION_ROLLED_BACK:')
    const targetState=verifiedCreationRollback?'failed'
      :row.state==='escrowed'?'uncertain':row.state==='queued'?'failed':row.state
    if (targetState===row.state) return
    await client.query(
      "UPDATE rmm_local_admin_rotations SET state=$2,credential_ciphertext=CASE WHEN $3 THEN NULL ELSE credential_ciphertext END,retired_at=CASE WHEN $3 THEN now() ELSE retired_at END,updated_at=now() WHERE id=$1",
      [row.id,targetState,verifiedCreationRollback])
    await client.query(
      "UPDATE rmm_local_admin_accounts SET state=CASE WHEN $3 AND current_rotation_id IS NULL THEN 'pending' WHEN current_rotation_id IS NULL THEN 'error' ELSE state END,last_error=$2,updated_at=now() WHERE id=$1",
      [row.account_id,verifiedCreationRollback
        ?'Windows account creation was rolled back after a group membership failure. No password was activated.'
        :targetState==='uncertain'?'Rotation activation unconfirmed. Check escrowed candidate and device state.':'Rotation did not complete.',
        verifiedCreationRollback])
    await audited(client,{tenantId:job.tenant_id,accountId:row.account_id,rotationId:row.id,eventType:'rotation.'+targetState,actorKind:'agent',detail:{jobId:job.id,verifiedAccountAbsent:verifiedCreationRollback}})
  })
}
