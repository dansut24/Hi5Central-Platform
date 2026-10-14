import assert from 'node:assert/strict'
import {tenantExperienceSnapshot} from '../src/tenantExperience.js'
import {sessionPayload} from '../src/session.js'

const firstTenant='11111111-1111-4111-8111-111111111111'
const managedTenant='22222222-2222-4222-8222-222222222222'
const customTenant='33333333-3333-4333-8333-333333333333'
const legacy=new Date('2026-10-01T10:00:00.000Z')
const newOnboarding=new Date('2026-10-12T19:00:00.000Z')
const dark={appearance:{theme:'dark',accentMode:'personal',accent:'#d38301',density:'comfortable'}}
const rose={appearance:{theme:'light',accentMode:'tenant',accent:'#f43f5e',density:'comfortable'}}
const old={preferences:dark,first_login_completed_at:legacy,platform_guidance:{itsm:{completedAt:legacy.toISOString()}},platform_getting_started:{}}

let experience=tenantExperienceSnapshot(old,managedTenant,newOnboarding)
assert.equal(experience.firstLoginCompletedAt,null,'New tenant cannot inherit other tenant first-login marker')
assert.equal(experience.preferences,null,'New tenant cannot inherit old personal accent')
assert.deepEqual(experience.platformGuidance,{},'New tenant starts its own coach marks')

experience=tenantExperienceSnapshot(old,firstTenant,new Date('2026-09-01T09:00:00Z'))
assert.equal(experience.firstLoginCompletedAt,legacy,'Existing tenant keeps legacy first login')
assert.equal(experience.preferences.appearance.theme,'dark')
assert.equal(experience.preferences.appearance.accent,'#d38301')

const after={...old,
  preferences:{...dark,tenantOverrides:{[managedTenant]:rose}},
  platform_guidance:{...old.platform_guidance,tenantFirstLogin:{[managedTenant]:'2026-10-12T19:55:00.000Z'},
    tenantPlatforms:{[managedTenant]:{itsm:{completedAt:'2026-10-12T19:59:00.000Z'}}}},
}
const assigned=tenantExperienceSnapshot(after,managedTenant,newOnboarding)
assert.equal(assigned.firstLoginCompletedAt,'2026-10-12T19:55:00.000Z')
assert.equal(assigned.preferences.appearance.accent,'#f43f5e')
assert.equal(assigned.platformGuidance.itsm.completedAt,'2026-10-12T19:59:00.000Z')
assert.equal(tenantExperienceSnapshot(after,customTenant,newOnboarding).preferences,null,'Other new tenant unaffected')
assert.equal(tenantExperienceSnapshot(after,firstTenant,new Date('2026-09-01')).preferences.appearance.accent,'#d38301')

const session={
  user_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenant_id:managedTenant,tenant_role:'owner',slug:'h5c-managed-qa26',
  company_name:'Managed QA',email:'example.invalid@example.invalid',name:'Test User',
  tenant_url:'https://h5c-managed-qa26.hi5central.com',modules:{itsm:true},
  onboarding_step:'complete',onboarding_completed_at:newOnboarding,
  onboarding_data:{theme:{mode:'light',accent:'#f43f5e'}},configuration:{theme:{mode:'light',accent:'#f43f5e'}},
  user_preferences:old.preferences,user_first_login_completed_at:old.first_login_completed_at,
  user_platform_guidance:old.platform_guidance,user_platform_getting_started:old.platform_getting_started,
}
const payload=sessionPayload(session)
assert.equal(payload.userExperience.firstLoginCompletedAt,null)
assert.equal(payload.preferences,null)
assert.equal(payload.settings.theme.accent,'#f43f5e')
assert.throws(()=>sessionPayload(null),/verified session/,'Never present null session as authenticated')
const afterPayload=sessionPayload({...session,
  user_preferences:after.preferences,user_platform_guidance:after.platform_guidance})
assert.equal(afterPayload.preferences.appearance.theme,'light')
assert.equal(afterPayload.userExperience.firstLoginCompletedAt,'2026-10-12T19:55:00.000Z')

console.log('PASS: first login is per tenant, existing tenants keep preferences, new branding is retained, null sessions rejected')
