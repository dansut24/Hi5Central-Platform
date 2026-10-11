import assert from 'node:assert/strict'
import {digestReferenceValue,planReferenceChanges,REFERENCE_RESOURCES} from '../src/environmentReferencePlan.js'

const people=REFERENCE_RESOURCES.find(x=>x.kind==='people')
const source=[{id:'live-1',external_key:'USR-A',name:'Alex',phone:'555-111',
  job_title:'Analyst',active:true}]
const target=[{id:'uat-different-1',external_key:'USR-A',name:'Alex',phone:'555-111',
  job_title:'Analyst',active:true}]
const input=(s=source,t=target,b=[])=>planReferenceChanges({source:s,target:t,baselines:b,resource:people})
const initial=input()
assert.equal(initial.stats.conflicts,0)
assert.equal(initial.stats.initialised,4)
assert.equal(initial.stats.updates,0)
const baselines=people.fields.map(field=>({
  external_key:'USR-A',field_key:field,
  source_digest:digestReferenceValue(source[0][field]),
  target_digest:digestReferenceValue(target[0][field]),
}))
const changed=[{...source[0],phone:'555-222'}]
const next=input(changed,target,baselines)
assert.equal(next.stats.updates,1)
assert.equal(next.changes.find(x=>x.field==='phone').action,'update')
assert.equal(next.changes.find(x=>x.field==='phone').value,'555-222')
const divergent=[{...target[0],phone:'uat-local-test'}]
const conflict=input(changed,divergent,baselines)
assert.equal(conflict.stats.conflicts,1)
assert.equal(conflict.stats.updates,0)
assert.equal(input(source,divergent,baselines).stats.conflicts,1,
  'A UAT-only change is not overwritten even when Production has not changed.')
const resolved=input(changed,[{...target[0],phone:'555-222'}],baselines)
assert.equal(resolved.stats.initialised,1,
  'Coincident values may safely advance the baseline.')
assert.equal(input(source,[],baselines).stats.missing,1)
assert.equal(input([],[target[0]],baselines).stats.destinationOnly,1)
assert.throws(()=>input([...source,...source]),/Duplicate/)
assert.throws(()=>input(source,[...target,...target]),/Duplicate/)
assert.equal(REFERENCE_RESOURCES.some(x=>x.fields.includes('password_hash')),false)
assert.equal(REFERENCE_RESOURCES.some(x=>x.fields.includes('user_id')),false)
assert.equal(REFERENCE_RESOURCES.some(x=>x.fields.includes('manager_id')),false)
assert.equal(REFERENCE_RESOURCES.some(x=>x.table.includes('rmm_device')),false)
console.log('PASS: stable-key master data sync, conflict protection, bootstrap and secrets isolation')
