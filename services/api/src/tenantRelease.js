import { pool } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { recordSecurityEvent, requestIp, requestUserAgent } from './securityAudit.js'
import { provisionTenantSandboxes, tenantSandboxUrl } from './tenantEnvironmentProvisioner.js'
import { issueEnvironmentTicket } from './environmentHandoff.js'
import { establishEnvironmentSession } from './environmentDirectSession.js'
import { tenantRuntimePoolState } from './runtimePoolControl.js'
import {withTransaction} from './db.js'
import {acceptTenantUat,scheduleTenantLive} from './tenantRuntimeReleaseLifecycle.js'
import {validateOnboardingMaintenanceWindow} from './onboardingMaintenancePolicy.js'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function preferencePayload(row) {
  return {
    tenantId: row.tenant_id,
    updateMode: row.update_mode,
    managedByHi5Central: row.update_mode === 'hi5_managed',
    testAutoSync: Boolean(row.test_auto_sync),
    uatAutoStage: Boolean(row.uat_auto_stage),
    liveAutoPromote: Boolean(row.live_auto_promote),
    liveDelayHours: Number(row.live_delay_hours || 0),
    allowEmergencySecurityUpdates: Boolean(row.allow_emergency_security_updates),
    maintenanceWindow: object(row.maintenance_window),
    updatedAt: row.updated_at,
  }
}

function environmentPayload(row, slug) {
  return {
    environment: row.environment,
    url: row.environment === 'live' ? null : tenantSandboxUrl(slug, row.environment),
    status: row.status,
    activeReleaseRef: row.active_release_ref || '',
    lastResetAt: row.last_reset_at,
    lastDeployedAt: row.last_deployed_at,
    updatedAt: row.updated_at,
  }
}

async function requireTenantAdmin(c) {
  const session = await resolveSession(c)
  if (!session) return { error: c.json({ error: 'Authentication required.' }, 401) }
  if (!originMatchesTenant(c.req.header('origin'), session.slug)) {
    return { error: c.json({ error: 'Tenant session mismatch.' }, 403) }
  }
  if (!['owner','admin'].includes(session.tenant_role)) {
    return { error: c.json({ error: 'Organisation administrator access is required.' }, 403) }
  }
  return { session }
}

