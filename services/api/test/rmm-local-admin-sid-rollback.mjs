import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const native=readFileSync(new URL('../../../native/agent/Agent/chatpass_agent/src/platform/windows/laps_rotation_impl.inc',import.meta.url),'utf8')
const api=readFileSync(new URL('../src/rmmLocalAdminVault.js',import.meta.url),'utf8')
const ui=readFileSync(new URL('../../../apps/rmm/src/features/rmm/RmmLocalAdminVault.jsx',import.meta.url),'utf8')

test('Windows uses account SID and group membership level zero',()=>{
  assert.ok(native.includes('NetUserGetInfo(nullptr, accountName.c_str(), 4, &userBuffer)'))
  assert.ok(native.includes('IsValidSid(user->usri4_user_sid)'))
  assert.ok(native.includes('LOCALGROUP_MEMBERS_INFO_0 membership'))
  assert.ok(native.includes('membership.lgrmi0_sid = user->usri4_user_sid'))
  assert.ok(native.includes('NetLocalGroupAddMembers(nullptr, groupName.c_str(), 0,'))
  assert.ok(!native.includes('LOCALGROUP_MEMBERS_INFO_3 membership'))
})
test('Failed account creation requires deletion and SID absence verification',()=>{
  assert.ok(native.includes('NetUserDel(nullptr,accountWide.c_str())'))
  assert.ok(native.includes('ManagedAccountSid(accountWide).empty()'))
  assert.ok(native.includes('LAPS_ACCOUNT_CREATION_ROLLED_BACK:'))
  assert.ok(native.includes('Windows account removal is unconfirmed'))
  assert.ok(api.includes("String(job.error_message||'').startsWith('LAPS_ACCOUNT_CREATION_ROLLED_BACK:')"))
  assert.ok(api.includes("['escrowed','uncertain'].includes(row.state)"))
  assert.ok(api.includes('credential_ciphertext=CASE WHEN $3 THEN NULL ELSE credential_ciphertext END'))
  assert.ok(api.includes('verifiedAccountAbsent:verifiedCreationRollback'))
})
test('Vault displays recovery reason requirement by affected controls',()=>{
  assert.ok(ui.includes('at least 10 characters for rotation, 12 for reveal'))
  assert.ok(ui.includes('{error&&<p className="rmm-local-admin-error" role="alert">{error}</p>}'))
})

test('disables unsafe rotation on Agent 1.0.508 until corrected 1.0.509 is installed',()=>{
  assert.ok(api.includes('Number(version[3])<509'))
  assert.ok(ui.includes('agentPatchVersion>=509'))
  assert.ok(ui.includes('!agentSupportsRotation'))
})

test('UI version parser recognises compatible 1.0.509+ versions without double-escaping',()=>{
  const marker="agentPatchVersion=Number(String(account?.agentVersion||'').match(/"
  const offset=ui.indexOf(marker)
  assert.ok(offset>=0,'Expected UI agentPatchVersion parser')
  const regexText=ui.slice(offset+marker.length)
  const end=regexText.indexOf('/)')
  assert.ok(end>0,'Expected closing regex delimiter')
  const parser=new RegExp(regexText.slice(0,end))
  assert.equal(Number('1.0.509'.match(parser)?.[1]||0),509)
  assert.equal(Number('1.0.510'.match(parser)?.[1]||0),510)
  assert.equal(Number('1.0.508'.match(parser)?.[1]||0),508)
  assert.equal(Number('invalid'.match(parser)?.[1]||0),0)
  assert.ok(ui.includes('agentPatchVersion>=509'))
})
