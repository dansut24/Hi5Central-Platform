// EPM file-specific support approvals. Pilot disabled unless explicitly scoped to a tenant and device.
// These routes NEVER execute commands: only the local authenticated Windows broker may redeem.
import { hasPermission } from './access.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { pool } from './db.js'
import { authenticateAgent } from './rmmAgent.js'
import { recordRmmActivity } from './rmmActivity.js'
import { resolveSession } from './session.js'

const pilotTenant = (process.env.RMM_EPM_PILOT_TENANT || '').trim().toLowerCase()
const pilotDevice = (process.env.RMM_EPM_PILOT_DEVICE || '').trim().toLowerCase()
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
}
export function registerRmmEpmFileRoutes(app) {
  app.post('/api/v1/agent/epm/file-requests', async c => {
    const auth = await requireAgent(c); if (auth.error) return auth.error
    const b = await c.req.json().catch(()=>({}))
    const sid=clean(b.sid), name=clean(b.username), filePath=clean(b.path)
    const hash=clean(b.sha256).toUpperCase(), thumb=clean(b.signerThumbprint).toUpperCase()
    const publisher=clean(b.publisher), reason=clean(b.reason)
    if (!/^S-1-[0-9-]{5,220}$/.test(sid) || sid.length > 255
      || !Number.isInteger(b.sessionId) || b.sessionId < 1 || b.sessionId > 2147483647
      || !safePath(filePath) || !validSha(hash) || !allowed(thumb)
      || !publisher || publisher.length > 255 || name.length > 255
      || b.signatureStatus !== 'Valid' || reason.length < 20 || reason.length > 2000)
      return c.json({error:'Invalid identity, verified executable, or business justification.'},400)
    const existing=await pool.query(
      `SELECT id,status,approval_expires_at FROM rmm_epm_file_requests
       WHERE tenant_id=$1 AND agent_device_id=$2 AND requester_sid=$3
         AND requester_session_id=$4 AND file_path=$5 AND file_sha256=$6
         AND signer_thumbprint=$7 AND status IN ('pending','approved')
       ORDER BY created_at DESC LIMIT 1`,
      [auth.agent.tenant_id,auth.agent.id,sid,b.sessionId,filePath,hash,thumb])
    const cur=existing.rows[0]
    if (cur && (cur.status==='pending' || (cur.approval_expires_at && Date.parse(cur.approval_expires_at)>Date.now())))
      return c.json({success:true,requestId:cur.id,status:cur.status,duplicate:true})
    const result=await pool.query(
      `INSERT INTO rmm_epm_file_requests
      (tenant_id,agent_device_id,requester_sid,requester_name,requester_session_id,
      file_path,file_name,file_sha256,publisher,signer_thumbprint,business_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,status`,
      [auth.agent.tenant_id,auth.agent.id,sid,name,b.sessionId,filePath,filePath.split('\\').pop(),hash,publisher,thumb,reason])
    return c.json({success:true,requestId:result.rows[0].id,status:'pending'},201)
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
      approvalExpiresAt:item.approval_expires_at,decisionNote:item.decision_note})
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
         AND file_path=$6 AND file_sha256=$7 AND signer_thumbprint=$8 RETURNING id`,
      [c.req.param('id'),auth.agent.tenant_id,auth.agent.id,clean(b.sid),b.sessionId,
       clean(b.path),clean(b.sha256).toUpperCase(),clean(b.signerThumbprint).toUpperCase()])
    if (!result.rowCount) return c.json({error:'Approval expired, changed or already used.'},409)
    return c.json({success:true,redeemed:true})
  })
  app.post('/api/v1/agent/epm/file-requests/:id/failed', async c => {
    const auth=await requireAgent(c); if(auth.error) return auth.error
    if (!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const stages=new Set([
      'service-security-context','create-admin-identity','assign-admin-group','logon-identity',
      'validate-elevated-token','duplicate-primary-token',
      'bind-desktop-session','create-elevated-process','unexpected-launch-error',
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
  app.get('/api/v1/rmm/epm/file-requests', async c => {
    const auth=await requireTechnician(c); if(auth.error) return auth.error
    const q=await pool.query(
      `SELECT id,agent_device_id,requester_sid,requester_name,file_name,file_path,
       file_sha256,publisher,signer_thumbprint,business_reason,status,
       decision_note,created_at,decided_at,approval_expires_at,redeemed_at,
       launch_failure_stage,launch_failure_code,launch_failure_at
       FROM rmm_epm_file_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 150`,
      [auth.session.tenant_id])
    return c.json({requests:q.rows,pilot:true})
  })
  app.post('/api/v1/rmm/epm/file-requests/:id/decision', async c => {
    const auth=await requireTechnician(c); if(auth.error) return auth.error
    if (!validId(c.req.param('id'))) return c.json({error:'Invalid request.'},400)
    const b=await c.req.json().catch(()=>({}))
    const note=clean(b.note), decision=clean(b.decision)
    if (!['approved','rejected'].includes(decision) || note.length<10 || note.length>2000)
      return c.json({error:'Decision and a 10–2000 character explanation are required.'},400)
    const result=await pool.query(
      `UPDATE rmm_epm_file_requests
         SET status=$3,decision_note=$4,decided_by_user_id=$5,decided_at=now(),
           approval_expires_at=CASE WHEN $3='approved' THEN now()+interval '15 minutes' ELSE NULL END,
           updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING id,status,agent_device_id,file_name`,
      [c.req.param('id'),auth.session.tenant_id,decision,note,auth.session.user_id])
    if(!result.rowCount) return c.json({error:'Request already decided.'},409)
    const item=result.rows[0]
    await recordRmmActivity({
      tenantId:auth.session.tenant_id,agentDeviceId:item.agent_device_id,
      actorType:'technician',actorUserId:auth.session.user_id,
      actorLabel:auth.session.name||auth.session.email||'Technician',
      category:'security',eventType:'epm.file.'+decision,
      summary:'File elevation '+decision+' for '+item.file_name,
      detail:note,outcome:decision==='approved'?'success':'rejected',
      metadata:{requestId:item.id},
    }).catch(()=>null)
    return c.json({success:true,status:decision,approvalMinutes:decision==='approved'?15:0})
  })
}
