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
import {rollbackReadiness,queueRollback} from './stageRollbackControl.js'
import {validateOnboardingMaintenanceWindow} from './onboardingMaintenancePolicy.js'
import {tenantOrganisationTimezone,withOrganisationReleaseTimezone} from './tenantOrganisationTimezone.js'
import {rescheduleUnclaimedTenantReleaseJobs} from './tenantMaintenanceReschedule.js'

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
  const [preference, environments, pendingReleases, settings] = await Promise.all([
    pool.query('SELECT * FROM tenant_release_preferences WHERE tenant_id=$1', [tenantId]),
    pool.query(
      `SELECT * FROM tenant_environment_state
       WHERE tenant_id=$1
       ORDER BY CASE environment WHEN 'test' THEN 1 WHEN 'uat' THEN 2 ELSE 3 END`,
      [tenantId],
    ),
    pool.query([
      'SELECT j.id,j.environment,j.build_sha,j.status,j.scheduled_at',
      'FROM tenant_release_rollout_jobs j',
      "WHERE j.tenant_id=$1 AND j.status IN ('pending','scheduled','deferred')",
      'ORDER BY j.scheduled_at,j.id LIMIT 25',
    ].join(' '),[tenantId]),
    pool.query('SELECT configuration,onboarding_data FROM tenant_settings WHERE tenant_id=$1',[tenantId]),
  ])
  const organisationTimezone=tenantOrganisationTimezone(settings.rows[0]||{},preference.rows[0])
  const ownedPreference={...preference.rows[0],
    maintenance_window:withOrganisationReleaseTimezone(
      preference.rows[0].maintenance_window,organisationTimezone)}
  return {
    organisationTimezone,
    pendingReleases:pendingReleases.rows.map(row=>({
      jobId:row.id,environment:row.environment,buildSha:row.build_sha,
      status:row.status,scheduledAt:row.scheduled_at,
    })),
    preference: preferencePayload(ownedPreference),
    environments: environments.rows
      .filter(row => row.environment!=='uat'||preference.rows[0]?.update_mode==='admin_controlled')
      .map(row => environmentPayload(row, slug)),
  }
}

