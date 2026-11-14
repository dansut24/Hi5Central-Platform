import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('../src/rmmLocalAdminVault.js',import.meta.url),'utf8')
test('escrow SQL validates account metadata as text instead of comparing text to UUID',()=>{
  assert.match(api,/j\.request_metadata->>'account_id'=r\.account_id::text/)
  assert.doesNotMatch(api,/j\.request_metadata->>'account_id'=\$3(?:\s|$)/)
})
test('escrow requires claimed agent-owned job, tenant, account and matching job identity',()=>{
  assert.match(api,/r\.tenant_id=\$1 AND r\.agent_device_id=\$2 AND r\.account_id=\$3 AND r\.job_id=\$4/)
  assert.match(api,/j\.status='claimed'/)
  assert.match(api,/j\.request_metadata->>'source'='local_admin_vault'/)
  assert.match(api,/j\.request_metadata->>'account_id'=r\.account_id::text/)
})
test('agent needs positive escrow acknowledgement before account change',()=>{
  assert.match(api,/credential_ciphertext=\$2,state='escrowed'/)
  assert.match(api,/return c\.json\(\{accepted:true,rotationId:result\.id\}\)/)
})
