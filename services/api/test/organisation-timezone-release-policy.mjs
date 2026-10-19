import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {tenantOrganisationTimezone,validOrganisationTimezone,withOrganisationReleaseTimezone} from '../src/tenantOrganisationTimezone.js'
import {validateOnboardingMaintenanceWindow} from '../src/onboardingMaintenancePolicy.js'
import {nextTenantMaintenanceWindow} from '../src/releaseRolloutPlanner.js'

const companymanaged={
 configuration:{company:{timezone:'Europe/London'}},
 onboarding_data:{company:{timezone:'Europe/London'}},
}
const current={
 maintenance_window:{start:'21:15',end:'00:00',timezone:'Europe/London',days:['mon','tue','wed','thu','fri','sat','sun']},
}
const edited={days:current.maintenance_window.days,start:'09:30',end:'12:00',timezone:''}

test('Organisation timezone is authoritative even when release form has missing or invalid zone',()=>{
 const tz=tenantOrganisationTimezone(companymanaged,current)
 assert.equal(tz,'Europe/London')
 const prepared=validateOnboardingMaintenanceWindow(withOrganisationReleaseTimezone(edited,tz))
 assert.equal(prepared.timezone,'Europe/London')
 assert.equal(prepared.start,'09:30')
 assert.equal(prepared.end,'12:00')
})
test('Screenshot 09:30–12:00 time uses London UK timezone and next eligible interval',()=>{
 const prepared=validateOnboardingMaintenanceWindow(
   withOrganisationReleaseTimezone(edited,tenantOrganisationTimezone(companymanaged,current)))
 const scheduled=nextTenantMaintenanceWindow({
   policy:prepared,now:new Date('2026-10-19T08:20:00Z'),durationMinutes:15,
 })
 assert.equal(scheduled.ok,true)
 assert.equal(scheduled.scheduledAt,'2026-10-19T08:30:00.000Z')
})
test('Changing Organisation timezone overrides stale release timezone',()=>{
 const org={configuration:{company:{timezone:'America/New_York'}},onboarding_data:{company:{timezone:'Europe/London'}}}
 assert.equal(tenantOrganisationTimezone(org,current),'America/New_York')
 assert.equal(withOrganisationReleaseTimezone(edited,'America/New_York').timezone,'America/New_York')
})
test('Invalid configured Organisation timezone cannot be masked by old release settings',()=>{
 assert.throws(()=>tenantOrganisationTimezone({
   configuration:{company:{timezone:'a/bogus-zone'}},onboarding_data:{company:{timezone:'Europe/London'}}
 },current),/Organisation time zone is invalid/)
 assert.equal(validOrganisationTimezone('invalid-zone'),null)
})
test('Legacy tenants use onboarding or validated existing release timezone, never global settings',()=>{
 assert.equal(tenantOrganisationTimezone({onboarding_data:{company:{timezone:'Europe/Dublin'}}},current),'Europe/Dublin')
 assert.equal(tenantOrganisationTimezone({},current),'Europe/London')
 assert.throws(()=>tenantOrganisationTimezone({},{}),/Set a valid organisation time zone/)
})
test('UI reads tenant preference, removes global policy write, and displays non-editable timezone',()=>{
 const view=readFileSync(new URL('../../../apps/itsm/src/features/settings/ProductionReleaseManagement.jsx',import.meta.url),'utf8')
 assert.match(view,/setPolicy\(tenantState\.preference\)/)
 assert.doesNotMatch(view,/setPolicy\(platformResult\.value\?\.deploymentPolicy/)
 assert.doesNotMatch(view,/releaseApi\('\/deployment\/preferences',\{method:'PATCH'/)
 assert.match(view,/input readOnly value=\{organisationTimezone/)
 assert.match(view,/tenantState\?\.organisationTimezone/)
})
test('Tenant release route derives authoritative timezone inside protected policy transaction',()=>{
 const api=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 assert.match(api,/SELECT configuration,onboarding_data FROM tenant_settings WHERE tenant_id=\$1 FOR SHARE/)
 assert.match(api,/withOrganisationReleaseTimezone\(maintenanceWindow,organisationTimezone\)/)
 assert.match(api,/return \{preference:preferencePayload\(after\),organisationTimezone/)
})
test('Organisation Settings propagates timezone changes to release preferences',()=>{
 const settings=readFileSync(new URL('../src/settings.js',import.meta.url),'utf8')
 assert.match(settings,/validOrganisationTimezone\(data\.timezone\)/)
 assert.match(settings,/UPDATE tenant_release_preferences SET/)
 assert.match(settings,/eventType:'release\.maintenance_timezone_inherited'/)
})