export function registerTenantReleaseRoutes(app) {
  // Custom customers can request a rollback of their own UAT only.
  // Production rollback is exclusively a Hi5Central administrator operation.
  // Use the existing Live workspace as the authenticated release centre; the
  // selected target is UAT and its isolated database/runtime, never Live.
  app.get('/api/v1/release-management/rollback',async c=>{
    const auth=await requireTenantAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Open your Production release centre to manage UAT rollback.'},403)
    try{
      const result=await rollbackReadiness(pool,{
        tenantId:auth.session.tenant_id,environment:'uat',actor:'customer',
        executorReady:process.env.H5C_STAGE_ROLLBACK_QUEUE_READY==='true'})
      return c.json({...result,customerCanRollbackProduction:false,
        rollbackEnvironment:'uat'})
    }catch(error){
      return c.json({error:error.message||'Could not read UAT rollback status.'},error.status||409)
    }
  })
  app.post('/api/v1/release-management/rollback',async c=>{
    const auth=await requireTenantAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Open your Production release centre to manage UAT rollback.'},403)
    const body=await c.req.json().catch(()=>null)
    if(body?.environment!=='uat'||body?.confirm!=='ROLLBACK_MY_CUSTOM_UAT')
      return c.json({error:'Customer rollback is permitted for Custom UAT only. Hi5Central manages all Production rollback.'},403)
    // Fail closed until a stage-restricted executor is independently proven.
    // Never accept requests the worker is not able to service.
    if(process.env.H5C_STAGE_ROLLBACK_QUEUE_READY!=='true')
      return c.json({error:'UAT rollback execution is not yet enabled. No changes were made.'},409)
    try{
      const request=await withTransaction(async db=>{
        const queued=await queueRollback(db,{
          tenantId:auth.session.tenant_id,userId:auth.session.user_id,
          actor:'customer',body})
        await recordSecurityEvent({
          db,tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
          sessionId:auth.session.session_id||null,
          eventType:'release.custom_uat_rollback_requested',
          ipAddress:requestIp(c),userAgent:requestUserAgent(c),
          metadata:{requestId:queued.id,fromBuildSha:queued.source_build_sha,
            toBuildSha:queued.target_build_sha,environment:'uat',
            productionChanged:false},
        })
        return queued
      })
      return c.json({request,productionChanged:false},202)
    }catch(error){
      return c.json({error:String(error.message||error).slice(0,500)},error.status||409)
    }
  })
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
      : body.maintenanceWindow
    // Managed has no UAT; Custom UAT is available automatically but only
    // the customer can approve a matching Production promotion.
    const modeDefaults = updateMode === 'hi5_managed'
      ? { uatAutoStage: false, liveAutoPromote: true }
      : { uatAutoStage: true, liveAutoPromote: false }

    await ensurePreference(auth.session.tenant_id)
    let outcome
    try {
      outcome=await withTransaction(async db=>{
        // Same advisory claim lock as the restricted host worker; a running,
        // leased or routed release cannot move in a preferences race.
        await db.query("SELECT pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'))")
        const before=await db.query(
          'SELECT maintenance_window FROM tenant_release_preferences WHERE tenant_id=$1 FOR UPDATE',
          [auth.session.tenant_id])
        if(!before.rowCount)throw new Error('Release preference record is missing.')
        const currentSettings=await db.query(
          'SELECT configuration,onboarding_data FROM tenant_settings WHERE tenant_id=$1 FOR SHARE',
          [auth.session.tenant_id])
        const organisationTimezone=tenantOrganisationTimezone(
          currentSettings.rows[0]||{},before.rows[0])
        // Ignore stale/browser/client timezone. Validate only the explicitly
        // edited hours/days; always use the tenant's Organisation timezone.
        const adjustedWindow=Object.keys(maintenanceWindow).length
          ?validateOnboardingMaintenanceWindow(
            withOrganisationReleaseTimezone(maintenanceWindow,organisationTimezone))
          :{}
        const previousWindow=before.rows[0].maintenance_window
        const result=await db.query(
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
            JSON.stringify(adjustedWindow),
            auth.session.user_id,
          ])
        const after=result.rows[0]
        const windowChanged=JSON.stringify(previousWindow)!==JSON.stringify(after.maintenance_window)
        const rescheduling=windowChanged
          ?await rescheduleUnclaimedTenantReleaseJobs(db,{
            tenantId:auth.session.tenant_id,actorId:auth.session.user_id,
          })
          :{rescheduledJobs:[],unchangedJobs:[],blockedJobs:[]}
        await recordSecurityEvent({
          db,tenantId:auth.session.tenant_id,
          actorUserId:auth.session.user_id,sessionId:auth.session.session_id||null,
          eventType:'release.preferences_updated',ipAddress:requestIp(c),
          userAgent:requestUserAgent(c),
          metadata:{
            updateMode,liveDelayHours:delay,
            allowEmergencySecurityUpdates:body?.allowEmergencySecurityUpdates!==false,
            maintenanceWindowChanged:windowChanged,previousMaintenanceWindow:windowChanged?previousWindow:null,
            newMaintenanceWindow:windowChanged?after.maintenance_window:null,
            rescheduledJobs:rescheduling.rescheduledJobs,
            blockedJobs:rescheduling.blockedJobs,
            customerDeploymentStarted:false,
          },
        })
        return {preference:preferencePayload(after),organisationTimezone,
          maintenanceWindowChanged:windowChanged,...rescheduling}
      })
    }catch(error){
      return c.json({error:String(error.message||error)},error.status||409)
    }
    return c.json(outcome)
  })
}
