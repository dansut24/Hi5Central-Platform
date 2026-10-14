import test from 'node:test'
import assert from 'node:assert/strict'
import { originMatchesTenant, allowedRequestOrigin } from '../src/deploymentConfig.js'

const managed='h5c-managed-qa26'
const custom='h5c-custom-qa26'
test('QA26 billing admin origin is accepted for only its own tenant',()=>{
  for(const slug of [managed,custom]){
    const admin='https://'+slug+'-admin.hi5central.com'
    assert.equal(originMatchesTenant(admin,slug),true)
    assert.equal(allowedRequestOrigin(admin),admin)
    assert.equal(originMatchesTenant('https://'+slug+'.hi5central.com',slug),true)
  }
  assert.equal(originMatchesTenant('https://'+managed+'-admin.hi5central.com',custom),false)
  assert.equal(originMatchesTenant('https://'+custom+'-admin.hi5central.com',managed),false)
})
test('QA26 origin exception cannot grant access to arbitrary or spoofed hosts',()=>{
  for(const origin of [
    'https://different-tenant-admin.hi5central.com',
    'https://h5c-managed-qa26-admin.hi5central.com.evil.com',
    'http://h5c-managed-qa26-admin.hi5central.com',
    'https://h5c-managed-qa26-admin.hi5central.com:4443',
    'https://h5c-managed-qa26-admin.hi5central.com@evil.example',
    'https://admin.hi5central.com',
  ]) assert.equal(originMatchesTenant(origin,managed),false,origin)
  assert.equal(originMatchesTenant('https://h5c-managed-qa26-admin.hi5central.com','some-other-tenant'),false)
})
