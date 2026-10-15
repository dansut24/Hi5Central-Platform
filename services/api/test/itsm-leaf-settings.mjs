import assert from 'node:assert/strict'
import test from 'node:test'
import {applyItsmSettingsEdits,recordItsmConfigurationChange} from '../src/itsmConfigurationChanges.js'

const tenantId='11111111-1111-4111-8111-111111111111'
const actorUserId='22222222-2222-4222-8222-222222222222'

test('One changed nested field does not materialise 18 untouched editor defaults',async()=>{
  const persisted={numberingMode:'default',slaWarnings:true,serviceRequestSlaTargets:{High:{responseMinutes:'60'}}}
  const edits=[{path:['dashboard','showApprovals'],value:false}]
  const applied=applyItsmSettingsEdits(persisted,edits)
  assert.deepEqual(applied.changedPaths,['dashboard.showApprovals'])
  assert.equal(Object.keys(applied.configuration).length,4)
  assert.equal(applied.configuration.dashboard.showApprovals,false)
  assert.deepEqual(applied.configuration.serviceRequestSlaTargets,persisted.serviceRequestSlaTargets)
  assert.equal(Object.prototype.hasOwnProperty.call(applied.configuration,'calendar'),false)
  const events=[]
  const db={query:async(sql,params)=>{events.push({sql,params});return {rows:[{id:'event'}]}}}
  const result=await recordItsmConfigurationChange({db,tenantId,actorUserId,
    environment:'uat',before:persisted,after:applied.configuration,changedPaths:applied.changedPaths})
  assert.deepEqual(result.changedKeys,['dashboard.showApprovals'])
  assert.equal(events[0].params[2],'tenant_settings.itsm.delta-v2')
  assert.deepEqual(events[0].params[5],['dashboard.showApprovals'])
})
test('A user can edit one SLA leaf without replacing other SLA rules',()=>{
  const persisted={slaTargets:{High:{responseMinutes:'30',resolutionMinutes:'480'},Low:{responseMinutes:'480'}}}
  const edited=applyItsmSettingsEdits(persisted,[{path:['slaTargets','High','responseMinutes'],value:'35'}])
  assert.deepEqual(edited.changedPaths,['slaTargets.High.responseMinutes'])
  assert.equal(edited.configuration.slaTargets.High.resolutionMinutes,'480')
  assert.equal(edited.configuration.slaTargets.Low.responseMinutes,'480')
  assert.equal(persisted.slaTargets.High.responseMinutes,'30')
})
test('Repeated same value is a no-op and cannot generate a fake audit event',()=>{
 const original={dashboard:{showApprovals:true}}
 const changed=applyItsmSettingsEdits(original,[{path:['dashboard','showApprovals'],value:true}])
 assert.deepEqual(changed.changedPaths,[])
 assert.deepEqual(changed.configuration,original)
})
test('Refuse full snapshots, objects, duplicate/overlapping paths and prototype pollution',()=>{
 for(const bad of [
  null,{},[{path:['dashboard'],value:{showApprovals:true}}],
  [{path:['__proto__','evil'],value:true}],
  [{path:['constructor'],value:'oops'}],
  [{path:['dashboard','showApprovals'],value:true},{path:['dashboard','showApprovals'],value:false}],
  [{path:['dashboard'],value:false},{path:['dashboard','showApprovals'],value:false}],
  [{path:['slaTargets','High'],value:[]}],
  [{path:['dashboard','showApprovals'],value:Number.POSITIVE_INFINITY}],
 ]) {
   assert.throws(()=>applyItsmSettingsEdits({},bad),Error)
 }
 assert.throws(()=>applyItsmSettingsEdits({dashboard:{showApprovals:true}},
   [{path:['dashboard','showApprovals','oops'],value:true}]),/scalar/)
})
