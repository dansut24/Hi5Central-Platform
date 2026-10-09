import assert from 'node:assert/strict'
import test from 'node:test'
import { needsManagedRuntimeAttestation,validateRuntimeAttestation,assertManagedRuntimeAttestation } from '../src/managedRuntimeGuard.js'

const sandbox={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:'uat',rootDomain:'hi5central.com'}
const attested={
  environment:'uat',root_domain:'hi5central.com',
  instance_id:'33333333-3333-4333-8333-333333333333',
  verified_by:'platform-operator',verified_at:new Date(),
}

test('UAT/Test managed runtimes require an attested database; Dev and self-host do not',()=>{
  assert.equal(needsManagedRuntimeAttestation(sandbox),true)
  assert.equal(needsManagedRuntimeAttestation({...sandbox,runtimeEnvironment:'test'}),true)
  for(const cfg of [
    {...sandbox,runtimeEnvironment:'dev'},
    {...sandbox,runtimeEnvironment:'live'},
    {...sandbox,tenancyMode:'single'},
    {...sandbox,deploymentMode:'self_hosted'},
  ])assert.equal(needsManagedRuntimeAttestation(cfg),false)
})

test('correct UAT identity is accepted but Test, missing and incomplete identities are rejected',()=>{
  assert.equal(validateRuntimeAttestation(sandbox,attested).allowed,true)
  for(const identity of [
    null,
    {...attested,environment:'test'},
    {...attested,root_domain:'other.com'},
    {...attested,instance_id:null},
    {...attested,verified_by:''},
    {...attested,verified_at:null},
  ]) assert.equal(validateRuntimeAttestation(sandbox,identity).allowed,false)
})

test('runtime refuses to start before RMM broker if attestation absent',async()=>{
  const pool={ query:async()=>({rows:[]}) }
  await assert.rejects(assertManagedRuntimeAttestation(pool,sandbox),/startup blocked/)
  await assert.doesNotReject(assertManagedRuntimeAttestation(pool,{...sandbox,tenancyMode:'single'}))
})

test('runtime rejects missing identity table instead of falling back to existing customer data',async()=>{
  const pool={query:async()=>{throw new Error('relation does not exist')}}
  await assert.rejects(assertManagedRuntimeAttestation(pool,sandbox),/attestation schema unavailable/)
})
