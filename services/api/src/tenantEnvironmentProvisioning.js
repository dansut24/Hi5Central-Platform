import { isValidCustomerSlug } from './tenantEnvironmentHostnames.js'

// Pure authorisation precondition used before any provisioning queue operation.
// Environment readiness is a separate operator-verified gate.
export function provisionRequestEligibility({
  deploymentMode,
  tenancyMode,
  tenantSlug,
  environment,
  status,
  tenantStatus,
}) {
  if (deploymentMode !== 'managed' || tenancyMode !== 'multi') {
    return { allowed: false, code: 'MANAGED_MULTI_TENANCY_REQUIRED',
      reason: 'Customer environment provisioning requires the managed multi-tenant control plane.' }
  }
  if (!isValidCustomerSlug(tenantSlug)) {
    return { allowed: false, code: 'INTERNAL_OR_RESERVED_TENANT',
      reason: 'Internal development and reserved tenant names cannot provision customer sandboxes.' }
  }
  if (!['uat', 'test'].includes(environment)) {
    return { allowed: false, code: 'INVALID_ENVIRONMENT',
      reason: 'Only customer UAT and Test may be requested; Production is managed separately.' }
  }
  if (tenantStatus !== 'active') {
    return { allowed: false, code: 'TENANT_NOT_ACTIVE',
      reason: 'Activate the customer tenant before requesting additional environments.' }
  }
  if (!['pending', 'failed'].includes(status)) {
    return { allowed: false, code: 'NOT_PENDING',
      reason: 'Only pending or failed customer environments can be requested.' }
  }
  return { allowed: true }
}
