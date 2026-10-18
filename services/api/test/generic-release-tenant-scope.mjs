import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readGenericTenantScope} from '../src/genericReleaseTenantScope.js'

const sql=readFileSync(new URL('../migrations/platform-admin/172_automatic_all_itsm_customer_release_discovery.sql',import.meta.url),'utf8')
const routes=readFileSync(new URL('../src/certifiedTenantReleaseRoutes.js',import.meta.url),'utf8')
const ui=readFileSync(new URL('../../../apps/admin/src/features/admin/GenericReleasePlanning.jsx',import.meta.url),'utf8')

test('all ITSM tenants are discovered without pilot lists, with active/onboarded constraints',async()=>{
 const calls=[]
 const db={async query(text){calls.push(text);return calls.length===1?
  {rows:[{mode:'all_onboarded',reason:'Automatic discovery',updated_at:new Date()}]}:
  {rows:[{id:'one',slug:'managed',eligible:true},{id:'two',slug:'custom',eligible:true}]}}}
 const result=await readGenericTenantScope(db)
 assert.equal(result.eligible,2)
 assert.equal(result.autoDiscovery,true)
 assert.equal(result.manualAdmissionRequired,false)
 assert.equal(result.certificationStillRequired,true)
 assert.match(calls[1],/hi5_release_generic_tenant_permitted/)
 assert.match(calls[1],/t.status='active'/)
 assert.match(calls[1],/s.onboarding_completed_at IS NOT NULL/)
 assert.match(calls[1],/modules->>'itsm'/)
 assert.doesNotMatch(calls[1],/platform_release_generic_pilot_tenants/)
})
test('global automatic scope still fails closed until reviewed migration',async()=>{
 const db={async query(){return {rows:[{mode:'pilot'}]}}}
 await assert.rejects(readGenericTenantScope(db),/migration has not been applied/)
})
test('no pilot admission endpoints or UI; retained central release and route gates',()=>{
 assert.match(routes,/Named pilot enrollment is retired/)
 assert.doesNotMatch(routes,/enrolTenTenantPilot/)
 assert.doesNotMatch(ui,/GenericReleasePilotScope/)
 assert.match(sql,/c.mode='all_onboarded'/)
 assert.match(sql,/t.status='active'/)
 assert.match(sql,/s.onboarding_completed_at IS NOT NULL/)
 assert.match(sql,/pref.update_mode IN/)
 assert.doesNotMatch(sql,/platform_release_generic_pilot_tenants/)
 assert.match(routes,/verifyOfficialReleaseRun/)
 assert.match(routes,/verifyDevReleaseSmoke/)
 assert.match(routes,/authoriseDirectCustomerReleaseStages/)
})
