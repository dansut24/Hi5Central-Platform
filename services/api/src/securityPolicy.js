const allowedSessionHours = new Set([8, 12, 24])
const MFA_GRACE_MINUTES = 15

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function effectiveConfiguration(row) {
  if (row?.configuration && Object.keys(row.configuration).length) return row.configuration
  return row?.onboarding_data || {}
}

export function securitySettings(row) {
  const security = asObject(effectiveConfiguration(row).security)
  const requestedHours = Number(security.sessionHours || 12)
  const sessionHours = allowedSessionHours.has(requestedHours) ? requestedHours : 12

  return {
    requireMfa: true,
    sessionHours,
    passwordPolicy: security.passwordPolicy === 'standard' ? 'standard' : 'strong',
    auditRetention: ['90', '365', '730'].includes(String(security.auditRetention || '365'))
      ? String(security.auditRetention || '365')
      : '365',
    mfaEnforcedAt: security.mfaEnforcedAt || null,
  }
}

// MFA is a platform-wide, centrally enforced identity requirement. A
// tenant's older per-environment configuration must never disable it.
// Prior to completed onboarding, the bootstrap session can finish setup;
// completed accounts must enrol or verify MFA before receiving a session.
export function mfaRequiredFor(row) {
  return Boolean(row?.onboarding_completed_at)
}

export function loginRequiresMfa(row) {
  return mfaRequiredFor(row)
}

export function sandboxPolicyRequiresMfa(row) {
  return mfaRequiredFor(row)
}

export function sessionTtlSeconds(row) {
  return securitySettings(row).sessionHours * 60 * 60
}

export function mfaGraceEndsAt(row) {
  if (!mfaRequiredFor(row)) return null
  const security = securitySettings(row)
  const enforcedAt = security.mfaEnforcedAt || row.onboarding_completed_at
  if (!enforcedAt) return null
  const timestamp = new Date(enforcedAt).getTime()
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp + MFA_GRACE_MINUTES * 60 * 1000)
}

// No grace period for a completed tenant: legacy unverified sessions cannot
// be restored after mandatory MFA goes live. The next login offers setup.
export function sessionNeedsMfa(row) {
  return mfaRequiredFor(row) && !Boolean(row?.mfa_verified_at)
}
