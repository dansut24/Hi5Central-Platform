// Shared form helpers for resuming an existing custom App Portal draft.
// Published revisions remain immutable. Edits create a new revision within the
// same application; unchanged drafts keep their existing revision and package.
export const emptyCustom = {
  name: '', publisher: '', description: '', category: 'Company software', sourceKind: 'direct_url',
  version: '', url: '', sha256: '', expectedSigner: '', installerType: 'msi',
  executionMode: 'arguments', installArguments: '', script: '', timeoutSeconds: 600,
  verificationMethod: 'auto', productCode: '', displayNameContains: '', filePath: '',
}

// Human-friendly app identity to the Windows uninstall-registry / software
// inventory name. This is a suggestion, not a claim of installed state.
export function inventoryDisplayName(name = '') {
  const cleaned = String(name || '').trim()
  if (/^7[\\s-]?zip$/i.test(cleaned)) return '7-Zip'
  return cleaned
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
    verificationMethod: !verification.method ||
      (verification.method === 'uninstall_registry' && !verification.productCode &&
        (!verification.displayNameContains ||
          String(verification.displayNameContains).trim().toLowerCase() === inventoryDisplayName(app.name).toLowerCase()))
      ? 'auto' : String(verification.method),
    productCode: String(verification.productCode || ''),
    displayNameContains: String(verification.displayNameContains || ''),
    filePath: String(verification.filePath || ''),
  }
}

export function customRevisionPayload(form) {
  const verification = form.verificationMethod === 'file_version'
    ? { method: 'file_version', filePath: form.filePath, targetVersion: form.version }
    : form.verificationMethod === 'auto'
      ? { method: 'uninstall_registry', productCode: '',
          displayNameContains: inventoryDisplayName(form.name), targetVersion: form.version }
      : { method: 'uninstall_registry', productCode: form.productCode,
          displayNameContains: form.displayNameContains, targetVersion: form.version }
  return {
    version: form.version,
    sourceKind: form.sourceKind,
    sourceConfig: form.sourceKind === 'direct_url' ? { url: form.url } : {},
    sha256: form.sourceKind === 'direct_url' ? form.sha256 : '',
    // Agent still requires a verified Authenticode signer. Start from the
    // publisher field, allow an explicit override when the signing identity differs.
    expectedSigner: String(form.expectedSigner || form.publisher || '').trim(),
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
