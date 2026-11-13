// Shared form helpers for resuming an existing custom App Portal draft.
// Published revisions remain immutable. Edits create a new revision within the
// same application; unchanged drafts keep their existing revision and package.
export const emptyCustom = {
  name: '', publisher: '', description: '', category: 'Company software', sourceKind: 'direct_url',
  version: '', url: '', sha256: '', expectedSigner: '', installerType: 'msi',
  executionMode: 'arguments', installArguments: '', script: '', timeoutSeconds: 600,
  verificationMethod: 'uninstall_registry', productCode: '', displayNameContains: '', filePath: '',
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch {}
  }
  return {}
}

export function formFromDraft(app, revision) {
  const execution = object(revision?.execution)
  const verification = object(revision?.verification)
  const source = object(revision?.source_config)
  return {
    ...emptyCustom,
    name: String(app.name || ''),
    publisher: String(app.publisher || ''),
    description: String(app.description || ''),
    category: String(app.category || 'Company software'),
    sourceKind: revision?.source_kind || 'upload',
    version: String(revision?.version || ''),
    url: String(source.url || ''),
    sha256: String(revision?.sha256 || ''),
    expectedSigner: String(revision?.expected_signer || ''),
    installerType: String(revision?.installer_type || 'msi'),
    executionMode: String(execution.mode || 'arguments'),
    installArguments: String(execution.arguments || ''),
    script: String(execution.script || ''),
    timeoutSeconds: Number(execution.timeoutSeconds || 600),
    verificationMethod: String(verification.method || 'uninstall_registry'),
    productCode: String(verification.productCode || ''),
    displayNameContains: String(verification.displayNameContains || ''),
    filePath: String(verification.filePath || ''),
  }
}

export function customRevisionPayload(form) {
  const verification = form.verificationMethod === 'file_version'
    ? { method: 'file_version', filePath: form.filePath, targetVersion: form.version }
    : { method: 'uninstall_registry', productCode: form.productCode,
        displayNameContains: form.displayNameContains, targetVersion: form.version }
  return {
    version: form.version,
    sourceKind: form.sourceKind,
    sourceConfig: form.sourceKind === 'direct_url' ? { url: form.url } : {},
    sha256: form.sourceKind === 'direct_url' ? form.sha256 : '',
    expectedSigner: form.expectedSigner,
    installerType: form.installerType,
    execution: {
      mode: form.executionMode,
      arguments: form.installArguments,
      script: form.script,
      timeoutSeconds: Number(form.timeoutSeconds || 600),
      successExitCodes: [0, 1641, 3010],
    },
    verification,
  }
}

export function revisionFingerprint(form) {
  return JSON.stringify(customRevisionPayload(form))
}

export function draftHasUploadedPackage(revision) {
  const source = object(revision?.source_config)
  return revision?.source_kind === 'upload' && Boolean(
    source.storageKey && Number(source.byteSize) > 0 && /^[a-f0-9]{64}$/i.test(String(revision.sha256 || '')),
  )
}
