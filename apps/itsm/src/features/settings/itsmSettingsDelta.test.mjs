import assert from 'node:assert/strict'
import test from 'node:test'
import {collectItsmSettingsEdits} from './itsmSettingsDelta.js'

test('Built-in defaults are not written as changes when only one checkbox is edited',()=>{
 const baseline={numberingMode:'default',dashboard:{showApprovals:true},queues:{pageSize:'25'},incidents:{defaultStatus:'New'},attachments:{maxMb:'5'}}
 const changed={...baseline,dashboard:{...baseline.dashboard,showApprovals:false}}
 assert.deepEqual(collectItsmSettingsEdits(baseline,changed),[
  {path:['dashboard','showApprovals'],value:false},
 ])
 assert.deepEqual(collectItsmSettingsEdits(baseline,baseline),[])
})
test('One nested SLA edit is an exact leaf, not a whole priorities bucket',()=>{
 const old={slaTargets:{High:{responseMinutes:'30',resolutionMinutes:'480'}}}
 const next={slaTargets:{High:{responseMinutes:'35',resolutionMinutes:'480'}}}
 assert.deepEqual(collectItsmSettingsEdits(old,next),[
  {path:['slaTargets','High','responseMinutes'],value:'35'},
 ])
})
test('Displaying defaulted sections and saving without an edit is a no-op',()=>{
 const mergedDefaults={dashboard:{showServiceHealth:true},slaTargets:{High:{responseMinutes:'30'}},calendar:{showProjects:true}}
 assert.deepEqual(collectItsmSettingsEdits(mergedDefaults,structuredClone(mergedDefaults)),[])
})
test('Unsupported removal is rejected instead of deleting hidden tenant data',()=>{
 assert.throws(()=>collectItsmSettingsEdits({queues:{pageSize:'25'}},{queues:{}}),/removed/)
})
