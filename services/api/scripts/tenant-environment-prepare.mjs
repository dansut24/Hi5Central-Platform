import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { checkProvisioningPreflight, validateControlPlaneAttestation } from '../src/tenantEnvironmentOperatorChecks.js'
import { suspendedTenantSeed, matchesPreparedIdentity } from '../src/tenantEnvironmentBootstrap.js'

function requireEnv(key) {
  const value = String(process.env[key] || '').trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}
function endpointOf(raw) {
  const u = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('Invalid PostgreSQL connection.')
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}${u.pathname}`
}
async function transact(client, write) {
  await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY')
  await client.query("SET LOCAL statement_timeout='12000ms'")
  await client.query("SET LOCAL lock_timeout='4000ms'")
}
async function controlRequest(db, requestId, lock) {
  const result = await db.query(
    `SELECT q.id,q.tenant_id,q.state AS request_state,q.environment,
            t.slug,t.company_name,t.status AS tenant_status,
            e.provisioning_status,e.hostname_label,ts.modules
       FROM tenant_environment_provision_requests q
       JOIN tenants t ON t.id=q.tenant_id
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN tenant_environment_instances e
         ON e.tenant_id=q.tenant_id AND e.environment=q.environment
      WHERE q.id=$1
      ${lock ? 'FOR UPDATE OF q,e' : ''}`,
    [requestId],
  )
  return result.rows[0] || null
}
async function targetEvidence(db, requestId, slug) {
  const identity = (await db.query(
    'SELECT environment,root_domain,instance_id FROM managed_runtime_database_identity WHERE singleton=true',
  )).rows[0] || null
  const bootstrap = (await db.query(
    'SELECT * FROM managed_environment_tenant_bootstrap WHERE control_request_id=$1',
    [requestId],
  )).rows[0] || null
  const tenant = (await db.query(
    'SELECT id,slug,company_name,status FROM tenants WHERE slug=$1',
    [slug],
  )).rows[0] || null
  const settings = tenant
    ? (await db.query('SELECT tenant_url,portal_url,rmm_url,modules FROM tenant_settings WHERE tenant_id=$1',[tenant.id])).rows[0] || null
    : null
  return { identity, bootstrap, tenant, settings }
}
async function run() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--check','--apply'].includes(arg))) {
    throw new Error('Usage: node tenant-environment-prepare.mjs [--check|--apply]')
  }
  const mode = args[0] === '--apply' ? 'apply' : 'check'
  const requestId = requireEnv('PROVISION_REQUEST_ID')
  assert.match(requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const environment = requireEnv('TARGET_ENVIRONMENT').toLowerCase()
  if (!['uat','test'].includes(environment)) throw new Error('Only UAT and Test can be prepared.')
  const rootDomain = requireEnv('ROOT_DOMAIN').toLowerCase()
  const controlUrl = requireEnv('CONTROL_DATABASE_URL')
  const targetUrl = requireEnv('TARGET_DATABASE_URL')
  const controlEndpoint = endpointOf(controlUrl)
  const targetEndpoint = endpointOf(targetUrl)
  if (controlEndpoint === targetEndpoint) throw new Error('Refusing to use the same control and target database.')
  const control = new pg.Client({ connectionString:controlUrl,connectionTimeoutMillis:5000,application_name:'hi5-env-prepare-control' })
  const target = new pg.Client({ connectionString:targetUrl,connectionTimeoutMillis:5000,application_name:'hi5-env-prepare-'+randomUUID().slice(0,8) })
  let controlOpen=false, targetOpen=false
  try {
    await Promise.all([control.connect(),target.connect()])
    await transact(control,mode==='apply');controlOpen=true
    await transact(target,mode==='apply');targetOpen=true
    // An independently attested control plane is required: the internal
    // single-tenant Dev database must never become a provisioning source.
    const controlIdentity = (await control.query(
      `SELECT deployment_mode,tenancy_mode,root_domain,instance_id,verified_by,verified_at
         FROM managed_control_plane_identity WHERE singleton=true`,
    )).rows[0] || null
    const controlValidation = validateControlPlaneAttestation(controlIdentity, rootDomain)
    if (!controlValidation.allowed) throw new Error(
      `Control-plane identity verification failed: ${controlValidation.errors.join('; ')}`,
    )
    const request=await controlRequest(control,requestId,mode==='apply')
    if (!request) throw new Error('Provisioning request not found.')
    const evidence=await targetEvidence(target,requestId,request.slug)
    const seed=suspendedTenantSeed({
      request,environment,rootDomain,databaseInstanceId:evidence.identity?.instance_id,
    })
    const existing=Boolean(evidence.bootstrap || evidence.tenant)
    const repeat=existing && matchesPreparedIdentity(seed,evidence.bootstrap,evidence.tenant,evidence.settings)
    if (existing && !repeat) throw new Error('Target has an unrecognised or altered tenant identity. Manual reconciliation required.')
    if (repeat && !(request.request_state==='claimed' && request.provisioning_status==='provisioning')) {
      throw new Error('Prepared target exists but control-plane request state is inconsistent.')
    }
    if (!repeat) {
      const preflight=checkProvisioningPreflight({
        request,databaseIdentity:evidence.identity,targetTenantExists:existing,
        controlEndpoint,targetEndpoint,environment,rootDomain,
      })
      if (!preflight.approvedForIsolationSetup) throw new Error(`Preflight blocked: ${preflight.failures.join('; ')}`)
      if (request.request_state!=='requested') throw new Error('New identity preparation requires a queued request.')
      if (!['pending','failed'].includes(request.provisioning_status)) throw new Error('Environment status has changed.')
    }
    const summary={
      requestId,environment,hostname:seed.expectedHostname,slug:seed.slug,
      targetInstanceId:seed.databaseInstanceId,
      mode,idempotent:repeat,tenantStatus:'suspended',
      usersImported:0,devicesImported:0,agentTokensIssued:0,
      routingEnabled:false,ready:false,
    }
    if (mode!=='apply') {
      await target.query('ROLLBACK');targetOpen=false
      await control.query('ROLLBACK');controlOpen=false
      console.log(JSON.stringify({...summary,result:repeat?'identity_already_prepared':'eligible_to_prepare'},null,2))
      return
    }
    if (requireEnv('CONFIRM_TENANT_BOOTSTRAP') !== `${seed.slug}:${environment}:${requestId}`) {
      throw new Error('Explicit CONFIRM_TENANT_BOOTSTRAP must match slug:environment:request UUID.')
    }
    if (!repeat) {
      const tenant = await target.query(
        `INSERT INTO tenants (slug,company_name,status)
         VALUES ($1,$2,'suspended') RETURNING id`,
        [seed.slug,seed.companyName],
      )
      const localId=tenant.rows[0].id
      await target.query(
        `INSERT INTO tenant_settings
          (tenant_id,modules,onboarding_step,tenant_url,portal_url,rmm_url)
         VALUES ($1,$2::jsonb,$3,$4,$5,NULL)`,
        [localId,JSON.stringify(seed.modules),seed.onboardingStep,seed.urls.tenantUrl,seed.urls.portalUrl],
      )
      await target.query(
        `INSERT INTO managed_environment_tenant_bootstrap
          (control_request_id,control_tenant_id,local_tenant_id,environment,database_instance_id,expected_hostname)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [seed.requestId,seed.controlTenantId,localId,seed.environment,seed.databaseInstanceId,seed.expectedHostname],
      )
      const verified=await targetEvidence(target,requestId,seed.slug)
      if (!matchesPreparedIdentity(seed,verified.bootstrap,verified.tenant,verified.settings)) {
        throw new Error('Suspended identity verification failed; rolling back target transaction.')
      }
      // Source control transaction owns the request/environment row locks;
      // cancellation is blocked until both transactions settle.
      const state=await control.query(
        `UPDATE tenant_environment_provision_requests
            SET state='claimed',claimed_at=COALESCE(claimed_at,now()),updated_at=now()
          WHERE id=$1 AND state='requested' RETURNING id`,
        [requestId],
      )
      const environmentRow=await control.query(
        `UPDATE tenant_environment_instances
            SET provisioning_status='provisioning',updated_at=now()
          WHERE tenant_id=$1 AND environment=$2 AND provisioning_status IN ('pending','failed')
          RETURNING tenant_id`,
        [seed.controlTenantId,environment],
      )
      if (state.rowCount!==1 || environmentRow.rowCount!==1) {
        throw new Error('Control-plane request changed; refusing to finalise identity preparation.')
      }
    }
    // These two databases cannot share a transaction. Commit the disabled
    // target first; a control commit failure leaves only a suspended orphan,
    // never an active tenant. Operator must reconcile manually.
    await target.query('COMMIT');targetOpen=false
    await control.query('COMMIT');controlOpen=false
    console.log(JSON.stringify({...summary,result:repeat?'already_prepared':'identity_prepared',requiresManualIsolationVerification:true},null,2))
  } finally {
    if (targetOpen) await target.query('ROLLBACK').catch(()=>{})
    if (controlOpen) await control.query('ROLLBACK').catch(()=>{})
    await Promise.allSettled([target.end(),control.end()])
  }
}
run().catch(error=>{
  console.error('Sandbox identity preparation blocked:',error.message)
  process.exitCode=1
})
