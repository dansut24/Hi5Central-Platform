import assert from 'node:assert/strict'
import test from 'node:test'
import { invitationLandingUrl } from '../src/managedSandboxInvitations.js'

const tenantUrl='https://synthacmeuat.hi5central.com'
const portalUrl='https://synthacmeuat-portal.hi5central.com'
test('requester invitations land in Portal, not staff ITSM',()=>{
  assert.equal(invitationLandingUrl('requester',tenantUrl,portalUrl),portalUrl)
})
test('owner/admin/analyst invitations land in staff workspace',()=>{
  for(const role of ['owner','admin','analyst']){
    assert.equal(invitationLandingUrl(role,tenantUrl,portalUrl),tenantUrl)
  }
})
