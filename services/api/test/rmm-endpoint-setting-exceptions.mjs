import test from 'node:test'
import assert from 'node:assert/strict'
import { ENDPOINT_SETTINGS, highRiskEndpointOverride, validateSettings, validateSettingValue, resolveEndpointSetting, resolveEndpointProfile } from '../src/rmmEndpointPolicyModel.js'

const smb = 'windows.smb1.enabled'
const device = { id: 'device-1', reference: 'endpoint-lenovo', user_principal_name: 'user@example.com' }
const group = { id: 'group-1', deviceIds: ['endpoint-lenovo'] }
const profile = { id: 'policy-1', scope_type: 'estate', scope_id: '', settings: [{ key: smb, value: false }] }
const exception = (id, scope_type, scope_id, mode, value, extra = {}) => ({
  id, setting_key: smb, scope_type, scope_id, mode, value, reason: 'Approved legacy requirement', revoked_at: null, expires_at: null, ...extra,
})
test('catalogue has distinct setting identities and native LAPS directory choices', () => {
  assert.equal(new Set(ENDPOINT_SETTINGS.map((setting) => setting.key)).size, ENDPOINT_SETTINGS.length)
  assert.deepEqual(ENDPOINT_SETTINGS.find((setting) => setting.key === 'windows.laps.backup_directory').values, ['entra','ad'])
  assert.throws(() => validateSettingValue('windows.laps.backup_directory','hi5central'), /invalid option/)
  assert.throws(() => validateSettings([{key:smb,value:true},{key:smb,value:false}]), /Duplicate/)
  assert.throws(() => validateSettingValue(smb,'enabled'), /true or false/)
})
test('unsafe SMBv1/firewall/USB overrides require explicit acceptance in the API', () => {
  assert.equal(highRiskEndpointOverride(smb, true, 'override'), true)
  assert.equal(highRiskEndpointOverride(smb, false, 'override'), false)
  assert.equal(highRiskEndpointOverride(smb, true, 'exclude'), false)
  assert.equal(highRiskEndpointOverride('windows.firewall.public.enabled', false, 'override'), true)
  assert.equal(highRiskEndpointOverride('windows.usb.storage.enabled', true, 'override'), true)
})
test('profile target and baseline default evaluation', () => {
  assert.deepEqual(resolveEndpointProfile({profile, exceptions:[], device, groups:[group]}).settings[0].state, 'configured')
  assert.equal(resolveEndpointProfile({profile:{...profile,scope_type:'group',scope_id:'unmatched'},exceptions:[],device,groups:[group]}).applicable,false)
  assert.equal(resolveEndpointProfile({profile:{...profile,scope_type:'group',scope_id:group.id},exceptions:[],device,groups:[group]}).applicable,true)
})
test('group exception changes only SMBv1 setting, retaining firewall baseline', () => {
  const extended = {...profile,settings:[...profile.settings,{key:'windows.firewall.domain.enabled',value:true}]}
  const result = resolveEndpointProfile({profile:extended, exceptions:[exception('group-ex','group',group.id,'override',true)], device, groups:[group]})
  assert.equal(result.settings[0].value,true)
  assert.equal(result.settings[0].state,'overridden')
  assert.equal(result.settings[1].value,true)
  assert.equal(result.settings[1].state,'configured')
})
test('device exception overrides group and user exceptions', () => {
  const exceptions = [
    exception('group-ex','group',group.id,'override',true),
    exception('user-ex','user','user@example.com','override',true),
    exception('device-ex','device',device.id,'exclude',null),
  ]
  const result = resolveEndpointProfile({profile,exceptions,device,groups:[group]}).settings[0]
  assert.equal(result.state,'excluded')
  assert.equal(result.value,null)
  assert.equal(result.exception.id,'device-ex')
})
test('conflicting equally-specific group values are surfaced rather than arbitrarily applied', () => {
  const result = resolveEndpointSetting({key:smb,configuredValue:false,deviceId:'device-1',groupIds:['g1','g2'],
    exceptions:[exception('ex1','group','g1','override',false),exception('ex2','group','g2','override',true)]})
  assert.equal(result.state,'conflict')
  assert.equal(result.value,null)
  assert.equal(result.conflicts.length,2)
})
test('expired and revoked exceptions do not override a baseline', () => {
  const result = resolveEndpointSetting({key:smb,configuredValue:false,deviceId:device.id,at:new Date('2026-11-14T14:00:00Z'),exceptions:[
    exception('old','device',device.id,'override',true,{expires_at:'2026-11-13T00:00:00Z'}),
    exception('revoked','device',device.id,'override',true,{revoked_at:'2026-11-13T00:00:00Z'}),
  ]})
  assert.equal(result.state,'configured')
  assert.equal(result.value,false)
})
test('user exception only affects devices assigned to that user', () => {
  const ex = [exception('user-ex','user','user@example.com','exclude',null)]
  assert.equal(resolveEndpointProfile({profile,exceptions:ex,device,groups:[]}).settings[0].state,'excluded')
  assert.equal(resolveEndpointProfile({profile,exceptions:ex,device:{...device,user_principal_name:'someoneelse@example.com'},groups:[]}).settings[0].state,'configured')
})
