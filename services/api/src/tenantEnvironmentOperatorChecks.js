import { isValidCustomerSlug } from './tenantEnvironmentHostnames.js'

/**
 * A passing preflight only permits the next *isolated setup* step.
 * It cannot authorise activation, routing or copying existing customer data.
 */
export function checkProvisioningPreflight({ request, databaseIdentity, targetTenantExists, controlEndpoint, targetEndpoint, environment, rootDomain }) {
  const failures = []
  if (!request) failures.push('Provisioning request not found.')
  if (request && !['requested','claimed'].includes(request.request_state)) failures.push('Provisioning request is not active.')
  if (request && !isValidCustomerSlug(request.slug)) failures.push('Customer slug is reserved or invalid.')
  if (request?.tenant_status !== 'active') failures.push('Customer tenant is not active.')
  if (request && request.provisioning_status !== 'pending' && request.provisioning_status !== 'failed') failures.push('Environment is not pending or failed.')
  if (request && request.environment !== environment) failures.push('Requested environment does not match the target.')
  if (!['uat','test'].includes(environment)) failures.push('Only UAT and Test are supported.')
  if (request && request.hostname_label !== `${request.slug}${environment}`) failures.push('Reserved hostname label mismatch.')
  if (controlEndpoint === targetEndpoint) failures.push('Control and target database endpoints are identical.')
  if (!databaseIdentity) failures.push('Target database is missing operator-attested environment identity.')
  else {
    if (databaseIdentity.environment !== environment) failures.push('Target database identifies as a different runtime environment.')
    if (databaseIdentity.root_domain !== rootDomain) failures.push('Target database root domain differs from expected.')
  }
  if (targetTenantExists) failures.push('Tenant already exists in target database; never overwrite or clone it.')
  return { approvedForIsolationSetup: failures.length === 0, failures }
}

/** A request queue is not proof that its database is the managed control plane. */
export function validateControlPlaneAttestation(identity, rootDomain) {
  const errors = []
  if (!identity) return { allowed: false, errors: ['Managed control-plane attestation is missing.'] }
  if (identity.deployment_mode !== 'managed' || identity.tenancy_mode !== 'multi') {
    errors.push('Control database is not an attested managed multi-tenant control plane.')
  }
  if (identity.root_domain !== rootDomain) errors.push('Control-plane root domain mismatch.')
  if (!/^[0-9a-f-]{36}$/i.test(String(identity.instance_id || ''))) {
    errors.push('Control-plane instance identity missing.')
  }
  if (!String(identity.verified_by || '').trim() || !identity.verified_at) {
    errors.push('Control-plane operator attestation incomplete.')
  }
  return { allowed: errors.length === 0, errors }
}
