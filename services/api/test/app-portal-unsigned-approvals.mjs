import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalMatches, allowedUnsignedScope, unsignedManifestApproval } from '../src/appPortalUnsignedApproval.js'

const sha='A'.repeat(64)
const revision={
  id:'rev-1', revision_id:'rev-1', tenant_id:'tenant-1',
  source_kind:'upload', source_config:{inspection:{status:'unsigned'}}, sha256:sha,
}
const approval={
  id:'approval-1', revision_id:'rev-1', tenant_id:'tenant-1',
  package_sha256:sha, approved_by_user_id:'owner-1', revoked_at:null,
}

test('owner-approved unsigned revision with exact hash matches', ()=>{
  assert.equal(approvalMatches(revision,approval),true)
  assert.deepEqual(unsignedManifestApproval(revision,approval,'device-1'), {
    kind:'hi5_app_portal_unsigned_v1',approvalId:'approval-1',
    revisionId:'rev-1',tenantId:'tenant-1',deviceId:'device-1',sha256:sha,
  })
})
test('changed SHA-256, revision, or tenant invalidates approval', ()=>{
  assert.equal(approvalMatches({...revision,sha256:'B'.repeat(64)},approval),false)
  assert.equal(approvalMatches({...revision,id:'rev-2',revision_id:'rev-2'},approval),false)
  assert.equal(approvalMatches(revision,{...approval,tenant_id:'tenant-2'}),false)
})
test('revoked or unsigned exception on signed/invalid package never matches', ()=>{
  assert.equal(approvalMatches(revision,{...approval,revoked_at:new Date().toISOString()}),false)
  assert.equal(approvalMatches({...revision,source_config:{inspection:{status:'pending_windows_trust'}}},approval),false)
  assert.equal(approvalMatches({...revision,source_config:{inspection:{status:'invalid_or_unrecognised'}}},approval),false)
})
test('unsigned assignments are restricted to an individual device and never forced', ()=>{
  for (const scope of ['Estate','Site','User','Group']) assert.equal(allowedUnsignedScope(scope,'available'),false)
  assert.equal(allowedUnsignedScope('Device','required'),false)
  assert.equal(allowedUnsignedScope('Device','uninstall'),false)
  assert.equal(allowedUnsignedScope('Device','available'),true)
  assert.equal(allowedUnsignedScope('Device','approval_required'),true)
})
