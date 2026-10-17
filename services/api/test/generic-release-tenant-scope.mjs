import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {validateTenTenantPilotRequest} from '../src/genericReleaseTenantScope.js'

const actor=randomUUID()
const ids=Array.from({length:10},()=>randomUUID())
const approved={
 tenantIds:ids,
 confirmation:'AUTHORISE_TEN_TENANT_PILOT',
 reason:'Reviewed real ten-tenant pilot for audited upgrades and rollback.',
 reviewedChange:'PR #79 / independent platform owner review',
}
test('pilot approval accepts only exact 10 named tenants with explicit human acknowledgement',()=>{
 const request=validateTenTenantPilotRequest({body:approved,actorId:actor})
 assert.deepEqual(request.tenantIds,ids)
 assert.equal(request.actorId,actor)
 assert.equal(request.reason,approved.reason)
})
test('pilot denies missing, duplicate or broadened cohorts',()=>{
 for(const tenantIds of [[],ids.slice(0,9),[...ids,randomUUID()],ids.map((x,i)=>i===9?ids[0]:x)]){
  assert.throws(()=>validateTenTenantPilotRequest({body:{...approved,tenantIds},actorId:actor}),/Exactly ten distinct/)
 }
 for(const key of ['deployNow','unpause','executionEnabled','allTenants','bypassApproval','force']){
  assert.throws(()=>validateTenTenantPilotRequest({body:{...approved,[key]:true},actorId:actor}),
   /cannot deploy, unpause or enable general/)
 }
})
test('pilot denies weak evidence, missing platform admin identity or implicit confirmations',()=>{
 assert.throws(()=>validateTenTenantPilotRequest({body:{...approved,confirmation:'yes'},actorId:actor}),
  /AUTHORISE_TEN_TENANT_PILOT/)
 assert.throws(()=>validateTenTenantPilotRequest({body:{...approved,reason:'short'},actorId:actor}),
  /meaningful pilot reason/)
 assert.throws(()=>validateTenTenantPilotRequest({body:{...approved,reviewedChange:'PR'},actorId:actor}),
  /meaningful pilot reason/)
 assert.throws(()=>validateTenTenantPilotRequest({body:approved,actorId:''}),
  /Authenticated platform owner/)
})
