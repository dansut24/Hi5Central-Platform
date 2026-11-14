import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWindowsPolicyCommand, parseWindowsPolicyResult, WINDOWS_POLICY_WRITE_KEYS } from '../src/rmmEndpointWindowsDriver.js'
const id = 'bbbbbbbb-0000-4000-8000-000000000001'
const key = 'windows.filesystem.long_paths_enabled'
test('the only initial write adapter is reversible Win32 long paths', () => {
  assert.deepEqual(WINDOWS_POLICY_WRITE_KEYS, [key])
  const command = buildWindowsPolicyCommand({profileId:id, action:'apply',settings:[{key,value:true}]})
  assert.match(command,/H5C_ENDPOINT_POLICY=/)
  assert.match(command,/EndpointPolicyBackups/)
  assert.match(command,/Post-write verification mismatch/)
  assert.doesNotMatch(command,/H5C_DESCRIPTOR_B64/)
})
test('the driver refuses unsafe firewall, SMBv1 and LAPS writes', () => {
  for (const unsafe of ['windows.smb1.enabled','windows.firewall.public.enabled','windows.laps.backup_directory']) {
    assert.throws(()=>buildWindowsPolicyCommand({profileId:id,action:'apply',settings:[{key:unsafe,value:unsafe==='windows.laps.backup_directory'?'entra':true}]}),/adapter unavailable/i)
  }
})
test('PowerShell script descriptors validate and cannot embed arbitrary client commands', () => {
  assert.throws(()=>buildWindowsPolicyCommand({profileId:';exit',action:'audit',settings:[{key,value:true}]}),/profile id/i)
  assert.throws(()=>buildWindowsPolicyCommand({profileId:id,action:'execute',settings:[{key,value:true}]}),/invalid action/i)
  assert.throws(()=>buildWindowsPolicyCommand({profileId:id,action:'apply',settings:[{key,value:'1'}]}),/true or false/)
  assert.throws(()=>buildWindowsPolicyCommand({profileId:id,action:'audit',settings:[{key,value:true},{key,value:true}]}),/duplicate/i)
})
test('restore requires a prior locally saved value rather than resetting to a guessed default', () => {
  const command=buildWindowsPolicyCommand({profileId:id,action:'restore',settings:[{key,value:true}]})
  assert.match(command,/refusing unsafe default restoration/)
  assert.match(command,/Remove-ItemProperty/)
})
test('result parsing rejects non-agent payloads and accepts observed settings', () => {
  assert.equal(parseWindowsPolicyResult('hello'),null)
  const report={protocol:'h5c.endpoint.v1',action:'audit',results:[{key,observed:false,status:'observed'}]}
  assert.deepEqual(parseWindowsPolicyResult('H5C_ENDPOINT_POLICY='+JSON.stringify(report)),report)
})
