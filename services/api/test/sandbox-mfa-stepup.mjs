import assert from 'node:assert/strict'
import {loginRequiresMfa,sandboxPolicyRequiresMfa,mfaRequiredFor,securitySettings} from '../src/securityPolicy.js'

const base={
  onboarding_completed_at:'2026-10-10T00:00:00.000Z',
  tenant_role:'owner',
  configuration:{security:{requireMfa:false,sessionHours:'12'}},
  onboarding_data:{security:{requireMfa:false}},
}
for (const role of ['owner','admin','administrator','agent','requester','technician']) {
  for (const stored of [true,false]) {
    const row={...base,tenant_role:role,configuration:{security:{requireMfa:stored}}}
    assert.equal(mfaRequiredFor(row),true,role+' must use MFA')
    assert.equal(loginRequiresMfa(row),true,role+' must verify MFA at central login')
    assert.equal(sandboxPolicyRequiresMfa(row),true,role+' same MFA in UAT/Test')
    assert.equal(securitySettings(row).requireMfa,true,'legacy MFA flag cannot disable it')
  }
}
assert.equal(mfaRequiredFor({...base,onboarding_completed_at:null}),false,
  'uncompleted onboarding remains on a constrained setup session')
assert.equal(loginRequiresMfa({...base,onboarding_completed_at:null}),false)
console.log('PASS: MFA mandatory centrally for every onboarded role, regardless of old sandbox setting')
