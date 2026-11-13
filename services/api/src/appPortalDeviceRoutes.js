// A tiny, tenant-scoped desired-state workflow on the existing Windows Agent
// job queue. No custom remote control service or second scheduler is introduced.
import {
  selfServicePowerShell,
  SELF_SERVICE_PORTAL_SHA256,
  SELF_SERVICE_PATCHHOST_SHA256,
  SELF_SERVICE_VERSION,
  classifySelfServiceDeployment,
} from './appPortalDeviceDeployment.js'

const clean = (value) => String(value ?? '').trim()
export const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value))

export function registerAppPortalDeviceRoutes(app, deps) {
  const { pool, requireManage, agentSocketForDevice, sendAgentMessage, recordRmmActivity } = deps
  if (![pool, requireManage, agentSocketForDevice, sendAgentMessage].every(Boolean)) {
    throw new Error('RMM Self Service is missing authenticated Agent services')
  }

  async function loadDevice(tenantId, agentId) {
    const found = await pool.query(
      `SELECT d.id,d.inventory_id,d.agent_version,d.websocket_status,i.name,i.operating_system
         FROM rmm_agent_devices d
         JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=d.tenant_id
        WHERE d.id=$1 AND d.tenant_id=$2 AND d.disabled_at IS NULL LIMIT 1`,
      [agentId, tenantId])
    return found.rows[0] || null
  }
  async function loadPolicy(tenantId, agentId) {
    const found = await pool.query(
      `SELECT p.*,j.status AS job_status,j.error_message AS job_error,j.completed_at AS job_completed_at,
              j.result AS job_result
         FROM rmm_device_self_service p
         LEFT JOIN rmm_agent_jobs j ON j.id=p.last_job_id AND j.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND p.agent_device_id=$2 LIMIT 1`,
      [tenantId, agentId])
    return found.rows[0] || null
  }
  function publicPolicy(row, device) {
    return {
      enabled: row?.enabled === true,
      status: classifySelfServiceDeployment(row),
      version: row?.release_version || SELF_SERVICE_VERSION,
      lastJobId: row?.last_job_id || null,
      lastJobStatus: row?.job_status || null,
      lastError: row?.job_error || null,
      lastCompletedAt: row?.job_completed_at || null,
      updatedAt: row?.updated_at || null,
      deviceName: device.name,
      agentVersion: device.agent_version,
      online: agentSocketForDevice(device.id)?.readyState === 1,
      installed: row?.enabled === true && row?.job_status === 'completed',
      retentionOnDisable: 'The application and shortcut remain installed; only automatic deployment is disabled.',
    }
  }
  async function context(c) {
    const auth = await requireManage(c)
    if (auth.error) return { error: auth.error }
    // Some production Hono adapters omit named param bindings for routes
    // inserted into the compiled router. Match only this exact route shape.
    const routeDeviceId = new URL(c.req.url).pathname.match(
      /\/api\/v1\/rmm\/app-portal\/devices\/([^/]+)\/self-service\/?$/)?.[1]
    const agentId = clean(routeDeviceId || c.req.param('agentDeviceId'))
    if (!isUuid(agentId)) return { error: c.json({ error: 'A valid managed device ID is required.' }, 400) }
    const device = await loadDevice(auth.session.tenant_id, agentId)
    if (!device) return { error: c.json({ error: 'Device not found in your tenant.' }, 404) }
    if (!/windows/i.test(device.operating_system || '')) {
      return { error: c.json({ error: 'The Windows Self Service app requires a Windows managed device.' }, 409) }
    }
    return { auth, device }
  }
  app.get('/api/v1/rmm/app-portal/devices/:agentDeviceId/self-service', async (c) => {
    const ctx = await context(c)
    if (ctx.error) return ctx.error
    const row = await loadPolicy(ctx.auth.session.tenant_id, ctx.device.id)
    return c.json({ success: true, policy: publicPolicy(row, ctx.device) })
  })

  app.post('/api/v1/rmm/app-portal/devices/:agentDeviceId/self-service', async (c) => {
    const ctx = await context(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'Enabled must be true or false.' }, 400)
    const tenantId = ctx.auth.session.tenant_id
    const agentId = ctx.device.id
    const enable = body.enabled
    // Never execute caller-provided URLs, scripts or shell arguments.
    const previous = await loadPolicy(tenantId, agentId)
    const unchanged = previous && previous.enabled === enable
      && previous.portal_sha256 === SELF_SERVICE_PORTAL_SHA256
      && previous.patch_host_sha256 === SELF_SERVICE_PATCHHOST_SHA256
    if (unchanged && body.retry !== true &&
      ['queued','claimed','completed'].includes(previous.job_status)) {
      return c.json({ success: true, unchanged: true, policy: publicPolicy(previous, ctx.device) })
    }
    await pool.query(
      `INSERT INTO rmm_device_self_service
          (tenant_id,agent_device_id,enabled,release_version,portal_sha256,patch_host_sha256,updated_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id,agent_device_id)
        DO UPDATE SET enabled=EXCLUDED.enabled,release_version=EXCLUDED.release_version,
          portal_sha256=EXCLUDED.portal_sha256,patch_host_sha256=EXCLUDED.patch_host_sha256,
          updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
      [tenantId, agentId, enable, SELF_SERVICE_VERSION, SELF_SERVICE_PORTAL_SHA256,
        SELF_SERVICE_PATCHHOST_SHA256, ctx.auth.session.user_id])
    // The Agent already consumes persistent queued jobs after reconnect.
    // Leave offline jobs queued; never require the user to run an EXE manually.
    const payload = { command: selfServicePowerShell(enable), timeout_seconds: enable ? 300 : 60 }
    await pool.query(
      `UPDATE rmm_agent_jobs SET status='cancelled',completed_at=now(),
          error_message='Superseded by the latest Self Service device setting',updated_at=now()
        WHERE tenant_id=$1 AND agent_device_id=$2 AND status='queued'
          AND request_metadata->>'source'='self_service_device_policy'`,
      [tenantId, agentId])
    const jobResult = await pool.query(
      `INSERT INTO rmm_agent_jobs
        (tenant_id,agent_device_id,job_type,payload,queued_by_user_id,
         initiated_by,initiated_by_label,request_metadata)
       VALUES ($1,$2,'custom.command',$3::jsonb,$4,'technician',$5,$6::jsonb)
       RETURNING id,created_at,status`,
      [tenantId, agentId, JSON.stringify(payload), ctx.auth.session.user_id,
        clean(ctx.auth.session.name || ctx.auth.session.email || 'Technician').slice(0,255),
        JSON.stringify({source:'self_service_device_policy',enabled:enable,
          version:SELF_SERVICE_VERSION,portal_sha256:SELF_SERVICE_PORTAL_SHA256,
          patch_host_sha256:SELF_SERVICE_PATCHHOST_SHA256})])
    const job = jobResult.rows[0]
    await pool.query(
      `UPDATE rmm_device_self_service SET last_job_id=$3,last_dispatched_at=now()
        WHERE tenant_id=$1 AND agent_device_id=$2`, [tenantId, agentId, job.id])
    let method = 'agent_poll_on_reconnect'
    if (agentSocketForDevice(agentId)?.readyState === 1) {
      const claimed = await pool.query(
        `UPDATE rmm_agent_jobs SET status='claimed',claimed_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND status='queued' RETURNING id`,
        [job.id, tenantId])
      if (claimed.rowCount) {
        if (sendAgentMessage(agentId, {
          type: 'job_execute',
          job: { id:job.id,job_type:'custom.command',payload,created_at:job.created_at },
        })) {
          method = 'websocket'
        } else {
          await pool.query(
            `UPDATE rmm_agent_jobs SET status='queued',claimed_at=NULL,updated_at=now()
              WHERE id=$1 AND status='claimed'`, [job.id])
        }
      } else {
        method = 'agent_poll'
      }
    }
    recordRmmActivity?.({
      tenantId, agentDeviceId: agentId, inventoryId: ctx.device.inventory_id,
      actorUserId: ctx.auth.session.user_id, actorType:'technician',
      actorLabel: ctx.auth.session.name || ctx.auth.session.email || 'Technician',
      eventType: enable ? 'app_portal.self_service.enabled' : 'app_portal.self_service.disabled',
      category:'software',summary: enable ? 'Self Service enabled for one Windows device' : 'Self Service disabled for one Windows device',
      detail: ctx.device.name + ' · version ' + SELF_SERVICE_VERSION +
        ' · existing installation retained on disable',
      outcome:'requested',jobId:job.id,
      metadata: {enabled:enable,portalSha256:SELF_SERVICE_PORTAL_SHA256},
    }).catch(() => null)
    const row = await loadPolicy(tenantId, agentId)
    return c.json({ success:true,jobId:job.id,dispatched:method,policy:publicPolicy(row,ctx.device) },202)
  })
}
