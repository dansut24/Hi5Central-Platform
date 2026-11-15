// Hi5Central EPM: native Windows UAC review safety policy.
// CPUS_CREDUI cannot supply a verified immutable target executable or
// Windows administrative operation; no API authorization can grant it.
export const NATIVE_UAC_CREDENTIAL_RELEASE_ENABLED = false
export const NATIVE_UAC_REVIEW_TTL_MS = 5 * 60 * 1000
// Status polling is read-only; permit the local notification watcher to
// retrieve a decision after the original secure-desktop consent window closes.
export const NATIVE_UAC_STATUS_TTL_MS = 24 * 60 * 60 * 1000
const sidRe = /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/
const controls = /[\u0000-\u001F\u007F]/
export function validateNativeUacRequest(body, now = Date.now(), ttlMs = NATIVE_UAC_REVIEW_TTL_MS) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const sid = typeof b.sid === 'string' ? b.sid : ''
  const username = typeof b.username === 'string' ? b.username.trim() : ''
  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  const stamp = typeof b.consentStartedAt === 'string' ? Date.parse(b.consentStartedAt) : NaN
  const sessionId = b.sessionId
  const consentProcessId = b.consentProcessId
  if (!sidRe.test(sid) || sid.length > 255 || username.length < 1 ||
    username.length > 255 || controls.test(username) || controls.test(reason) ||
    reason.length < 20 || reason.length > 512 ||
    !Number.isInteger(sessionId) || sessionId < 1 || sessionId > 2147483647 ||
    !Number.isInteger(consentProcessId) || consentProcessId < 1 ||
    consentProcessId > 2147483647 || !Number.isFinite(stamp) ||
    stamp > now + 15000 || stamp < now - ttlMs)
      return { ok: false, error: 'Invalid Windows user, UAC instance or justification.' }
  if (b.targetPath || b.file || b.executable || b.target) {
    // The native credential provider does not know these values; accepting
    // arbitrary caller-supplied hints risks falsely assuring technicians.
    return {ok:false,error:'Native UAC target identity is unavailable; no target hints accepted.'}
  }
  return {
    ok: true,
    sid, username, reason, sessionId, consentProcessId,
    consentStartedAt: new Date(stamp).toISOString(),
    scope: 'unidentified-native-uac',
    credentialReleaseEnabled: NATIVE_UAC_CREDENTIAL_RELEASE_ENABLED
  }
}
export function canReleaseNativeUacCredential() {
  // Do not permit a toggle, env var or technician decision to grant broad
  // local administrator credentials without a separately qualified design.
  return false
}

export function validateNativeUacStatusRequest(body, now = Date.now()) {
  // This is never an elevation grant. Full user/session/consent-instance
  // binding remains mandatory even for read-only notification status.
  return validateNativeUacRequest(body, now, NATIVE_UAC_STATUS_TTL_MS)
}
