import test from 'node:test'
import assert from 'node:assert/strict'
import {
  invitationToken,invitationHash,validInvitationToken,validInvitationEmail,
  permittedInvitationRole,sandboxInvitationGate,validInvitationRecord,
} from '../src/managedSandboxInvitations.js'

const config={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:'uat',rootDomain:'hi5central.com'}
const tenant={id:'11111111-1111-4111-8111-111111111111',slug:'acme',status:'active',
  tenant_url:'https://acmeuat.hi5central.com',portal_url:'https://acmeuat-portal.hi5central.com',
  rmm_url:null,runtime_database_instance_id:'33333333-3333-4333-8333-333333333333'}
const bootstrap={
  local_tenant_id:tenant.id,control_request_id:'22222222-2222-4222-8222-222222222222',
  stage:'identity_prepared',environment:'uat',
  database_instance_id:tenant.runtime_database_instance_id,
  expected_hostname:'acmeuat.hi5central.com',
}
const approval={
  tenant_id:tenant.id,bootstrap_request_id:bootstrap.control_request_id,
  state:'approved',approved_by:'two-person-review',approved_at:new Date(),
}
const modules={itsm:true,selfService:true,rmm:false}

test('one-time invitations use unguessable, SHA-256 hashed tokens',()=>{
  const raw=invitationToken()
  const second=invitationToken()
  assert.equal(validInvitationToken(raw),true)
  assert.notEqual(raw,second)
  assert.match(invitationHash(raw),/^[a-f0-9]{64}$/)
  assert.equal(invitationHash(raw),invitationHash(raw))
  assert.notEqual(invitationHash(raw),invitationHash(second))
  for(const bad of ['123','',null,undefined,'x'.repeat(80)]) {
    assert.equal(validInvitationToken(bad),false)
  }
})

test('only valid lowercase invitation email addresses and authorised roles',()=>{
  assert.equal(validInvitationEmail('person@example.org'),true)
  for(const invalid of ['A@EXAMPLE.ORG','bad@example','another @mail.example','',null]) {
    assert.equal(validInvitationEmail(invalid),false)
  }
  assert.equal(permittedInvitationRole('owner','owner'),true)
  assert.equal(permittedInvitationRole('requester','admin'),true)
  assert.equal(permittedInvitationRole('owner','admin'),false)
  assert.equal(permittedInvitationRole('admin','analyst'),false)
})

test('tenant must be active, attested and independently approved before invitation issue or redemption',()=>{
  assert.equal(sandboxInvitationGate(config,tenant,bootstrap,approval,modules).allowed,true)
  for(const [cfg,t,b,a,m] of [
    [{...config,runtimeEnvironment:'test'},tenant,bootstrap,approval,modules],
    [{...config,tenancyMode:'single'},tenant,bootstrap,approval,modules],
    [{...config,runtimeEnvironment:'live'},tenant,bootstrap,approval,modules],
    [config,{...tenant,status:'suspended'},bootstrap,approval,modules],
    [config,tenant,null,approval,modules],
    [config,tenant,{...bootstrap,local_tenant_id:'wrong'},approval,modules],
    [config,tenant,{...bootstrap,stage:'ready'},approval,modules],
    [config,{...tenant,tenant_url:'https://acme.hi5central.com'},bootstrap,approval,modules],
    [config,{...tenant,rmm_url:'https://acmeuat-rmm.hi5central.com'},bootstrap,approval,modules],
    [config,tenant,{...bootstrap,expected_hostname:'acmetest.hi5central.com'},approval,modules],
    [config,tenant,{...bootstrap,database_instance_id:'99999999-9999-4999-8999-999999999999'},approval,modules],
    [config,tenant,bootstrap,null,modules],
    [config,tenant,bootstrap,{...approval,state:'revoked'},modules],
    [config,tenant,bootstrap,{...approval,approved_at:null},modules],
    [config,tenant,bootstrap,{...approval,bootstrap_request_id:'wrong'},modules],
    [config,tenant,bootstrap,approval,{...modules,rmm:true}],
  ])assert.equal(sandboxInvitationGate(cfg,t,b,a,m).allowed,false)
})

test('an invitation expires, cannot be replayed, and cannot be used in another tenant',()=>{
  const invitation={
    tenant_id:tenant.id,email:'person@example.org',
    expires_at:new Date(Date.now()+60_000),
    accepted_at:null,revoked_at:null,
  }
  assert.equal(validInvitationRecord(invitation,tenant.id,invitation.email),true)
  assert.equal(validInvitationRecord({...invitation,accepted_at:new Date()},tenant.id,invitation.email),false)
  assert.equal(validInvitationRecord({...invitation,revoked_at:new Date()},tenant.id,invitation.email),false)
  assert.equal(validInvitationRecord({...invitation,expires_at:new Date(Date.now()-60_000)},tenant.id,invitation.email),false)
  assert.equal(validInvitationRecord(invitation,'other-tenant',invitation.email),false)
  assert.equal(validInvitationRecord(invitation,tenant.id,'other@example.org'),false)
})
