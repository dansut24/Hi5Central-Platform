import assert from 'node:assert/strict'
import test from 'node:test'
import { needsManagedRuntimeAttestation, validateRuntimeAttestation, assertManagedRuntimeAttestation, validateManagedRuntimeRedisIdentity, assertManagedRuntimeRedisAttestation, MANAGED_RUNTIME_REDIS_IDENTITY_KEY } from '../src/managedRuntimeGuard.js'

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

const redisIdentity = {
  environment: 'uat',
  rootDomain: 'hi5central.com',
  databaseInstanceId: attested.instance_id,
  redisInstanceId: '88888888-8888-4888-8888-888888888888',
  verifiedBy: 'independent-operator',
  verifiedAt: '2026-10-09T19:00:00.000Z',
}

test('managed UAT Redis must be bound to its specific attested database', () => {
  assert.equal(validateManagedRuntimeRedisIdentity(sandbox, attested, redisIdentity).allowed, true)
  for (const invalid of [
    null,
    { ...redisIdentity, environment: 'test' },
    { ...redisIdentity, rootDomain: 'wrong.test' },
    { ...redisIdentity, databaseInstanceId: '99999999-9999-4999-8999-999999999999' },
    { ...redisIdentity, redisInstanceId: 'not-a-uuid' },
    { ...redisIdentity, verifiedBy: '' },
    { ...redisIdentity, verifiedAt: 'n/a' },
  ]) {
    assert.equal(validateManagedRuntimeRedisIdentity(sandbox, attested, invalid).allowed, false)
  }
})

test('managed Test Redis cannot reuse UAT binding', () => {
  const testConfig = { ...sandbox, runtimeEnvironment: 'test' }
  const testDb = { ...attested, environment: 'test' }
  assert.equal(validateManagedRuntimeRedisIdentity(testConfig, testDb, redisIdentity).allowed, false)
})

test('runtime refuses missing, corrupt or wrong Redis identity before starting the API', async () => {
  const clients = [
    { get: async () => null },
    { get: async () => '{invalid' },
    { get: async () => JSON.stringify({ ...redisIdentity, environment: 'test' }) },
  ]
  for (const client of clients) {
    await assert.rejects(assertManagedRuntimeRedisAttestation(client, sandbox, attested), /startup blocked|attestation is unreadable/)
  }
  let requestedKey = ''
  await assert.doesNotReject(assertManagedRuntimeRedisAttestation({
    get: async (key) => { requestedKey = key; return JSON.stringify(redisIdentity) },
  }, sandbox, attested))
  assert.equal(requestedKey, MANAGED_RUNTIME_REDIS_IDENTITY_KEY)
})

test('Redis attestation requirement is limited to managed multi-tenant UAT/Test', async () => {
  const client = { get: async () => { throw new Error('should not be called') } }
  for (const cfg of [
    { ...sandbox, runtimeEnvironment: 'dev' },
    { ...sandbox, runtimeEnvironment: 'live' },
    { ...sandbox, tenancyMode: 'single' },
    { ...sandbox, deploymentMode: 'self_hosted' },
  ]) {
    await assert.doesNotReject(assertManagedRuntimeRedisAttestation(client, cfg, null))
  }
})
