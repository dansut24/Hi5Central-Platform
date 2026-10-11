import assert from 'node:assert/strict'
import {mfaRequiredFor,loginMfaRequired} from '../src/securityPolicy.js'

const row=(policy,role='owner')=>({
  onboarding_completed_at:new Date().toISOString(),
  configuration:{security:{requireMfa:policy}},
  tenant_role:role,
})
assert.equal(mfaRequiredFor(row(false)),false)
assert.equal(loginMfaRequired(row(false)),false)
assert.equal(loginMfaRequired(row(false),true),true,
  'A UAT-required MFA challenge must work when Live MFA is optional')
assert.equal(loginMfaRequired(row(false),false),false)
assert.equal(loginMfaRequired(row(true),false),true,
  'Opt-in cannot bypass mandatory Live MFA')
assert.equal(loginMfaRequired(row(true),null),true)
assert.equal(loginMfaRequired(row(false),'false'),false,
  'Only a literal boolean true may request extra MFA')
assert.equal(loginMfaRequired(row(false,'analyst'),true),true)
assert.equal(loginMfaRequired(row(true,'analyst')),false)
console.log('PASS: central identity MFA can be strengthened, never downgraded')
