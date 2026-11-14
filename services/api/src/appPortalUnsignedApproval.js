// Every unsigned exception is scoped to a single immutable revision and
// uploaded SHA-256, never to a publisher, URL, or an entire tenant.
export const SHA256_PATTERN = /^[A-F0-9]{64}$/
export function isUnsignedUpload(revision) {
  return revision?.source_kind === 'upload'
    && revision?.source_config?.inspection?.status === 'unsigned'
}
export function approvalMatches(revision, approval) {
  if (!isUnsignedUpload(revision) || !approval || approval.revoked_at) return false
  const sha = String(revision.sha256 || '').toUpperCase()
  return SHA256_PATTERN.test(sha)
    && String(approval.package_sha256 || '').toUpperCase() === sha
    && String(approval.revision_id || '') === String(revision.revision_id || revision.id || '')
    && String(approval.tenant_id || '') === String(revision.tenant_id || '')
}
export function allowedUnsignedScope(scopeType, intent) {
  return scopeType === 'Device' && ['available', 'approval_required'].includes(intent)
}
export function unsignedManifestApproval(revision, approval, agentDeviceId) {
  if (!approvalMatches(revision, approval)) return null
  if (!String(agentDeviceId || '')) return null
  return {
    kind: 'hi5_app_portal_unsigned_v1',
    approvalId: approval.id,
    revisionId: revision.revision_id || revision.id,
    tenantId: revision.tenant_id,
    deviceId: agentDeviceId,
    sha256: String(revision.sha256).toUpperCase(),
  }
}
