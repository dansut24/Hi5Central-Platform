import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateUatConfigurationCandidates,prepareSelectiveItsmPromotion,
  prepareSelectiveItsmRevert,
} from '../src/uatSelectiveConfiguration.js'

const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const newer='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const event=(id,path,before,after,kind='boolean')=>({
  id,entity_key:'tenant_settings.itsm.delta-v2',recorded_at:'2026-10-15T10:00:00Z',
  changed_keys:[path],value_changes:[{path,kind,before,after,beforeSource:'saved'}],
})
const ledger=(settings,live,events,history=[])=>evaluateUatConfigurationCandidates({
  events,uatConfig:settings,liveConfig:live,priorPromotions:history,
})

test('Only the exact selected UAT milestone toggle can be promoted',()=>{
  const source={projects:{showMilestones:false,showTaskDueDates:true},dashboard:{showApprovals:false}}
  const production={projects:{showMilestones:true,showTaskDueDates:true},dashboard:{showApprovals:true}}
  const events=[event(first,'projects.showMilestones',true,false)]
  const [candidate]=ledger(source,production,events)
  assert.equal(candidate.status,'ready')
  const updated=prepareSelectiveItsmPromotion({candidate,liveConfig:production})
  assert.deepEqual(updated.changedPaths,['projects.showMilestones'])
  assert.equal(updated.configuration.projects.showMilestones,false)
  assert.equal(updated.configuration.projects.showTaskDueDates,true)
  assert.equal(updated.configuration.dashboard.showApprovals,true)
  assert.equal(production.projects.showMilestones,true)
})

test('Live missing value uses documented effective default (On)',()=>{
  const [candidate]=ledger({projects:{showMilestones:false}}, {projects:{showTaskDueDates:true}},
    [event(first,'projects.showMilestones',true,false)])
  assert.equal(candidate.liveValue,true)
  assert.equal(candidate.status,'ready')
  const updated=prepareSelectiveItsmPromotion({candidate,liveConfig:{projects:{showTaskDueDates:true}}})
  assert.equal(updated.configuration.projects.showMilestones,false)
})

test('Production independently edited to same value is automatically already applied',()=>{
  const [candidate]=ledger({projects:{showMilestones:false}},{projects:{showMilestones:false}},
    [event(first,'projects.showMilestones',true,false)])
  assert.equal(candidate.status,'already_applied')
  assert.throws(()=>prepareSelectiveItsmPromotion({
    candidate,liveConfig:{projects:{showMilestones:false}},
  }),/not ready/)
})

test('Production divergence blocks overwriting unrelated edits',()=>{
  const [candidate]=ledger({projects:{defaultHealth:'Blocked'}},{projects:{defaultHealth:'At risk'}},
    [event(first,'projects.defaultHealth','On track','Blocked','enum')])
  assert.equal(candidate.status,'conflict')
  assert.throws(()=>prepareSelectiveItsmPromotion({
    candidate,liveConfig:{projects:{defaultHealth:'At risk'}},
  }),/not ready/)
})

test('Missing unknown baseline blocks unsafe promotion',()=>{
  const [candidate]=ledger({catalogue:{enabled:false}},{},
    [event(first,'catalogue.enabled',null,false)])
  assert.equal(candidate.status,'unknown_baseline')
})

test('Latest UAT change supersedes earlier versions of same field',()=>{
  const events=[
    event(newer,'projects.showMilestones',false,true),
    event(first,'projects.showMilestones',true,false),
  ]
  const candidates=ledger({projects:{showMilestones:true}},
    {projects:{showMilestones:false}},events)
  assert.equal(candidates.length,1)
  assert.equal(candidates[0].eventId,newer)
  assert.equal(candidates[0].status,'ready')
})
test('No safe values in latest UAT event still invalidate old proposal',()=>{
  const events=[
    {...event(newer,'projects.showMilestones',false,true),value_changes:[]},
    event(first,'projects.showMilestones',true,false),
  ]
  const candidates=ledger({projects:{showMilestones:false}},
    {projects:{showMilestones:true}},events)
  assert.equal(candidates.length,0)
})
test('Excludes sensitive and historic snapshot keys from selectable candidates',()=>{
  const events=[
    event(newer,'integrations.apiToken','a','b','enum'),
    {...event(first,'projects.showMilestones',true,false),
      entity_key:'tenant_settings.itsm'},
  ]
  assert.deepEqual(ledger({integrations:{apiToken:'b'}},{},events),[])
})
test('Repeated same immutable UAT event cannot be promoted twice',()=>{
  const events=[event(first,'projects.showMilestones',true,false)]
  const [candidate]=ledger({projects:{showMilestones:false}},
    {projects:{showMilestones:true}},events,[{
      uat_event_id:first,setting_path:'projects.showMilestones',status:'applied',
    }])
  assert.equal(candidate.status,'promoted')
})

test('Revert restores previous value only while Production still matches the approved value',()=>{
  const promotion={
    status:'applied',setting_path:'projects.showMilestones',before_value:true,after_value:false,
  }
  const original={projects:{showMilestones:false,showTaskDueDates:true}}
  const changed=prepareSelectiveItsmRevert({promotion,liveConfig:original})
  assert.deepEqual(changed.changedPaths,['projects.showMilestones'])
  assert.equal(changed.configuration.projects.showMilestones,true)
  assert.equal(changed.configuration.projects.showTaskDueDates,true)
  assert.throws(()=>prepareSelectiveItsmRevert({
    promotion,liveConfig:{projects:{showMilestones:true}},
  }),/changed since promotion/)
  assert.throws(()=>prepareSelectiveItsmRevert({
    promotion:{...promotion,status:'reverted'},liveConfig:original,
  }),/Only applied/)
})
