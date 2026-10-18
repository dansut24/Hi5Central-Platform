import test from 'node:test'
import assert from 'node:assert/strict'
import {parsePinnedQaReleaseSha} from '../src/releasePlannerScope.js'

const SHA='ff3795f7d1bc5d256ced5142b578c0897f57f6a7'

test('unset QA pin preserves the existing full certification scan',()=>{
  assert.equal(parsePinnedQaReleaseSha(undefined),null)
})
test('an exact 40-character certified candidate can be pinned',()=>{
  assert.equal(parsePinnedQaReleaseSha(SHA),SHA)
})
test('configured empty, uppercase, abbreviated, invalid and whitespace-padded pins fail closed',()=>{
  for(const bad of ['',SHA.toUpperCase(),SHA.slice(0,12),'z'.repeat(40),' '+SHA,SHA+' ',null,0])
    assert.throws(()=>parsePinnedQaReleaseSha(bad),/RELEASE_QA_BUILD_SHA/)
})
