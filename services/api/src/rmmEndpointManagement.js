import { hasPermission } from './access.js'
import { pool, withTransaction } from './db.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { scopeDeviceRows, loadGroups } from './rmmScope.js'
import { ENDPOINT_SETTINGS, endpointSetting, highRiskEndpointOverride, settingAllowedInProfile, validateSettings, validateSettingValue, resolveEndpointProfile } from './rmmEndpointPolicyModel.js'
import { buildWindowsPolicyCommand, parseWindowsPolicyResult, WINDOWS_POLICY_READ_KEYS, WINDOWS_POLICY_WRITE_KEYS } from './rmmEndpointWindowsDriver.js'
import { unresolvedEndpointRestores } from './rmmEndpointRemoval.js'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const text = (value, length = 200) => String(value ?? '').trim().slice(0, length)
const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const toDate = (value) => value ? new Date(value) : null

async function auth(c, write = false) {
  const session = await resolveSession(c)
  if (!session) throw bad('Authentication required.', 401)
  if (!originMatchesTenant(c.req.header('origin'), session.slug)) throw bad('Tenant session mismatch.', 403)
  if (!(write ? ['rmm.policies.manage'] : ['rmm.policies.view','rmm.policies.manage']).some((permission) => hasPermission(session.access, permission))) throw bad('Endpoint policy access denied.', 403)
  return session
}
async function history(client, session, profileId, exceptionId, action, detail) {
  await client.query('INSERT INTO rmm_endpoint_policy_history (tenant_id,profile_id,exception_id,action,detail,actor_user_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
    [session.tenant_id, profileId, exceptionId, action, JSON.stringify(detail), session.user_id])
}
const wrap = (handler) => async (c) => {
  try { return await handler(c) }
  catch (error) {
    if (error.code === '23505') return c.json({ error: 'A profile with this name already exists.' }, 409)
    if (!error.status) console.error('[RMM endpoint policies]', error)
    return c.json({ error: error.status ? error.message : 'Endpoint management request failed.' }, error.status || 500)
  }
}
function scopeInput(source, allowed) {
  const type = text(source.scopeType || 'estate', 16).toLowerCase()
  let id = text(source.scopeId, 256)
  if (!allowed.includes(type)) throw bad('Unsupported assignment type.')
  if (type === 'user') { id = id.toLowerCase(); if (!emailPattern.test(id)) throw bad('Select a valid user email.') }
  else if (type !== 'estate' && !idPattern.test(id)) throw bad('Select a valid device or group.')
  else if (type === 'estate') id = ''
  return { type, id }
}
async function scopeExists(tenantId, scope) {
  if (scope.type === 'estate') return true
  const query = {
    device: ['SELECT 1 FROM rmm_device_inventory WHERE tenant_id=$1 AND id=$2::uuid AND active=true', scope.id],
    group: ['SELECT 1 FROM rmm_device_groups WHERE tenant_id=$1 AND id=$2::uuid', scope.id],
    user: ['SELECT 1 FROM rmm_device_inventory WHERE tenant_id=$1 AND active=true AND lower(user_principal_name)=$2 UNION SELECT 1 FROM organisation_people WHERE tenant_id=$1 AND lower(email)=$2 LIMIT 1', scope.id],
  }[scope.type]
  const result = await pool.query(query[0], [tenantId, query[1]])
  return Boolean(result.rowCount)
}
async function profileById(tenantId, profileId) {
  if (!idPattern.test(profileId)) throw bad('Invalid profile ID.')
  const result = await pool.query('SELECT * FROM rmm_endpoint_profiles WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL', [tenantId, profileId])
  if (!result.rowCount) throw bad('Profile not found.', 404)
  return result.rows[0]
}
function profileInput(body) {
  const name = text(body.name, 120)
  if (!name) throw bad('Profile name is required.')
  const kind = text(body.kind || 'baseline', 20)
  if (!['baseline','configuration','laps'].includes(kind)) throw bad('Invalid profile type.')
  const status = text(body.status || 'draft', 20)
  if (!['draft','ready','disabled'].includes(status)) throw bad('Invalid profile status.')
  const scope = scopeInput(body, ['estate','device','group','user'])
  let settings
  try { settings = validateSettings(body.settings || []) } catch (error) { throw bad(error.message) }
  if (!settings.length) throw bad('Choose at least one setting.')
  if (settings.some((entry) => highRiskEndpointOverride(entry.key, entry.value, 'override'))) throw bad('High-risk settings must be changed through a time-limited, risk-accepted setting exception.')
  if (settings.some((item) => !settingAllowedInProfile(kind, item.key))) throw bad('This setting is not supported in the selected profile type.')
  if (kind === 'laps') {
    const backup = settings.find((item) => item.key === 'windows.laps.backup_directory')?.value
    const age = settings.find((item) => item.key === 'windows.laps.password_age_days')?.value
    if (!backup) throw bad('Windows LAPS profiles require an Entra ID or Active Directory backup destination.')
    if (backup === 'entra' && age != null && age < 7) throw bad('Windows LAPS with Entra ID requires a password age of at least seven days.')
    if (settings.some((item) => item.key === 'windows.laps.ad_password_encryption') && backup !== 'ad') throw bad('Active Directory password encryption requires an AD backup destination.')
  }
  return { name, description: text(body.description, 1000), kind, status, scope, settings }
}
async function cancelQueuedEndpointJobs(client, tenantId, profileId, settingKey = '') {
  await client.query(
    "UPDATE rmm_agent_jobs SET status='cancelled',completed_at=now(),updated_at=now(),error_message='Endpoint profile or exception changed before dispatch.' " +
    "WHERE tenant_id=$1 AND status='queued' AND request_metadata->>'source'='endpoint_management' " +
    "AND request_metadata->>'endpoint_profile_id'=$2 AND ($3='' OR request_metadata->>'setting_key'=$3 OR request_metadata->>'setting_key'='audit')",
    [tenantId,profileId,settingKey])
}
async function outstandingRestoreTargets(tenantId, profileId) {
  const runs = await pool.query(
    "SELECT status,result,request_metadata,created_at FROM rmm_agent_jobs WHERE tenant_id=$1 AND request_metadata->>'source'='endpoint_management' AND request_metadata->>'endpoint_profile_id'=$2 AND request_metadata->>'action' IN ('apply','restore') AND status='completed' ORDER BY created_at DESC LIMIT 5001",
    [tenantId,profileId])
  // A truncated audit history must NEVER be interpreted as proof of restoration.
  if (runs.rowCount>5000) throw bad('Too many policy executions to safely prove rollback. Contact Hi5Central support for a device-side reconciliation.',409)
  return unresolvedEndpointRestores(runs.rows.map((job)=>{
    const meta=job.request_metadata||{}
    const report=parseWindowsPolicyResult(job.result?.output)
    return {...job,verifiedRestore:meta.action==='restore'&&Boolean(report?.results?.some((r)=>
      r.key===meta.setting_key && r.action==='restore' && r.status==='verified'))}
  }))
}
async function rejectUnrestoredSettings(tenantId, profileId, settingKeys = []) {
  // Claimed device writes can complete AFTER desired policy is withdrawn.
  // Refuse removal rather than invalidating an in-flight write's provenance.
  const inFlight=await pool.query(
    "SELECT 1 FROM rmm_agent_jobs WHERE tenant_id=$1 AND request_metadata->>'source'='endpoint_management' AND request_metadata->>'endpoint_profile_id'=$2 AND status='claimed' AND request_metadata->>'action'='apply' AND ($3::text[] IS NULL OR request_metadata->>'setting_key'=ANY($3::text[])) LIMIT 1",
    [tenantId,profileId,settingKeys.length?settingKeys:null])
  if(inFlight.rowCount) throw bad('A Windows apply job is still running. Wait for verified completion or resolution before withdrawing the policy.',409)
  const outstanding=(await outstandingRestoreTargets(tenantId,profileId))
    .filter((item)=>!settingKeys.length||settingKeys.includes(item.settingKey))
  if (outstanding.length) {
    const summary=outstanding.slice(0,3).map((item)=>item.settingKey+' on '+item.deviceId).join('; ')
    throw bad('Restore the original Windows setting on affected devices before removing or unassigning this policy: '+summary,409)
  }
}
async function exceptionsFor(tenantId, profileId) {
  const result = await pool.query('SELECT * FROM rmm_endpoint_setting_exceptions WHERE tenant_id=$1 AND profile_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC',
    [tenantId, profileId])
  return result.rows
}
export function registerRmmEndpointManagementRoutes(app) {
  app.get('/api/v1/rmm/endpoint-management', wrap(async (c) => {
    const session = await auth(c)
    const [profiles, exceptions, devices] = await Promise.all([
      pool.query('SELECT * FROM rmm_endpoint_profiles WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC', [session.tenant_id]),
      pool.query('SELECT * FROM rmm_endpoint_setting_exceptions WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY updated_at DESC', [session.tenant_id]),
      scopeDeviceRows(session.tenant_id),
    ])
    const groups = await loadGroups(session.tenant_id, devices)
    const users = [...new Map(devices.map((device) => {
      const email = text(device.user_principal_name || device.assigned_person_email, 256).toLowerCase()
      return [email, { email, name: device.assigned_person_name || device.user_display_name || email }]
    }).filter(([email]) => emailPattern.test(email))).values()]
    const restoreItems=await Promise.all(profiles.rows.map((profile)=>outstandingRestoreTargets(session.tenant_id,profile.id)))
    const profilesWithRestore=profiles.rows.map((profile,i)=>({...profile,restorationRequired:restoreItems[i]}))
    return c.json({ catalogue: ENDPOINT_SETTINGS, profiles: profilesWithRestore, exceptions: exceptions.rows, devices: devices.map((device) => ({ id: device.id, reference: device.reference, name: device.name, user: device.user_principal_name || device.assigned_person_email, os: device.operating_system })), groups: groups.map(({ id, name, mode, devices }) => ({ id, name, mode, devices })), users, phase: 'policy-preview', deviceEnforcement: false })
  }))
  app.post('/api/v1/rmm/endpoint-management/profiles', wrap(async (c) => {
    const session = await auth(c, true)
    const input = profileInput(await c.req.json())
    if (!await scopeExists(session.tenant_id, input.scope)) throw bad('Assignment target is not in this tenant.')
    const saved = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO rmm_endpoint_profiles (tenant_id,name,description,kind,status,scope_type,scope_id,settings,created_by_user_id,updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9) RETURNING *`,
        [session.tenant_id,input.name,input.description,input.kind,input.status,input.scope.type,input.scope.id,JSON.stringify(input.settings),session.user_id])
      await history(client, session, result.rows[0].id, null, 'profile.created', { name: input.name, scope: input.scope, settings: input.settings.map((entry) => entry.key) })
      return result.rows[0]
    })
    return c.json({ profile: saved }, 201)
  }))
  app.put('/api/v1/rmm/endpoint-management/profiles/:id', wrap(async (c) => {
    const session = await auth(c, true)
    const previous = await profileById(session.tenant_id, c.req.param('id'))
    const body = await c.req.json()
    if (!Number.isInteger(body.revision) || body.revision !== previous.revision) throw bad('Profile was edited elsewhere. Refresh before saving.', 409)
    const input = profileInput(body)
    const removedSettingKeys=previous.settings.filter((entry)=>!input.settings.some((next)=>next.key===entry.key)).map((entry)=>entry.key)
    const withdrawal=(input.status==='disabled'&&previous.status!=='disabled') ||
      input.scope.type!==previous.scope_type || input.scope.id!==previous.scope_id
    if (withdrawal) await rejectUnrestoredSettings(session.tenant_id,previous.id)
    else if (removedSettingKeys.length) await rejectUnrestoredSettings(session.tenant_id,previous.id,removedSettingKeys)
    if (!await scopeExists(session.tenant_id, input.scope)) throw bad('Assignment target is not in this tenant.')
    const saved = await withTransaction(async (client) => {
      const result = await client.query(`UPDATE rmm_endpoint_profiles
         SET name=$3,description=$4,kind=$5,status=$6,scope_type=$7,scope_id=$8,settings=$9::jsonb,
             revision=revision+1,updated_by_user_id=$10,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND revision=$11 AND archived_at IS NULL RETURNING *`,
        [session.tenant_id,previous.id,input.name,input.description,input.kind,input.status,input.scope.type,input.scope.id,JSON.stringify(input.settings),session.user_id,body.revision])
      if (!result.rowCount) throw bad('Profile was edited elsewhere.', 409)
      await cancelQueuedEndpointJobs(client,session.tenant_id,previous.id)
      const removed = previous.settings.filter((entry) => !input.settings.some((next) => next.key === entry.key)).map((entry) => entry.key)
      if (removed.length) {
        const revoked = await client.query(`UPDATE rmm_endpoint_setting_exceptions SET revoked_at=now(),updated_at=now(),updated_by_user_id=$4
          WHERE tenant_id=$1 AND profile_id=$2 AND setting_key=ANY($3::text[]) AND revoked_at IS NULL RETURNING id,setting_key`,
          [session.tenant_id,previous.id,removed,session.user_id])
        for (const item of revoked.rows) await history(client, session, previous.id, item.id, 'exception.revoked_on_setting_removal', { key: item.setting_key })
      }
      await history(client, session, previous.id, null, 'profile.updated', { previousRevision: previous.revision, settings: input.settings.map((entry) => entry.key), removedSettings: removed })
      return result.rows[0]
    })
    return c.json({ profile: saved })
  }))
  // Remove withdraws desired configuration and its exceptions, preserving
  // history. The caller must restore any applied settings first; it does not
  // silently undo Windows configuration or delete a native Windows LAPS account.
  app.delete('/api/v1/rmm/endpoint-management/profiles/:id', wrap(async(c)=>{
    const session=await auth(c,true)
    const profile=await profileById(session.tenant_id,c.req.param('id'))
    const body=await c.req.json().catch(()=>({}))
    if (!Number.isInteger(body.revision)||body.revision!==profile.revision) throw bad('Profile changed. Refresh before removal.',409)
    const reason=text(body.reason,1000)
    if (reason.length<10) throw bad('Enter a reason of at least 10 characters to remove this policy.')
    if (body.confirmName!==profile.name) throw bad('Type the exact profile name to confirm removal.')
    await rejectUnrestoredSettings(session.tenant_id,profile.id)
    await withTransaction(async(client)=>{
      const archived=await client.query(
        "UPDATE rmm_endpoint_profiles SET archived_at=now(),status='disabled',revision=revision+1,updated_at=now(),updated_by_user_id=$4 WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND archived_at IS NULL RETURNING id",
        [session.tenant_id,profile.id,profile.revision,session.user_id])
      if (!archived.rowCount) throw bad('Profile changed before it could be removed.',409)
      await cancelQueuedEndpointJobs(client,session.tenant_id,profile.id)
      const revoked=await client.query(
        "UPDATE rmm_endpoint_setting_exceptions SET revoked_at=now(),updated_at=now(),updated_by_user_id=$3 WHERE tenant_id=$1 AND profile_id=$2 AND revoked_at IS NULL RETURNING id,setting_key",
        [session.tenant_id,profile.id,session.user_id])
      for (const item of revoked.rows)
        await history(client,session,profile.id,item.id,'exception.revoked_on_profile_removal',{key:item.setting_key})
      await history(client,session,profile.id,null,'profile.removed',{
        name:profile.name,kind:profile.kind,reason,scopeType:profile.scope_type,scopeId:profile.scope_id,
        settings:profile.settings.map((row)=>row.key),revokedExceptions:revoked.rowCount,
        deviceRestorationVerified:true})
    })
    return c.json({removed:true,id:profile.id,reason})
  }))
  app.post('/api/v1/rmm/endpoint-management/profiles/:id/exceptions', wrap(async (c) => {
    const session = await auth(c, true)
    const profile = await profileById(session.tenant_id, c.req.param('id'))
    const body = await c.req.json()
    const key = text(body.settingKey, 120)
    if (!profile.settings.some((entry) => entry.key === key) || !endpointSetting(key)) throw bad('This setting is not present in the profile.')
    const scope = scopeInput(body, ['device','group','user'])
    if (!await scopeExists(session.tenant_id, scope)) throw bad('Exception target is not in this tenant.')
    const mode = text(body.mode, 20)
    if (!['exclude','override'].includes(mode)) throw bad('Select exclude or override.')
    const reason = text(body.reason, 2000)
    if (reason.length < 8) throw bad('A meaningful exception justification is required.')
    let value = null
    if (mode === 'override') {
      try { value = validateSettingValue(key, body.value) } catch (error) { throw bad(error.message) }
    }
    let expiresAt = toDate(body.expiresAt)
    if (body.expiresAt && (!expiresAt || Number.isNaN(expiresAt.getTime()))) throw bad('Invalid expiry date.')
    if (expiresAt && (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 365*86400000)) throw bad('Expiry must be within the next 365 days.')
    const highRisk = highRiskEndpointOverride(key, value, mode)
    if (highRisk && (body.riskAccepted !== true || !expiresAt)) throw bad('High-risk overrides require explicit risk acceptance and an expiry date.')
    const saved = await withTransaction(async (client) => {
      const result = await client.query(`INSERT INTO rmm_endpoint_setting_exceptions
        (tenant_id,profile_id,setting_key,scope_type,scope_id,mode,value,reason,risk_accepted,expires_at,created_by_user_id,updated_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$11)
        ON CONFLICT (tenant_id,profile_id,setting_key,scope_type,scope_id) WHERE revoked_at IS NULL
        DO UPDATE SET mode=EXCLUDED.mode,value=EXCLUDED.value,reason=EXCLUDED.reason,
          risk_accepted=EXCLUDED.risk_accepted,expires_at=EXCLUDED.expires_at,
          updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()
        RETURNING *`,
        [session.tenant_id,profile.id,key,scope.type,scope.id,mode,value === null ? null : JSON.stringify(value),reason,Boolean(body.riskAccepted),expiresAt,session.user_id])
      await cancelQueuedEndpointJobs(client,session.tenant_id,profile.id,key)
      await history(client, session, profile.id, result.rows[0].id, 'exception.saved', { key, scope, mode, value, reason, expiresAt, riskAccepted: Boolean(body.riskAccepted) })
      return result.rows[0]
    })
    return c.json({ exception: saved }, 201)
  }))
  app.delete('/api/v1/rmm/endpoint-management/profiles/:id/exceptions/:exceptionId', wrap(async (c) => {
    const session = await auth(c, true)
    const profile = await profileById(session.tenant_id, c.req.param('id'))
    if (!idPattern.test(c.req.param('exceptionId'))) throw bad('Invalid exception ID.')
    const result = await withTransaction(async (client) => {
      const removed = await client.query(`UPDATE rmm_endpoint_setting_exceptions
        SET revoked_at=now(),updated_at=now(),updated_by_user_id=$4
        WHERE tenant_id=$1 AND profile_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING *`,
        [session.tenant_id,profile.id,c.req.param('exceptionId'),session.user_id])
      if (!removed.rowCount) throw bad('Exception not found.', 404)
      const item = removed.rows[0]
      await cancelQueuedEndpointJobs(client,session.tenant_id,profile.id,item.setting_key)
      await history(client, session, profile.id, item.id, 'exception.revoked', { key: item.setting_key, scopeType: item.scope_type, scopeId: item.scope_id, reason: item.reason })
      return item
    })
    return c.json({ revoked: true, id: result.id })
  }))

  // Operator-triggered Windows jobs. Writes are restricted to explicitly supported low-risk adapters.
  app.post('/api/v1/rmm/endpoint-management/profiles/:id/devices/:deviceId/run', wrap(async (c) => {
    const session = await auth(c, true)
    const profile = await profileById(session.tenant_id, c.req.param('id'))
    const deviceId = c.req.param('deviceId')
    if (!idPattern.test(deviceId)) throw bad('Invalid device ID.')
    const body = await c.req.json()
    const action = text(body.action, 24)
    if (!['audit','apply','restore'].includes(action)) throw bad('Choose audit, apply or restore.')
    const devices = await scopeDeviceRows(session.tenant_id)
    const device = devices.find((row) => row.id === deviceId)
    if (!device) throw bad('Device not found.', 404)
    const [groups, exceptions, agentResult] = await Promise.all([
      loadGroups(session.tenant_id, devices),
      exceptionsFor(session.tenant_id, profile.id),
      pool.query('SELECT id,websocket_status,last_telemetry_at FROM rmm_agent_devices WHERE tenant_id=$1 AND inventory_id=$2 AND disabled_at IS NULL ORDER BY last_telemetry_at DESC LIMIT 1', [session.tenant_id,deviceId]),
    ])
    if (!agentResult.rowCount) throw bad('This device does not have a directly enrolled Hi5Central agent.', 409)
    if (action !== 'audit' && (agentResult.rows[0].websocket_status !== 'Connected' || !agentResult.rows[0].last_telemetry_at || Date.now()-new Date(agentResult.rows[0].last_telemetry_at).getTime()>90000)) {
      throw bad('Windows write/restore requires a currently connected agent. Reconnect the device and retry.',409)
    }
    const resolved = resolveEndpointProfile({ profile, exceptions, device, groups })
    if (action !== 'restore' && !resolved.applicable) throw bad('This profile does not target the device.', 409)
    if (action === 'apply' && profile.status !== 'ready') throw bad('Only a ready profile can be applied.', 409)
    const requestedKey = text(body.settingKey, 150)
    const chosen = action === 'audit'
      ? resolved.settings.filter((entry) => WINDOWS_POLICY_READ_KEYS.includes(entry.key) && entry.state !== 'conflict')
      : [resolved.settings.find((entry) => entry.key === requestedKey) || {key:requestedKey,value:false,state:'not_assigned'}]
    if (!chosen.length) throw bad('No supported Windows settings are available for this action.', 409)
    if (action === 'apply' && chosen.some((item) => item.state === 'excluded' || item.state === 'conflict' || item.state === 'not_assigned')) {
      throw bad('This setting is excluded, conflicting, or no longer assigned.', 409)
    }
    if (action !== 'audit' && (chosen.length !== 1 || !WINDOWS_POLICY_WRITE_KEYS.includes(chosen[0].key))) throw bad('This setting has no safe Windows write/restore adapter.', 409)
    // Prevent ambiguous writes from overlapping ready profiles on the same device.
    if (action === 'apply') {
      const others = await pool.query('SELECT * FROM rmm_endpoint_profiles WHERE tenant_id=$1 AND id<>$2 AND status=$3 AND settings @> $4::jsonb',
        [session.tenant_id,profile.id,'ready',JSON.stringify([{key:chosen[0].key}])])
      for (const another of others.rows) {
        const otherResult = resolveEndpointProfile({
          profile: another,device,groups,
          exceptions: await exceptionsFor(session.tenant_id,another.id),
        })
        if (otherResult.applicable && otherResult.settings.some((setting)=>setting.key===chosen[0].key && setting.state!=='excluded')) {
          throw bad('Another ready profile also manages this setting on this device.',409)
        }
      }
    }
    let command
    try {
      command = buildWindowsPolicyCommand({ profileId:profile.id,action,
        settings:chosen.map((item)=>({key:item.key,value:item.value ?? false})) })
    } catch (error) { throw bad(error.message,409) }
    const job = await withTransaction(async (client)=>{
      const lockKey = session.tenant_id + ':' + deviceId + ':' + (action==='audit' ? 'audit' : chosen[0].key)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[lockKey])
      const pending = await client.query(
        "SELECT id FROM rmm_agent_jobs WHERE tenant_id=$1 AND agent_device_id=$2 AND status IN ('queued','claimed') AND request_metadata->>'source'='endpoint_management' AND request_metadata->>'setting_key'=$3 LIMIT 1",
        [session.tenant_id,agentResult.rows[0].id,action==='audit'?'audit':chosen[0].key])
      if (pending.rowCount) throw bad('A policy run for this setting is already pending.',409)
      const metadata={source:'endpoint_management',endpoint_profile_id:profile.id,profile_revision:profile.revision,
        expires_at:new Date(Date.now()+180000).toISOString(),
        action,device_id:deviceId,setting_key:action==='audit'?'audit':chosen[0].key,
        desired:chosen.map(({key,value,state})=>({key,value,state}))}
      const inserted=await client.query(
        "INSERT INTO rmm_agent_jobs (tenant_id,agent_device_id,job_type,payload,queued_by_user_id,initiated_by,initiated_by_label,request_metadata) "+
        "VALUES ($1,$2,'custom.command',$3::jsonb,$4,'technician',$5,$6::jsonb) RETURNING id,status,created_at",
        [session.tenant_id,agentResult.rows[0].id,JSON.stringify({command,timeout_seconds:120,run_as:'system'}),session.user_id,
          text(session.name||session.email||'Technician',120),JSON.stringify(metadata)])
      await history(client,session,profile.id,null,'endpoint.'+action+'.queued',{jobId:inserted.rows[0].id,deviceId,desired:metadata.desired})
      return inserted.rows[0]
    })
    return c.json({jobId:job.id,status:job.status,action,deviceId,deviceEnforcement:true},202)
  }))
  app.get('/api/v1/rmm/endpoint-management/runs/:jobId',wrap(async (c)=>{
    const session=await auth(c)
    if (!idPattern.test(c.req.param('jobId'))) throw bad('Invalid job ID.')
    const result=await pool.query(
      "SELECT id,status,result,error_message,request_metadata,created_at,completed_at FROM rmm_agent_jobs WHERE id=$1 AND tenant_id=$2 AND request_metadata->>'source'='endpoint_management'",
      [c.req.param('jobId'),session.tenant_id])
    if (!result.rowCount) throw bad('Run not found.',404)
    const job=result.rows[0]
    const report=parseWindowsPolicyResult(job.result?.output)
    const verified=job.status==='completed' && Boolean(report) &&
      report.results.every((row)=>row.status==='verified' || row.status==='observed')
    const expected=job.request_metadata?.desired||[]
    const compliance=report?.action==='audit' ?
      report.results.map((row)=>({
        key:row.key,observed:row.observed,
        status:expected.find((item)=>item.key===row.key)?.state==='excluded'?'excluded':
          row.status!=='observed'?'error':
          Object.is(expected.find((item)=>item.key===row.key)?.value,row.observed)?'compliant':'drift',
      })) : []
    return c.json({id:job.id,status:job.status,error:job.error_message,action:job.request_metadata.action,
      createdAt:job.created_at,completedAt:job.completed_at,report,verified,compliance})
  }))

  app.get('/api/v1/rmm/endpoint-management/profiles/:id/effective/:deviceId', wrap(async (c) => {
    const session = await auth(c)
    const profile = await profileById(session.tenant_id, c.req.param('id'))
    if (!idPattern.test(c.req.param('deviceId'))) throw bad('Invalid device ID.')
    const devices = await scopeDeviceRows(session.tenant_id)
    const device = devices.find((row) => row.id === c.req.param('deviceId'))
    if (!device) throw bad('Device not found.', 404)
    const [groups, exceptions] = await Promise.all([loadGroups(session.tenant_id, devices), exceptionsFor(session.tenant_id, profile.id)])
    return c.json({ profile: { id: profile.id, name: profile.name, status: profile.status }, device: { id: device.id, name: device.name }, resolution: resolveEndpointProfile({ profile, exceptions, device, groups }), deviceEnforcement: false })
  }))
}
