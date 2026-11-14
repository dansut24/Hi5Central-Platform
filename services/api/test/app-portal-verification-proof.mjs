import test from 'node:test'
import assert from 'node:assert/strict'
import { isVerifiedAppPortalInstallation } from '../src/appPortalVerificationProof.js'

const app = Object.freeze({ id: 'app-1', revisionId: 'rev-2' })
const verified = Object.freeze({
  app_id: 'app-1', revision_id: 'rev-2',
  installation_status: 'succeeded', job_status: 'completed',
  result: { success: true, verificationPassed: true,
    verifiedVersion: '160.0', verification: { meetsTarget: true } },
})

test('completed independent PatchHost Windows and version verification is proof', () => {
  assert.equal(isVerifiedAppPortalInstallation(verified, app), true)
})

test('previous revision proof is not accepted for the current app', () => {
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, revision_id: 'rev-1' }, app), false)
})

test('a failed job, even when claiming verification success, is not installed', () => {
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, job_status: 'failed' }, app), false)
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, installation_status: 'failed' }, app), false)
})

test('installer exit code alone is not proof of installed application', () => {
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, result: { success: true, exitCode: 0 } }, app), false)
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, result: { ...verified.result, verificationPassed: false } }, app), false)
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, result: { ...verified.result, verification: { meetsTarget: false } } }, app), false)
})

test('a queued job and malformed payload cannot be falsely marked installed', () => {
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, job_status: 'queued' }, app), false)
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, result: null }, app), false)
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, result: 'success' }, app), false)
})

test('another app cannot reuse the verified result', () => {
  assert.equal(isVerifiedAppPortalInstallation({ ...verified, app_id: 'app-2' }, app), false)
})
