import { createHash, randomBytes } from 'node:crypto'
import { isValidCustomerSlug } from './tenantEnvironmentHostnames.js'
import { isManagedCustomerSandbox } from './managedSandboxPolicy.js'

export const INVITATION_TTL_HOURS = 24
export const VALID_INVITATION_ROLES = Object.freeze(['owner','admin','analyst','requester'])

export function invitationToken() {
  return randomBytes(32).toString('base64url')
}

export function invitationHash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function validInvitationToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function validInvitationEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    && value === value.trim().toLowerCase()
}

export function permittedInvitationRole(role, inviterRole) {
  return VALID_INVITATION_ROLES.includes(role)
    && (inviterRole === 'owner' || (inviterRole === 'admin' && role !== 'owner'))
}

/**
 * A bootstrap is NOT approval. Neither a ready hostname nor a "claimed"
 * provisioning request can activate access on its own.
 */
export function sandboxInvitationGate(config, tenant, bootstrap, approval, modules) {
  if (!isManagedCustomerSandbox(config)) return { allowed:false, reason:'not_sandbox' }
  if (!tenant || tenant.status !== 'active' || !isValidCustomerSlug(tenant.slug)) {
    return { allowed:false, reason:'tenant_inactive' }
  }
  if (!bootstrap || bootstrap.local_tenant_id !== tenant.id
      || bootstrap.environment !== config.runtimeEnvironment
      || bootstrap.stage !== 'identity_prepared') {
    return { allowed:false, reason:'bootstrap_mismatch' }
  }
  if (!approval || approval.tenant_id !== tenant.id
      || approval.bootstrap_request_id !== bootstrap.control_request_id
      || approval.state !== 'approved'
      || !String(approval.approved_by || '').trim() || !approval.approved_at) {
    return { allowed:false, reason:'approval_missing' }
  }
  if (!modules || modules.rmm !== false) return { allowed:false, reason:'rmm_enabled' }
  return { allowed:true, reason:'approved' }
}

export function validInvitationRecord(invitation, tenantId, email, now = new Date()) {
  return Boolean(invitation
    && invitation.tenant_id === tenantId
    && invitation.email === email
    && !invitation.revoked_at && !invitation.accepted_at
    && new Date(invitation.expires_at).getTime() > now.getTime())
}
