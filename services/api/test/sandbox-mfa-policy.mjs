import assert from 'node:assert/strict'
import {sandboxRequiresMfaForLogin} from '../src/sandboxMfaPolicy.js'

function dbFor(row, expectedSlug='testing-uat') {
  return {async query(sql,params) {
    assert.match(sql,/lower\(u\.email\)=\$2/)
    assert.deepEqual(params,[expectedSlug,'someone@example.com'])
    return {rows:row?[row]:[]}
  }}
}
const policy=(required,role='owner')=>({
  tenant_role:role,
  configuration:{security:{requireMfa:required}},
  onboarding_completed_at:'2026-10-11T00:00:00.000Z',
})
assert.equal(await sandboxRequiresMfaForLogin('testing-uat','Someone@Example.com',{db:dbFor(policy(true))}),true)
assert.equal(await sandboxRequiresMfaForLogin('testing-uat','someone@example.com',{db:dbFor(policy(false))}),false)
assert.equal(await sandboxRequiresMfaForLogin('testing-uat','someone@example.com',{db:dbFor(policy(true,'analyst'))}),false)
assert.equal(await sandboxRequiresMfaForLogin('testing-uat','someone@example.com',{db:dbFor(null)}),false)
console.log('PASS: UAT requires central MFA only for tenant users covered by the UAT policy')
