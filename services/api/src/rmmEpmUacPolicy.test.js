import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  validateNativeUacRequest,validateNativeUacStatusRequest,canReleaseNativeUacCredential,
  NATIVE_UAC_REVIEW_TTL_MS
} from './rmmEpmUacPolicy.js'

const now = Date.parse('2026-11-15T17:40:00.000Z')
const good = {
  sid:'S-1-5-21-12-13-14-1001',
  username:'TEST\\Employee', sessionId:2,
  consentProcessId:1234,
  consentStartedAt:new Date(now-2000).toISOString(),
  reason:'I need approval to change this Windows setting.'
}

test('review request is bound to Windows user, session and exact consent process instance',()=>{
  const parsed=validateNativeUacRequest(good,now)
  assert.equal(parsed.ok,true)
  assert.equal(parsed.scope,'unidentified-native-uac')
  assert.equal(parsed.credentialReleaseEnabled,false)
  assert.equal(parsed.consentProcessId,1234)
  assert.equal(parsed.consentStartedAt,good.consentStartedAt)
})
test('unidentified native UAC never releases an administrator credential',()=>{
  assert.equal(canReleaseNativeUacCredential(),false)
  assert.equal(validateNativeUacRequest({...good,targetPath:'C:\\Windows\\System32\\cmd.exe'},now).ok,false)
  assert.equal(validateNativeUacRequest({...good,executable:'notepad.exe'},now).ok,false)
})
test('spoofed, stale and malformed UAC session requests fail closed',()=>{
  const invalid=[
    {...good,sid:'S-1-5-18'},
    {...good,sessionId:0},
    {...good,consentProcessId:0},
    {...good,consentStartedAt:new Date(now-NATIVE_UAC_REVIEW_TTL_MS-1000).toISOString()},
    {...good,consentStartedAt:new Date(now+20000).toISOString()},
    {...good,reason:'short'},
    {...good,reason:'A'.repeat(513)},
    {...good,reason:'Justification line one\nline two'},
    {...good,username:'TEST\\Employee\nADMIN'},
    {...good,reason:4},
    {...good,consentStartedAt:'invalid'},
    { ...good, target:'random target' }
  ]
  for(const item of invalid){
    assert.equal(validateNativeUacRequest(item,now).ok,false,JSON.stringify(item))
  }
})

test('read-only notification polling survives the UAC process closing without granting elevation',()=>{
  const sixMinutes=now+6*60*1000
  const parsed=validateNativeUacStatusRequest(good,sixMinutes)
  assert.equal(parsed.ok,true)
  assert.equal(parsed.credentialReleaseEnabled,false)
  assert.equal(validateNativeUacRequest(good,sixMinutes).ok,false)
  assert.equal(validateNativeUacStatusRequest({...good,sessionId:0},sixMinutes).ok,false)
  assert.equal(validateNativeUacStatusRequest({...good,target:'c:\\\\untrusted.exe'},sixMinutes).ok,false)
  assert.equal(validateNativeUacStatusRequest(good,now+25*60*60*1000).ok,false)
})