async function ensurePreference(tenantId) {
  await pool.query(
    `INSERT INTO tenant_release_preferences (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  )
  await pool.query(
    `INSERT INTO tenant_environment_state (tenant_id,environment,status)
     VALUES ($1,'test','available'),($1,'uat','available'),($1,'live','ready')
     ON CONFLICT (tenant_id,environment) DO NOTHING`,
    [tenantId],
  )
}

export async function persistOnboardingUpdatePreference(client, { tenantId, userId, data }) {
  const updateMode = String(data?.updateMode || '').toLowerCase()
  if (!['admin_controlled', 'hi5_managed'].includes(updateMode)) {
    const error = new Error('Choose Hi5Central managed or customer-controlled updates.')
    error.status = 400
    throw error
  }
  if (updateMode === 'hi5_managed' && deployment.deploymentMode === 'self_hosted'
    && !String(process.env.RELEASE_SIGNING_PUBLIC_KEY_PEM || process.env.LICENSING_PUBLIC_KEY_PEM || '').trim()) {
    const error = new Error('A trusted Hi5Central release-signing key is required before managed updates can be enabled.')
    error.status = 409
    throw error
  }
  const liveDelayHours = data?.liveDelayHours == null ? 24 : Number(data.liveDelayHours)
  if (!Number.isInteger(liveDelayHours) || liveDelayHours < 0 || liveDelayHours > 720) {
    const error = new Error('Choose a Live release delay between 0 and 720 hours.')
    error.status = 400
    throw error
  }
  const managed = updateMode === 'hi5_managed'
  const maintenanceWindow=validateOnboardingMaintenanceWindow(data?.maintenanceWindow)
  // UAT is automatic for Custom, Production promotion remains customer approved.
  // Managed tenants do not have UAT and update Production only in their window.
  const autoUat=!managed
  await client.query(
    `INSERT INTO tenant_release_preferences
       (tenant_id,update_mode,test_auto_sync,uat_auto_stage,live_auto_promote,live_delay_hours,allow_emergency_security_updates,maintenance_window,updated_by,updated_at)
     VALUES ($1,$2,true,$3,$4,$5,$6,$7::jsonb,$8,now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       update_mode=excluded.update_mode,
       test_auto_sync=excluded.test_auto_sync,
       uat_auto_stage=excluded.uat_auto_stage,
       live_auto_promote=excluded.live_auto_promote,
       live_delay_hours=excluded.live_delay_hours,
       allow_emergency_security_updates=excluded.allow_emergency_security_updates,
       maintenance_window=excluded.maintenance_window,
       updated_by=excluded.updated_by,
       updated_at=now()`,
    [tenantId, updateMode, autoUat, managed, liveDelayHours, data?.allowEmergencySecurityUpdates !== false, JSON.stringify(maintenanceWindow), userId],
  )
  await client.query(
    `INSERT INTO tenant_environment_state (tenant_id,environment,status)
     VALUES ($1,'test','available'),($1,'uat','available'),($1,'live','ready')
     ON CONFLICT (tenant_id,environment) DO NOTHING`,
    [tenantId],
  )
}

export async function tenantReleaseState(tenantId, slug = '') {
  await ensurePreference(tenantId)
  const [preference, environments] = await Promise.all([
    pool.query('SELECT * FROM tenant_release_preferences WHERE tenant_id=$1', [tenantId]),
    pool.query(
      `SELECT * FROM tenant_environment_state
       WHERE tenant_id=$1
       ORDER BY CASE environment WHEN 'test' THEN 1 WHEN 'uat' THEN 2 ELSE 3 END`,
      [tenantId],
    ),
  ])
  return {
    preference: preferencePayload(preference.rows[0]),
    environments: environments.rows.map(row => environmentPayload(row, slug)),
  }
}

export function registerTenantReleaseRoutes(app) {
  // Inform customer owners of their installed runtime assignment and
  // pending version offers; this route cannot select or activate a pool.
  app.get('/api/v1/release-management/runtime-updates',async c=>{
    const auth=await requireTenantAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Check your Production workspace for customer-specific release assignments.'},403)
    return c.json(await tenantRuntimePoolState(pool,auth.session.tenant_id))
  })

  app.post('/api/v1/release-management/runtime-updates/:id/accept-uat',async c=>{
    const auth=await requireTenantAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Approve customer releases in the Production release centre.'},403)
    const body=await c.req.json().catch(()=>null)
    try{
      const accepted=await withTransaction(db=>acceptTenantUat({
        db,tenantId:auth.session.tenant_id,offerId:c.req.param('id'),
        userId:auth.session.user_id,evidence:body,
      }))
      await recordSecurityEvent({
        tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
        sessionId:auth.session.session_id||null,
        eventType:'release.runtime_uat_accepted',
        ipAddress:requestIp(c),userAgent:requestUserAgent(c),
        metadata:{offerId:accepted.id,buildSha:accepted.build_sha},
      })
      return c.json({accepted,productionChanged:false})
    }catch(error){
      return c.json({error:error.message||'UAT acceptance failed.'},error.status||409)
    }
  })
  app.post('/api/v1/release-management/runtime-updates/:id/schedule',async c=>{
    const auth=await requireTenantAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Schedule customer Production releases from Live.'},403)
    const preference=await pool.query('SELECT update_mode FROM tenant_release_preferences WHERE tenant_id=$1',
      [auth.session.tenant_id])
    if(preference.rows[0]?.update_mode!=='admin_controlled')
      return c.json({error:'Hi5Central-managed customers receive scheduled updates through the managed release operator.'},403)
    const body=await c.req.json().catch(()=>null)
    try{
      const scheduled=await withTransaction(db=>scheduleTenantLive({
        db,tenantId:auth.session.tenant_id,offerId:c.req.param('id'),
        userId:auth.session.user_id,confirmed:body?.confirm===true,
        requestedAt:body?.requestedAt||null,
      }))
      await recordSecurityEvent({
        tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
        sessionId:auth.session.session_id||null,
        eventType:'release.runtime_production_scheduled',
        ipAddress:requestIp(c),userAgent:requestUserAgent(c),
        metadata:{offerId:scheduled.id,buildSha:scheduled.build_sha},
      })
      return c.json({scheduled,productionChanged:false,
        message:'Production update scheduled for a trusted host activation; no application traffic has moved.'},202)
    }catch(error){
      return c.json({error:error.message||'Could not schedule this release.'},error.status||409)
    }
  })

  app.get('/api/v1/release-management', async (c) => {
    const auth = await requireTenantAdmin(c)
    if (auth.error) return auth.error
    const state = await tenantReleaseState(auth.session.tenant_id, auth.session.slug)
    return c.json({
      deploymentMode: deployment.deploymentMode,
      edition: deployment.deploymentMode === 'managed' ? 'managed' : deployment.selfHostEdition,
      ...state,
    })
  })

  app.post('/api/v1/release-management/environment-access', async c => {
    const auth = await requireTenantAdmin(c)
    if (auth.error) return auth.error
    let body
    try { body=await c.req.json() } catch { return c.json({error:'Invalid environment request.'},400) }
    const environment=String(body?.environment || '')
    if (!['test','uat'].includes(environment)) return c.json({error:'Choose Test or UAT.'},400)
    try {
      const access=await establishEnvironmentSession(c,auth.session,environment)
      return c.json(access)
    } catch(error) {
      return c.json({error:error.message || 'Cannot open this environment yet.'},409)
    }
  })

  app.post('/api/v1/release-management/provision', async (c) => {
    const auth = await requireTenantAdmin(c)
    if (auth.error) return auth.error
    if (!auth.session.onboarding_completed_at) {
      return c.json({ error: 'Complete onboarding before preparing environment workspaces.' }, 409)
    }
    await provisionTenantSandboxes(auth.session.tenant_id)
    return c.json(await tenantReleaseState(auth.session.tenant_id, auth.session.slug))
  })

  app.patch('/api/v1/release-management/preferences', async (c) => {
    const auth = await requireTenantAdmin(c)
    if (auth.error) return auth.error
    let body
    try { body = await c.req.json() } catch {
      return c.json({ error: 'A valid JSON request body is required.' }, 400)
    }

    const updateMode = String(body?.updateMode || '').trim().toLowerCase()
    if (!['admin_controlled','hi5_managed'].includes(updateMode)) {
      return c.json({ error: 'updateMode must be admin_controlled or hi5_managed.' }, 400)
    }
    if (updateMode === 'hi5_managed' && deployment.deploymentMode === 'self_hosted'
      && !String(process.env.RELEASE_SIGNING_PUBLIC_KEY_PEM || process.env.LICENSING_PUBLIC_KEY_PEM || '').trim()) {
      return c.json({ error: 'A trusted Hi5Central release-signing public key is required before managed updates can be enabled.' }, 409)
    }

    const delay = body?.liveDelayHours == null ? 24 : Math.floor(Number(body.liveDelayHours))
    if (!Number.isFinite(delay) || delay < 0 || delay > 720) {
      return c.json({ error: 'liveDelayHours must be between 0 and 720.' }, 400)
    }

    const maintenanceWindow = body?.maintenanceWindow == null
      ? {}
      : validateOnboardingMaintenanceWindow(body.maintenanceWindow)
    // Managed has no UAT; Custom UAT is available automatically but only
    // the customer can approve a matching Production promotion.
    const modeDefaults = updateMode === 'hi5_managed'
      ? { uatAutoStage: false, liveAutoPromote: true }
      : { uatAutoStage: true, liveAutoPromote: false }

    await ensurePreference(auth.session.tenant_id)
    const result = await pool.query(
      `UPDATE tenant_release_preferences SET
         update_mode=$2,
         test_auto_sync=true,
         uat_auto_stage=$3,
         live_auto_promote=$4,
         live_delay_hours=$5,
         allow_emergency_security_updates=$6,
         maintenance_window=CASE WHEN $7::jsonb='{}'::jsonb THEN maintenance_window ELSE $7::jsonb END,
         updated_by=$8,
         updated_at=now()
       WHERE tenant_id=$1
       RETURNING *`,
      [
        auth.session.tenant_id,
        updateMode,
        modeDefaults.uatAutoStage,
        modeDefaults.liveAutoPromote,
        delay,
        body?.allowEmergencySecurityUpdates !== false,
        JSON.stringify(maintenanceWindow),
        auth.session.user_id,
      ],
    )

    await recordSecurityEvent({
      tenantId: auth.session.tenant_id,
      actorUserId: auth.session.user_id,
      sessionId: auth.session.session_id || null,
      eventType: 'release.preferences_updated',
      ipAddress: requestIp(c),
      userAgent: requestUserAgent(c),
      metadata: {
        updateMode,
        liveDelayHours: delay,
        allowEmergencySecurityUpdates: body?.allowEmergencySecurityUpdates !== false,
      },
    })

    return c.json({ preference: preferencePayload(result.rows[0]) })
  })
}
