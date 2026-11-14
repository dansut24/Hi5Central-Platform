/**
 * Independent Self Service may install software while the main RMM Agent is
 * stopped. PatchHost itself validates the installed application and target
 * version against Windows, so the portal must not await unrelated Agent
 * inventory telemetry. Accept proof only for the app's current revision.
 */
export function isVerifiedAppPortalInstallation(installation, app) {
  if (!installation || !app || typeof installation !== 'object') return false
  const result = installation.result
  return installation.app_id === app.id
    && installation.revision_id === app.revisionId
    && installation.installation_status === 'succeeded'
    && installation.job_status === 'completed'
    && result !== null && typeof result === 'object' && !Array.isArray(result)
    && result.success === true
    && result.verificationPassed === true
    && result.verification?.meetsTarget === true
}
