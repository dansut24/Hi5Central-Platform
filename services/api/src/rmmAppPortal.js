import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { hasPermission } from './access.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { pool, withTransaction } from './db.js'
import { agentSocketForDevice, authenticateAgent, sendAgentMessage } from './rmmAgent.js'
import { recordRmmActivity } from './rmmActivity.js'
import { softwarePatchPlan } from './rmmPatching.js'
import { resolveSession } from './session.js'
import { inspectAppPortalIcon, MAX_APP_PORTAL_ICON_BYTES } from './appPortalIcon.js'
import { findInstalledApp } from './appPortalInventory.js'
import { inspectUploadedPackage } from './appPortalPackageInspection.js'
import { approvalMatches, allowedUnsignedScope, isUnsignedUpload, unsignedManifestApproval } from './appPortalUnsignedApproval.js'
import { registerAppPortalDeviceRoutes } from './appPortalDeviceRoutes.js'

function clean(value = '') { return String(value ?? '').trim() }
function lower(value = '') { return clean(value).toLowerCase() }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function array(value) { return Array.isArray(value) ? value : [] }
function uuid(value = '') { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value)) }
function validSha256(value = '') { return /^[a-f0-9]{64}$/i.test(clean(value)) }
function validHttps(value = '') {
  try { const url = new URL(clean(value)); return url.protocol === 'https:' && Boolean(url.hostname) } catch { return false }
}
const packageRoot = path.resolve(process.env.APP_PORTAL_PACKAGE_DIR || '/srv/app-portal-packages')
const maxPackageBytes = 2 * 1024 * 1024 * 1024
// Separate storage checksum from metadata and owner approval. Neither a mutable
// file name nor a certificate-subject string can stand in for a pinned hash.
async function hashStoredPackage(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex').toUpperCase()
}
async function currentUnsignedApproval(tenantId, revisionId) {
  const result = await pool.query(
    `SELECT * FROM rmm_app_portal_unsigned_approvals
      WHERE tenant_id=$1 AND revision_id=$2 AND revoked_at IS NULL LIMIT 1`,
    [tenantId, revisionId])
  return result.rows[0] || null
}


function packageAbsolutePath(storageKey = '') {
  const key = clean(storageKey).replaceAll('\\', '/')
  if (!key || key.startsWith('/') || key.includes('../')) return ''
  const absolute = path.resolve(packageRoot, key)
  if (absolute !== packageRoot && !absolute.startsWith(packageRoot + path.sep)) return ''
  return absolute
}
function packageTokenHash(token = '') {
  return createHash('sha256').update(clean(token), 'utf8').digest('hex')
}
function scopeRank(type = '') { return ({ Estate: 100, Site: 200, Group: 300, User: 400, Device: 500 })[clean(type)] || 0 }
function actorLabel(identity = {}) { return clean(identity.displayName || identity.upn || identity.username || 'End user').slice(0, 255) }
async function requireManage(c) {
  const session = await resolveSession(c)
  if (!session) return { error: c.json({ error: 'Authentication required.' }, 401) }
  if (!originMatchesTenant(c.req.header('origin'), session.slug)) {
    return { error: c.json({ error: 'Tenant session mismatch.' }, 403) }
  }
  if (!hasPermission(session.access, 'rmm.software.manage')) {
    return { error: c.json({ error: 'You do not have permission to manage App Portal.' }, 403) }
  }
  return { session }
}

async function requireAgent(c) {
  const agent = await authenticateAgent(
    c.req.header('x-hi5-device-id'),
    c.req.header('x-hi5-agent-secret'),
  )
  if (!agent) return { error: c.json({ success: false, error: 'Agent authentication failed.' }, 401) }
  return { agent }
}

function normalizedIdentity(body = {}) {
  const identity = object(body.identity)
  return {
    sid: clean(identity.sid).slice(0, 255),
    username: clean(identity.username).slice(0, 255),
    upn: clean(identity.upn).toLowerCase().slice(0, 320),
    displayName: clean(identity.displayName).slice(0, 255),
    sessionId: clean(identity.sessionId).slice(0, 80),
  }
}
async function rememberIdentity(agent, identity) {
  if (!identity.sid && !identity.upn && !identity.username) return
  if (identity.sid) {
    await pool.query(
      `INSERT INTO rmm_app_portal_end_users
        (tenant_id,agent_device_id,sid,username,upn,display_name,session_id,last_seen_at,source_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8::jsonb)
       ON CONFLICT (tenant_id,agent_device_id,sid) WHERE sid<>''
       DO UPDATE SET username=EXCLUDED.username,upn=EXCLUDED.upn,display_name=EXCLUDED.display_name,
                     session_id=EXCLUDED.session_id,last_seen_at=now(),source_payload=EXCLUDED.source_payload,updated_at=now()`,
      [agent.tenant_id, agent.id, identity.sid, identity.username, identity.upn, identity.displayName,
        identity.sessionId, JSON.stringify(identity)],
    )
    return
  }
  await pool.query(
    `UPDATE rmm_app_portal_end_users
        SET username=$4,display_name=$5,session_id=$6,last_seen_at=now(),source_payload=$7::jsonb,updated_at=now()
      WHERE id=(SELECT id FROM rmm_app_portal_end_users
                 WHERE tenant_id=$1 AND agent_device_id=$2 AND lower(upn)=lower($3)
                 ORDER BY last_seen_at DESC LIMIT 1)`,
    [agent.tenant_id, agent.id, identity.upn, identity.username, identity.displayName,
      identity.sessionId, JSON.stringify(identity)],
  )
}
async function adminBundle(tenantId) {
  const [apps, revisions, assignments, requests, catalogue, unsignedApprovals, devices] = await Promise.all([
    pool.query(
      `SELECT a.*,r.revision AS current_revision,r.version,r.source_kind,r.publish_state,r.validation
         FROM rmm_app_portal_apps a
         LEFT JOIN rmm_app_portal_revisions r ON r.id=a.current_revision_id
        WHERE a.tenant_id=$1 AND a.status<>'archived'
        ORDER BY lower(a.name)`, [tenantId]),
    pool.query(
      `SELECT r.* FROM rmm_app_portal_revisions r
         JOIN rmm_app_portal_apps a ON a.id=r.app_id AND a.tenant_id=$1
        ORDER BY r.app_id,r.revision DESC`, [tenantId]),
    pool.query(
      `SELECT x.* FROM rmm_app_portal_assignments x
         JOIN rmm_app_portal_apps a ON a.id=x.app_id AND a.tenant_id=$1
        WHERE x.enabled=true ORDER BY x.priority DESC,x.created_at`, [tenantId]),
    pool.query(
      `SELECT q.*,a.name AS app_name
         FROM rmm_app_portal_requests q JOIN rmm_app_portal_apps a ON a.id=q.app_id
        WHERE q.tenant_id=$1 ORDER BY q.created_at DESC LIMIT 250`, [tenantId]),
    pool.query(
      `SELECT id,canonical_name,publisher,target_version,provider,provider_package_id,
              installer_type,qualification_state,qualification_version,catalogue_source,icon_url
         FROM rmm_software_catalogue
        WHERE status='active' AND (tenant_id=$1 OR tenant_id IS NULL)
          AND qualification_state IN ('qualified','qualified_limited')
        ORDER BY lower(canonical_name) LIMIT 1000`, [tenantId]),
    pool.query(
      `SELECT id,tenant_id,app_id,revision_id,package_sha256,approved_by_user_id,
              reason,approved_at,revoked_at
         FROM rmm_app_portal_unsigned_approvals
        WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY approved_at DESC`, [tenantId]),
    pool.query(
      `SELECT d.id,d.inventory_id,i.name,i.manufacturer,i.model,i.reference,
              d.agent_version,d.websocket_status
         FROM rmm_agent_devices d
         JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=d.tenant_id
        WHERE d.tenant_id=$1 AND d.disabled_at IS NULL
        ORDER BY lower(i.name) LIMIT 2000`, [tenantId]),
  ])
  return {
    apps: apps.rows,
    revisions: revisions.rows,
    assignments: assignments.rows,
    requests: requests.rows,
    catalogue: catalogue.rows,
    unsignedApprovals: unsignedApprovals.rows,
    devices: devices.rows,
  }
}
function validateCustomRevision(body = {}) {
  const source = object(body.sourceConfig)
  const execution = object(body.execution)
  const verification = object(body.verification)
  const version = clean(body.version)
  const sourceKind = lower(body.sourceKind || 'direct_url')
  const installerType = lower(body.installerType)
  const expectedSigner = clean(body.expectedSigner)
  const sha256 = clean(body.sha256)
  const mode = lower(execution.mode || 'arguments')
  const errors = []

  if (!version || version.length > 100) errors.push('A version is required.')
  if (!['direct_url','upload'].includes(sourceKind)) errors.push('Custom source type is invalid.')
  if (sourceKind === 'direct_url' && !validHttps(source.url)) errors.push('Direct source must be a valid HTTPS URL.')
  if (sourceKind === 'upload' && (!clean(source.storageKey) || !Number(source.byteSize))) errors.push('Uploaded package is missing.')
  if (!validSha256(sha256)) errors.push('A 64-character SHA-256 is required.')
  if (!expectedSigner || expectedSigner.length > 255) errors.push('An expected Authenticode signer is required.')
  if (!['msi','exe'].includes(installerType)) errors.push('Installer type must be MSI or EXE.')
  if (!['arguments','powershell','batch'].includes(mode)) errors.push('Execution mode is not supported.')
  if (mode === 'arguments' && clean(execution.arguments).length > 1000) errors.push('Install arguments are too long.')
  if (mode !== 'arguments') {
    const script = String(execution.script || '')
    if (!script || script.length > 128 * 1024) errors.push('Install script is required and must be 128 KB or smaller.')
  }
  const timeout = Number(execution.timeoutSeconds || 600)
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) errors.push('Timeout must be between 30 and 3600 seconds.')
  const method = lower(verification.method)
  if (!['uninstall_registry','file_version'].includes(method)) errors.push('Use uninstall registry or file version verification.')
  if (method === 'uninstall_registry' && !clean(verification.productCode) && !clean(verification.displayNameContains)) {
    errors.push('Registry verification requires product code or display name.')
  }
  if (method === 'file_version' && !clean(verification.filePath)) errors.push('File version verification requires a file path.')
  return errors
}
async function assignmentContext(agent, identity) {
  const [device, groups] = await Promise.all([
    pool.query(
      `SELECT i.id AS inventory_id,i.reference,i.user_principal_name,p.email AS person_email,
              s.id::text AS site_uuid,s.external_key AS site_external_key
         FROM rmm_device_inventory i
         LEFT JOIN organisation_people p ON p.id=i.assigned_person_id AND p.tenant_id=i.tenant_id
         LEFT JOIN organisation_sites s ON s.id=p.site_id AND s.tenant_id=i.tenant_id
        WHERE i.id=$1 AND i.tenant_id=$2 LIMIT 1`, [agent.inventory_id, agent.tenant_id]),
    pool.query(
      `SELECT g.id::text AS id,g.name FROM rmm_device_group_memberships gm
         JOIN rmm_device_groups g ON g.id=gm.group_id AND g.tenant_id=$2
        WHERE gm.inventory_id=$1`, [agent.inventory_id, agent.tenant_id]),
  ])
  const row = device.rows[0] || {}
  const deviceIds = new Set([clean(agent.id), clean(agent.inventory_id), clean(row.reference)].filter(Boolean).map(lower))
  const userIds = new Set([identity.sid, identity.upn, identity.username, row.user_principal_name, row.person_email]
    .filter(Boolean).map(lower))
  const siteIds = new Set([row.site_uuid, row.site_external_key].filter(Boolean).map(lower))
  const groupIds = new Set(groups.rows.flatMap((group) => [group.id, group.name]).filter(Boolean).map(lower))
  return { row, deviceIds, userIds, siteIds, groupIds }
}

