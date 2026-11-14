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
