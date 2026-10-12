import assert from 'node:assert/strict'
import {loginRequiresMfa,sandboxPolicyRequiresMfa,mfaRequiredFor} from '../src/securityPolicy.js'

const base={
  onboarding_completed_at:'2026-10-10T00:00:00.000Z',
  tenant_role:'owner',
  configuration:{security:{requireMfa:false,sessionHours:'12'}},
  onboarding_data:{security:{requireMfa:false}},
}
const live={...base}
const uat={...base,configuration:{security:{requireMfa:true}}}
assert.equal(mfaRequiredFor(live),false)
assert.equal(sandboxPolicyRequiresMfa(live),false)
assert.equal(sandboxPolicyRequiresMfa(uat),true)
assert.equal(loginRequiresMfa(live),false)
assert.equal(loginRequiresMfa(live,sandboxPolicyRequiresMfa(uat)),true,
  'UAT requiring MFA must produce a Production MFA challenge rather than an unverified session')
assert.equal(loginRequiresMfa(live,sandboxPolicyRequiresMfa(live)),false)
assert.equal(loginRequiresMfa(uat),true)
assert.equal(loginRequiresMfa({...live,tenant_role:'administrator'},true),false,
  'Step-up applies only to security-policy privileged roles')
assert.equal(loginRequiresMfa({...live,tenant_role:'agent'},true),false)
assert.equal(loginRequiresMfa({...live,onboarding_completed_at:null},true),false)
assert.equal(loginRequiresMfa({...live,tenant_role:'admin'},true),true)
assert.equal(loginRequiresMfa(live,'true'),false,'Untrusted truthy strings must not enable step-up')
assert.equal(loginRequiresMfa({...live,configuration:{security:{requireMfa:true}}},false),true,
  'A stricter Production policy cannot be relaxed by any sandbox request')
console.log('PASS: stronger UAT MFA step-up, Production MFA guard, role gating, and separate security policies')