function assignmentMatches(assignment, context) {
  const id = lower(assignment.scope_id)
  if (assignment.scope_type === 'Estate') return id === '*' || id === 'estate' || !id
  if (assignment.scope_type === 'Device') return context.deviceIds.has(id)
  if (assignment.scope_type === 'User') return context.userIds.has(id)
  if (assignment.scope_type === 'Site') return context.siteIds.has(id)
  if (assignment.scope_type === 'Group') return context.groupIds.has(id)
  return false
}
async function resolvedApps(agent, identity) {
  const context = await assignmentContext(agent, identity)
  const result = await pool.query(
    `SELECT a.id,a.name,a.publisher,a.description,a.category,a.icon_url,a.source_type,a.catalogue_id,
            (SELECT count(*)::int
               FROM rmm_app_portal_installations i
              WHERE i.tenant_id=a.tenant_id AND i.app_id=a.id AND i.status='succeeded') AS install_count,
            r.id AS revision_id,r.revision,r.version,r.source_kind,r.publish_state,
            r.source_config,
            x.id AS assignment_id,x.scope_type,x.scope_id,x.scope_name,x.intent,x.priority
       FROM rmm_app_portal_apps a
       JOIN rmm_app_portal_revisions r ON r.id=a.current_revision_id AND r.publish_state='published'
       JOIN rmm_app_portal_assignments x ON x.app_id=a.id AND x.tenant_id=a.tenant_id AND x.enabled=true
      WHERE a.tenant_id=$1 AND a.status='published'
        AND (r.source_kind<>'upload'
          OR COALESCE(r.source_config->'inspection'->>'status','')<>'unsigned'
          OR EXISTS (SELECT 1 FROM rmm_app_portal_unsigned_approvals ua
              WHERE ua.tenant_id=r.tenant_id AND ua.revision_id=r.id
                AND ua.revoked_at IS NULL AND ua.package_sha256=r.sha256))
      ORDER BY lower(a.name),x.priority DESC`, [agent.tenant_id],
  )
  const byApp = new Map()
  for (const row of result.rows) {
    if (row.source_kind === 'upload' && object(object(row.source_config).inspection).status === 'unsigned'
      && !allowedUnsignedScope(row.scope_type, row.intent)) continue
    if (!assignmentMatches(row, context)) continue
    const score = scopeRank(row.scope_type) * 100000 + Number(row.priority || 0)
    const current = byApp.get(row.id)
    if (!current || score > current.score) byApp.set(row.id, { score, row })
  }
  return [...byApp.values()].map(({ row }) => ({
    id: row.id,
    name: row.name,
    publisher: row.publisher,
    description: row.description,
    category: row.category,
    iconUrl: row.icon_url,
    sourceType: row.source_type,
    catalogueId: row.catalogue_id,
    installCount: Number(row.install_count || 0),
    revisionId: row.revision_id,
    revision: row.revision,
    version: row.version,
    intent: row.intent,
    scope: { type: row.scope_type, id: row.scope_id, name: row.scope_name },
  })).filter((app) => app.intent !== 'hidden')
}
async function revisionForInstall(tenantId, appId) {
  const result = await pool.query(
    `SELECT a.id AS app_id,a.name,a.publisher,a.catalogue_id,a.source_type,a.status,
            r.id AS revision_id,r.revision,r.version,r.source_kind,r.source_config,r.sha256,
            r.expected_signer,r.installer_type,r.execution,r.verification,r.publish_state
       FROM rmm_app_portal_apps a
       JOIN rmm_app_portal_revisions r ON r.id=a.current_revision_id
      WHERE a.tenant_id=$1 AND a.id=$2 AND a.status='published' AND r.publish_state='published'
      LIMIT 1`, [tenantId, appId],
  )
  return result.rows[0] || null
}

