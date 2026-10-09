import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentConfig } from '../src/lib/deploymentConfig.js'

test('managed UAT/Test never inherit Production Admin origin even if supplied',()=>{
  for(const env of ['uat','test']){
    globalThis.window={__HI5_CONFIG__:{
      deploymentMode:'managed',tenancyMode:'multi',
      runtimeEnvironment:env,rootDomain:'hi5central.com',
      apiUrl:`https://pilot-${env}-api.hi5central.com`,
      adminUrl:'https://admin.hi5central.com',
      primaryTenantSlug:'',
    }}
    const config=deploymentConfig()
    assert.equal(config.runtimeEnvironment,env)
    assert.equal(config.adminUrl,'')
    assert.equal(config.adminOrigin,'')
    assert.equal(config.apiUrl,`https://pilot-${env}-api.hi5central.com`)
    assert.equal(config.primaryTenantSlug,'')
  }
  delete globalThis.window
})
test('internal Dev and regular Production Admin configuration stay available',()=>{
  globalThis.window={__HI5_CONFIG__:{
    deploymentMode:'managed',tenancyMode:'multi',
    runtimeEnvironment:'live',rootDomain:'hi5central.com',
  }}
  assert.equal(deploymentConfig().adminUrl,'https://admin.hi5central.com')
  globalThis.window.__HI5_CONFIG__.runtimeEnvironment='dev'
  assert.equal(deploymentConfig().adminUrl,'https://admin.hi5central.com')
  delete globalThis.window
})
