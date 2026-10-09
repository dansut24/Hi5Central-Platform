import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { checkProvisioningPreflight } from '../src/tenantEnvironmentOperatorChecks.js'

// Read-only preflight for a future privileged tenant environment operator.
// Never copies data, creates users, changes tenant status, or configures DNS.
// Run from an isolated operator host with scoped database credentials.
function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function endpointIdentity(connectionString) {
  const parsed = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Only PostgreSQL URLs are supported')
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${decodeURIComponent(parsed.pathname)}`
}


async function main() {
  const requestId = required('PROVISION_REQUEST_ID')
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const environment = required('TARGET_ENVIRONMENT').toLowerCase()
  const rootDomain = required('ROOT_DOMAIN').toLowerCase()
  const controlUrl = required('CONTROL_DATABASE_URL')
  const targetUrl = required('TARGET_DATABASE_URL')
  if (!['uat','test'].includes(environment)) throw new Error('TARGET_ENVIRONMENT must be uat or test')
  const controlEndpoint = endpointIdentity(controlUrl)
  const targetEndpoint = endpointIdentity(targetUrl)
  if (controlEndpoint === targetEndpoint) throw new Error('Refusing to connect twice to the same database.')

  const control = new pg.Client({ connectionString: controlUrl, connectionTimeoutMillis: 5000, application_name: 'hi5-env-preflight-' + randomUUID().slice(0, 8) })
  const target = new pg.Client({ connectionString: targetUrl, connectionTimeoutMillis: 5000, application_name: 'hi5-env-preflight-target' })
  try {
    await Promise.all([control.connect(), target.connect()])
    // Both connections are explicitly read-only. This script cannot fulfill
    // queued requests or mark a managed customer sandbox as ready.
    await Promise.all([control.query('BEGIN READ ONLY'),target.query('BEGIN READ ONLY')])
    const reqResult = await control.query(
      `SELECT q.id,q.state AS request_state,q.environment,t.slug,t.status AS tenant_status,
              e.provisioning_status,e.hostname_label
         FROM tenant_environment_provision_requests q
         JOIN tenants t ON t.id=q.tenant_id
         JOIN tenant_environment_instances e
           ON e.tenant_id=q.tenant_id AND e.environment=q.environment
        WHERE q.id=$1 LIMIT 1`,
      [requestId],
    )
    const request=reqResult.rows[0]||null
    const identityTable = await target.query("SELECT to_regclass('public.managed_runtime_database_identity') AS relation")
    const identity = identityTable.rows[0]?.relation
      ? (await target.query('SELECT environment,root_domain,instance_id FROM managed_runtime_database_identity WHERE singleton=true')).rows[0] || null
      : null
    const tenantTable = await target.query("SELECT to_regclass('public.tenants') AS relation")
    const existing = request && tenantTable.rows[0]?.relation
      ? (await target.query('SELECT EXISTS(SELECT 1 FROM tenants WHERE slug=$1) AS found',[request.slug])).rows[0].found
      : false
    const checks=checkProvisioningPreflight({
      request,databaseIdentity:identity,targetTenantExists:existing,
      controlEndpoint,targetEndpoint,environment,rootDomain,
    })
    if (!tenantTable.rows[0]?.relation) {
      checks.approvedForIsolationSetup=false
      checks.failures.push('Target database has not been migrated with the tenant schema.')
    }
    process.stdout.write(JSON.stringify({
      requestId,environment,tenantSlug:request?.slug || null,
      expectedHostname:request ? `${request.hostname_label}.${rootDomain}` : null,
      targetIdentity:identity ? { environment:identity.environment,rootDomain:identity.root_domain,instanceId:identity.instance_id } : null,
      ...checks,
      nextStep:checks.approvedForIsolationSetup
        ? 'Target database is eligible for isolated tenant onboarding; no writes have been performed.'
        : 'Do not provision or route the customer environment.',
    },null,2)+'\n')
    if (!checks.approvedForIsolationSetup) process.exitCode=1
  } finally {
    await Promise.allSettled([control.query('ROLLBACK'),target.query('ROLLBACK')])
    await Promise.allSettled([control.end(),target.end()])
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error=>{
    process.stderr.write(`Preflight blocked: ${error.message}\n`)
    process.exitCode=1
  })
}