async function dispatchCustomInstall(agent, app, identity) {
  const capabilitiesResult = await pool.query(
    `SELECT patch_capabilities,websocket_status,last_telemetry_at FROM rmm_agent_devices
      WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [agent.id, agent.tenant_id])
  const state = capabilitiesResult.rows[0] || {}
  const socket = agentSocketForDevice(agent.id)
  const fresh = state.last_telemetry_at && Date.now() - new Date(state.last_telemetry_at).getTime() <= 90_000
  if (!socket || socket.readyState !== 1 || !fresh) return { error: 'This device is offline.', status: 409 }
  if (object(state.patch_capabilities).softwareInstall !== true) {
    return { error: 'PatchHost software installation is not available on this device.', status: 409 }
  }

  const source = object(app.source_config)
  const execution = object(app.execution)
  const mode = lower(execution.mode || 'arguments')
  let unsignedApproval = null
  if (source.inspection?.status === 'unsigned') {
    if (app.source_kind !== 'upload') return { error: 'Unsigned HTTPS URLs are not supported.', status: 409 }
    const approved = await currentUnsignedApproval(agent.tenant_id, app.revision_id)
    const revisionIdentity = { ...app, tenant_id: agent.tenant_id }
    if (!approvalMatches(revisionIdentity, approved)) {
      return { error: 'The unsigned package approval was revoked or does not match this revision and hash.', status: 409 }
    }
    // Enforce device-only scope again at dispatch time, not just catalogue view.
    const allowedDevice = await pool.query(
      `SELECT 1 FROM rmm_app_portal_assignments x
         JOIN rmm_agent_devices d ON d.tenant_id=x.tenant_id AND d.id=$3
         LEFT JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=d.tenant_id
        WHERE x.tenant_id=$1 AND x.app_id=$2 AND x.enabled=true AND x.scope_type='Device'
          AND x.intent IN ('available','approval_required')
          AND lower(x.scope_id) IN (lower(d.id::text),lower(d.inventory_id::text),lower(i.reference))
        LIMIT 1`, [agent.tenant_id, app.app_id, agent.id])
    if (!allowedDevice.rowCount) return { error: 'Unsigned software may only be assigned to an individual managed device.', status: 403 }
    if (object(object(state.patch_capabilities).vendorDirect).approvedUnsigned !== true) {
      return { error: 'This device needs a Hi5Central Agent with approved unsigned-package support before installation.', status: 409 }
    }
    unsignedApproval = unsignedManifestApproval(revisionIdentity, approved, agent.id)
    if (!unsignedApproval || mode !== 'arguments') {
      return { error: 'Unsigned approval does not cover this installer or execution mode.', status: 409 }
    }
  }
  if (mode !== 'arguments') {
    const vendorDirect = object(object(state.patch_capabilities).vendorDirect)
    if (vendorDirect.customExecution !== true) {
      return { error: 'This endpoint needs the latest Hi5Central Agent before it can run a custom application script.', status: 409 }
    }
  }

  let downloadUrl = clean(source.url)
  if (app.source_kind === 'upload') {
    const storagePath = packageAbsolutePath(source.storageKey)
    if (!storagePath || !validSha256(app.sha256)) {
      return { error: 'The uploaded package is incomplete or invalid.', status: 409 }
    }
    try {
      const info = await stat(storagePath)
      if (!info.isFile() || Number(info.size) !== Number(source.byteSize)) {
        return { error: 'The uploaded package is unavailable or changed on storage.', status: 409 }
      }
    } catch {
      return { error: 'The uploaded package is unavailable.', status: 409 }
    }
    const token = randomBytes(32).toString('base64url')
    await pool.query(
      `DELETE FROM rmm_app_portal_package_tokens WHERE expires_at < now() - interval '1 day'`).catch(() => null)
    await pool.query(
      `INSERT INTO rmm_app_portal_package_tokens
        (tenant_id,revision_id,agent_device_id,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '45 minutes')`,
      [agent.tenant_id, app.revision_id, agent.id, packageTokenHash(token)])
    downloadUrl = `${String(deployment.apiUrl || `https://api.${deployment.rootDomain}`).replace(/\/$/, '')}/api/v1/agent/app-portal/packages/${token}`
  }
  if (!validHttps(downloadUrl)) return { error: 'Application download URL is invalid.', status: 409 }

  const manifest = {
    protocolVersion: 1,
    action: 'software.install',
    intent: 'install',
    applicationName: app.name,
    publisher: app.publisher,
    packageId: '',
    installedVersion: '',
    targetVersion: app.version,
    provider: 'vendor_direct',
    downloadUrl,
    sha256: clean(app.sha256).toUpperCase(),
    installerType: lower(app.installer_type),
    installerTechnology: lower(app.installer_type) === 'msi' ? 'msi' : clean(execution.installerTechnology || 'generic'),
    expectedSigner: clean(app.expected_signer),
    ...(unsignedApproval ? { unsignedApproval } : {}),
    installArguments: mode === 'arguments' ? clean(execution.arguments) : '',
    customExecution: mode === 'arguments' ? null : {
      mode,
      script: String(execution.script || ''),
      timeoutSeconds: Number(execution.timeoutSeconds || 600),
      successExitCodes: array(execution.successExitCodes).map(Number).filter(Number.isInteger).slice(0, 16),
    },
    verification: {
      ...object(app.verification),
      method: lower(object(app.verification).method),
      targetVersion: clean(object(app.verification).targetVersion || app.version),
    },
  }

  const label = actorLabel(identity)
  const created = await withTransaction(async (client) => {
    const installResult = await client.query(
      `INSERT INTO rmm_app_portal_installations
        (tenant_id,app_id,revision_id,inventory_id,agent_device_id,requested_by_sid,requested_by_upn,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
      [agent.tenant_id, app.app_id, app.revision_id, agent.inventory_id, agent.id, identity.sid, identity.upn],
    )
    const installation = installResult.rows[0]
    const jobResult = await client.query(
      `INSERT INTO rmm_agent_jobs
        (tenant_id,agent_device_id,job_type,payload,initiated_by,initiated_by_label,request_metadata)
       VALUES ($1,$2,'patch.software',$3::jsonb,'system',$4,$5::jsonb)
       RETURNING id,status,correlation_id,created_at`,
      [agent.tenant_id, agent.id, JSON.stringify(manifest), label,
        JSON.stringify({ source: 'app_portal', app_portal_installation_id: installation.id,
          app_id: app.app_id, revision_id: app.revision_id, intent: 'install' })],
    )
    const job = jobResult.rows[0]
    await client.query(
      `UPDATE rmm_app_portal_installations SET agent_job_id=$2,status='running',started_at=now(),updated_at=now()
        WHERE id=$1`, [installation.id, job.id])
    return { installation, job }
  })
  // Agent's persistent /jobs poll owns claiming and acknowledgement. A
  // WebSocket send is advisory and must never mark a job as executing before
  // Windows has actually received it; doing so stranded App Portal installs.
  // Keep this queued until Agent polls, even after a temporary reconnect.
  await recordRmmActivity({
    tenantId: agent.tenant_id, agentDeviceId: agent.id, inventoryId: agent.inventory_id,
    actorType: 'user', actorLabel: label, eventType: 'software.install.requested', category: 'software',
    summary: label + ' requested App Portal install “' + app.name + '”',
    detail: 'Target ' + app.version + ' · custom revision ' + app.revision,
    outcome: 'requested', jobId: created.job.id, correlationId: created.job.correlation_id,
    metadata: { appId: app.app_id, revisionId: app.revision_id, installationId: created.installation.id },
  }).catch(() => null)
  return { success: true, jobId: created.job.id, installationId: created.installation.id }
}
async function dispatchCatalogueInstall(agent, app, identity) {
  const plan = await softwarePatchPlan(agent.tenant_id, agent.id, app.catalogue_id, { intent: 'install' })
  if (plan.error) return plan
  const label = actorLabel(identity)
  const created = await withTransaction(async (client) => {
    const installationResult = await client.query(
      `INSERT INTO rmm_app_portal_installations
        (tenant_id,app_id,revision_id,inventory_id,agent_device_id,requested_by_sid,requested_by_upn,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
      [agent.tenant_id, app.app_id, app.revision_id, agent.inventory_id, agent.id, identity.sid, identity.upn])
    const installation = installationResult.rows[0]
    const jobResult = await client.query(
      `INSERT INTO rmm_agent_jobs
        (tenant_id,agent_device_id,job_type,payload,initiated_by,initiated_by_label,request_metadata)
       VALUES ($1,$2,'patch.software',$3::jsonb,'system',$4,$5::jsonb)
       RETURNING id,status,correlation_id,created_at`,
      [agent.tenant_id, agent.id, JSON.stringify(plan.manifest), label,
        JSON.stringify({ source: 'app_portal', app_portal_installation_id: installation.id,
          app_id: app.app_id, revision_id: app.revision_id, catalogue_id: app.catalogue_id, intent: 'install' })])
    const job = jobResult.rows[0]
    await client.query(
      `INSERT INTO rmm_patch_deployments
        (tenant_id,inventory_id,catalogue_id,agent_job_id,application_name,provider,provider_package_id,
         installed_version,target_version,status,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,'running',$9::jsonb)`,
      [agent.tenant_id, agent.inventory_id, app.catalogue_id, job.id, plan.manifest.applicationName,
        plan.provider, plan.manifest.packageId, plan.manifest.targetVersion,
        JSON.stringify({ source: 'app_portal', appPortalInstallationId: installation.id })])
    await client.query(
      `UPDATE rmm_app_portal_installations SET agent_job_id=$2,status='running',started_at=now(),updated_at=now()
        WHERE id=$1`, [installation.id, job.id])
    return { installation, job }
  })
  // Existing Agent polling claims the job and reports its result.
  // Avoid pre-claiming and losing it when a WebSocket dispatch is missed.
  await recordRmmActivity({
    tenantId: agent.tenant_id, agentDeviceId: agent.id, inventoryId: agent.inventory_id,
    actorType: 'user', actorLabel: label, eventType: 'software.install.requested', category: 'software',
    summary: label + ' requested App Portal install “' + app.name + '”',
    detail: 'Target ' + plan.manifest.targetVersion + ' via ' + plan.provider,
    outcome: 'requested', jobId: created.job.id, correlationId: created.job.correlation_id,
    metadata: { appId: app.app_id, revisionId: app.revision_id, installationId: created.installation.id },
  }).catch(() => null)
  return { success: true, jobId: created.job.id, installationId: created.installation.id }
}

export function registerRmmAppPortalRoutes(app) {
  registerAppPortalDeviceRoutes(app, {
    pool, requireManage, agentSocketForDevice, sendAgentMessage, recordRmmActivity,
  })

  app.get('/api/v1/agent/app-portal/packages/:token', async (c) => {
    const token = clean(c.req.param('token'))
    if (token.length < 40 || token.length > 100) return c.json({ error: 'Package token is invalid.' }, 404)
    const tokenHash = packageTokenHash(token)
    const found = await pool.query(
      `SELECT t.id,t.expires_at,t.tenant_id,t.revision_id,r.source_kind,r.source_config,r.sha256,r.installer_type
         FROM rmm_app_portal_package_tokens t
         JOIN rmm_app_portal_revisions r ON r.id=t.revision_id AND r.tenant_id=t.tenant_id
        WHERE t.token_hash=$1 AND t.expires_at>now() AND r.source_kind='upload'
        LIMIT 1`,
      [tokenHash])
    const row = found.rows[0]
    if (!row) return c.json({ error: 'Package token is invalid or expired.' }, 404)
    const source = object(row.source_config)
    if (object(source.inspection).status === 'unsigned') {
      const approval = await currentUnsignedApproval(row.tenant_id, row.revision_id)
      if (!approvalMatches({ ...row, id: row.revision_id }, approval)) {
        return c.json({ error: 'Unsigned approval was revoked; package download blocked.' }, 403)
      }
    }
    const absolute = packageAbsolutePath(source.storageKey)
    if (!absolute) return c.json({ error: 'Package is unavailable.' }, 404)
    let info
    try { info = await stat(absolute) } catch { return c.json({ error: 'Package is unavailable.' }, 404) }
    if (!info.isFile() || Number(info.size) !== Number(source.byteSize)) {
      return c.json({ error: 'Package storage validation failed.' }, 409)
    }
    await pool.query(
      `UPDATE rmm_app_portal_package_tokens SET used_at=COALESCE(used_at,now()) WHERE id=$1`,
      [row.id]).catch(() => null)
    const fileName = path.basename(clean(source.fileName || ('package.' + row.installer_type))).replaceAll('"', '')
    return new Response(Readable.toWeb(createReadStream(absolute)), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': 'attachment; filename="' + fileName + '"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Hi5-SHA256': clean(row.sha256),
      },
    })
  })


  // Public raster assets at 192-bit unguessable URLs so Windows Self Service
  // can load images over HTTPS without having a technician login cookie.
  app.get('/api/v1/rmm/app-portal/icons/:token', async (c) => {
    const token = clean(c.req.param('token'))
    if (!/^[a-f0-9]{48}$/.test(token)) return c.json({ error: 'Logo not found.' }, 404)
    const url = String(deployment.apiUrl || ('https://api.' + deployment.rootDomain))
      .replace(/\/$/, '') + '/api/v1/rmm/app-portal/icons/' + token
    const exists = await pool.query(
      'SELECT 1 FROM rmm_app_portal_apps WHERE icon_url=$1 AND status<>$2 LIMIT 1',
      [url, 'archived'])
    if (!exists.rowCount) return c.json({ error: 'Logo not found.' }, 404)
    const filename = path.join(packageRoot, '_icons', token + '.png')
    let info
    try { info = await stat(filename) } catch { return c.json({ error: 'Logo not found.' }, 404) }
    if (!info.isFile() || info.size <= 0 || info.size > MAX_APP_PORTAL_ICON_BYTES) {
      return c.json({ error: 'Logo unavailable.' }, 404)
    }
    return new Response(Readable.toWeb(createReadStream(filename)), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(info.size),
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  })

  app.put('/api/v1/rmm/app-portal/apps/:appId/icon', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const appId = clean(c.req.param('appId'))
    if (!uuid(appId)) return c.json({ error: 'Application id is invalid.' }, 400)
    const found = await pool.query(
      "SELECT id,icon_url FROM rmm_app_portal_apps WHERE id=$1 AND tenant_id=$2 AND status<>'archived' LIMIT 1",
      [appId, auth.session.tenant_id])
    if (!found.rowCount) return c.json({ error: 'Application was not found.' }, 404)
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/png') {
      return c.json({ error: 'Choose a PNG logo.' }, 415)
    }
    const length = Number(c.req.header('content-length') || 0)
    if (length > MAX_APP_PORTAL_ICON_BYTES) {
      return c.json({ error: 'Logo exceeds the 512 KB limit.' }, 413)
    }
    if (!c.req.raw.body) return c.json({ error: 'Logo file is required.' }, 400)
    let total = 0
    const chunks = []
    try {
      for await (const chunk of Readable.fromWeb(c.req.raw.body)) {
        total += chunk.byteLength
        if (total > MAX_APP_PORTAL_ICON_BYTES) {
          return c.json({ error: 'Logo exceeds the 512 KB limit.' }, 413)
        }
        chunks.push(Buffer.from(chunk))
      }
    } catch {
      return c.json({ error: 'Logo upload was interrupted.' }, 400)
    }
    const data = Buffer.concat(chunks)
    const validation = inspectAppPortalIcon(data)
    if (validation.error) return c.json({ error: validation.error }, 400)

    const token = randomBytes(24).toString('hex')
    const folder = path.join(packageRoot, '_icons')
    const filePath = path.join(folder, token + '.png')
    const url = String(deployment.apiUrl || ('https://api.' + deployment.rootDomain))
      .replace(/\/$/, '') + '/api/v1/rmm/app-portal/icons/' + token
    await mkdir(folder, { recursive: true })
    try {
      await writeFile(filePath, data, { flag: 'wx', mode: 0o600 })
      const updated = await pool.query(
        "UPDATE rmm_app_portal_apps SET icon_url=$3,updated_by_user_id=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status<>'archived' RETURNING id,icon_url",
        [appId, auth.session.tenant_id, url, auth.session.user_id])
      if (!updated.rowCount) throw new Error('Application not found.')
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => null)
      console.error('App Portal logo upload failed', appId, error)
      return c.json({ error: 'Unable to save the application logo.' }, 500)
    }
    return c.json({ success: true, iconUrl: url, width: validation.width, height: validation.height })
  })

  app.get('/api/v1/rmm/app-portal', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    return c.json({
      ...await adminBundle(auth.session.tenant_id),
      canApproveUnsigned: auth.session.tenant_role === 'owner',
    })
  })
  app.post('/api/v1/rmm/app-portal/apps', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const sourceType = lower(body.sourceType)
    const name = clean(body.name).slice(0, 255)
    if (!['catalogue','custom'].includes(sourceType) || !name) {
      return c.json({ error: 'Application name and source type are required.' }, 400)
    }
    const catalogueId = sourceType === 'catalogue' ? clean(body.catalogueId) : null
    if (catalogueId && !uuid(catalogueId)) return c.json({ error: 'Catalogue id is invalid.' }, 400)
    let catalogue = null
    if (catalogueId) {
      const found = await pool.query(
        `SELECT id,canonical_name,publisher,target_version,icon_url FROM rmm_software_catalogue
          WHERE id=$1 AND status='active' AND (tenant_id=$2 OR tenant_id IS NULL)
            AND qualification_state IN ('qualified','qualified_limited') LIMIT 1`,
        [catalogueId, auth.session.tenant_id])
      catalogue = found.rows[0]
      if (!catalogue) return c.json({ error: 'Qualified catalogue application was not found.' }, 404)
    }
    const created = await withTransaction(async (client) => {
      const appResult = await client.query(
        `INSERT INTO rmm_app_portal_apps
          (tenant_id,catalogue_id,source_type,name,publisher,description,category,icon_url,
           created_by_user_id,updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [auth.session.tenant_id, catalogueId, sourceType, catalogue?.canonical_name || name,
          catalogue?.publisher || clean(body.publisher).slice(0,255), clean(body.description).slice(0,4000),
          clean(body.category || 'Company software').slice(0,120),
          clean(body.iconUrl || catalogue?.icon_url).slice(0,1000), auth.session.user_id])
      const portalApp = appResult.rows[0]
      if (sourceType !== 'catalogue') return portalApp
      const revisionResult = await client.query(
        `INSERT INTO rmm_app_portal_revisions
          (tenant_id,app_id,revision,version,source_kind,publish_state,created_by_user_id)
         VALUES ($1,$2,1,$3,'catalogue','draft',$4) RETURNING *`,
        [auth.session.tenant_id, portalApp.id, catalogue.target_version || '', auth.session.user_id])
      await client.query(`UPDATE rmm_app_portal_apps SET current_revision_id=$2 WHERE id=$1`,
        [portalApp.id, revisionResult.rows[0].id])
      return { ...portalApp, current_revision_id: revisionResult.rows[0].id }
    })
    return c.json({ success: true, app: created }, 201)
  })

  // Draft metadata can be corrected without creating a duplicate application.
  app.patch('/api/v1/rmm/app-portal/apps/:appId', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const appId = clean(c.req.param('appId'))
    if (!uuid(appId)) return c.json({ error: 'Application id is invalid.' }, 400)
    const body = await c.req.json().catch(() => ({}))
    const name = clean(body.name).slice(0, 255)
    if (!name) return c.json({ error: 'Application name is required.' }, 400)
    const result = await pool.query(
      "UPDATE rmm_app_portal_apps SET name=$3,publisher=$4,description=$5,category=$6,updated_by_user_id=$7,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND source_type='custom' AND status='draft' RETURNING *",
      [appId, auth.session.tenant_id, name, clean(body.publisher).slice(0, 255),
        clean(body.description).slice(0, 4000), clean(body.category || 'Company software').slice(0, 120), auth.session.user_id])
    if (!result.rowCount) return c.json({ error: 'Only an existing custom draft can be edited.' }, 409)
    return c.json({ success: true, app: result.rows[0] })
  })

  app.post('/api/v1/rmm/app-portal/apps/:appId/revisions', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const appId = clean(c.req.param('appId'))
    const body = await c.req.json().catch(() => ({}))
    const portalApp = await pool.query(
      `SELECT * FROM rmm_app_portal_apps
        WHERE id=$1 AND tenant_id=$2 AND status<>'archived' LIMIT 1`,
      [appId, auth.session.tenant_id])
    if (!portalApp.rowCount) return c.json({ error: 'App Portal application was not found.' }, 404)
    if (portalApp.rows[0].source_type === 'catalogue') {
      return c.json({ error: 'Catalogue revisions are controlled by the qualified catalogue.' }, 409)
    }
    const sourceKind = lower(body.sourceKind || 'direct_url')
    if (!['direct_url','upload'].includes(sourceKind)) return c.json({ error: 'Custom source type is invalid.' }, 400)
    const revisionNumber = await pool.query(
      `SELECT COALESCE(MAX(revision),0)+1 AS next FROM rmm_app_portal_revisions WHERE app_id=$1`, [appId])
    const inserted = await pool.query(
      `INSERT INTO rmm_app_portal_revisions
        (tenant_id,app_id,revision,version,source_kind,source_config,sha256,expected_signer,installer_type,
         execution,verification,validation,publish_state,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,'{}'::jsonb,'draft',$12)
       RETURNING *`,
      [auth.session.tenant_id, appId, Number(revisionNumber.rows[0].next), clean(body.version), sourceKind,
        JSON.stringify(object(body.sourceConfig)), clean(body.sha256).toUpperCase(), clean(body.expectedSigner),
        lower(body.installerType), JSON.stringify(object(body.execution)), JSON.stringify(object(body.verification)),
        auth.session.user_id])
    await pool.query(
      `UPDATE rmm_app_portal_apps SET current_revision_id=$2,updated_by_user_id=$3,updated_at=now() WHERE id=$1`,
      [appId, inserted.rows[0].id, auth.session.user_id])
    return c.json({ success: true, revision: inserted.rows[0] }, 201)
  })

  app.put('/api/v1/rmm/app-portal/revisions/:revisionId/package', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const revisionId = clean(c.req.param('revisionId'))
    const found = await pool.query(
      `SELECT r.id,r.app_id,r.installer_type,r.source_kind,r.publish_state
         FROM rmm_app_portal_revisions r
         JOIN rmm_app_portal_apps a ON a.id=r.app_id AND a.tenant_id=r.tenant_id
        WHERE r.id=$1 AND r.tenant_id=$2 AND a.source_type='custom' LIMIT 1`,
      [revisionId, auth.session.tenant_id])
    const revision = found.rows[0]
    if (!revision) return c.json({ error: 'Revision was not found.' }, 404)
    if (revision.source_kind !== 'upload' || revision.publish_state !== 'draft') {
      return c.json({ error: 'Only draft upload revisions can receive a package.' }, 409)
    }
    if (!c.req.raw.body) return c.json({ error: 'Package body is required.' }, 400)
    const contentLength = Number(c.req.header('content-length') || 0)
    if (contentLength > maxPackageBytes) return c.json({ error: 'Package exceeds the 2 GB upload limit.' }, 413)

    let fileName = clean(c.req.header('x-hi5-filename') || 'package.' + revision.installer_type)
    try { fileName = decodeURIComponent(fileName) } catch {}
    fileName = path.basename(fileName).slice(0, 255)
    const expectedSuffix = '.' + lower(revision.installer_type)
    if (!lower(fileName).endsWith(expectedSuffix)) {
      return c.json({ error: 'Uploaded filename must end in ' + expectedSuffix + '.' }, 400)
    }

    const storageKey = [auth.session.tenant_id, revision.app_id, revision.id + expectedSuffix].join('/')
    const absolute = packageAbsolutePath(storageKey)
    if (!absolute) return c.json({ error: 'Package storage path is invalid.' }, 500)
    await mkdir(path.dirname(absolute), { recursive: true })

    let byteSize = 0
    const digest = createHash('sha256')
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        byteSize += chunk.length
        if (byteSize > maxPackageBytes) return callback(new Error('package_too_large'))
        digest.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body), meter, createWriteStream(absolute, { flags: 'w' }))
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => null)
      if (error?.message === 'package_too_large') return c.json({ error: 'Package exceeds the 2 GB upload limit.' }, 413)
      console.error('App Portal package upload failed', revision.id, error)
      return c.json({ error: 'Package upload failed.' }, 500)
    }
    if (!byteSize) {
      await rm(absolute, { force: true }).catch(() => null)
      return c.json({ error: 'Uploaded package is empty.' }, 400)
    }

    const sha256 = digest.digest('hex').toUpperCase()
    // Read MSI properties / EXE version resources and embedded Authenticode
    // certificate only. Never run the uploaded binary to inspect its metadata.
    // The endpoint's WinVerifyTrust remains the final trust check before any install.
    let inspection
    try {
      inspection = await inspectUploadedPackage(absolute, revision.installer_type)
    } catch (error) {
      console.error('App Portal package inspection unavailable', revision.id, error)
      inspection = { status: 'inspection_unavailable', signer: '', digestMatched: false,
        metadata: { name: '', publisher: '', version: '', productCode: '' } }
    }
    const metadata = object(inspection.metadata)
    const sourceConfig = {
      storageKey,
      fileName,
      byteSize,
      contentType: clean(c.req.header('content-type') || 'application/octet-stream').slice(0, 150),
      uploadedAt: new Date().toISOString(),
      inspection: {
        status: inspection.status,
        signer: clean(inspection.signer),
        digestMatched: Boolean(inspection.digestMatched),
        metadata,
        inspectedAt: new Date().toISOString(),
        finalWindowsTrustRequired: true,
      },
    }
    // Package identity is learned automatically where MSI metadata is available.
    // Explicit administrator names/versions are never silently overwritten.
    await pool.query(
      `UPDATE rmm_app_portal_unsigned_approvals SET revoked_at=now()
        WHERE tenant_id=$1 AND revision_id=$2 AND revoked_at IS NULL`,
      [auth.session.tenant_id, revision.id])
    await pool.query(
      `UPDATE rmm_app_portal_revisions
          SET source_config=$3::jsonb,sha256=$4,
              expected_signer=CASE WHEN $5<>'' THEN $5 ELSE '' END,
              version=CASE WHEN version='' AND $6<>'' THEN $6 ELSE version END,
              verification=CASE
                WHEN verification->>'method'='uninstall_registry' AND $7<>'' THEN
                  jsonb_set(jsonb_set(verification,'{productCode}',to_jsonb($7::text)),
                    '{displayNameContains}',to_jsonb($8::text))
                ELSE verification END,
              validation=$9::jsonb
        WHERE id=$1 AND tenant_id=$2`,
      [revision.id, auth.session.tenant_id, JSON.stringify(sourceConfig), sha256,
       inspection.status === 'pending_windows_trust' ? clean(inspection.signer) : '',
       clean(metadata.version), clean(metadata.productCode), clean(metadata.name),
       JSON.stringify({ state: inspection.status, inspectedAt: new Date().toISOString() })])
    await pool.query(
      `UPDATE rmm_app_portal_apps
          SET publisher=CASE WHEN publisher='' AND $3<>'' THEN $3 ELSE publisher END,
              updated_at=now()
        WHERE id=$1 AND tenant_id=$2`,
      [revision.app_id, auth.session.tenant_id, clean(metadata.publisher)])
    return c.json({
      success: true, sha256, byteSize, fileName,
      inspection: sourceConfig.inspection,
    })
  })

  // Only a tenant owner can explicitly approve the exact SHA-256 of an
  // unsigned, already-uploaded draft. Approval is separately audited and can
  // never be carried to a different revision or a replacement package.
  app.post('/api/v1/rmm/app-portal/revisions/:revisionId/unsigned-approval', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    if (auth.session.tenant_role !== 'owner') {
      return c.json({ error: 'Only the tenant owner can approve unsigned installer packages.' }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    if (body.acknowledgeUnsigned !== true) {
      return c.json({ error: 'Explicit acknowledgement of unsigned installer risk is required.' }, 400)
    }
    const reason = clean(body.reason)
    if (reason.length < 12 || reason.length > 1000) {
      return c.json({ error: 'Provide an approval reason between 12 and 1000 characters.' }, 400)
    }
    const revisionId = clean(c.req.param('revisionId'))
    const result = await pool.query(
      `SELECT r.*,a.name AS app_name
         FROM rmm_app_portal_revisions r
         JOIN rmm_app_portal_apps a ON a.id=r.app_id AND a.tenant_id=r.tenant_id
        WHERE r.id=$1 AND r.tenant_id=$2 AND a.source_type='custom'
          AND a.current_revision_id=r.id AND a.status='draft'
          AND r.publish_state='draft' LIMIT 1`,
      [revisionId, auth.session.tenant_id])
    const revision = result.rows[0]
    if (!revision) return c.json({ error: 'Current unsigned draft was not found.' }, 404)
    if (!isUnsignedUpload(revision) || !validSha256(revision.sha256)) {
      return c.json({ error: 'Only an uploaded package positively classified as unsigned can use this approval.' }, 409)
    }
    if (!['msi','exe'].includes(lower(revision.installer_type))) {
      return c.json({ error: 'Unsigned approval is limited to MSI and EXE packages.' }, 409)
    }
    if (lower(object(revision.execution).mode || 'arguments') !== 'arguments') {
      return c.json({ error: 'Unsigned packages cannot run custom scripts.' }, 409)
    }
    const storage = object(revision.source_config)
    const filePath = packageAbsolutePath(storage.storageKey)
    if (!filePath) return c.json({ error: 'Package storage is invalid.' }, 409)
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size !== Number(storage.byteSize)
        || await hashStoredPackage(filePath) !== clean(revision.sha256).toUpperCase()) {
        return c.json({ error: 'Stored package differs from its recorded SHA-256 and cannot be approved.' }, 409)
      }
    } catch {
      return c.json({ error: 'Stored package is unavailable for verification.' }, 409)
    }
    const existing = await currentUnsignedApproval(auth.session.tenant_id, revision.id)
    if (existing && approvalMatches(revision, existing)) {
      return c.json({ success: true, approval: existing, alreadyApproved: true })
    }
    const inserted = await pool.query(
      `INSERT INTO rmm_app_portal_unsigned_approvals
        (tenant_id,app_id,revision_id,package_sha256,approved_by_user_id,reason)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id,revision_id) WHERE revoked_at IS NULL DO NOTHING
        RETURNING *`,
      [auth.session.tenant_id, revision.app_id, revision.id, clean(revision.sha256).toUpperCase(),
       auth.session.user_id, reason])
    const approval = inserted.rows[0] || await currentUnsignedApproval(auth.session.tenant_id, revision.id)
    if (!approvalMatches(revision, approval)) {
      return c.json({ error: 'Unsigned approval conflicted with a different package hash.' }, 409)
    }
    await recordRmmActivity({
      tenantId: auth.session.tenant_id, actorUserId: auth.session.user_id,
      actorType: 'technician', actorLabel: auth.session.name || auth.session.email,
      eventType: 'app_portal.unsigned.approved', category: 'software',
      summary: 'Tenant owner approved an unsigned App Portal revision',
      detail: revision.app_name + ' · SHA-256 ' + revision.sha256 + ' · ' + reason,
      outcome: 'success', metadata: { appId: revision.app_id, revisionId: revision.id,
        approvalId: approval.id, sha256: revision.sha256 },
    }).catch(error => console.error('Unsigned approval activity record failed', error))
    return c.json({ success: true, approval }, 201)
  })

  app.delete('/api/v1/rmm/app-portal/revisions/:revisionId/unsigned-approval', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    if (auth.session.tenant_role !== 'owner') {
      return c.json({ error: 'Only the tenant owner can revoke an unsigned package approval.' }, 403)
    }
    const result = await pool.query(
      `UPDATE rmm_app_portal_unsigned_approvals SET revoked_at=now(),revoked_by_user_id=$3
         WHERE tenant_id=$1 AND revision_id=$2 AND revoked_at IS NULL
         RETURNING id,app_id,package_sha256`,
      [auth.session.tenant_id, clean(c.req.param('revisionId')), auth.session.user_id])
    if (!result.rowCount) return c.json({ error: 'There is no active approval to revoke.' }, 404)
    await recordRmmActivity({
      tenantId: auth.session.tenant_id, actorUserId: auth.session.user_id,
      actorType: 'technician', actorLabel: auth.session.name || auth.session.email,
      eventType: 'app_portal.unsigned.revoked', category: 'software',
      summary: 'Tenant owner revoked unsigned package approval',
      detail: 'SHA-256 ' + result.rows[0].package_sha256,
      outcome: 'success', metadata: { appId: result.rows[0].app_id,
        revisionId: clean(c.req.param('revisionId')), approvalId: result.rows[0].id },
    }).catch(error => console.error('Unsigned revocation activity record failed', error))
    return c.json({ success: true, revoked: true })
  })

  app.post('/api/v1/rmm/app-portal/revisions/:revisionId/publish', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const revisionId = clean(c.req.param('revisionId'))
    const found = await pool.query(
      `SELECT r.*,a.source_type,a.catalogue_id FROM rmm_app_portal_revisions r
         JOIN rmm_app_portal_apps a ON a.id=r.app_id
        WHERE r.id=$1 AND r.tenant_id=$2 LIMIT 1`, [revisionId, auth.session.tenant_id])
    const revision = found.rows[0]
    if (!revision) return c.json({ error: 'Revision was not found.' }, 404)
    let errors = []
    if (revision.source_type === 'catalogue') {
      if (!revision.catalogue_id) errors.push('Catalogue identity is missing.')
      const catalogue = revision.catalogue_id ? await pool.query(
        `SELECT target_version,qualification_state FROM rmm_software_catalogue
          WHERE id=$1 AND status='active' LIMIT 1`, [revision.catalogue_id]) : { rowCount: 0, rows: [] }
      if (!catalogue.rowCount || !['qualified','qualified_limited'].includes(catalogue.rows[0].qualification_state)) {
        errors.push('Catalogue application is not currently qualified for deployment.')
      } else if (!clean(catalogue.rows[0].target_version)) {
        errors.push('Catalogue target version is missing.')
      } else {
        await pool.query(`UPDATE rmm_app_portal_revisions SET version=$2 WHERE id=$1`,
          [revisionId, catalogue.rows[0].target_version])
      }
    } else {
      errors = validateCustomRevision({
        version: revision.version, sourceKind: revision.source_kind, sourceConfig: revision.source_config, sha256: revision.sha256,
        expectedSigner: revision.expected_signer, installerType: revision.installer_type,
        execution: revision.execution, verification: revision.verification,
      })
      if (revision.source_kind === 'upload') {
        const inspection = object(object(revision.source_config).inspection)
        if (inspection.status === 'unsigned') {
          errors = errors.filter(error => error !== 'An expected Authenticode signer is required.')
          errors.push('This installer is unsigned. Hi5Central cannot deploy it while Windows signature verification is mandatory.')
        } else if (inspection.status !== 'pending_windows_trust' || !clean(inspection.signer)) {
          errors = errors.filter(error => error !== 'An expected Authenticode signer is required.')
          errors.push('The installer signing certificate could not be identified automatically. Please upload a valid signed installer.')
        }
      }
    }
    if (revision.source_type === 'custom' && isUnsignedUpload(revision)) {
      const approved = await currentUnsignedApproval(auth.session.tenant_id, revisionId)
      errors = errors.filter(error => error !== 'An expected Authenticode signer is required.'
        && !error.startsWith('This installer is unsigned.'))
      if (!approvalMatches(revision, approved)) {
        errors.push('This unsigned revision requires explicit tenant-owner approval of its exact SHA-256 before publishing.')
      } else if (lower(object(revision.execution).mode || 'arguments') !== 'arguments') {
        errors.push('Approved unsigned packages cannot execute custom scripts.')
      } else {
        const source = object(revision.source_config)
        const storagePath = packageAbsolutePath(source.storageKey)
        try {
          const info = storagePath ? await stat(storagePath) : null
          if (!info?.isFile() || info.size !== Number(source.byteSize)
            || await hashStoredPackage(storagePath) !== clean(revision.sha256).toUpperCase()) {
            errors.push('Stored unsigned package differs from its approved SHA-256.')
          }
        } catch {
          errors.push('The approved unsigned package could not be verified on storage.')
        }
      }
    }
    if (errors.length) {
      await pool.query(`UPDATE rmm_app_portal_revisions SET validation=$2::jsonb WHERE id=$1`,
        [revisionId, JSON.stringify({ state: 'failed', errors, validatedAt: new Date().toISOString() })])
      return c.json({ error: 'Revision cannot be published.', errors }, 409)
    }
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE rmm_app_portal_revisions SET publish_state='retired'
          WHERE app_id=$1 AND id<>$2 AND publish_state='published'`, [revision.app_id, revisionId])
      await client.query(
        `UPDATE rmm_app_portal_revisions
            SET publish_state='published',published_at=now(),validation=$2::jsonb WHERE id=$1`,
        [revisionId, JSON.stringify({ state: 'passed', validatedAt: new Date().toISOString() })])
      await client.query(
        `UPDATE rmm_app_portal_apps SET status='published',current_revision_id=$2,
                updated_by_user_id=$3,updated_at=now() WHERE id=$1`,
        [revision.app_id, revisionId, auth.session.user_id])
    })
    await recordRmmActivity({
      tenantId: auth.session.tenant_id, actorUserId: auth.session.user_id, actorType: 'technician',
      actorLabel: auth.session.name || auth.session.email || 'Technician',
      eventType: 'app_portal.revision.published', category: 'software',
      summary: 'Published App Portal application revision',
      detail: 'Revision ' + revision.revision + ' · ' + revision.version,
      outcome: 'success', metadata: { appId: revision.app_id, revisionId },
    }).catch(() => null)
    return c.json({ success: true })
  })
  app.post('/api/v1/rmm/app-portal/apps/:appId/assignments', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const appId = clean(c.req.param('appId'))
    const body = await c.req.json().catch(() => ({}))
    const scopeType = clean(body.scopeType)
    const scopeId = clean(body.scopeId)
    const intent = lower(body.intent || 'available')
    if (!['Estate','Site','Group','User','Device'].includes(scopeType)) return c.json({ error: 'Scope type is invalid.' }, 400)
    if (scopeType !== 'Estate' && !scopeId) return c.json({ error: 'Scope id is required.' }, 400)
    if (!['available','required','uninstall','hidden','approval_required'].includes(intent)) {
      return c.json({ error: 'Assignment intent is invalid.' }, 400)
    }
    const exists = await pool.query(
      `SELECT a.id,a.source_type,r.id AS revision_id,r.source_kind,r.source_config,
              r.sha256,r.tenant_id,r.publish_state
         FROM rmm_app_portal_apps a
         LEFT JOIN rmm_app_portal_revisions r ON r.id=a.current_revision_id
        WHERE a.id=$1 AND a.tenant_id=$2 LIMIT 1`,
      [appId, auth.session.tenant_id])
    if (!exists.rowCount) return c.json({ error: 'Application was not found.' }, 404)
    const revision = exists.rows[0]
    if (isUnsignedUpload(revision)) {
      if (revision.publish_state !== 'published') {
        return c.json({ error: 'The unsigned package must be approved and published before assignment.' }, 409)
      }
      const approval = await currentUnsignedApproval(auth.session.tenant_id, revision.revision_id)
      if (!approvalMatches(revision, approval)) {
        return c.json({ error: 'The unsigned package approval is missing, revoked or no longer matches the file hash.' }, 409)
      }
      if (!allowedUnsignedScope(scopeType, intent)) {
        return c.json({ error: 'Approved unsigned packages may only be made available or approval-required to an individual Device.' }, 403)
      }
      const knownDevice = await pool.query(
        `SELECT 1 FROM rmm_agent_devices d
           LEFT JOIN rmm_device_inventory i ON i.id=d.inventory_id AND i.tenant_id=d.tenant_id
          WHERE d.tenant_id=$1 AND d.disabled_at IS NULL
            AND lower($2) IN (lower(d.id::text),lower(d.inventory_id::text),lower(i.reference))
          LIMIT 1`, [auth.session.tenant_id, scopeId])
      if (!knownDevice.rowCount) {
        return c.json({ error: 'Choose a registered device from this tenant; other scopes are not permitted for unsigned software.' }, 403)
      }
    }
    const result = await pool.query(
      `INSERT INTO rmm_app_portal_assignments
        (tenant_id,app_id,scope_type,scope_id,scope_name,intent,priority,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,app_id,scope_type,scope_id)
       DO UPDATE SET scope_name=EXCLUDED.scope_name,intent=EXCLUDED.intent,priority=EXCLUDED.priority,
                     enabled=true,updated_at=now()
       RETURNING *`,
      [auth.session.tenant_id, appId, scopeType, scopeType === 'Estate' ? '*' : scopeId,
        clean(body.scopeName).slice(0,255), intent, Number(body.priority || 0), auth.session.user_id])
    return c.json({ success: true, assignment: result.rows[0] })
  })

  app.delete('/api/v1/rmm/app-portal/assignments/:assignmentId', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const result = await pool.query(
      `UPDATE rmm_app_portal_assignments SET enabled=false,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [clean(c.req.param('assignmentId')), auth.session.tenant_id])
    if (!result.rowCount) return c.json({ error: 'Assignment was not found.' }, 404)
    return c.json({ success: true })
  })
  app.post('/api/v1/rmm/app-portal/requests/:requestId/decision', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const decision = lower(body.decision)
    if (!['approved','rejected'].includes(decision)) {
      return c.json({ error: 'Decision must be approved or rejected.' }, 400)
    }
    const requestResult = await pool.query(
      `SELECT q.*,a.current_revision_id,a.status AS app_status
         FROM rmm_app_portal_requests q
         JOIN rmm_app_portal_apps a ON a.id=q.app_id AND a.tenant_id=q.tenant_id
        WHERE q.id=$1 AND q.tenant_id=$2 AND q.status='pending' LIMIT 1`,
      [clean(c.req.param('requestId')), auth.session.tenant_id])
    const request = requestResult.rows[0]
    if (!request) return c.json({ error: 'Pending request was not found.' }, 404)

    if (decision === 'rejected') {
      await pool.query(
        `UPDATE rmm_app_portal_requests
            SET status='rejected',decided_by_user_id=$3,decision_note=$4,decided_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2`,
        [request.id, auth.session.tenant_id, auth.session.user_id, clean(body.note).slice(0,2000)])
      return c.json({ success: true, status: 'rejected' })
    }

    if (request.app_status !== 'published' || clean(request.current_revision_id) !== clean(request.revision_id)) {
      return c.json({ error: 'The application revision changed after this request. Ask the user to submit a new request.' }, 409)
    }
    const agentResult = await pool.query(
      `SELECT id,tenant_id,inventory_id FROM rmm_agent_devices
        WHERE id=$1 AND tenant_id=$2 AND disabled_at IS NULL LIMIT 1`,
      [request.agent_device_id, auth.session.tenant_id])
    const agent = agentResult.rows[0]
    if (!agent) return c.json({ error: 'The endpoint is no longer managed by Hi5Central.' }, 409)
    const identity = { sid: request.requested_by_sid, upn: request.requested_by_upn, username: '', displayName: '', sessionId: '' }
    const available = await resolvedApps(agent, identity)
    const assignment = available.find((item) => item.id === request.app_id && item.intent === 'approval_required')
    if (!assignment) return c.json({ error: 'The approval-required assignment no longer applies to this user or device.' }, 409)
    const revision = await revisionForInstall(auth.session.tenant_id, request.app_id)
    if (!revision || clean(revision.revision_id) !== clean(request.revision_id)) {
      return c.json({ error: 'The requested revision is no longer current.' }, 409)
    }
    const dispatched = revision.source_type === 'catalogue'
      ? await dispatchCatalogueInstall(agent, revision, identity)
      : await dispatchCustomInstall(agent, revision, identity)
    if (dispatched.error) return c.json({ error: dispatched.error }, dispatched.status || 409)

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE rmm_app_portal_requests
            SET status='fulfilled',decided_by_user_id=$3,decision_note=$4,decided_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2`,
        [request.id, auth.session.tenant_id, auth.session.user_id, clean(body.note).slice(0,2000)])
      await client.query(
        `UPDATE rmm_app_portal_installations
            SET request_source='approval',updated_at=now()
          WHERE id=$1 AND tenant_id=$2`,
        [dispatched.installationId, auth.session.tenant_id])
    })
    return c.json({ success: true, status: 'fulfilled', installationId: dispatched.installationId, jobId: dispatched.jobId })
  })

  app.post('/api/v1/agent/app-portal/catalogue', async (c) => {
    const auth = await requireAgent(c)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const identity = normalizedIdentity(body)
    await rememberIdentity(auth.agent, identity)
    const apps = await resolvedApps(auth.agent, identity)
    const [jobs, installed, device, softwareUpdates, windowsUpdates] = await Promise.all([
      pool.query(
        `SELECT i.id,i.app_id,i.revision_id,i.status AS installation_status,i.created_at,i.completed_at,
                j.id AS job_id,j.status AS job_status,j.result,j.error_message
           FROM rmm_app_portal_installations i
           LEFT JOIN rmm_agent_jobs j ON j.id=i.agent_job_id
          WHERE i.tenant_id=$1 AND i.agent_device_id=$2
          ORDER BY i.created_at DESC LIMIT 100`,
        [auth.agent.tenant_id, auth.agent.id]),
      pool.query(
        `SELECT DISTINCT catalogue_id
           FROM rmm_software_patch_observations
          WHERE tenant_id=$1 AND inventory_id=$2
            AND catalogue_id IS NOT NULL AND installed_version<>''`,
        [auth.agent.tenant_id, auth.agent.inventory_id]),
      pool.query(
        `SELECT i.name,i.manufacturer,i.model,i.operating_system,i.os_version,i.is_encrypted,i.source_payload,
                i.storage_total_bytes,i.storage_free_bytes,i.user_display_name,i.user_principal_name,
                i.compliance_state,d.agent_version,d.websocket_status,d.last_telemetry_at,d.active_user
           FROM rmm_device_inventory i
           JOIN rmm_agent_devices d ON d.inventory_id=i.id AND d.tenant_id=i.tenant_id
          WHERE i.id=$1 AND i.tenant_id=$2 LIMIT 1`,
        [auth.agent.inventory_id, auth.agent.tenant_id]),
      pool.query(
        `SELECT application_name AS title,installed_version,available_version,
                patch_status AS status,observed_at AS updated_at,count(*) OVER()::int AS total_count
           FROM rmm_software_patch_observations
          WHERE tenant_id=$1 AND inventory_id=$2 AND patch_status='update_available'
          ORDER BY observed_at DESC LIMIT 8`,
        [auth.agent.tenant_id, auth.agent.inventory_id]),
      pool.query(
        `SELECT title,update_class,severity,downloaded,reboot_required,last_seen_at AS updated_at,
                count(*) OVER()::int AS total_count
           FROM rmm_windows_update_observations
          WHERE tenant_id=$1 AND inventory_id=$2 AND pending=true
          ORDER BY last_seen_at DESC LIMIT 8`,
        [auth.agent.tenant_id, auth.agent.inventory_id]),
    ])
    const installedCatalogueIds = new Set(installed.rows.map((row) => clean(row.catalogue_id)))
    const { source_payload: softwareInventory, ...publicDevice } = device.rows[0] || {}
    const enrichedApps = apps.map((app) => {
      const detected = app.sourceType === 'custom'
        ? findInstalledApp({ app, inventory: softwareInventory })
        : null
      return {
        ...app,
        installed: detected ? detected.installed
          : Boolean(app.catalogueId && installedCatalogueIds.has(clean(app.catalogueId))),
        ...(detected || {}),
      }
    })
    const requests = identity.sid || identity.upn
      ? await pool.query(
        `SELECT id,app_id,revision_id,status,requested_by_sid,requested_by_upn,
                created_at,decided_at,decision_note
           FROM rmm_app_portal_requests
          WHERE tenant_id=$1 AND agent_device_id=$2
            AND (($3<>'' AND requested_by_sid=$3)
              OR ($4<>'' AND lower(requested_by_upn)=lower($4)))
          ORDER BY created_at DESC LIMIT 100`,
        [auth.agent.tenant_id, auth.agent.id, identity.sid, identity.upn])
      : { rows: [] }
    const deviceRow = device.rows[0]
      ? {
        ...publicDevice,
        storage_total_bytes: device.rows[0].storage_total_bytes == null
          ? null
          : Number(device.rows[0].storage_total_bytes),
        storage_free_bytes: device.rows[0].storage_free_bytes == null
          ? null
          : Number(device.rows[0].storage_free_bytes),
      }
      : {}

    return c.json({
      success: true,
      apps: enrichedApps,
      installations: jobs.rows,
      requests: requests.rows,
      device: deviceRow,
      updates: {
        software: softwareUpdates.rows,
        windows: windowsUpdates.rows,
        total: Number(softwareUpdates.rows[0]?.total_count || 0)
          + Number(windowsUpdates.rows[0]?.total_count || 0),
      },
    })
  })

  app.post('/api/v1/agent/app-portal/install', async (c) => {
    const auth = await requireAgent(c)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const appId = clean(body.appId)
    if (!uuid(appId)) return c.json({ success: false, error: 'Application id is invalid.' }, 400)
    const identity = normalizedIdentity(body)
    await rememberIdentity(auth.agent, identity)
    const available = await resolvedApps(auth.agent, identity)
    const assignment = available.find((item) => item.id === appId)
    if (!assignment) {
      return c.json({ success: false, error: 'This application is not assigned to this user or device.' }, 403)
    }
    const appRevision = await revisionForInstall(auth.agent.tenant_id, appId)
    if (!appRevision) return c.json({ success: false, error: 'Published application revision was not found.' }, 409)
    if (assignment.intent === 'uninstall') {
      return c.json({ success: false, error: 'This assignment is configured for removal, not self-service installation.' }, 409)
    }
    if (assignment.intent === 'approval_required') {
      const existing = await pool.query(
        `SELECT * FROM rmm_app_portal_requests
          WHERE tenant_id=$1 AND app_id=$2 AND agent_device_id=$3 AND status='pending'
            AND COALESCE(requested_by_sid,'')=$4
          ORDER BY created_at DESC LIMIT 1`,
        [auth.agent.tenant_id, appId, auth.agent.id, identity.sid])
      if (existing.rowCount) return c.json({ success: true, approvalRequired: true, request: existing.rows[0] }, 202)
      const request = await pool.query(
        `INSERT INTO rmm_app_portal_requests
          (tenant_id,app_id,revision_id,agent_device_id,requested_by_sid,requested_by_upn,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [auth.agent.tenant_id, appId, appRevision.revision_id, auth.agent.id,
          identity.sid, identity.upn, clean(body.reason).slice(0,2000)])
      return c.json({ success: true, approvalRequired: true, request: request.rows[0] }, 202)
    }
    const active = await pool.query(
      `SELECT i.id,j.status FROM rmm_app_portal_installations i
         JOIN rmm_agent_jobs j ON j.id=i.agent_job_id
        WHERE i.tenant_id=$1 AND i.agent_device_id=$2 AND i.app_id=$3
          AND j.status IN ('queued','claimed')
        ORDER BY i.created_at DESC LIMIT 1`,
      [auth.agent.tenant_id, auth.agent.id, appId])
    if (active.rowCount) return c.json({ success: false, error: 'This application is already installing.', installationId: active.rows[0].id }, 409)
    const result = appRevision.source_type === 'catalogue'
      ? await dispatchCatalogueInstall(auth.agent, appRevision, identity)
      : await dispatchCustomInstall(auth.agent, appRevision, identity)
    if (result.error) return c.json({ success: false, ...result }, result.status || 409)
    return c.json(result, 202)
  })

  app.get('/api/v1/rmm/app-portal/installations/:installationId', async (c) => {
    const auth = await requireManage(c)
    if (auth.error) return auth.error
    const result = await pool.query(
      `SELECT i.*,a.name,r.version,j.status AS job_status,j.result AS job_result,j.error_message
         FROM rmm_app_portal_installations i
         JOIN rmm_app_portal_apps a ON a.id=i.app_id
         JOIN rmm_app_portal_revisions r ON r.id=i.revision_id
         LEFT JOIN rmm_agent_jobs j ON j.id=i.agent_job_id
        WHERE i.id=$1 AND i.tenant_id=$2 LIMIT 1`,
      [clean(c.req.param('installationId')), auth.session.tenant_id])
    if (!result.rowCount) return c.json({ error: 'Installation was not found.' }, 404)
    return c.json(result.rows[0])
  })
}
