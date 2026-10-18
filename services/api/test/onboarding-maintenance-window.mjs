import test from 'node:test'
import assert from 'node:assert/strict'
import {validateOnboardingMaintenanceWindow} from '../src/onboardingMaintenancePolicy.js'
const valid={timezone:'Europe/London',days:['mon','wed','fri'],start:'02:00',end:'05:00'}
test('explicit selected weekdays, start/end and IANA zone are retained',()=>{
 assert.deepEqual(validateOnboardingMaintenanceWindow(valid),valid)
 assert.deepEqual(validateOnboardingMaintenanceWindow({...valid,days:['fri','mon']}),{...valid,days:['mon','fri']})
})
test('fails closed for an absent, empty or invalid maintenance window',()=>{
 for(const broken of [null,{},[],{...valid,days:[]},{...valid,days:['wat']},
  {...valid,days:['mon','mon']},{...valid,start:'25:00'},
  {...valid,end:'02:00'},{...valid,end:'02:15'},
  {...valid,timezone:'Mars/Planet'}]){
  assert.throws(()=>validateOnboardingMaintenanceWindow(broken),error=>error.status===400)
 }
})
test('overnight IANA-local maintenance windows are supported',()=>{
 assert.equal(validateOnboardingMaintenanceWindow({
   ...valid,days:['sat'],start:'23:00',end:'03:00',
 }).start,'23:00')
})
test('policy UI and backend persist the identical explicit maintenance field',async()=>{
 const {readFileSync}=await import('node:fs')
 const wizard=readFileSync(new URL('../../../apps/itsm/src/features/onboarding/OnboardingWizard.jsx',import.meta.url),'utf8')
 const api=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 assert.match(wizard,/Application release maintenance window/)
 assert.match(wizard,/Select your maintenance days to continue/)
 assert.match(wizard,/maintenanceWindow: defaultReleaseWindow\(session\)/)
 assert.match(api,/validateOnboardingMaintenanceWindow\(data\?\.maintenanceWindow\)/)
 assert.match(api,/maintenance_window=excluded.maintenance_window/)
 assert.match(api,/const autoUat=!managed/)
 assert.match(api,/\? \{ uatAutoStage: false, liveAutoPromote: true \}/)
 assert.match(api,/: \{ uatAutoStage: true, liveAutoPromote: false \}/)
})
