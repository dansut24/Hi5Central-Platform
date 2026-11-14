// Self Service MSI uninstall policy. Never execute an arbitrary registry
// UninstallString or a command provided by an unprivileged Windows process.
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i

export function normaliseMsiProductCode(value = '') {
  const str = String(value || '').trim()
  return GUID.test(str) ? '{' + str.replace(/[{}]/g, '').toUpperCase() + '}' : ''
}

export function eligibleSelfServiceUninstall(revision, enabled) {
  if (!enabled || !revision || revision.publish_state !== 'published'
    || String(revision.installer_type).toLowerCase() !== 'msi'
    || String(revision.source_type || 'custom') !== 'custom'
    || String(revision.expected_signer || '').trim().length < 3) return ''
  const v = revision.verification
  if (!v || typeof v !== 'object'
    || String(v.method).toLowerCase() !== 'uninstall_registry') return ''
  return normaliseMsiProductCode(v.productCode)
}

export function isVerifiedRemovalJob(job, app) {
  if (!job || !app || job.status !== 'completed'
    || job.revision_id !== app.revisionId
    || job.app_id !== app.id) return false
  return job.result?.success === true
    && job.result?.removalVerified === true
}
