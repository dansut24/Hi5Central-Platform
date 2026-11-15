// EPM file-specific support approvals. Pilot disabled unless explicitly scoped to a tenant and device.
// These routes NEVER execute commands: only the local authenticated Windows broker may redeem.
import { hasPermission } from './access.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { pool } from './db.js'
import { authenticateAgent } from './rmmAgent.js'
import { recordRmmActivity } from './rmmActivity.js'
import { resolveSession } from './session.js'
import { validateNativeUacRequest, validateNativeUacStatusRequest, canReleaseNativeUacCredential } from './rmmEpmUacPolicy.js'
import { validateFileAutoLaunchIntent } from './rmmEpmAutoLaunchPolicy.js'
import { validateManagedAction } from './rmmEpmManagedUacPolicy.js'
import { assessEpmApproval, decideEpmApproval } from './rmmEpmApprovalPolicy.js'

const pilotTenant = (process.env.RMM_EPM_PILOT_TENANT || '').trim().toLowerCase()
const pilotDevice = (process.env.RMM_EPM_PILOT_DEVICE || '').trim().toLowerCase()
// Hardened is the safe default. The existing Newtest endpoint uses an
// explicit 'pilot' profile until dual-person tests are qualified.
const approvalProfile=process.env.RMM_EPM_APPROVAL_PROFILE==='pilot'?'pilot':'hardened'
const breakGlassEnabled=process.env.RMM_EPM_BREAKGLASS_ENABLED==='true'
const allowedFileHashes=(process.env.RMM_EPM_ADMITTED_EXE_SHA256||'')
  .split(',').map(value=>value.trim().toUpperCase())
  .filter(value=>/^[A-F0-9]{64}$/.test(value))
const epmRisk=(row)=>assessEpmApproval(row,{
  profile:approvalProfile,breakGlassEnabled,allowedFileHashes
})

const clean = (v) => String(v ?? '').trim()
const validId = (v) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(clean(v))
const validSha = (v) => /^[A-F0-9]{64}$/.test(clean(v))
const allowed = (v) => /^[0-9A-F]{40,128}$/.test(clean(v))
const safePath = (v) => typeof v === 'string' && v.length > 3 && v.length <= 2048
  && /^[A-Za-z]:\\(?!\\)/.test(v) && !v.includes('..\\')
  && !v.startsWith('\\\\') && !v.includes(':', 3)
  && !/[\u0000-\u001F]/.test(v) && v.toLowerCase().endsWith('.exe')
const pilot = (agent) => pilotTenant === 'newtest' && pilotDevice
  && String(agent.id).toLowerCase() === pilotDevice
