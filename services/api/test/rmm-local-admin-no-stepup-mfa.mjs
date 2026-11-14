import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('../src/rmmLocalAdminVault.js', import.meta.url),'utf8')
const ui = readFileSync(new URL('../../../apps/rmm/src/features/rmm/RmmLocalAdminVault.jsx', import.meta.url),'utf8')

test('local admin vault rotation and reveal no longer require additional recent MFA', () => {
  assert.doesNotMatch(api, /revealMfaRecent|recentlyVerified|five minutes|last 5 minutes/i)
  assert.doesNotMatch(ui, /recentlyVerified|MFA within the last five minutes/i)
})
test('local admin vault still requires interactive tenant session and distinct RBAC roles', () => {
  assert.match(api, /if \(!session \|\| !session\.session_id\)/)
  assert.match(api, /originMatchesTenant/)
  assert.match(api, /hasPermission\(session\.access,permission\)/)
  assert.match(api, /authorize\(c,'rmm\.security\.local_admin\.rotate'\)/)
  assert.match(api, /authorize\(c,'rmm\.security\.local_admin\.read'\)/)
})
test('operator reason, audit, escrow and server-side vault security are retained', () => {
  assert.match(api, /reason\.length<10/)
  assert.match(api, /reason\.length<12/)
  assert.match(api, /eventType:'credential\.revealed'/)
  assert.match(api, /eventType:'rotation\.requested'/)
  assert.match(api, /protectLocalAdminPassword/)
  assert.match(api, /revealLocalAdminPassword/)
  assert.match(api, /credential_ciphertext/)
  assert.match(ui, /disabled=\{busy\|\|!account\.agentConnected\|\|!data\.canRotate\}/)
  assert.match(ui, /disabled=\{busy\|\|!data\.canReveal\}/)
})
