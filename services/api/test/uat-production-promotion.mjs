import assert from 'node:assert/strict'
import test from 'node:test'
import {assessUatProductionPromotion} from '../src/uatProductionPromotion.js'

const sha='a'.repeat(40)
const other='b'.repeat(40)
const request={
  status:'pending',build_sha:sha,
  evidence:'I confirmed login, MFA, incident updates and mobile layouts in Custom UAT.',
  approved_change_shas:[other],
}
const uat={verified:true,apiSha:sha,itsmSha:sha}
const live={verified:true,apiSha:other,itsmSha:other}
const gate=(overrides={})=>assessUatProductionPromotion({
  review:request,uat,live,published:true,...overrides,
})

test('A host-verified published UAT review is ready for platform operator queue',()=>{
  assert.equal(gate().allowed,true)
  assert.equal(gate().code,'READY_TO_QUEUE')
})
test('Reject missing, withdrawn, duplicate or malformed customer UAT approvals',()=>{
  assert.equal(gate({review:null}).code,'REVIEW_NOT_PENDING')
  assert.equal(gate({review:{...request,status:'approved'}}).allowed,false)
  assert.equal(gate({review:{...request,status:'rejected'}}).allowed,false)
  assert.equal(gate({review:{...request,build_sha:'latest'}}).code,'INVALID_REVISION')
  assert.equal(gate({review:{...request,evidence:'tested'}}).code,'MISSING_TEST_EVIDENCE')
  assert.equal(gate({review:{...request,approved_change_shas:[other,other]}}).code,'INVALID_CHANGE_SELECTION')
  assert.equal(gate({review:{...request,approved_change_shas:['wrong']}}).code,'INVALID_CHANGE_SELECTION')
})
test('Never promote unpublished or stale/unverified/replaced API or ITSM builds',()=>{
  assert.equal(gate({published:false}).code,'NOT_PUBLISHED')
  assert.equal(gate({uat:{...uat,verified:false}}).code,'UAT_MISMATCH')
  assert.equal(gate({uat:{...uat,apiSha:other}}).code,'UAT_MISMATCH')
  assert.equal(gate({uat:{...uat,itsmSha:other}}).code,'UAT_MISMATCH')
  assert.equal(gate({live:{...live,apiSha:sha,itsmSha:sha}}).code,'ALREADY_INSTALLED')
})
test('No browser-supplied target or revision is required; reviewed immutable build is authoritative',()=>{
  assert.equal(gate().allowed,true)
  assert.equal(gate({review:{...request,build_sha:other}}).code,'UAT_MISMATCH')
})
