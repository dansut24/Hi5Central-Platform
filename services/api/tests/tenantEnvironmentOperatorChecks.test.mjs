import assert from 'node:assert/strict'
import test from 'node:test'
import { checkProvisioningPreflight, validateControlPlaneAttestation } from '../src/tenantEnvironmentOperatorChecks.js'

const base = {
  request: {
    request_state:'requested',environment:'uat',slug:'acme',
    tenant_status:'active',provisioning_status:'pending',hostname_label:'acmeuat',
  },
  databaseIdentity:{environment:'uat',root_domain:'hi5central.com'},
  targetTenantExists:false,
  controlEndpoint:'control-db.internal:5432/control',
  targetEndpoint:'uat-db.internal:5432/uat',
  environment:'uat',rootDomain:'hi5central.com',
}

test('clean UAT environment passes read-only setup preflight but is not activated',()=>{
  const result=checkProvisioningPreflight(base)
  assert.equal(result.approvedForIsolationSetup,true)
  assert.deepEqual(result.failures,[])
})

test('preflight rejects mismatched runtime identity, root domain and database reuse',()=>{
  for(const override of [
    {databaseIdentity:null},
    {databaseIdentity:{environment:'test',root_domain:'hi5central.com'}},
    {databaseIdentity:{environment:'uat',root_domain:'wrong.example'}},
    {targetEndpoint:base.controlEndpoint},
    {targetTenantExists:true},
    {environment:'test'},
  ]) {
    assert.equal(checkProvisioningPreflight({...base,...override}).approvedForIsolationSetup,false,JSON.stringify(override))
  }
})

test('preflight blocks invalid states, reserved names and mismatched host reservation',()=>{
  for(const change of [
    {request_state:'cancelled'},{request_state:'completed'},
    {tenant_status:'suspended'},{provisioning_status:'ready'},
    {provisioning_status:'provisioning'},{slug:'dev'},
    {slug:'acmetest'}, {hostname_label:'otheruat'},
  ]) {
    const request={...base.request,...change}
    assert.equal(checkProvisioningPreflight({...base,request}).approvedForIsolationSetup,false,JSON.stringify(change))
  }
})

test('missing request is rejected safely',()=>{
  const result=checkProvisioningPreflight({...base,request:null})
  assert.equal(result.approvedForIsolationSetup,false)
})

test('control plane must have independent managed multi-tenant attestation',()=>{
  const valid={
    deployment_mode:'managed',tenancy_mode:'multi',
    root_domain:'hi5central.com',
    instance_id:'55555555-5555-4555-8555-555555555555',
    verified_by:'isolated-ci-operator',verified_at:new Date(),
  }
  assert.equal(validateControlPlaneAttestation(valid,'hi5central.com').allowed,true)
  for(const identity of [
    null,{...valid,tenancy_mode:'single'},
    {...valid,deployment_mode:'self_hosted'},
    {...valid,root_domain:'other.example'},
    {...valid,verified_at:null},
    {...valid,instance_id:null},
  ]) assert.equal(validateControlPlaneAttestation(identity,'hi5central.com').allowed,false)
})
