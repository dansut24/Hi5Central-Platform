import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveAuditSettings, assessmentSignature, assessDevicePolicy, rollupCompliance, shouldQueueAutomaticAudit, AUTOMATIC_ASSESSMENT_CADENCE_MS } from '../src/rmmEndpointCompliance.js'
import { buildWindowsPolicyCommand, parseWindowsPolicyResult, WINDOWS_POLICY_WRITE_KEYS } from '../src/rmmEndpointWindowsDriver.js'

const profile={id:'aaaaaaaa-0000-4000-8000-000000000001',revision:2,status:'ready'}
const resolution={applicable:true,settings:[{key:'windows.filesystem.long_paths_enabled',value:true,state:'configured'}]}
const desired=effectiveAuditSettings(resolution)
const now=new Date('2026-11-14T21:00:00Z').getTime()
const agent={websocket_status:'Connected',last_authenticated_at:new Date(now-4000).toISOString()}
const report=(observed)=>({protocol:'h5c.endpoint.v1',profileId:profile.id,action:'audit',
  results:[{key:desired[0].key,action:'audit',status:'observed',observed}]})
const job=(observed,status='completed')=>({id:'bbbbbbbb-0000-4000-8000-000000000001',status,created_at:new Date(now-10000).toISOString(),
  completed_at:new Date(now-5000).toISOString(),
  request_metadata:{action:'audit',assessment_signature:assessmentSignature(profile.revision,desired)},
  result:{output:'H5C_ENDPOINT_POLICY='+JSON.stringify(report(observed))}})
const run=(jobs,overrides={})=>assessDevicePolicy({profile,resolution,agent,jobs,parseResult:parseWindowsPolicyResult,now,...overrides})

test('only supported, non-excluded Windows values are audited',()=>{
  const r={applicable:true,settings:[...resolution.settings,
    {key:'windows.firewall.public.enabled',value:true,state:'excluded'},
    {key:'windows.usb.storage.enabled',value:false,state:'configured'}]}
  assert.deepEqual(effectiveAuditSettings(r),desired)
})
test('new and previously applied policies are pending until actual audit',()=>{
  assert.equal(run([]).status,'pending')
  assert.equal(run([job(true),{status:'completed',created_at:new Date(now).toISOString(),request_metadata:{action:'apply'}}]).status,'pending')
})
test('matching Agent observations confirm compliance; changed values signal drift',()=>{
  const okay=run([job(true)])
  assert.equal(okay.status,'compliant')
  assert.equal(okay.settings[0].status,'compliant')
  const drift=run([job(false)])
  assert.equal(drift.status,'drift')
  assert.equal(drift.settings[0].observed,false)
})
test('a changed profile revision invalidates old compliance',()=>{
  assert.equal(run([job(true)],{profile:{...profile,revision:3}}).status,'pending')
})
test('offline devices are not assessed or counted as compliant',()=>{
  assert.equal(run([job(true)],{agent:{...agent,websocket_status:'Disconnected'}}).status,'offline')
  assert.equal(run([job(true)],{agent:null}).status,'offline')
})
test('stale audits are pending; malformed or failed results are errors',()=>{
  const stale=job(true)
  stale.completed_at=new Date(now-25*3600000).toISOString()
  assert.equal(run([stale]).status,'pending')
  const malformed=job(true)
  malformed.result.output='not-an-agent-receipt'
  assert.equal(run([malformed]).status,'error')
  assert.equal(run([job(true,'failed')]).status,'error')
})
test('excluding all or mixing unsupported settings avoids false green compliance',()=>{
  assert.equal(run([job(true)],{resolution:{applicable:true,settings:[{...desired[0],state:'excluded'}]}}).status,'excluded')
  assert.equal(run([job(true)],{resolution:{applicable:true,settings:[...resolution.settings,
    {key:'windows.usb.storage.enabled',value:false,state:'configured'}]}}).status,'partial')
  assert.equal(run([job(true)],{resolution:{applicable:true,settings:[{...desired[0],state:'conflict'}]}}).status,'conflict')
})
test('roll-up reflects each assigned device, including offline and drift',()=>{
  assert.deepEqual(rollupCompliance([{status:'compliant'},{status:'offline'},{status:'drift'}]).assigned,3)
  assert.equal(rollupCompliance([{status:'compliant'},{status:'offline'},{status:'drift'}]).compliant,1)
})
test('Windows adapter remains allowlisted and records presence of original value',()=>{
  assert.deepEqual(WINDOWS_POLICY_WRITE_KEYS,['windows.filesystem.long_paths_enabled'])
  const script=buildWindowsPolicyCommand({profileId:profile.id,action:'restore',settings:[{key:desired[0].key,value:true}]})
  assert.match(script,/LongPathsWasPresent/)
  assert.match(script,/Registry value presence mismatch after restoration/)
  assert.match(script,/No previously saved value; refusing unsafe default restoration/)
  assert.match(script,/Remove-ItemProperty -Path \$targetPath -Name LongPathsEnabled/)
  assert.throws(()=>buildWindowsPolicyCommand({profileId:profile.id,action:'apply',settings:[{key:'windows.firewall.public.enabled',value:false}]}),/adapter unavailable/i)
})

test('automatic read-only audit requeues after any newer apply or restore, not only after TTL',()=>{
  const audit=job(false)
  const apply={status:'completed',created_at:new Date(now-1000).toISOString(),request_metadata:{action:'apply'}}
  const restore={status:'completed',created_at:new Date(now).toISOString(),request_metadata:{action:'restore'}}
  const signature=assessmentSignature(profile.revision,desired)
  assert.equal(shouldQueueAutomaticAudit([audit],signature,now),false)
  assert.equal(shouldQueueAutomaticAudit([apply,audit],signature,now),true)
  assert.equal(shouldQueueAutomaticAudit([restore,audit],signature,now),true)
  assert.equal(shouldQueueAutomaticAudit([audit],assessmentSignature(3,desired),now),true)
  assert.equal(shouldQueueAutomaticAudit([{...audit,status:'claimed'}],signature,now),false)
  assert.equal(shouldQueueAutomaticAudit([],signature,now),true)
})

test('automatic drift discovery reassesses after ten minutes rather than waiting 24 hours',()=>{
  assert.equal(AUTOMATIC_ASSESSMENT_CADENCE_MS,10*60*1000)
  const last={...job(true),created_at:new Date(now-11*60*1000).toISOString(),
    completed_at:new Date(now-11*60*1000+1000).toISOString()}
  const signature=assessmentSignature(profile.revision,desired)
  assert.equal(shouldQueueAutomaticAudit([last],signature,now),true)
  assert.equal(shouldQueueAutomaticAudit([{...last,created_at:new Date(now-9*60*1000).toISOString()}],signature,now),false)
  assert.equal(shouldQueueAutomaticAudit([{...last,status:'claimed'}],signature,now),false)
})
