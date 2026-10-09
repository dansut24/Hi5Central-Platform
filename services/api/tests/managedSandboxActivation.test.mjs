import assert from 'node:assert/strict'
import test from 'node:test'
import { sandboxTenantAccess } from '../src/managedSandboxAccess.js'

const config={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:'uat',rootDomain:'hi5central.com'}
const tenantId='11111111-1111-4111-8111-111111111111'
const requestId='22222222-2222-4222-8222-222222222222'
const instance='33333333-3333-4333-8333-333333333333'
const approved={
  id:tenantId,slug:'acme',status:'active',
  tenant_url:'https://acmeuat.hi5central.com',
  portal_url:'https://acmeuat-portal.hi5central.com',
  rmm_url:null,modules:{itsm:true,selfService:true,rmm:false},
  runtime_database_instance_id:instance,
  local_tenant_id:tenantId,control_request_id:requestId,
  database_instance_id:instance,expected_hostname:'acmeuat.hi5central.com',
  environment:'uat',stage:'identity_prepared',
  approval_tenant_id:tenantId,bootstrap_request_id:requestId,
  approval_state:'approved',approved_by:'independent-reviewer',
  approved_at:new Date(),
}
const fakeDb=row=>({
  query:async(sql,values)=>{
    assert.match(sql,/managed_environment_access_approvals/)
    assert.deepEqual(values,[tenantId,'uat','hi5central.com'])
    return {rows:row?[row]:[]}
  },
})

test('only an attested, explicitly approved active UAT tenant receives session access',async()=>{
  assert.equal(await sandboxTenantAccess(fakeDb(approved),config,tenantId),true)
  assert.equal(await sandboxTenantAccess(fakeDb(null),config,tenantId),false)
})

test('suspension or approval revocation terminates existing session eligibility immediately',async()=>{
  for(const row of [
    {...approved,status:'suspended'},
    {...approved,approval_state:'revoked'},
    {...approved,approved_at:null},
    {...approved,environment:'test'},
    {...approved,database_instance_id:'99999999-9999-4999-8999-999999999999'},
    {...approved,tenant_url:'https://acme.hi5central.com'},
    {...approved,rmm_url:'https://acmeuat-rmm.hi5central.com'},
    {...approved,modules:{...approved.modules,rmm:true}},
  ])assert.equal(await sandboxTenantAccess(fakeDb(row),config,tenantId),false)
})

test('internal Dev and current Production preserve their existing session behaviour',async()=>{
  const neverCalled={query:async()=>{throw new Error('unexpected access query')}}
  for(const cfg of [
    {...config,tenancyMode:'single',runtimeEnvironment:'dev'},
    {...config,runtimeEnvironment:'live'},
    {...config,deploymentMode:'self_hosted'},
  ]) assert.equal(await sandboxTenantAccess(neverCalled,cfg,tenantId),true)
})
