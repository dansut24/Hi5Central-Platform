import assert from 'node:assert/strict'
import test from 'node:test'
import {completeReleaseSelection,MAX_RELEASE_HISTORY_COMMITS,reviewedReleaseRange} from '../src/releaseReviewRange.js'

const id=n=>n.toString(16).padStart(40,'0')
const manifest=(count,options={})=>({
  schemaVersion:2,historyComplete:true,historyLimit:MAX_RELEASE_HISTORY_COMMITS,
  sha:id(count),commits:Array.from({length:count},(_,i)=>({sha:id(count-i),subject:'Change '+i})),
  ...options,
})
test('188 commits from the exact Live ancestor must ALL be reviewed',()=>{
  const source=manifest(230)
  const result=reviewedReleaseRange(source,id(42))
  assert.equal(result.knownBaseline,true)
  assert.equal(result.changes.length,188)
  assert.equal(result.changes.at(-1).sha,id(43))
  assert.equal(completeReleaseSelection(result.changes,result.changes.map(x=>x.sha)),true)
  assert.equal(completeReleaseSelection(result.changes,result.changes.slice(0,70).map(x=>x.sha)),false)
  assert.equal(completeReleaseSelection(result.changes,result.changes.slice(0,100).map(x=>x.sha)),false)
})
test('same-revision Live requires no change selection',()=>{
  const source=manifest(188)
  const result=reviewedReleaseRange(source,source.sha)
  assert.equal(result.knownBaseline,true)
  assert.deepEqual(result.changes,[])
})
test('unknown or older-than-window Live baselines fail closed',()=>{
  const source=manifest(MAX_RELEASE_HISTORY_COMMITS)
  assert.equal(reviewedReleaseRange(source,id(999)).knownBaseline,false)
  assert.equal(reviewedReleaseRange(source,'').knownBaseline,false)
  assert.equal(reviewedReleaseRange(source,id(0)).knownBaseline,false)
  assert.equal(reviewedReleaseRange(source,id(1)).changes.length,MAX_RELEASE_HISTORY_COMMITS-1)
})
test('historical 100-commit/truncated manifest cannot approve the 188-commit release',()=>{
  const old=manifest(230,{
    schemaVersion:1,historyComplete:false,
    commits:manifest(230).commits.slice(0,100),
  })
  assert.equal(reviewedReleaseRange(old,id(42)).knownBaseline,false)
  assert.match(reviewedReleaseRange(old,id(42)).reason,/complete, trusted Git history/)
})
test('missing, duplicate, untrusted or oversized inventory blocks approval',()=>{
  const m=manifest(189)
  assert.equal(reviewedReleaseRange({...m,commits:[]},id(1)).knownBaseline,false)
  assert.equal(reviewedReleaseRange({...m,commits:[m.commits[1],...m.commits.slice(1)]},id(1)).knownBaseline,false)
  assert.equal(reviewedReleaseRange({...m,commits:[m.commits[0],m.commits[0],...m.commits.slice(2)]},id(1)).knownBaseline,false)
  assert.equal(reviewedReleaseRange({...m,historyComplete:false},id(1)).knownBaseline,false)
  assert.equal(reviewedReleaseRange({...m,historyLimit:100},id(1)).knownBaseline,false)
  const over=manifest(MAX_RELEASE_HISTORY_COMMITS+1)
  assert.equal(reviewedReleaseRange(over,id(1)).knownBaseline,false)
})
test('selecting wrong, duplicate, missing, or extra commit never counts as full approval',()=>{
  const expected=reviewedReleaseRange(manifest(230),id(42)).changes
  const approved=expected.map(x=>x.sha)
  assert.equal(completeReleaseSelection(expected,approved.slice().reverse()),true)
  assert.equal(completeReleaseSelection(expected,approved.slice(1)),false)
  assert.equal(completeReleaseSelection(expected,[...approved.slice(0,-1),approved[0]]),false)
  assert.equal(completeReleaseSelection(expected,[...approved,id(999)]),false)
  assert.equal(completeReleaseSelection(expected,[...approved.slice(0,-1),id(999)]),false)
})
