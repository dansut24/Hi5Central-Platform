import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyCustom, formFromDraft, customRevisionPayload,
  revisionFingerprint, draftHasUploadedPackage, inventoryDisplayName,
} from '../src/lib/appPortalDraft.js'

const app = {
  id: 'app-7zip', name: '7Zip', publisher: '',
  description: '7Zip', category: 'Company software',
  source_type: 'custom', status: 'draft',
}
const initialRevision = {
  id: 'revision-1', app_id: app.id, revision: 1, version: '26.06',
  installer_type: 'msi', source_kind: 'upload', publish_state: 'draft',
  expected_signer: '', source_config: {},
  execution: { mode: 'arguments', arguments: '/S', timeoutSeconds: 600, successExitCodes: [0, 1641, 3010] },
  verification: { method: 'uninstall_registry', productCode: '', targetVersion: '26.06', displayNameContains: '' },
}

test('loads the existing failed 7Zip draft without creating another app', () => {
  const form = formFromDraft(app, initialRevision)
  assert.equal(form.name, '7Zip')
  assert.equal(form.version, '26.06')
  assert.equal(form.installerType, 'msi')
  assert.equal(form.sourceKind, 'upload')
  assert.equal(form.installArguments, '/S')
  assert.equal(form.verificationMethod, 'auto')
  assert.equal(form.expectedSigner, '')
  assert.equal(draftHasUploadedPackage(initialRevision), false)
})

test('changes to a draft installer create a distinct revision signature', () => {
  const form = formFromDraft(app, initialRevision)
  const baseline = revisionFingerprint(form)
  form.installArguments = '/qn /norestart'
  form.expectedSigner = 'Approved publisher'
  form.displayNameContains = '7-Zip'
  const payload = customRevisionPayload(form)
  assert.notEqual(revisionFingerprint(form), baseline)
  assert.equal(payload.execution.arguments, '/qn /norestart')
  assert.equal(payload.expectedSigner, 'Approved publisher')
  assert.equal(payload.verification.displayNameContains, '7-Zip')
  assert.equal(payload.sourceKind, 'upload')
  assert.deepEqual(payload.sourceConfig, {})
  assert.equal(payload.sha256, '')
})

test('resuming an uploaded package does not misidentify its existing hash as a settings change', () => {
  const form = formFromDraft(app, initialRevision)
  const uploaded = { ...initialRevision,
    sha256: 'A'.repeat(64), source_config: {
      storageKey: 'tenant/app/revision-1.msi',
      fileName: '7zip.msi', byteSize: 42_000_000,
    },
  }
  assert.equal(draftHasUploadedPackage(uploaded), true)
  assert.equal(revisionFingerprint(form), revisionFingerprint(formFromDraft(app, uploaded)))
})

test('changing an upload draft to HTTPS requires a pinned hash', () => {
  const form = formFromDraft(app, initialRevision)
  form.sourceKind = 'direct_url'
  form.url = 'https://example.com/approved.msi'
  form.sha256 = 'B'.repeat(64)
  const payload = customRevisionPayload(form)
  assert.equal(payload.sourceConfig.url, form.url)
  assert.equal(payload.sha256, form.sha256)
  assert.equal(draftHasUploadedPackage({ ...initialRevision, source_kind: 'direct_url' }), false)
})

test('file version detection, scripts and timeout are retained when editing', () => {
  const rev = {
    ...initialRevision,
    execution: { mode: 'powershell', script: 'exit 0', timeoutSeconds: 120 },
    verification: { method: 'file_version', filePath: 'C:\\Apps\\test.exe', targetVersion: '26.06' },
  }
  const form = formFromDraft(app, rev)
  const payload = customRevisionPayload(form)
  assert.equal(payload.execution.mode, 'powershell')
  assert.equal(payload.execution.script, 'exit 0')
  assert.equal(payload.execution.timeoutSeconds, 120)
  assert.equal(payload.verification.method, 'file_version')
  assert.equal(payload.verification.filePath, 'C:\\Apps\\test.exe')
})

test('new custom applications retain existing defaults', () => {
  assert.equal(emptyCustom.sourceKind, 'upload')
  assert.equal(emptyCustom.verificationMethod, 'auto')
  assert.equal(emptyCustom.installerType, 'msi')
  assert.equal(emptyCustom.executionMode, 'arguments')
})

test('automatic detection needs no technical product-code or path from admins', () => {
  const form = formFromDraft(app, initialRevision)
  const payload = customRevisionPayload(form)
  assert.deepEqual(payload.verification, {
    method: 'uninstall_registry',
    productCode: '',
    displayNameContains: '7-Zip',
    targetVersion: '26.06',
  })
  assert.equal(inventoryDisplayName('7 Zip'), '7-Zip')
})
test('publisher is not misused as certificate signer; advanced override stays supported', () => {
  const form = { ...emptyCustom, name:'Sample', publisher:'Example Software Ltd', version:'1.0' }
  const payload = customRevisionPayload(form)
  assert.equal(payload.expectedSigner,'')
  form.expectedSigner='Example Code Signing LLC'
  assert.equal(customRevisionPayload(form).expectedSigner,'Example Code Signing LLC')
})
