import assert from 'node:assert/strict'
import test from 'node:test'
import { managedSandboxBlocksRmm, requiresConnectCodeHmacKey } from '../src/managedSandboxPolicy.js'

const config={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:'uat'}
test('UAT/Test forbid Connect and do not require disabled Connect secret',()=>{
  for(const runtimeEnvironment of ['uat','test']){
    const env={...config,runtimeEnvironment}
    assert.equal(managedSandboxBlocksRmm(env),true)
    assert.equal(requiresConnectCodeHmacKey(env,'production'),false)
  }
})
test('Production, single-tenant and self-hosted Connect retain HMAC requirement',()=>{
  for(const env of [
    {...config,runtimeEnvironment:'live'},
    {...config,tenancyMode:'single'},
    {...config,deploymentMode:'self_hosted'},
  ])assert.equal(requiresConnectCodeHmacKey(env,'production'),true)
  assert.equal(requiresConnectCodeHmacKey({...config,runtimeEnvironment:'live'},'test'),false)
})
