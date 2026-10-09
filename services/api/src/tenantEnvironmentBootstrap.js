import { isValidCustomerSlug, managedTenantUrls } from './tenantEnvironmentHostnames.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Shared UUID validator for the operator, preflight and bootstrap seeding.
export function isValidUuid(value) {
  return UUID.test(String(value ?? ''))
}

// Only minimal organisation identity is copied. Never copy users, password
// hashes, sessions, API/agent tokens, device records, automations or tickets.
export function suspendedTenantSeed({ request, environment, rootDomain, databaseInstanceId }) {
  if (!request || !['requested','claimed'].includes(request.request_state)) {
    throw new Error('An active provisioning request is required.')
  }
  if (!['uat','test'].includes(environment) || request.environment !== environment) {
    throw new Error('Provisioning target environment mismatch.')
  }
  if (!isValidCustomerSlug(request.slug) || request.hostname_label !== `${request.slug}${environment}`) {
    throw new Error('Reserved hostname does not identify a valid customer.')
  }
  if (request.tenant_status !== 'active'
    || !['pending','failed','provisioning'].includes(request.provisioning_status)) {
    throw new Error('Tenant or environment is not eligible for identity preparation.')
  }
  if (!isValidUuid(request.id) || !isValidUuid(request.tenant_id)
    || !isValidUuid(databaseInstanceId)) {
    throw new Error('Provisioning identifiers are invalid.')
  }
  const companyName = String(request.company_name || '').trim()
  if (companyName.length < 2 || companyName.length > 120) throw new Error('Invalid customer company name.')
  if (typeof request.modules !== 'object' || !request.modules || Array.isArray(request.modules)) {
    throw new Error('Source tenant modules are missing.')
  }
  const itsm = request.modules.itsm === true
  const urls = managedTenantUrls(request.slug, rootDomain, environment)
  const expectedHostname = `${request.hostname_label}.${rootDomain}`
  if (urls.tenantUrl !== `https://${expectedHostname}`) throw new Error('Hostname reservation mismatch.')
  return Object.freeze({
    requestId: request.id,
    controlTenantId: request.tenant_id,
    databaseInstanceId,
    environment,
    slug: request.slug,
    companyName,
    tenantStatus: 'suspended',
    modules: { itsm, selfService: itsm, rmm: false },
    onboardingStep: 'company',
    urls,
    expectedHostname,
  })
}

// Idempotent retries may observe a previously written suspended identity.
// They must never replace or reactivate it, even if the request is retried.
export function matchesPreparedIdentity(seed, bootstrap, tenant, settings) {
  return Boolean(bootstrap && tenant && settings
    && bootstrap.control_request_id === seed.requestId
    && bootstrap.control_tenant_id === seed.controlTenantId
    && bootstrap.database_instance_id === seed.databaseInstanceId
    && bootstrap.environment === seed.environment
    && bootstrap.expected_hostname === seed.expectedHostname
    && bootstrap.stage === 'identity_prepared'
    && bootstrap.local_tenant_id === tenant.id
    && tenant.slug === seed.slug
    && tenant.company_name === seed.companyName
    && tenant.status === 'suspended'
    && settings.tenant_url === seed.urls.tenantUrl
    && settings.portal_url === seed.urls.portalUrl
    && settings.rmm_url === null
    && settings.modules?.rmm === false
    && settings.modules?.itsm === seed.modules.itsm
    && settings.modules?.selfService === seed.modules.selfService)
}
