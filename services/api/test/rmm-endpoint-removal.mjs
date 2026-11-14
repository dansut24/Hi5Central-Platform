import test from 'node:test'
import assert from 'node:assert/strict'
import { unresolvedEndpointRestores } from '../src/rmmEndpointRemoval.js'
import { readFileSync } from 'node:fs'

const job=(action,stamp,verifiedRestore=false,deviceId='device-1',settingKey='windows.filesystem.long_paths_enabled')=>({
  status:'completed',created_at:new Date(stamp).toISOString(),verifiedRestore,
  request_metadata:{source:'endpoint_management',endpoint_profile_id:'profile-1',device_id:deviceId,setting_key:settingKey,action},
})
test('Removing an unapplied policy needs no Windows restoration',()=>{
  assert.deepEqual(unresolvedEndpointRestores([]),[])
})
test('Removing an applied setting requires a verified original-value restoration',()=>{
  assert.equal(unresolvedEndpointRestores([job('apply','2026-11-14T10:00:00Z')]).length,1)
  assert.equal(unresolvedEndpointRestores([job('restore','2026-11-14T11:00:00Z',false),job('apply','2026-11-14T10:00:00Z')]).length,1)
  assert.deepEqual(unresolvedEndpointRestores([job('restore','2026-11-14T11:00:00Z',true),job('apply','2026-11-14T10:00:00Z')]),[])
})
test('A later apply requires a new restoration, even after an earlier successful restore',()=>{
  const runs=[job('apply','2026-11-14T12:00:00Z'),job('restore','2026-11-14T11:00:00Z',true),job('apply','2026-11-14T10:00:00Z')]
  assert.equal(unresolvedEndpointRestores(runs).length,1)
})
test('Tracks each device and setting separately',()=>{
  const runs=[job('apply','2026-11-14T10:00:00Z',false,'device-1'),job('restore','2026-11-14T11:00:00Z',true,'device-2'),
    job('apply','2026-11-14T09:00:00Z',false,'device-2')]
  assert.equal(unresolvedEndpointRestores(runs).length,1)
  assert.equal(unresolvedEndpointRestores(runs)[0].deviceId,'device-1')
})
test('Endpoint API archives instead of hard-deleting policies and retains audit',()=>{
  const api=readFileSync(new URL('../src/rmmEndpointManagement.js',import.meta.url),'utf8')
  assert.ok(api.includes("app.delete('/api/v1/rmm/endpoint-management/profiles/:id'"))
  assert.ok(api.includes("SET archived_at=now(),status='disabled'"))
  assert.ok(api.includes("rejectUnrestoredSettings(session.tenant_id,profile.id)"))
  assert.ok(api.includes("'profile.removed'"))
  assert.ok(api.includes("await cancelQueuedEndpointJobs(client,session.tenant_id,profile.id)"))
})
test('Native local-admin removal validates exactly the managed SID and re-checks account absence',()=>{
  const native=readFileSync(new URL('../../../native/agent/Agent/chatpass_agent/src/platform/windows/laps_rotation_impl.inc',import.meta.url),'utf8')
  assert.ok(native.includes('observedSid != expectedSid'))
  assert.ok(native.includes('NetUserDel(nullptr, accountWide.c_str())'))
  assert.ok(native.includes('if (!ManagedAccountSid(accountWide).empty())'))
  assert.ok(native.includes('IsNativeLapsCurrentlyManagingAccounts()'))
})
test('LAPS API never wipes escrow until a verified Agent removal receipt',()=>{
  const api=readFileSync(new URL('../src/rmmLocalAdminVault.js',import.meta.url),'utf8')
  assert.ok(api.includes("receipt.verified_absent===true"))
  assert.ok(api.includes("receipt.account_sid===a.account_sid"))
  assert.ok(api.includes("SET credential_ciphertext=NULL"))
  assert.ok(api.includes("state='removal_uncertain'"))
  assert.ok(api.includes("eventType:'removal.verified'"))
  assert.ok(api.includes("'management.paused'"))
  const agent=readFileSync(new URL('../src/rmmAgent.js',import.meta.url),'utf8')
  assert.ok(agent.includes("job_type<>'laps.remove'"))
})

test('Destructive local-account removal requires a second independent administrator access confirmation',()=>{
  const api=readFileSync(new URL('../src/rmmLocalAdminVault.js',import.meta.url),'utf8')
  const ui=readFileSync(new URL('../../../apps/rmm/src/features/rmm/RmmLocalAdminVault.jsx',import.meta.url),'utf8')
  assert.ok(api.includes('body.confirmedAlternativeAdmin!==true'))
  assert.ok(ui.includes('alternativeAdminConfirmed'))
  assert.ok(ui.includes('another working administrator login'))
})

test('Permanent LAPS removal uses a distinct privilege rather than password-rotation permission',()=>{
  const api=readFileSync(new URL('../src/rmmLocalAdminVault.js',import.meta.url),'utf8')
  const access=readFileSync(new URL('../src/access.js',import.meta.url),'utf8')
  assert.ok(access.includes('rmm.security.local_admin.remove'))
  assert.ok(api.includes("canRemove:hasPermission(session.access,'rmm.security.local_admin.remove')"))
  assert.equal(api.split("authorize(c,'rmm.security.local_admin.remove')").length-1,2)
  assert.ok(api.includes("authorize(c,'rmm.security.local_admin.rotate')"))
})
