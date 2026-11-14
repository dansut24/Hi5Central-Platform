import { hasPermission } from './access.js'
import { pool, withTransaction } from './db.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { authenticateAgent } from './rmmAgent.js'
import {
  protectLocalAdminPassword, revealLocalAdminPassword, validLocalAdminPassword,
  validateDedicatedLocalAdminName, revealMfaRecent, rotationMetadata,
} from './rmmLocalAdminVaultCrypto.js'

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const clean=(v,max=256)=>String(v??'').trim().slice(0,max)
function fail(message,status=400) { return Object.assign(new Error(message),{status}) }
function safe(handler) {
  return async (c)=>{
    try { return await handler(c) }
    catch (error) {
      // Never log agent-submitted credentials or complete request bodies.
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
    'SELECT a.*,d.name AS device_name,d.agent_version,d.websocket_status,d.last_telemetry_at FROM rmm_local_admin_accounts a JOIN rmm_agent_devices d ON d.id=a.agent_device_id WHERE a.tenant_id=$1 AND a.id=$2 AND d.disabled_at IS NULL',
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
    const result=await pool.query(
      'SELECT a.*,d.name AS device_name,d.agent_version,d.websocket_status,d.last_telemetry_at,r.state AS rotation_state,r.escrowed_at,r.activated_at,r.reveal_count,r.revealed_at,r.created_at AS rotation_created_at FROM rmm_local_admin_accounts a JOIN rmm_agent_devices d ON d.id=a.agent_device_id LEFT JOIN rmm_local_admin_rotations r ON r.id=a.current_rotation_id WHERE a.tenant_id=$1 AND d.disabled_at IS NULL ORDER BY d.name',
      [session.tenant_id])
    const deviceRows=await pool.query(
      "SELECT a.id AS agent_device_id,i.name,i.platform,a.agent_version,a.last_telemetry_at,a.websocket_status FROM rmm_agent_devices a JOIN rmm_device_inventory i ON i.id=a.inventory_id WHERE a.tenant_id=$1 AND a.disabled_at IS NULL AND i.active=true AND i.platform ILIKE '%windows%' AND NOT EXISTS(SELECT 1 FROM rmm_local_admin_accounts m WHERE m.tenant_id=a.tenant_id AND m.agent_device_id=a.id) ORDER BY i.name",
      [session.tenant_id])
    return c.json({accounts:result.rows.map((a)=>exposedAccount(a,a.rotation_state?{id:a.current_rotation_id,state:a.rotation_state,escrowed_at:a.escrowed_at,activated_at:a.activated_at,reveal_count:a.reveal_count,revealed_at:a.revealed_at,created_at:a.rotation_created_at}:null)),
      availableDevices:deviceRows.rows.map((row)=>({id:row.agent_device_id,name:row.name,version:row.agent_version,online:row.websocket_status==='Connected'&&row.last_telemetry_at&&Date.now()-new Date(row.last_telemetry_at).getTime()<90000})),
      canRotate:hasPermission(session.access,'rmm.security.local_admin.rotate'),
      canReveal:hasPermission(session.access,'rmm.security.local_admin.read'),
      recentlyVerified:revealMfaRecent(session),
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
        "INSERT INTO rmm_local_admin_accounts(tenant_id,agent_device_id,inventory_id,account_name,created_by_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,agent_device_id) DO NOTHING RETURNING *",
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
    if (!revealMfaRecent(session)) throw fail('Complete fresh MFA within the last five minutes before rotating a privileged account.',403)
    const body=await c.req.json().catch(()=>({}))
    const reason=clean(body.reason,500)
    if (reason.length<10) throw fail('Provide a business reason for password rotation.')
    const account=await accountFor(session.tenant_id,c.req.param('accountId'))
    if (account.state==='disabled') throw fail('Account management is disabled.',409)
    if (account.websocket_status!=='Connected'||!account.last_telemetry_at||Date.now()-new Date(account.last_telemetry_at).getTime()>90000) throw fail('The device must be online for immediate rotation.',409)
    const version=String(account.agent_version||'').match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)/)
    if (!version || Number(version[1])!==1 || Number(version[2])!==0 || Number(version[3])<507) throw fail('A Hi5Central Agent version with secure local-admin rotation support is required.',409)
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
    if (!revealMfaRecent(session)) throw fail('For password reveal, sign in again and complete MFA within the last 5 minutes.',403)
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
        "SELECT r.*,a.account_name,a.account_sid FROM rmm_local_admin_rotations r JOIN rmm_local_admin_accounts a ON a.id=r.account_id JOIN rmm_agent_jobs j ON j.id=r.job_id WHERE r.tenant_id=$1 AND r.agent_device_id=$2 AND r.account_id=$3 AND r.job_id=$4 AND r.state='queued' AND j.job_type='laps.rotate' AND j.status='claimed' AND j.agent_device_id=$2 AND j.request_metadata->>'source'='local_admin_vault' AND j.request_metadata->>'account_id'=$3 FOR UPDATE OF r",
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
  if (job.job_type!=='laps.rotate'||job.request_metadata?.source!=='local_admin_vault') return
  await withTransaction(async(client)=>{
    const result=await client.query(
      'SELECT r.id,r.state,r.account_id FROM rmm_local_admin_rotations r WHERE r.job_id=$1 AND r.tenant_id=$2 AND r.agent_device_id=$3 FOR UPDATE',
      [job.id,job.tenant_id,job.agent_device_id])
    if (!result.rowCount) return
    const row=result.rows[0]
    if (success && row.state==='active') return
    const targetState=row.state==='escrowed'?'uncertain':row.state==='queued'?'failed':row.state
    if (targetState===row.state) return
    await client.query('UPDATE rmm_local_admin_rotations SET state=$2,updated_at=now() WHERE id=$1',[row.id,targetState])
    await client.query(
      "UPDATE rmm_local_admin_accounts SET state=CASE WHEN current_rotation_id IS NULL THEN 'error' ELSE state END,last_error=$2,updated_at=now() WHERE id=$1",
      [row.account_id,targetState==='uncertain'?'Rotation activation unconfirmed. Check escrowed candidate and device state.':'Rotation did not complete.'])
    await audited(client,{tenantId:job.tenant_id,accountId:row.account_id,rotationId:row.id,eventType:'rotation.'+targetState,actorKind:'agent',detail:{jobId:job.id}})
  })
}