async function pilotAllowed(agent) {
  if (!pilot(agent)) return false
  const q = await pool.query('SELECT 1 FROM tenants WHERE id=$1 AND slug=$2', [agent.tenant_id,pilotTenant])
  return q.rowCount === 1
}
async function requireAgent(c) {
  const agent = await authenticateAgent(c.req.header('x-hi5-device-id'),c.req.header('x-hi5-agent-secret'))
  if (!agent) return { error:c.json({error:'Agent authentication required.'},401) }
  if (!await pilotAllowed(agent)) return {error:c.json({error:'File elevation is not enabled for this endpoint.'},403)}
  return {agent}
}
async function requireTechnician(c) {
  const session = await resolveSession(c)
  if (!session) return {error:c.json({error:'Authentication required.'},401)}
  if (!originMatchesTenant(c.req.header('origin'),session.slug)) return {error:c.json({error:'Tenant mismatch.'},403)}
  if (!hasPermission(session.access,'rmm.software.manage')) return {error:c.json({error:'Insufficient privileges.'},403)}
  if (!pilotTenant || session.slug !== pilotTenant) return {error:c.json({error:'Elevation pilot not enabled for this tenant.'},403)}
  return {session}
}
function matchBinding(body,row) {
  return clean(body.sid) === row.requester_sid
    && Number.isInteger(body.sessionId) && body.sessionId === row.requester_session_id
    && clean(body.path) === row.file_path
    && clean(body.sha256).toUpperCase() === row.file_sha256
    && clean(body.signerThumbprint).toUpperCase() === row.signer_thumbprint
    && (clean(body.operationCode) || null) === row.managed_action_code
    && (clean(body.argumentsSha256).toUpperCase() || null) === row.managed_arguments_sha256
}
export function registerRmmEpmFileRoutes(app) {
  app.post('/api/v1/agent/epm/file-requests', async c => {
    const auth = await requireAgent(c); if (auth.error) return auth.error
    const b = await c.req.json().catch(()=>({}))
    const sid=clean(b.sid), name=clean(b.username), filePath=clean(b.path)
    const hash=clean(b.sha256).toUpperCase(), thumb=clean(b.signerThumbprint).toUpperCase()
    const publisher=clean(b.publisher), reason=clean(b.reason)
    const requestSource=['native-uac','managed-uac'].includes(clean(b.source))?clean(b.source):'explorer'
    // Only an explicitly requested, trusted Explorer EXE may auto-run.
    // This flag is never accepted for an unbound/native UAC operation.
    const autoLaunch=validateFileAutoLaunchIntent(b)
    if (!autoLaunch.ok) return c.json({error:autoLaunch.error},400)
    const autoLaunchOnApproval=autoLaunch.autoLaunchOnApproval
    const managed=validateManagedAction({
      source:requestSource,operationCode:b.operationCode,argumentsSha256:b.argumentsSha256,
      filePath,autoLaunchOnApproval
    })
    if (!managed.ok) return c.json({error:managed.error},400)
    if (!/^S-1-[0-9-]{5,220}$/.test(sid) || sid.length > 255
      || !Number.isInteger(b.sessionId) || b.sessionId < 1 || b.sessionId > 2147483647
      || !safePath(filePath) || !validSha(hash) || !allowed(thumb)
      || !publisher || publisher.length > 255 || name.length > 255
      || b.signatureStatus !== 'Valid' || reason.length < 20 || reason.length > 2000)
      return c.json({error:'Invalid identity, verified executable, or business justification.'},400)
    const existing=await pool.query(
      `SELECT id,status,approval_expires_at,auto_launch_on_approval FROM rmm_epm_file_requests
       WHERE tenant_id=$1 AND agent_device_id=$2 AND requester_sid=$3
         AND requester_session_id=$4 AND file_path=$5 AND file_sha256=$6
         AND signer_thumbprint=$7 AND request_source=$8
         AND managed_action_code IS NOT DISTINCT FROM $9
         AND managed_arguments_sha256 IS NOT DISTINCT FROM $10
         AND status IN ('pending','approved')
       ORDER BY created_at DESC LIMIT 1`,
      [auth.agent.tenant_id,auth.agent.id,sid,b.sessionId,filePath,hash,thumb,requestSource,managed.code,managed.digest])
    const cur=existing.rows[0]
    if (cur && (cur.status==='pending' || (cur.approval_expires_at && Date.parse(cur.approval_expires_at)>Date.now())))
      return c.json({success:true,requestId:cur.id,status:cur.status,duplicate:true,
        autoLaunchOnApproval:cur.auto_launch_on_approval})
    const result=await pool.query(
      `INSERT INTO rmm_epm_file_requests
      (tenant_id,agent_device_id,requester_sid,requester_name,requester_session_id,
      file_path,file_name,file_sha256,publisher,signer_thumbprint,business_reason,request_source,auto_launch_on_approval,managed_action_code,managed_arguments_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,status,auto_launch_on_approval`,
      [auth.agent.tenant_id,auth.agent.id,sid,name,b.sessionId,filePath,filePath.split('\\').pop(),hash,publisher,thumb,reason,requestSource,autoLaunchOnApproval,managed.code,managed.digest])
    return c.json({success:true,requestId:result.rows[0].id,status:'pending',
      autoLaunchOnApproval:result.rows[0].auto_launch_on_approval},201)
  })
  app.post('/api/v1/agent/epm/file-requests/:id/status', async c => {
    const auth=await requireAgent(c); if(auth.error) return auth.error
    if(!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const r=await pool.query(
      'SELECT * FROM rmm_epm_file_requests WHERE id=$1 AND agent_device_id=$2 AND tenant_id=$3',
      [c.req.param('id'),auth.agent.id,auth.agent.tenant_id])
    const item=r.rows[0]
    if (!item || !matchBinding(b,item)) return c.json({error:'Request is not bound to this file and user.'},404)
    const expired=item.status==='approved' && new Date(item.approval_expires_at)<=new Date()
    return c.json({success:true,status:expired?'expired':item.status,
      approvalExpiresAt:item.approval_expires_at,decisionNote:item.decision_note,
      autoLaunchOnApproval:item.auto_launch_on_approval===true,
      operationCode:item.managed_action_code,argumentsSha256:item.managed_arguments_sha256})
  })
  app.post('/api/v1/agent/epm/file-requests/:id/redeem', async c => {
    const auth=await requireAgent(c); if(auth.error) return auth.error
    if(!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    if (!safePath(b.path) || !validSha(clean(b.sha256).toUpperCase()) || !allowed(clean(b.signerThumbprint).toUpperCase()))
      return c.json({error:'Invalid file identity.'},400)
    const result=await pool.query(
      `UPDATE rmm_epm_file_requests SET status='redeemed',redeemed_at=now(),updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND agent_device_id=$3 AND status='approved'
         AND approval_expires_at>now() AND requester_sid=$4 AND requester_session_id=$5
         AND file_path=$6 AND file_sha256=$7 AND signer_thumbprint=$8
         AND managed_action_code IS NOT DISTINCT FROM $9
         AND managed_arguments_sha256 IS NOT DISTINCT FROM $10 RETURNING id`,
      [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,clean(b.sid),b.sessionId,
       clean(b.path),clean(b.sha256).toUpperCase(),clean(b.signerThumbprint).toUpperCase(),
       clean(b.operationCode)||null,clean(b.argumentsSha256).toUpperCase()||null])
    if (!result.rowCount) return c.json({error:'Approval expired, changed or already used.'},409)
    return c.json({success:true,redeemed:true})
  })
  app.post('/api/v1/agent/epm/file-requests/:id/failed', async c => {
    const auth=await requireAgent(c); if(auth.error) return auth.error
    if (!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const stages=new Set([
      'service-security-context','create-admin-identity','assign-admin-group','logon-identity',
      'validate-elevated-token','duplicate-check-token',
      'check-token-membership','duplicate-primary-token',
      'bind-desktop-session','resolve-admin-sid','load-admin-profile',
      'create-user-environment','create-process-job','set-process-job-limits',
      'create-elevated-process','assign-process-job','resume-approved-process',
      'desktop-client-handles','desktop-open-client','desktop-duplicate-station',
      'desktop-duplicate-desktop','desktop-handle-identity','desktop-query-identity',
      'desktop-read-acl','desktop-missing-acl','desktop-write-acl',
      'desktop-duplicate-admin-sid','desktop-grant-connection',
      'desktop-grant-invalid','desktop-grant-rejected',
      'desktop-grant-timeout','desktop-grant-pipe-io','desktop-grant-json',
      'desktop-grant-protocol','desktop-grant-access','desktop-grant-unexpected',
      'desktop-client-station','desktop-client-default','desktop-client-identity',
      'desktop-open-station','desktop-open-default','desktop-grant-sid',
      'desktop-grant-client-error',
      'launch-resolve-admin-group','launch-logon-identity','launch-validate-admin-token',
      'launch-bind-desktop-session','launch-resolve-admin-sid',
      'launch-desktop-grant-handshake','launch-load-admin-profile',
      'launch-create-user-environment','launch-create-process-job',
      'launch-create-elevated-process','launch-assign-process-job',
      'launch-resume-approved-process','launch-track-approved-process',
      'launch-access-denied','launch-cancelled','launch-io',
      'launch-invalid-operation','launch-win32-error','launch-json',
      'track-approved-process','unexpected-launch-error',
    ])
    const stage=clean(b.stage)
    const win32Code=b.win32Code
    if (!stages.has(stage) || !Number.isInteger(win32Code) || win32Code < 0 || win32Code > 65535)
      return c.json({error:'Invalid launch diagnostic codes.'},400)
    const result=await pool.query(
      `UPDATE rmm_epm_file_requests
          SET status='launch_failed',launch_failure_stage=$5,
              launch_failure_code=$6,launch_failure_at=now(),updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND agent_device_id=$3 AND status='redeemed'
       AND requester_sid=$4 RETURNING id`,
      [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,clean(b.sid),stage,win32Code])
    return c.json({success:Boolean(result.rowCount)})
  })
  // Agent-authenticated, request-bound process telemetry. Completion of a
  // process is deliberately NOT treated as successful software installation.
  app.post('/api/v1/agent/epm/file-requests/:id/lifecycle', async c => {
    const auth=await requireAgent(c); if(auth.error) return auth.error
    if(!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const phase=clean(b.phase), pid=b.pid, sid=clean(b.sid)
    const reasons=new Set(['job-empty','timeout','job-query-error','monitor-error','service-stopped'])
    if(!['started','ended'].includes(phase) || !/^S-1-[0-9-]{5,220}$/.test(sid)
      || !Number.isInteger(pid) || pid<1 || pid>2147483647)
      return c.json({error:'Invalid process lifecycle.'},400)
    if(phase==='started') {
      const q=await pool.query(
        `UPDATE rmm_epm_file_requests
           SET launch_pid=$5,launch_started_at=coalesce(launch_started_at,now()),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND agent_device_id=$3 AND requester_sid=$4
           AND status='redeemed' AND launch_pid IS NULL
         RETURNING id`,
        [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,sid,pid])
      return c.json({success:Boolean(q.rowCount)})
    }
    const reason=clean(b.reason), exitCode=b.exitCode, elapsedMs=b.elapsedMs
    if(!reasons.has(reason) || (exitCode!==null && (!Number.isInteger(exitCode) || exitCode<0 || exitCode>4294967295))
      || !Number.isInteger(elapsedMs) || elapsedMs<0 || elapsedMs>2700000)
      return c.json({error:'Invalid process exit observation.'},400)
    const q=await pool.query(
      `UPDATE rmm_epm_file_requests SET launch_pid=coalesce(launch_pid,$5),
         launch_started_at=coalesce(launch_started_at,now()-($8::integer*interval '1 millisecond')),
         launch_ended_at=now(),launch_exit_code=$6,launch_end_reason=$7,launch_elapsed_ms=$8,
         updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND agent_device_id=$3 AND requester_sid=$4
         AND status='redeemed' AND (launch_pid IS NULL OR launch_pid=$5)
         AND launch_ended_at IS NULL RETURNING id`,
      [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,sid,pid,exitCode,reason,elapsedMs])
    return c.json({success:Boolean(q.rowCount)})
  })
  app.get('/api/v1/rmm/epm/file-requests', async c => {
    const auth=await requireTechnician(c); if(auth.error) return auth.error
    const q=await pool.query(
      `SELECT id,agent_device_id,requester_sid,requester_name,file_name,file_path,
       file_sha256,publisher,signer_thumbprint,business_reason,status,request_source,auto_launch_on_approval,managed_action_code,managed_arguments_sha256,
       first_approved_by_user_id,first_approved_at,first_approval_note,
       decision_note,created_at,decided_at,approval_expires_at,redeemed_at,
       launch_failure_stage,launch_failure_code,launch_failure_at,
       launch_pid,launch_started_at,launch_ended_at,launch_exit_code,
       launch_end_reason,launch_elapsed_ms
       FROM rmm_epm_file_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 150`,
      [auth.session.tenant_id])
    return c.json({requests:q.rows.map(row=>({
      ...row,
      epm_risk:epmRisk(row),
      approval_stage:row.status==='pending'&&row.first_approved_by_user_id
        ? 'awaiting_second':'awaiting_first',
    })),pilot:true,approvalProfile})
  })
  app.post('/api/v1/rmm/epm/file-requests/:id/decision', async c => {
    const auth=await requireTechnician(c);if(auth.error)return auth.error
    if(!validId(c.req.param('id')))return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const note=clean(b.note),decision=clean(b.decision)
    const found=await pool.query(
      'SELECT id,agent_device_id,file_name,status,request_source,managed_action_code,first_approved_by_user_id FROM rmm_epm_file_requests WHERE id=$1 AND tenant_id=$2',
      [c.req.param('id'),auth.session.tenant_id])
    const record=found.rows[0]
    if(!record || record.status!=='pending')return c.json({error:'Request is missing or already decided.'},409)
    const policy=epmRisk(record)
    const canBreakGlass=hasPermission(auth.session.access,'rmm.policies.manage')
      && hasPermission(auth.session.access,'settings.security.manage')
    const choice=decideEpmApproval(policy,decision,note,
      record.first_approved_by_user_id,auth.session.user_id,canBreakGlass)
    if(!choice.ok)return c.json({error:choice.error},403)
    let result
    let eventType
    if(choice.stage==='first-approval'){
      result=await pool.query(
        `UPDATE rmm_epm_file_requests
         SET first_approved_by_user_id=$3,first_approved_at=now(),
             first_approval_note=$4,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status='pending'
           AND first_approved_by_user_id IS NULL
         RETURNING id,agent_device_id,file_name`,
        [record.id,auth.session.tenant_id,auth.session.user_id,note])
      eventType='epm.file.first_approval'
    }else{
      const finalStatus=choice.stage==='reject'?'rejected':'approved'
      result=await pool.query(
        `UPDATE rmm_epm_file_requests
         SET status=$3,decision_note=$4,decided_by_user_id=$5,decided_at=now(),
           approval_expires_at=CASE WHEN $3='approved' THEN now()+($6::integer*interval '1 minute') ELSE NULL END,
           updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status='pending'
           AND ($7::boolean=false OR (
             first_approved_by_user_id IS NOT NULL AND first_approved_by_user_id<>$5
           ))
         RETURNING id,agent_device_id,file_name`,
        [record.id,auth.session.tenant_id,finalStatus,note,auth.session.user_id,
          choice.ttlMinutes||0,choice.stage==='second-approval'])
      eventType='epm.file.'+finalStatus
    }
    if(!result.rowCount)return c.json({error:'Approval state changed; refresh and try again.'},409)
    const item=result.rows[0]
    await recordRmmActivity({
      tenantId:auth.session.tenant_id,agentDeviceId:item.agent_device_id,
      actorType:'technician',actorUserId:auth.session.user_id,
      actorLabel:auth.session.name||auth.session.email||'Technician',
      category:'security',eventType,
      summary:'EPM '+choice.stage+' for '+item.file_name+' ('+policy.risk+')',
      detail:note,outcome:choice.stage==='reject'?'rejected':'success',
      metadata:{requestId:item.id,risk:policy.risk,stage:choice.stage,
        requiredApprovers:policy.requiredApprovers,approvalProfile},
    }).catch(()=>null)
    return c.json({
      success:true,
      status:choice.stage==='first-approval'?'pending'
        :choice.stage==='reject'?'rejected':'approved',
      approvalStage:choice.stage==='first-approval'?'awaiting_second':'completed',
      requiredApprovers:policy.requiredApprovers,risk:policy.risk,
      approvalMinutes:choice.ttlMinutes||0
    })
  })
  // Review-only UAC requests. This queue never contains a trusted executable
  // identity and MUST NEVER issue, return or authorize an admin credential.
  app.post('/api/v1/agent/epm/uac-reviews', async c => {
    const auth=await requireAgent(c); if (auth.error) return auth.error
    const b=await c.req.json().catch(()=>({}))
    const checked=validateNativeUacRequest(b)
    if (!checked.ok) return c.json({error:checked.error},400)
    const result=await pool.query(
      `INSERT INTO rmm_epm_native_uac_reviews
        (tenant_id,agent_device_id,requester_sid,requester_name,
        requester_session_id,consent_process_id,consent_process_started_at,business_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id,agent_device_id,requester_session_id,
          consent_process_id,consent_process_started_at)
        DO NOTHING RETURNING id,status,expires_at`,
      [auth.agent.tenant_id,auth.agent.id,checked.sid,checked.username,
       checked.sessionId,checked.consentProcessId,checked.consentStartedAt,checked.reason])
    let row=result.rows[0]
    if (!row) {
      const existing=await pool.query(
        `SELECT id,status,expires_at,requester_sid,business_reason
           FROM rmm_epm_native_uac_reviews
          WHERE tenant_id=$1 AND agent_device_id=$2 AND requester_session_id=$3
            AND consent_process_id=$4 AND consent_process_started_at=$5`,
        [auth.agent.tenant_id,auth.agent.id,checked.sessionId,
         checked.consentProcessId,checked.consentStartedAt])
      row=existing.rows[0]
      if (!row || row.requester_sid!==checked.sid || row.business_reason!==checked.reason)
        return c.json({error:'UAC instance already belongs to a different request.'},409)
    }
    return c.json({success:true,requestId:row.id,
      status:Date.parse(row.expires_at)<Date.now()?'expired':row.status,
      scope:'unidentified-native-uac',credentialReleaseEnabled:false,
      notice:'Review only. Windows UAC will not resume or authenticate.'},
      result.rowCount ? 201 : 200)
  })
  app.post('/api/v1/agent/epm/uac-reviews/:id/status', async c => {
    const auth=await requireAgent(c); if (auth.error) return auth.error
    if (!validId(c.req.param('id'))) return c.json({error:'Invalid request ID.'},400)
    const checked=validateNativeUacStatusRequest(await c.req.json().catch(()=>({})))
    if (!checked.ok) return c.json({error:checked.error},400)
    const q=await pool.query(
      `SELECT status,expires_at,decision_note,decided_at FROM rmm_epm_native_uac_reviews
        WHERE id=$1 AND tenant_id=$2 AND agent_device_id=$3
          AND requester_sid=$4 AND requester_session_id=$5
          AND consent_process_id=$6 AND consent_process_started_at=$7`,
      [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,checked.sid,
       checked.sessionId,checked.consentProcessId,checked.consentStartedAt])
    if (!q.rowCount) return c.json({error:'UAC request instance not found.'},404)
    return c.json({success:true,
      status:Date.parse(q.rows[0].expires_at)<Date.now() && q.rows[0].status==='pending'
        ? 'expired':q.rows[0].status,
      decisionNote:['reviewed','rejected'].includes(q.rows[0].status)
        ? q.rows[0].decision_note : null,
      decidedAt:q.rows[0].decided_at,
      credentialReleaseEnabled:canReleaseNativeUacCredential()})
  })
  app.get('/api/v1/rmm/epm/uac-reviews', async c => {
    const auth=await requireTechnician(c); if(auth.error) return auth.error
    const q=await pool.query(
      `SELECT id,agent_device_id,requester_sid,requester_name,requester_session_id,
        consent_process_id,consent_process_started_at,business_reason,scope,
        CASE WHEN expires_at<now() AND status='pending' THEN 'expired'
             ELSE status END AS status,
        credential_release_enabled,decision_note,created_at,expires_at,decided_at
        FROM rmm_epm_native_uac_reviews
        WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [auth.session.tenant_id])
    return c.json({requests:q.rows,mode:'review-only',credentialReleaseEnabled:false})
  })
  app.post('/api/v1/rmm/epm/uac-reviews/:id/decision', async c => {
    const auth=await requireTechnician(c); if(auth.error) return auth.error
    if (!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const note=clean(b.note), decision=clean(b.decision)
    if (!['reviewed','rejected'].includes(decision)|| note.length<10 ||
      note.length>2000) return c.json({error:'Review or rejection and an explanation are required.'},400)
    const q=await pool.query(
      `UPDATE rmm_epm_native_uac_reviews
        SET status=$3,decision_note=$4,decided_by_user_id=$5,
        decided_at=now(),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='pending' AND expires_at>now()
        RETURNING id,agent_device_id`,
      [c.req.param('id'),auth.session.tenant_id,decision,note,auth.session.user_id])
    if(!q.rowCount) return c.json({error:'UAC request expired or already reviewed.'},409)
    await recordRmmActivity({
      tenantId:auth.session.tenant_id,agentDeviceId:q.rows[0].agent_device_id,
      actorType:'technician',actorUserId:auth.session.user_id,
      actorLabel:auth.session.name||auth.session.email||'Technician',
      category:'security',eventType:'epm.uac.review.'+decision,
      summary:'Unbound Windows UAC review '+decision+' (no elevation permission)',
      detail:note,outcome:decision==='rejected'?'rejected':'success',
      metadata:{requestId:q.rows[0].id,unidentifiedTarget:true,credentialRelease:false},
    }).catch(()=>null)
    return c.json({success:true,status:decision,credentialReleaseEnabled:false,
      notice:'Review recorded; no Windows elevation was authorized.'})
  })

}
